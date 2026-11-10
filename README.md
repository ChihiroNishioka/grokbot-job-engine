# grokbot-job-engine

iMessage から受け付ける仕事をジョブとして保存し、Worker への受け渡し、状態、結果、通知予定を管理する Job Engine です。

Phase 1 は SQLite の Job Store、Hono の HTTP API、期限切れの回収と滞留検出、通知予定の outbox、認証、入力検証、ログのマスキングを扱います。Dispatcher は Worker を起こす合図の契約とモックを提供します。webhook 実装は fetch を注入したテスト用です。

iMessage の受信・送信、Worker 本体、MCP、管理コマンドの解釈、Scheduler、Mac への導入、launchd、Tailscale の設定、バックアップは範囲外です。実際の webhook 送信も行いません。

## 起動する

Node.js 24 を使います。

```sh
npm ci
cp .env.example .env
```

`.env` の `JOB_API_TOKEN` を32文字以上のランダムな値に変更します。`ALLOWED_SOURCE_CHAT_IDS` には許可するトークの ID をカンマ区切りで設定します。例の値はダミーです。実際の秘密と個人情報は Git 管理外の `.env` だけに保存します。設定の一覧と範囲は [仕様9章と12章](docs/SPEC.md) を参照してください。

```sh
npm run dev
```

既定の待ち受けは `127.0.0.1:3320` です。Tailscale の中だけで使ってください。公開インターネットへ公開する設定は含みません。

ビルド済みコードを動かす場合は次を実行します。

```sh
npm run build
npm start
```

## API を使う

`GET /healthz` 以外は Bearer 認証が必要です。入力と応答の詳細は [仕様6章](docs/SPEC.md) を参照してください。補足の12章を優先します。

| メソッド | パス | 操作 |
|---|---|---|
| GET | `/healthz` | 生存確認 |
| POST | `/jobs` | ジョブ作成 |
| GET | `/jobs` | ジョブ一覧 |
| GET | `/jobs/:id` | ジョブ取得 |
| GET | `/jobs/:id/events` | 監査履歴 |
| POST | `/jobs/claim` | 次のジョブを取得 |
| POST | `/jobs/:id/claim` | 指定ジョブを取得 |
| POST | `/jobs/:id/heartbeat` | lease 更新 |
| POST | `/jobs/:id/complete` | 完了記録 |
| POST | `/jobs/:id/fail` | 失敗記録 |
| POST | `/jobs/:id/cancel` | キャンセル要求 |
| POST | `/jobs/:id/retry` | 再試行 |
| POST | `/outbox` | 通知予定の登録 |
| POST | `/outbox/claim` | 通知予定を取得 |
| POST | `/outbox/:id/sent` | 送信済み記録 |
| POST | `/outbox/:id/failed` | 送信失敗記録 |

ジョブの実行と通知の配送は at-least-once です。outbox の冪等キーは行の重複を防ぎます。送信後の記録前に停止すると再送されるため、将来の送信側も同じキーで重複を防ぐ必要があります。

## 検査する

```sh
npm run lint
npm run typecheck
npm test
npm run check:secrets
```

テストは HTTP サーバーを起動せず、`app.request()` と一時 DB を使います。時刻は FakeClock で進め、並行書き込みは worker_threads と Atomics で確認します。受け入れ条件は [GREEN.md](docs/GREEN.md) にあります。

秘密検査は Git 管理中と未追跡のファイルを対象にし、依存ディレクトリとロックファイルを除きます。検出時はファイル名・行番号・種類だけを表示します。テスト用のダミーを明記する必要がある行は `secret-scan:allow` で除外できます。

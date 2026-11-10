# grokbot-job-engine

iMessage から受け付ける仕事をジョブとして保存し、Worker への受け渡し、状態、結果、通知予定を管理する Job Engine です。

SQLite の Job Store、Genie の webhook を受ける Ingress、Genie が取りに来る返信、Worker 用 Job API を提供します。Worker は Transport を差し替えられ、box からは `tailscale nc` 経由でアクセスします。Dispatcher は Worker を起こす合図の契約とモックを提供します。

iMessage の受信・送信は Mac mini の Genie が担当します。処理関数の業務実装、MCP、Scheduler、Mac への導入、launchd、Tailscale の設定、バックアップは含みません。

実装済みと未確認の範囲は [動作確認の状況](docs/status.md) を参照してください。

## 起動する

Node.js 24 を使います。

```sh
npm ci
cp .env.example .env
```

`.env` の `JOB_API_TOKEN` と `GENIE_TOKEN` を別々の32文字以上のランダムな値に変更します。`GENIE_ALLOWED_CHAT_IDS` には自分宛てトークの整数 ID をカンマ区切りで設定します。`ALLOWED_SOURCE_CHAT_IDS` にも同じ ID を入れます。例の値はダミーです。実際の秘密と個人情報は Git 管理外の `.env` だけに保存します。[仕様13章](docs/SPEC.md) が1〜12章に優先します。

待ち受けは2つです。

| 用途 | HOST | PORT | 認証 |
|---|---|---|---|
| Genie の Ingress と返信取得 | `GENIE_HOST=127.0.0.1` | `GENIE_PORT=3321` | `GENIE_TOKEN` |
| Worker の Job API | `HOST=127.0.0.1` はローカル用の例 | `PORT=3320` | `JOB_API_TOKEN` |

Mac mini では `HOST` に tailnet 上の自分のアドレスを書きます。`.env.example` の `HOST` は `127.0.0.1` のままです。`HOST` は `net.isIP()` が認める IP リテラルだけを許します。未指定アドレスの別表記と IPv4-mapped の全ゼロも拒否します。Genie 用は loopback のみです。どちらも Funnel には出しません。

```dotenv
HOST=127.0.0.1
PORT=3320
GENIE_HOST=127.0.0.1
GENIE_PORT=3321
GENIE_ALLOWED_CHAT_IDS=21
ALLOWED_SOURCE_CHAT_IDS=21
GENIE_REPLY_PAGE_LIMIT=50
```

この例の `21` はダミーです。Mac mini 上の `.env` でだけ実際の値に置き換えます。

```sh
npm run dev
```

Genie 側は genie-in-messages の別 PR、ブランチ `feat/job-engine-route` が前提です。この PR で `job_webhook_url`、`job_chat_ids`、`job-secret`、loopback の http 許可、Notion と並べた返信取得が入ります。PR がマージされるまでは今の Genie では使えません。

Genie の設定（`config.json`）に足すキーの例は次のとおりです。`job_chat_ids` の数は、Mac mini 上で自分宛てトークの chat_id に置き換えます（Job Engine 側の `GENIE_ALLOWED_CHAT_IDS` と `ALLOWED_SOURCE_CHAT_IDS` にも同じ値が要ります。無いと Genie は `webhook_http_403` で止めます）。

```json
{
  "job_webhook_url": "http://127.0.0.1:3321/ingress/genie",
  "job_chat_ids": [7],
  "reply_fetch_url": "http://127.0.0.1:3321/genie/replies"
}
```

`job-secret` と `reply-secret` には `GENIE_TOKEN` と同じ値を保存し、両ファイルの権限を `0600` にします。通常の `webhook_url` と Notion の設定は今のままです。[Genie との契約](docs/genie.md) を参照してください。

box の Worker からの呼び方、CLI、接続できない場合の回復は [Worker の手順](docs/worker.md) を参照してください。

ビルド済みコードを動かす場合は次を実行します。

```sh
npm run build
npm start
```

## API を使う

`GET /healthz` 以外は Bearer 認証が必要です。入力と応答の詳細は [仕様6章](docs/SPEC.md) を参照してください。変更された入口・出口と経路は13章を優先します。Job API のルートは Ingress では公開しません。

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
npm run build
```

テストは HTTP サーバーを起動せず、`app.request()` と一時 DB を使います。時刻は FakeClock で進め、並行書き込みは worker_threads と Atomics で確認します。受け入れ条件は [GREEN.md](docs/GREEN.md) にあります。

秘密検査は Git 管理中と未追跡のファイルを対象にし、依存ディレクトリとロックファイルを除きます。検出時はファイル名・行番号・種類だけを表示します。テスト用のダミーを明記する必要がある行は `secret-scan:allow` で除外できます。

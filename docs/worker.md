# box から Worker を動かす

Worker は Mac mini の Job API を Tailscale 経由で呼びます。Job API の待ち受けは Mac mini の tailnet 上の自分のアドレスに設定します。Funnel には公開しません。

## `tailscale nc` を使う理由

box の tailscaled は userspace-networking で動作し、SOCKS と HTTP のプロキシはありません。プロキシの追加には tailscaled の再起動が必要で、その間は他の受信も止まります。この実装は設定を変更せず、`tailscale nc <Mac mini のホスト名> <PORT>` の標準入出力で HTTP/1.1 を送受信します。

要求には `Connection: close`、バイト数の `Content-Length`、Bearer 認証を付けます。応答は `Content-Length` と `Transfer-Encoding: chunked` の両方に対応します。子プロセスの stderr は破棄します。Transport、spawn、タイマーを注入できるため、テストでは実際の tailscale を起動しません。

## 1 回分の処理

`runWorkerOnce({client, claim, process})` は次の順番で動作します。

1. `claim` で 1 件を取得します。ジョブが無ければ `outcome: "idle"` で終了します。
2. 取得したジョブを処理関数 `process(job)` に渡します。
3. 処理関数が返す `{result, artifact_urls?, notify?}` を `complete` に送ります。`notify` が無ければ、`result.summary` と成果物 URL から仕様 13.4 の完了文を作ります。
4. 処理関数の例外だけを `fail` に送ります。エラー概要をマスクし、仕様 13.4 の失敗文を添えます。

claim、complete、fail のいずれかが届かなければ `outcome: "unreachable"` で終了します。通信障害を理由に追加の fail は送りません。API のエラーは `outcome: "api_error"` です。claim 済みなら lease が切れた後に Reconciler が queued に戻し、Dispatcher の次の起動で再実行できます。試行上限とキャンセル要求の扱いは通常の Reconciler と同じです。処理は at-least-once なので、外部への副作用はジョブ ID などで重複を防いでください。

## 設定する

次の Worker 専用環境変数を box で設定します。Mac mini の `.env` をコピーする必要はありません。

| 変数 | 内容 | 既定 |
|---|---|---|
| `JOB_API_TAILNET_HOST` | Mac mini のホスト名。必須 | なし |
| `JOB_API_PORT` | Job API のポート。1〜65535 | 3320 |
| `JOB_API_TOKEN_FILE` | Job API のトークンを入れた通常ファイル。権限は 600。必須 | なし |
| `TAILSCALE_BIN` | tailscale コマンドの名前またはパス | `tailscale` |
| `JOB_API_TIMEOUT_MS` | 1 要求の時間制限。1〜2^31−1 ミリ秒 | 15000 |

`JOB_API_TOKEN_FILE` の中身は Mac mini の `JOB_API_TOKEN` と合わせます。32 字以上にし、末尾の改行以外に改行を入れません。トークンを引数や出力に載せません。ホスト名、トークン、ファイルの実際のパスはリポジトリに保存しないでください。

```sh
export JOB_API_TAILNET_HOST='<Mac mini のホスト名>'
export JOB_API_PORT=3320
export JOB_API_TOKEN_FILE='<トークンファイルのパス>'
chmod 600 "$JOB_API_TOKEN_FILE"
```

## Routine から CLI を呼ぶ

`npm run build` で `dist/worker-cli.js` を生成します。Routine の Shell から呼びます。CLI は 1 要求を実行する道具です。処理全体を組み込む場合は `JobApiClient` と `runWorkerOnce` を使います。

```sh
node dist/worker-cli.js claim '{"worker_id":"routine-worker","lease_seconds":300}'
node dist/worker-cli.js get '{"job_id":"J-000123"}'
node dist/worker-cli.js heartbeat '{"job_id":"J-000123","claim_token":"<claim が返した値>"}'
node dist/worker-cli.js complete '{"job_id":"J-000123","claim_token":"<claim が返した値>","result":{"summary":"完了しました"}}'
node dist/worker-cli.js fail '{"job_id":"J-000123","claim_token":"<claim が返した値>","error":{"code":"PROCESSING_ERROR","message":"安全なエラー概要"}}'
node dist/worker-cli.js outbox '{"worker_id":"routine-worker"}'
```

claim の結果には `claim_token` が含まれます。heartbeat、complete、fail に同じ値を渡します。API 認証トークンとは別の値です。outbox は `/outbox/claim` を呼び、Genie 用の行は取得しません。CLI の complete と fail は API の入力をそのまま送るため、Genie への返信が必要なら `notify: {"body":"返信本文"}` も指定してください。既定文を自動で付けるのは `runWorkerOnce` です。

出力は JSON 1 行です。成功時は `{ok:true,data:...}`、届かない場合は `{ok:false,unreachable:true,reason:...}`、API エラーは `{ok:false,unreachable:false,status,code}` を返します。

| 終了コード | 意味 |
|---|---|
| 0 | 成功 |
| 3 | 届かない。`nc_not_found`、`connect_failed`、`timeout` |
| 4 | API のエラー、読めない API 応答、クライアントの実行エラー |
| 2 | コマンド、JSON、設定、トークンファイルの使い方が不正 |

`timeout` は子プロセスを停止します。応答が無いまま終了した場合と、不完全または読めない HTTP の応答は `connect_failed` とします。受信データは 16 MiB までです。送信成功後に応答を失う場合もあるため、通信障害を処理失敗として扱わず、lease と冪等性で回復します。

# box から Worker を動かす

main.ts は Dispatcher を起動しません。Phase 1 は Worker を起こす仕組みが無いため、Worker は手動または外部から呼び出す必要があります。`tailscale nc` と Genie との実配送は実機で未確認です。

Worker は Mac mini の Job API を Tailscale 経由で呼びます。Job API の待ち受けは Mac mini の tailnet 上の自分のアドレスに設定します。Funnel には公開しません。

## `tailscale nc` を使う理由

box の tailscaled は userspace-networking で動作し、SOCKS と HTTP のプロキシはありません。プロキシの追加には tailscaled の再起動が必要で、その間は他の受信も止まります。この実装は設定を変更せず、`tailscale nc <Mac mini のホスト名> <PORT>` の標準入出力で HTTP/1.1 を送受信します。

要求には `Connection: close`、バイト数の `Content-Length`、Bearer 認証を付けます。標準入力を EOF にせず、応答を読みます。`Content-Length` または chunked の末尾まで読めたら子プロセスを止めます。サーバー側の切断で子プロセスが終了した場合も、完全な応答なら成功です。子プロセスの stderr は破棄します。Transport、spawn、タイマーを注入できるため、テストでは実際の tailscale を起動しません。

## 1 回分の処理

`runWorkerOnce({client, claim, process})` は次の順番で動作します。

1. `claim` で 1 件を取得します。ジョブが無ければ `outcome: "idle"` で終了します。
2. 処理関数 `process({job, claimToken, heartbeat})` にジョブ、claim token、`heartbeat(): Promise<boolean>` を渡します。長い処理は lease 内に heartbeat を呼び、戻り値の `cancel_requested` を確認します。
3. 処理関数が返す `{result, artifact_urls?, notify?}` を `complete` に送ります。`notify` が無ければ、文字列の `result.summary`（それ以外は「結果を保存しました。」）と成果物 URL から仕様 13.4 の完了文を作ります。
4. 処理関数の例外だけを `fail` に送ります。例外の message はマスクして error に保存し、ユーザーには error.code に対応する固定の原因文を送ります。cancelled に遷移した場合はキャンセル文だけを送ります。

claim、heartbeat、complete、fail のいずれかが届かなければ `outcome: "unreachable"` で終了します。通信障害を理由に追加の fail は送りません。API のエラーは `outcome: "api_error"` です。claim 済みなら lease が切れた後に Reconciler が queued に戻し、Dispatcher を配線した後は、その起動で再実行できます。試行上限とキャンセル要求の扱いは通常の Reconciler と同じです。処理は at-least-once なので、外部への副作用はジョブ ID などで重複を防いでください。

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

claim の結果には `claim_token` が含まれます。heartbeat、complete、fail に同じ値を渡します。API 認証トークンとは別の値です。outbox は `/outbox/claim` を呼び、Genie 用の行は取得しません。CLI の complete と fail は `notify` を省略すると `runWorkerOnce` と同じ既定文を付けます。独自の返信は `notify: {"body":"返信本文"}`、通知を付けない場合は末尾に `--no-notify` を指定します。`--no-notify` は明示的な `notify` より優先します。

出力は JSON 1 行です。成功時は `{ok:true,data:...}`、届かない場合は `{ok:false,unreachable:true,reason:...}`、API エラーは `{ok:false,unreachable:false,status,code,message?}` を返します。

| 終了コード | 意味 |
|---|---|
| 0 | 成功 |
| 3 | 届かない。`nc_not_found`、`connect_failed`、`timeout` |
| 4 | API のエラー、読めない API 応答、クライアントの実行エラー |
| 2 | コマンド、JSON、設定、トークンファイルの使い方が不正 |

`timeout` は子プロセスを停止します。応答が無いまま終了した場合と、不完全または読めない HTTP の応答は `connect_failed` とします。受信データは 16 MiB までです。送信成功後に応答を失う場合もあるため、通信障害を処理失敗として扱わず、lease と冪等性で回復します。

使い方の誤りは `error:"USAGE_ERROR"` と `reason` を返します。理由コードは `BAD_JSON`、`UNKNOWN_COMMAND`、`MISSING_CONFIG`、`TOKEN_FILE_MODE`、`TOKEN_TOO_SHORT`、`INVALID_ARGUMENTS` です。API の 4xx は code と message を保持します。トークンやファイル内容は出力しません。

通知キーは `job:<job_id>:<kind>:<attempt>` です。同じ試行の再送は冪等で、retry 後の通知は別の行になります。Genie 経由のジョブが lease 切れで failed / cancelled になる場合も Reconciler が同じトランザクションで通知を作ります。

成果物 URL と固定文だけで1500字を超える場合は、URLを切らず `ARTIFACT_NOTIFICATION_TOO_LONG` を返します。Worker は `outcome:"notification_error"` と job_id、code を返し、complete / fail は送らず claim を保持します。CLI は終了コード2と同じ理由コードを返します。短い URL か明示的な短い `notify` で完了してください。CLI では `--no-notify` も使えます。API の成果物保存上限は変更しません。

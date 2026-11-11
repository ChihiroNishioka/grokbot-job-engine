# box から Worker を動かす

実装済みと未確認の範囲は [動作確認の状況](status.md) を参照してください。

Worker は Mac mini の Job API を Tailscale 経由で呼びます。Job API の待ち受けは Mac mini の tailnet 上の自分のアドレスに設定します。Funnel には公開しません。

## `tailscale nc` を使う理由

box の tailscaled は userspace-networking で動作し、SOCKS と HTTP のプロキシはありません。プロキシの追加には tailscaled の再起動が必要で、その間は他の受信も止まります。この実装は設定を変更せず、`tailscale nc <Mac mini のホスト名> <PORT>` の標準入出力で HTTP/1.1 を送受信します。

接続先が IPv6 リテラルの場合、`tailscale nc` には角括弧のないアドレスとポートを別々に渡します。HTTP の `Host` はアドレスを角括弧で囲み、ポートを付けます。

要求には `Connection: close`、バイト数の `Content-Length`、Bearer 認証を付けます。標準入力を EOF にせず、応答を読みます。`Content-Length` または chunked の末尾まで読めたら子プロセスを止めます。サーバー側の切断で子プロセスが終了した場合も、完全な応答なら成功です。子プロセスの stderr は破棄します。Transport、spawn、タイマーを注入できるため、テストでは実際の tailscale を起動しません。

## 1 回分の処理

`runWorkerOnce({client, claim, process})` は次の順番で動作します。

1. `claim` で 1 件を取得します。応答の `job.attempts` は今回を含む試行回数、`job.max_attempts` は試行上限です。ジョブが無ければ `outcome: "idle"` で終了します。
2. 処理関数 `process({job, claimToken, heartbeat})` にジョブ、claim token、`heartbeat(): Promise<boolean>` を渡します。長い処理は lease 内に heartbeat を呼びます。heartbeat() が true を返したら、処理関数で処理を止め、`{ok:false, code:"PROCESSING_ERROR"}` を返してください。`runWorkerOnce` が `fail` を送ります。CLI の場合は heartbeat 応答の `cancel_requested:true` を確認して処理を止め、同じコードで `fail` を呼んでください。
3. 成果物URLを検証してから、処理関数が成功として返す `{ok?:true, result, artifact_urls?, notify?}` を `complete` に送ります。`notify` が無ければ、文字列の `result.summary`（それ以外は「結果を保存しました。」）と成果物 URL から仕様 13.4 の完了文を作ります。
4. 処理関数が `{ok:false, code, message?, notify?}` を返した場合、または例外を投げた場合は `fail` に送ります。`code` は下表の固定コードから選べます。例外には `PROCESSING_ERROR` を使います。サーバーの `cancel_requested` が true なら `cancelled` に遷移し、`ジョブ <job_id> はキャンセルしました。` の文だけが通知されます。指定した `notify.body` は使いません。

`runWorkerOnce` 自体は処理関数を中断しません。heartbeat を呼ばずに `complete` を送った場合、キャンセル要求があっても `done` になります。完了結果と完了通知が保存されるため、取消を反映するには処理関数が heartbeat の戻り値に従って `fail` を選ぶ必要があります。

claim、heartbeat、complete、fail のいずれかが届かなければ `outcome: "unreachable"` で終了します。通信障害を理由に追加の fail は送りません。API のエラーは `outcome: "api_error"` です。claim 済みなら lease が切れた後に Reconciler が queued に戻し、Dispatcher を配線した後は、その起動で再実行できます。試行上限とキャンセル要求の扱いは通常の Reconciler と同じです。処理は at-least-once なので、外部への副作用はジョブ ID などで重複を防いでください。

## 利用者に伝える失敗原因

`fail` の `error.code` は次の日本語の原因文に対応します。`runWorkerOnce` の `process` からも、失敗結果の `code` で同じ原因を選べます。

| 固定コード | 日本語の原因文 |
|---|---|
| `TIMEOUT` | 処理が時間切れになりました |
| `SOURCE_UNAVAILABLE` | 参照先を利用できません |
| `INVALID_REQUEST` | 依頼の内容を確認してください |
| `INVALID_ARTIFACT` | 処理結果の成果物 URL が規則に合いませんでした |
| `PERMISSION_REQUIRED` | 処理に必要な権限がありません |
| `PROCESSING_ERROR` | 処理中にエラーが起きました |
| `LEASE_EXPIRED_MAX_ATTEMPTS` | 実行期限切れが再試行の上限に達しました |

CLI の `fail` は入力に試行回数を持たないため、既定文をサーバーに生成させます。API には `notify:{}` を送り、Job Store が保存済みの試行回数を使います。`--no-notify` では `notify` 自体を送らず、通知を作りません。

既定の失敗文は `INVALID_ARTIFACT` なら試行回数によらず `/retry` を案内せず、「同じ処理を再実行しても成果物 URL の規則違反は直らないため、処理側の修正が必要です。」と伝えます。Worker とサーバーの既定文（CLI の `fail` が送る `notify:{}`）で同じ規則を使います。それ以外は `attempts < max_attempts` のときだけ `/retry` を案内します。`INVALID_ARTIFACT` 以外で上限に達した場合は「再実行の上限（N 回）に達したため、/retry はできません。」と伝えます。Reconciler の `LEASE_EXPIRED_MAX_ATTEMPTS` も上限の文面になります。

API に未知の `error.code` を送ると「処理中にエラーが起きました」になります。`error.message` は通知に出さず、マスクして保存するだけです。`process` の失敗結果の `message` と例外の message も同じ扱いです。独自の利用者向け文面が必要なら `notify.body` を指定します。

```ts
process: async () => ({ok:false, code:'SOURCE_UNAVAILABLE'})
```

## 設定する

次の Worker 専用環境変数を box で設定します。Mac mini の `.env` をコピーする必要はありません。

| 変数 | 内容 | 既定 |
|---|---|---|
| `JOB_API_TAILNET_HOST` | Mac mini のホスト名または IP リテラル。必須 | なし |
| `JOB_API_PORT` | Job API のポート。1〜65535 | 3320 |
| `JOB_API_TOKEN_FILE` | Job API のトークンを入れた通常ファイル。権限は 600。必須 | なし |
| `TAILSCALE_BIN` | tailscale コマンドの名前またはパス | `tailscale` |
| `JOB_API_TIMEOUT_MS` | 1 要求の時間制限。1〜2^31−1 ミリ秒 | 15000 |

`JOB_API_TOKEN_FILE` の中身は Mac mini の `JOB_API_TOKEN` と合わせます。32 字以上にします。末尾の LF 改行 1 つだけは取り除いて許可し、それ以外の空白・改行・タブは拒否します。トークンを引数や出力に載せません。ホスト名、トークン、ファイルの実際のパスはリポジトリに保存しないでください。

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
node dist/worker-cli.js fail '{"job_id":"J-000123","claim_token":"<claim が返した値>","error":{"code":"PROCESSING_ERROR","message":"保存用の診断情報"}}'
node dist/worker-cli.js outbox '{"worker_id":"routine-worker"}'
```

改行や `'` を含む長い要約は、JSON 引数に `-` を指定して標準入力から渡せます。引用した heredoc の終端を使うと、Shell は本文を展開しません。JSON 内の改行は `\n` と書きます。次の claim token は説明用のダミー値なので、実行時は claim が返した値に置き換えてください。

```sh
node dist/worker-cli.js complete - <<'JSON'
{
  "job_id": "J-000123",
  "claim_token": "dummy-claim-token",
  "result": {
    "summary": "1 行目の要約です。\n2 行目には ' を含められます。\n長い要約もこの文字列に続けて渡せます。"
  }
}
JSON
```

標準入力は EOF まで読みます。上限は 1 MiB（1,048,576 バイト）です。超過すると終了コード 2、`reason:"STDIN_TOO_LARGE"` を返します。JSON を読めない場合は `BAD_JSON` です。どちらも入力本文や値は出力しません。

claim の結果には `claim_token` が含まれます。heartbeat、complete、fail に同じ値を渡します。API 認証トークンとは別の値です。outbox は `/outbox/claim` を呼び、Genie 用の行は取得しません。CLI の complete と fail は `notify` を省略すると `runWorkerOnce` と同じ既定文を付けます。独自の返信は `notify: {"body":"返信本文"}`、通知を付けない場合は末尾に `--no-notify` を指定します。`--no-notify` は明示的な `notify` より優先します。

出力は JSON 1 行です。成功時は `{ok:true,data:...}`、届かない場合は `{ok:false,unreachable:true,reason:...}`、API エラーは `{ok:false,unreachable:false,status,code,message?}` を返します。

| 終了コード | 意味 |
|---|---|
| 0 | 成功 |
| 3 | 届かない。`nc_not_found`、`connect_failed`、`timeout` |
| 4 | API のエラー、読めない API 応答、クライアントの実行エラー |
| 2 | コマンド、JSON、設定、トークンファイルの使い方が不正 |

`timeout` は子プロセスを停止します。応答が無いまま終了した場合と、不完全または読めない HTTP の応答は `connect_failed` とします。受信データは 16 MiB までです。送信成功後に応答を失う場合もあるため、通信障害を処理失敗として扱わず、lease と冪等性で回復します。

使い方の誤りは `error:"USAGE_ERROR"` と `reason` を返します。

| 理由コード | 内容 |
|---|---|
| `BAD_JSON` | JSON を読めない |
| `STDIN_TOO_LARGE` | 標準入力が 1 MiB を超えた |
| `UNKNOWN_COMMAND` | コマンドが存在しない |
| `INVALID_ARGUMENTS` | 引数が不正。入力の検証失敗は zod の失敗した項目名だけを `fields` に入れる |
| `MISSING_CONFIG` | 必須の設定が不足。欠けた環境変数名だけを `missing` に入れる |
| `INVALID_CONFIG` | 設定が不正。環境変数名だけを `fields` に入れる |
| `TOKEN_FILE_MISSING` | トークンファイルが無い |
| `TOKEN_FILE_UNREADABLE` | トークンファイルを読めない |
| `TOKEN_FILE_MODE` | 通常ファイルでない、または権限が 0600 でない |
| `TOKEN_TOO_SHORT` | トークンが 32 字未満 |
| `TOKEN_HAS_WHITESPACE` | 許可する末尾 LF 1 つを除き、空白・改行・タブがある |

API の 4xx は code と message を保持します。設定値、トークン、トークンファイルのパスや内容は出力しません。

通知キーは `job:<job_id>:<kind>:<attempt>` です。同じ試行の再送は冪等で、retry 後の通知は別の行になります。Genie 経由のジョブが lease 切れで failed / cancelled になる場合も Reconciler が同じトランザクションで通知を作ります。

## 長い通知を送る

既定の完了文は、先頭の定型文を残し、全体を 1500 コードポイント以内に収めます。要約には最低 200 コードポイントを確保します。要約が短ければ全文を残します。成果物 URL は入る分だけ元の順序で並べます。1 本で入らない URL も省略対象です。省略した分は「ほか N 件の成果物 URL は /status J-… で確認できます。」の 1 行で案内します。通知を短くしても `complete` は送り、結果と成果物 URL の全件を API に保存します。通知の長さを理由に処理を再実行しません。

独自の `notify.body` は `runWorkerOnce` と CLI で同じ関数を通します。返信用の記号を除去して 1500 コードポイント以内に切り、切った場合は戻り値または出力 JSON に `notify_truncated:true` を付けます。🧞‍♂️ や 🪔 だけで空になった本文は既定文に置き換え、`notify_replaced:true` を付けます。指定した本文がそのまま使われた場合、これらのフラグは付きません。


成果物 `artifact_urls` は20件以内、1本1200コードポイント以内、空白・制御文字なしのHTTPS URLにしてください。APIのcomplete、CLI、runWorkerOnceは同じ規則を使います。CLIは不正入力を終了コード2で拒否します。APIは400で拒否します。runWorkerOnceはprocessの結果をcomplete前に検証し、不正ならcompleteを送らず、`fail` の `INVALID_ARTIFACT` にします。規則に違反した理由だけをerror.messageに保存し、URL本文は保存しません。結果も保存せず失敗として知らせます。fail成功後はleaseが切れても再キューされません。URLを黙って捨ててdoneにすることを避けるため、この方式を使います。

成功したrunWorkerOnceとCLI completeは、通知本文に完全なURL行として載らなかった件数を `artifact_urls_omitted:N` で返します。0件なら省略します。独自notifyにも適用します。`--no-notify` は全URLが未掲載となります。`notify_truncated` と `notify_replaced` も成功時だけ返し、APIエラーや通信障害ではこれらのフラグと省略件数を返しません。

チャットの利用者は元のトークで `/status <job_id> [ページ]` を送り、保存済みの成果物URLを確認できます。ページ省略は1です。doneの状態行の直後にURLを並べ、見出しと案内を含め1500コードポイント以内に分割します。URLは途中で切りません。続きは `/status J-000123 2` のように案内します。不正な番号はページ番号の説明、ページ外は有効範囲を返します。別の許可トークでは、存在しないIDと同じ「ジョブが見つかりません。」を返し、ジョブの存在と状態を漏らしません。ページ番号が不正な場合も同じです。

変更前に保存された長大URLが単独でも表示上限を超える場合は、短いURLでの再登録が必要な旨を返します。既存URLの自動変換はしません。

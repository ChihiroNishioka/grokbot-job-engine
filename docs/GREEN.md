
# GREEN when

## 前提
- HTTP の振る舞いは `app.request()` で確かめる。内部の関数（設定、Reconciler、mask、Dispatcher、DB の開き直し）は直接呼ぶ。ポートは待ち受けない。
- DB は `:memory:` か `fs.mkdtempSync(path.join(os.tmpdir(), …))` のファイルを使う。
- 時刻は `FakeClock`（`now()` と `advance(ms)`）で進める。`sleep`、実時計、マシン専用のパスは使わない。
- トークンはテスト用のダミー値だけを使う。
- 共通の道具は `test/helpers/context.ts` に置く。
- better-sqlite3 は同期的に動くので、JS の上では呼び出しが一直線に並ぶ。同時 claim のテストは、**同じファイル DB に 2 本の接続を開き、両方から claim する**形で、CAS の変更行数による判定を確かめる。

## 設定と起動

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G01 | JOB_API_TOKEN が未設定か 32 字未満なら `loadConfig` が例外を投げる。例外のメッセージに値が入らない | — | `test/config.test.ts` |
| G02 | ALLOWED_SOURCE_CHAT_IDS が未設定か空なら例外を投げる。HOST の既定は `127.0.0.1`。数値の設定が範囲外なら例外を投げる | — | `test/config.test.ts` |
| G03 | `.env.example` に 9 章のキーがすべてあり、値はダミーである。リポジトリ（src、test、docs、.env.example）に `ts.net`、`100.x.x.x` 形式の IP、マシン固有の絶対パスがない | — | `test/hygiene.test.ts` |

## 認証とレート制限

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G04 | 保護されたすべてのルート（表で回す）に Authorization なしで送ると 401 UNAUTHORIZED になる | — | `test/api/auth.test.ts` |
| G05 | トークンが違う、長さが違う、`Basic` 方式、`Bearer` だけ、のどれも 401 になる。応答とログに送ったトークンが出ない | — | `test/api/auth.test.ts` |
| G06 | `/healthz` は認証なしで 200 `{ok:true}` を返し、ほかの情報を返さない | — | `test/api/auth.test.ts` |
| G07 | 上限 +1 回目が 429 RATE_LIMITED になり、`Retry-After` が 1 以上の整数。認証に失敗した要求も数に入る。clock を 60 秒進めると 200 に戻る。キーが別なら別々に数える | — | `test/api/rateLimit.test.ts` |

## create（冪等と許可）

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G08 | 正しい入力で 201 になり、`status=queued`、`attempts=0`、max_attempts が既定値、job_id が `^J-\d{6,}$`、`created:true` で、event `job.created` が 1 行ある | 3（モック） | `test/api/jobs.create.test.ts` |
| G09 | 同じ source と source_message_id で 2 回目（本文が違っても）は 200、`created:false`、同じ job_id になる。jobs と `job.created` はどちらも 1 行のまま。`Promise.all` で 5 回同時に送っても同じ。別の接続（同じファイル DB）から登録しても同じ | **8** | `test/api/jobs.create.test.ts` |
| G10 | 同じメッセージ ID で source_chat_id か requester_id が違うと 409 IDEMPOTENCY_CONFLICT になる | 8 | `test/api/jobs.create.test.ts` |
| G11 | 許可されていない source_chat_id は 403 CHAT_NOT_ALLOWED になり、行も event も増えない | 13（一部） | `test/api/jobs.create.test.ts` |
| G12 | 必須項目がない、request_text と payload_ref の両方がない、job_type の形が違う、priority が ±11、source が未知、scheduled_at にタイムゾーンがない、max_attempts が 0 か 11、parent_job_id が存在しない、知らないキーがある。どれも 400 VALIDATION_ERROR | — | `test/api/jobs.validation.test.ts` |
| G13 | request_text がちょうど上限の文字数（絵文字を含めてコードポイントで数える）なら 201、上限 +1 なら 400 | — | `test/api/jobs.validation.test.ts` |
| G14 | BODY_MAX_BYTES を超える本文は 413 PAYLOAD_TOO_LARGE になる。壊れた JSON は 400 INVALID_JSON になる | — | `test/api/jobs.validation.test.ts` |

## get / list / events

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G15 | get で 200 になり、claim の後でも `claim_token` を含まない。存在しない `J-999999` は 404 JOB_NOT_FOUND、`abc` も 404 | 5（モック） | `test/api/jobs.read.test.ts` |
| G16 | list を status、source_chat_id、job_type で絞れる。新しい順で、既定の件数は 20。limit=100 は 200、101 と 0 は 400。項目に request_text と result がない | — | `test/api/jobs.read.test.ts` |
| G17 | events は古い順で、limit=101 は 400。どの event の detail にも request_text の中身がない | — | `test/api/jobs.read.test.ts` |

## claim と heartbeat

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G18 | 次の 1 件の claim は、priority が高いもの、次に古いものを選ぶ。scheduled_at が未来のものは選ばない。`job_types` で絞れる。attempts が +1 になり、lease_expires_at が now+lease、job_runs に 1 行増え（running）、event が残る。対象がなければ 200 `{job:null}` | — | `test/api/jobs.claim.test.ts` |
| G19 | 指定 claim: queued なら 200。claimed、done、scheduled_at が未来のものは 409 JOB_NOT_CLAIMABLE。存在しなければ 404 | — | `test/api/jobs.claim.test.ts` |
| G20 | 同じジョブを 2 本の接続から claim すると、成功は 1 つだけで、もう 1 つは 409。`Promise.all` で 10 個の worker が claim しても成功は 1 つ。job_runs は 1 行。ジョブが 1 件だけのときに次の 1 件を 3 個の worker が取りに行くと、job を受け取るのは 1 つだけ | **9** | `test/store/claim.concurrency.test.ts` |
| G21 | lease_seconds が 9 や LEASE_SECONDS_MAX+1 なら 400。worker_id の形が違えば 400 | — | `test/api/jobs.claim.test.ts` |
| G22 | heartbeat が成功すると lease が now+lease に延び、`cancel_requested:false` を返す | — | `test/api/jobs.heartbeat.test.ts` |
| G23 | heartbeat の token が違えば 409 CLAIM_TOKEN_MISMATCH。clock を lease ちょうどまで進めると 409 LEASE_EXPIRED。queued のジョブには 409 INVALID_TRANSITION。どの場合も lease は変わらない | 11 | `test/api/jobs.heartbeat.test.ts` |

## complete と fail

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G24 | complete で done になり、result と artifact_urls が保存され、run が done（ended_at あり）、event が残る。同じ token でもう一度 complete すると 200 で、event は増えない | 5（モック） | `test/api/jobs.complete.test.ts` |
| G25 | complete の token が違えば 409 CLAIM_TOKEN_MISMATCH、lease が切れていれば 409 LEASE_EXPIRED（どちらも claimed のまま）。queued、failed、別の token の done なら 409 INVALID_TRANSITION。result が上限を超える、artifact_urls が http や 21 件なら 400 | — | `test/api/jobs.complete.test.ts` |
| G26 | 古い worker の締め出し: A の lease が切れ、reconcile で queued に戻り、B が claim する。その後の A の complete と heartbeat は 409 になり、B の complete は成功する。job_runs は 2 行（lease_expired と done） | 9, 11 | `test/scenario/stale-worker.test.ts` |
| G27 | fail で failed になり、error が保存され、run が failed になる。error.message に入ったメールアドレス、電話番号、トークンらしい文字列はマスクされて保存される。token 違いと lease 切れは G25 と同じ | — | `test/api/jobs.fail.test.ts` |

## cancel と retry

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G28 | queued を cancel するとすぐ cancelled になり、event が残る。その後の claim は 409 JOB_NOT_CLAIMABLE で、次の 1 件の claim にも出てこない | **15** | `test/api/jobs.cancel.test.ts` |
| G29 | claimed を cancel しても claimed のままで、`cancel_requested=true` になる。heartbeat が `cancel_requested:true` を返す。その後 fail すると cancelled、別のケースでは complete すると done になり result が残る | **15** | `test/api/jobs.cancel.test.ts` |
| G30 | done か failed を cancel すると 409 INVALID_TRANSITION。cancelled をもう一度 cancel すると 200 で、event は増えない。存在しないジョブは 404 | 15 | `test/api/jobs.cancel.test.ts` |
| G31 | failed を retry すると queued になり、claim 系の列が NULL、cancel_requested=0 になる。attempts はそのまま。もう一度 claim すると attempts=2 になり、job_runs に 2 行目が増える | **15** | `test/api/jobs.retry.test.ts` |
| G32 | attempts = max_attempts の failed を retry すると 409 MAX_ATTEMPTS_REACHED。queued、claimed、done、cancelled を retry すると 409 INVALID_TRANSITION | 15 | `test/api/jobs.retry.test.ts` |

## Reconciler

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G33 | lease が切れた claimed（attempts < max）は queued に戻り、claim 系の列が NULL になり、run が lease_expired、event の reason が `lease_expired` になる。lease の 1ms 前に呼んだときは変わらない | **11** | `test/reconciler/jobs.test.ts` |
| G34 | attempts ≥ max なら failed になり、error.code が `LEASE_EXPIRED_MAX_ATTEMPTS`。cancel_requested=1 なら cancelled | **11** | `test/reconciler/jobs.test.ts` |
| G35 | reconcile を続けて 2 回呼ぶと、2 回目の報告で変更が 0 件になる。reconcile の直前に heartbeat が成功していれば、そのジョブは触らない | 11 | `test/reconciler/jobs.test.ts` |
| G36 | lease が切れた sending の outbox は pending に戻り（token は NULL）、attempts が上限なら failed になる。古い pending の outbox が staleOutbox に、古い queued が staleQueued に出る。新しいものは出ない。報告に本文が入らない | 11, 12 | `test/reconciler/outbox.test.ts` |

## 再起動

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G37 | tmp のファイル DB で、create（queued）、create して claim（claimed）、done とその outbox（pending）を作る。DB を close して開き直し、新しい app を作ると、全件が同じ状態で残り、元の claim_token で complete できる。マイグレーションを 2 回流しても壊れない（user_version が変わらない） | **10** | `test/scenario/restart.test.ts` |

## outbox

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G38 | enqueue で 201、pending になり、target_chat_id と in_reply_to がジョブから写される。同じ idempotency_key でもう一度送ると 200、`created:false` で 1 行のまま。存在しない job_id は 404。body が 1501 字、kind が不正、`target_chat_id` を入力に含めると 400 | 8, 12 | `test/api/outbox.test.ts` |
| G39 | outbox の claim で sending と token が返る。2 本の接続で同時に claim しても成功は 1 つ。対象がなければ `{outbox:null}`。sent の行を指定して claim すると 409 OUTBOX_NOT_CLAIMABLE | — | `test/api/outbox.test.ts` |
| G40 | markSent で sent になり、sent_at が入る。同じ token でもう一度送ると 200 で、event は増えない。token が違えば 409 CLAIM_TOKEN_MISMATCH。lease が切れた後の markSent も受け付ける | — | `test/api/outbox.test.ts` |
| G41 | markFailed は、`retryable=true` かつ attempts < 上限なら pending、それ以外は failed になる。**どちらの場合もジョブの status=done、result、updated_at が変わらない** | **12** | `test/scenario/delivery-failure.test.ts` |

## エラー形式と監査

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G42 | 400、401、403、404、409、413、429 の本文がすべて `{error:{code,message}}` の形で、ほかのキーがない。未知のルートは 404 NOT_FOUND。store が例外を投げるように差し替えると 500 INTERNAL になり、スタックや入力値が出ない | — | `test/api/errors.test.ts` |
| G43 | 一連の流れ（create → claim → complete → outbox enqueue → claim → sent）の job_events が順番どおりにそろい、from_status と to_status が正しい。不正な遷移（409）では event が増えない | 3, 5（モック） | `test/scenario/happy-path.test.ts` |

## マスキング

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G44 | `mask()` が `Bearer abc…`、32 字以上のトークン、`user@example.com`、`+81 90-1234-5678`、`09012345678` を伏せる。`J-000123` と `2026-11-11T00:00:00.000Z` はそのまま残る | — | `test/logging/mask.test.ts` | <!-- secret-scan:allow -->
| G45 | 注入した出力先に集めたログの全行に、create の request_text（目印になる文字列を入れておく）、Authorization の値、claim_token、outbox の body が出ない | — | `test/logging/request-log.test.ts` |

## Dispatcher

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G46 | wake の本文のキーがちょうど `{v, event, event_id}` で、event_id は UUID、wake ごとに違う。JSON の文字列に job_id、request_text、source_chat_id、source_message_id が入っていない | — | `test/dispatcher/payload.test.ts` |
| G47 | webhook 実装（偽の fetch）は POST、Bearer、JSON で送る。200 なら `accepted:true`。500、429、fetch の例外なら `accepted:false` で、例外を投げない。どの場合もジョブの状態は変わらない（200 は完了ではない）。ログにトークンと URL のクエリが出ない | — | `test/dispatcher/webhook.test.ts` |
| G48 | dispatchTick は、claim できる queued があるときに wake を 1 回呼ぶ。対象がなければ 0 回（scheduled_at が未来のものだけのときも 0 回）。cooldown の間は呼ばず、clock を進めると再び呼ぶ | — | `test/dispatcher/tick.test.ts` |

## 品質

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G49 | `npm run lint`、`npm run typecheck`、`npm test` がすべて通る。test/ に `.listen(`、`serve(`、`setTimeout` による待ち合わせがない | — | `test/hygiene.test.ts` と CI 相当の手順 |

## 補足（仕様 12 章に対応）

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G50 | worker_threads（同じ一時ファイル DB、Atomics で開始をそろえる）4 本が同じジョブを claim すると成功は 1 本、job_runs は 1 行。同じ source_message_id の create を 4 本で同時に送ると jobs は 1 行。outbox の claim を 4 本で同時に送ると sending は 1 本 | **8, 9** | `test/store/concurrency.threads.test.ts` |
| G51 | job_events への INSERT を失敗させるトリガーを置くと、claim / complete がエラーになり、jobs と job_runs も変わらない（巻き戻る） | 9 | `test/store/atomicity.test.ts` |
| G52 | heartbeat / complete / fail を lease の 1ms 前は成功、ちょうどと 1ms 後は 409 LEASE_EXPIRED。fail の再送と claimed への cancel の再送は 200 で、event と job_runs が増えない | 11, 15 | `test/api/jobs.lease-boundary.test.ts` |
| G53 | reconcile の 4 通り（cancel_requested 0/1 × attempts 上限未満/到達）がそれぞれ queued / failed / cancelled / cancelled になり、どれも run が lease_expired で ended_at が入る。max_attempts に達した queued は次の 1 件の claim に出ない | **11** | `test/reconciler/jobs.test.ts` |
| G54 | outbox で A の lease が切れ、reconcile で pending に戻り、B が claim した後、A の sent / failed は 409 CLAIM_TOKEN_MISMATCH、B の sent は成功する。lease 切れでも reconcile 前なら A の sent は成功する | 12 | `test/scenario/stale-sender.test.ts` |
| G55 | 同じ idempotency_key で job_id・kind・body のどれかが違う enqueue は 409 IDEMPOTENCY_CONFLICT | 8 | `test/api/outbox.test.ts` |
| G56 | complete / fail に `notify:{body}` を付けると、同じトランザクションで outbox が 1 行でき（キー `job:<id>:done:<attempt>` / `job:<id>:failed:<attempt>`）、再送しても増えない。notify なしで done になり outboxStaleMs を過ぎたジョブは `terminalWithoutOutbox` に出る | 12 | `test/scenario/delivery-failure.test.ts` |
| G57 | outbox の enqueue / claim / sent / failed / reconcile の前後で、ジョブの行の全列が同じ | **12** | `test/scenario/delivery-failure.test.ts` |
| G58 | ログに出る path はルートのパターンで、未知のパス `/x/secret-like-value` は `unmatched` と出る。入れ子のオブジェクトの機密キーも `[REDACTED]`。event の reason、保存された error.message と last_error、500 の例外ログに、ダミーのトークン・メール・電話番号・`*.ts.net`・`100.64.x.x` が残らない | — | `test/logging/request-log.test.ts` |
| G59 | reconcile の対象が limit+1 件あると、1 回目は limit 件、2 回目は 1 件、3 回目は 0 件 | 11 | `test/reconciler/jobs.test.ts` |
| G60 | 設定の各整数が範囲外なら例外（値はメッセージに出ない）。LEASE_SECONDS_DEFAULT > LEASE_SECONDS_MAX も例外。scheduled_at は `Z`、`+09:00`、`-05:00` を受け付けて UTC に直し、オフセットなしは 400 | — | `test/config.test.ts`, `test/api/jobs.validation.test.ts` |

## 方針変更（SPEC 13 章：Genie と Worker の経路）

| ID | 条件 | 15 章 | 置き場所の案 |
|---|---|---|---|
| G61 | `GENIE_HOST` が loopback 以外、`HOST` が IP リテラルでないか、正規化後の未指定アドレス（IPv4-mapped を含む）、`GENIE_TOKEN` が 32 字未満、`GENIE_TOKEN` と `JOB_API_TOKEN` が同じ、`GENIE_ALLOWED_CHAT_IDS` が空か整数でない、のどれも loadConfig が例外（値はメッセージに出ない） | — | `test/config.test.ts` |
| G62 | Ingress アプリに `/jobs` は 404、Job API アプリに `/ingress/genie` と `/genie/replies` は 404。Ingress は JOB_API_TOKEN では 401、Job API は GENIE_TOKEN では 401 | — | `test/ingress/apps.test.ts` |
| G63 | 正しい Genie の payload（先頭 🪔）で 201 `{status:"created", job_id}`、ジョブが queued、request_text から 🪔 が除かれ、ack の outbox が 1 行（channel genie、キー `job:<id>:ack`、文面は 13.4 の受付）、ingress_messages に received_at が残る | 1, 2, 3（モック） | `test/ingress/genie.test.ts` |
| G64 | 同じ guid を 3 回送る（Promise.all を含む）と、ジョブ・ack・ingress_messages はどれも 1 行で、2 回目以降は同じ job_id を返す | **8** | `test/ingress/genie.test.ts` |
| G65 | 許可外の chat_id は 403 で行が増えない。sender_is_me=false は ignored で行が増えない（ingress_messages の ignored は可） | 13 | `test/ingress/genie.test.ts` |
| G66 | 本文が `🧞‍♂️ 完了しました`、`🪔 🧞‍♂️ …`、`🧞 …`、先頭に空白のある `  🧞‍♂️…` は ignored（bot_reply）でジョブも outbox も作らない。空や 🪔 だけは ignored（empty） | **14** | `test/ingress/loop.test.ts` |
| G67 | `/status`、`/cancel`、`/retry`、`/help` がそれぞれ 13.3 どおりに動き、command の outbox（キー `cmd:<guid>`）が 1 行できる。同じ guid の再送で再実行されない。別の chat のジョブと存在しないジョブは同じ「見つかりません」 | 7, **15** | `test/ingress/commands.test.ts` |
| G68 | `GET /genie/replies`（cursor なし）が pending の genie 行を昇順で、13.5 の形（id `je-<n>`、chat_id 数値、in_reply_to_guid、created_at）で返し、cursor が最後の `o:<n>`。同じ cursor で取り直すと同じ内容。page の上限を超える分は次のページ | 2, 6（モック） | `test/ingress/replies.test.ts` |
| G69 | `cursor=o:N` で取ると N 以下の pending の genie 行が sent（external_ref `genie:cursor`、event あり）になり、返事に出ない。ジョブの行は全列そのまま。形の違う cursor は 400。genie 以外の channel の行は出ない。`/outbox/claim` は genie の行を取らない | **12** | `test/ingress/replies.test.ts` |
| G70 | 受付 → claim → complete（notify）→ 返事の取得で、同じ guid に ack と done の 2 件が別の id で出る | 6（モック） | `test/scenario/genie-flow.test.ts` |
| G71 | Transport（偽の spawn）: 引数が `[tailscale, 'nc', host, port]`、送る内容が HTTP/1.1 で Authorization と Content-Length が付き、Content-Length と chunked の応答を読める | — | `test/worker/tailscale-nc.test.ts` |
| G72 | ENOENT は `nc_not_found`、応答なしで終了は `connect_failed`、時間切れ（偽の時計かタイマー注入）は `timeout` で子プロセスを止める。どれも例外を投げず `unreachable:true` | — | `test/worker/tailscale-nc.test.ts` |
| G73 | `runWorkerOnce` は、claim・complete・fail のどれかで届かないと `outcome:"unreachable"` で終わり、fail を呼ばない。その後 lease 切れ → reconcile で queued → 次の回に claim して done になる（Transport は app.request() に流すモック） | **11** | `test/worker/run-once.test.ts` |
| G74 | worker-cli は届かないとき終了コード 3、API エラーは 4、使い方の誤りは 2。出力にトークンが出ない（トークンは一時ファイルから読む） | — | `test/worker/cli.test.ts` |

## レビュー修正の受け入れ条件

| ID | 条件 | テスト |
|---|---|---|
| G75 | EOFで終了する偽ncでも応答を読み切り、長さ/chunked終端でkillする。close時も完全な応答は成功。不完全応答は失敗 | test/worker/tailscale-nc.test.ts |
| G76 | retry後の同種通知は異なる試行キーになり、同じ試行の再送は増えない。terminalWithoutOutboxは最後の試行で判定する | test/fix1-store.test.ts |
| G77 | 完了文のURLと固定文を保持し、結果だけを切って1500コードポイント以内。固定文とURLだけで上限超過の場合は明示エラー、独自notifyなら完了できる。失敗原因はコード別の固定文、生messageはマスク保存だけ | test/worker/review-fixes.test.ts |
| G78 | fail取消時はcancelled通知のみ。lease切れのGenie由来failed/cancelledは同じトランザクションで試行別通知を作り再送は冪等 | test/fix1-store.test.ts |
| G79 | 既知の管理コマンドだけを判定し前後空白を許す。未知のスラッシュ依頼はジョブ。help/見つからない/cancel/retryは13.7の文面 | test/fix1-store.test.ts |
| G80 | 長すぎる依頼は200 rejected/too_long、cmd:guidの説明返信が1件だけ | test/fix1-store.test.ts |
| G81 | CLIの理由コードと4xxのcode/messageを保持し秘密を出さない。notify省略は既定文、--no-notifyで抑止 | test/worker/cli.test.ts |
| G82 | processにjob/claimToken/heartbeatを渡しcancel_requestedを取得。heartbeat通信失敗で終端書込みをしない。非文字列summaryは固定文 | test/worker/review-fixes.test.ts |
| G83 | README/worker/genieはDispatcher未配線と実配送の実機未確認を明記する | test/worker/review-fixes.test.ts |

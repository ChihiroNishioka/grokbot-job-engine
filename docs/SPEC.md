# 仕様

## 1. 目的
- iMessage から頼まれた仕事を「ジョブ」として受け付け、状態を持ち、Worker に渡し、結果と通知予定を記録する。その土台になる **Job Engine のコア**を作る。
- 正しい状態は Job Store（SQLite）だけが持つ。Worker を起こす合図（Dispatcher）は「起きて」と知らせるだけで、状態の管理には使わない。
- 実行は at-least-once（少なくとも 1 回）が前提。二重に実行されても、CAS・claim_token・冪等キーで状態と通知が重複しないようにする。

## 2. 範囲

| 区分 | 内容 |
|---|---|
| 作る | Job Store（jobs / job_runs / job_events / delivery_outbox）、Job API（Hono）、Reconciler（関数と最小限の定期実行）、Dispatcher（インターフェース、モック、fetch を注入する webhook 実装はテスト用）、認証、レート制限、入力検証、ログのマスキング、設定の読み込み、.env.example、自動テスト |
| 作らない | iMessage の受信と送信、Mac mini への導入、launchd、Tailscale の設定、Scheduler（scheduled_at を保存し、claim のときに絞り込むだけ）、MCP、管理コマンド（/status /cancel /retry /help）の解釈、Worker 本体（Routine）、実際の webhook URL への送信、DB バックアップ |

## 3. 構成

- 実行環境と道具: Node 24、TypeScript（ESM、`strict`、`noUncheckedIndexedAccess`）、Hono（`@hono/node-server`）、better-sqlite3、zod、vitest、ESLint（typescript-eslint）。
- `.env` は Node の `--env-file` で読む。dotenv は使わない。
- npm scripts: `build`、`start`（`node --env-file=.env dist/main.js`）、`lint`、`typecheck`（`tsc --noEmit`）、`test`（`vitest run`）。

```
src/
  main.ts                 起動: loadConfig → openDb → createApp → serve(HOST, PORT) → Reconciler を setInterval で回す
  config/index.ts         loadConfig(env): zod で検証する。不正なら例外（値はメッセージに出さない）
  lib/clock.ts            Clock { now(): number }（UTC のミリ秒）、systemClock
  lib/ids.ts              randomToken()（32 バイトを base64url にする）、randomUUID の包み。どちらも注入できる
  db/open.ts              openDb(path | ':memory:')。PRAGMA を設定し、マイグレーションを流す
  db/migrations.ts        PRAGMA user_version で版を管理する。何度流しても同じ結果になる
  store/jobs.ts           ジョブの CAS 遷移（create/get/list/claim/heartbeat/complete/fail/cancel/retry）
  store/outbox.ts         enqueue/claim/markSent/markFailed
  store/events.ts         job_events への書き込みと読み出し
  store/errors.ts         StoreError(code)。API でエラーコードに対応させる
  api/app.ts              createApp(deps: {db, clock, config, logger, rateLimitKey?})
  api/routes/jobs.ts, api/routes/outbox.ts
  api/schemas.ts          zod スキーマ（すべて .strict()）
  api/middleware/{auth,rateLimit,errors,requestLog}.ts
  reconciler/index.ts     reconcile(deps, opts): ReconcileReport
  dispatcher/{types,mock,webhook,tick}.ts
  logging/{mask,logger}.ts
test/
  helpers/context.ts      FakeClock、:memory: の DB、テスト用 app、req() の小さな関数
  …（GREEN.md の置き場所案に合わせる）
```

- DB の PRAGMA: `journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000`。
- 時刻はすべて UTC のエポックミリ秒（INTEGER）で保存する。API では ISO 8601（`Z` 付き）で返す。
- 1 回の遷移（本体の UPDATE、job_runs、job_events）は 1 つの `db.transaction()` にまとめる。

## 4. DB スキーマ

```sql
CREATE TABLE id_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO id_counters (name, value) VALUES ('job', 0);
-- job_id = 'J-' || 6 桁以上のゼロ埋め。create のトランザクションの中で
-- UPDATE id_counters SET value = value + 1 WHERE name='job' RETURNING value

CREATE TABLE jobs (
  job_id            TEXT PRIMARY KEY CHECK (job_id GLOB 'J-[0-9][0-9][0-9][0-9][0-9][0-9]*' AND substr(job_id, 3) NOT GLOB '*[^0-9]*'),
  source            TEXT NOT NULL,                 -- Phase 1 は 'imessage' だけ
  source_message_id TEXT NOT NULL,
  source_chat_id    TEXT NOT NULL,
  requester_id      TEXT NOT NULL,
  job_type          TEXT NOT NULL,
  request_text      TEXT,
  payload_ref       TEXT,
  status            TEXT NOT NULL CHECK (status IN ('queued','claimed','done','failed','cancelled')),
  priority          INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -10 AND 10),
  scheduled_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  claimed_at        INTEGER,
  claimed_by        TEXT,
  claim_token       TEXT,
  lease_expires_at  INTEGER,
  heartbeat_at      INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  cancel_requested  INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  result            TEXT,                          -- JSON オブジェクト
  artifact_urls     TEXT NOT NULL DEFAULT '[]',    -- JSON 配列
  error             TEXT,                          -- JSON {code,message}
  correlation_id    TEXT,
  parent_job_id     TEXT REFERENCES jobs(job_id),
  UNIQUE (source, source_message_id),
  CHECK (request_text IS NOT NULL OR payload_ref IS NOT NULL),
  CHECK (status <> 'claimed' OR (claim_token IS NOT NULL AND claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE TABLE job_runs (
  run_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES jobs(job_id),
  attempt     INTEGER NOT NULL,
  worker_id   TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  outcome     TEXT NOT NULL DEFAULT 'running'
              CHECK (outcome IN ('running','done','failed','cancelled','lease_expired')),
  error_code  TEXT,
  UNIQUE (job_id, attempt)
);

CREATE TABLE delivery_outbox (
  outbox_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           TEXT NOT NULL REFERENCES jobs(job_id),
  idempotency_key  TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('ack','progress','done','failed','cancelled')),
  channel          TEXT NOT NULL DEFAULT 'imessage' CHECK (channel IN ('imessage')),
  target_chat_id   TEXT NOT NULL,                  -- jobs.source_chat_id を写す（入力では受け取らない）
  in_reply_to      TEXT,                           -- jobs.source_message_id を写す
  body             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  claimed_by       TEXT,
  claim_token      TEXT,
  lease_expires_at INTEGER,
  last_error       TEXT,                           -- JSON {code,message}
  external_ref     TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  sent_at          INTEGER,
  CHECK (status <> 'sending' OR (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

CREATE TABLE job_events (
  event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES jobs(job_id),
  outbox_id   INTEGER REFERENCES delivery_outbox(outbox_id),
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,     -- 'api' | 'worker:<worker_id>' | 'reconciler'
  type        TEXT NOT NULL,     -- 'job.created' 'job.claimed' 'job.done' 'job.failed' 'job.cancelled'
                                 -- 'job.cancel_requested' 'job.requeued' 'job.retried'
                                 -- 'outbox.enqueued' 'outbox.claimed' 'outbox.sent' 'outbox.failed' 'outbox.requeued'
  from_status TEXT,
  to_status   TEXT,
  reason      TEXT,
  detail      TEXT               -- JSON。request_text、outbox の body、トークンは入れない
);

CREATE INDEX jobs_claim_idx    ON jobs(status, priority DESC, created_at, job_id);
CREATE INDEX jobs_lease_idx    ON jobs(status, lease_expires_at);
CREATE INDEX jobs_chat_idx     ON jobs(source_chat_id, created_at DESC);
CREATE INDEX job_runs_job_idx  ON job_runs(job_id);
CREATE INDEX job_events_job_idx ON job_events(job_id, event_id);
CREATE INDEX outbox_status_idx ON delivery_outbox(status, created_at);
CREATE INDEX outbox_lease_idx  ON delivery_outbox(status, lease_expires_at);
```

### CAS の書き方
- 遷移は必ず `UPDATE … WHERE <期待する状態>` で書き、`changes` が 1 なら成功、0 なら失敗とする。
- `changes = 0` のときだけ、エラーの種類を決めるために SELECT する（判定には使わない）。
- 「次の 1 件」の claim は 1 文で書く。

  ```sql
  UPDATE jobs SET status='claimed', ... WHERE job_id = (SELECT job_id FROM jobs WHERE status='queued' AND cancel_requested=0 AND (scheduled_at IS NULL OR scheduled_at <= :now) ORDER BY priority DESC, created_at, job_id LIMIT 1) AND status='queued' RETURNING *
  ```

- claim_token は最後の claim のものを done、failed、cancelled のあとも残す（同じ呼び出しを繰り返したときの判定に使う）。queued に戻すときに消す。

## 5. 状態遷移

### jobs

| 元 | 操作 | 条件（CAS） | 先 | 副作用 |
|---|---|---|---|---|
| — | create | (source, source_message_id) が未登録、chat が許可済み | queued | event `job.created` |
| queued | claim | `cancel_requested=0`、`attempts < max_attempts`、`scheduled_at` が NULL か now 以下 | claimed | attempts+1、claim_token・claimed_by・claimed_at・lease を設定、job_runs を 1 行足す |
| queued | cancel | なし | cancelled | なし |
| claimed | heartbeat | token が一致し、`lease_expires_at > now` | claimed | lease を延ばし、heartbeat_at を更新する（event は書かない） |
| claimed | complete | token が一致し、lease 内 | done | result・artifact_urls を保存し、run を done にする |
| claimed | fail | token が一致し、lease 内、`cancel_requested=0` | failed | error を保存し（message はマスクする）、run を failed にする |
| claimed | fail | token が一致し、lease 内、`cancel_requested=1` | cancelled | run を cancelled にする |
| claimed | cancel | なし | claimed | `cancel_requested=1`、event `job.cancel_requested` |
| claimed | reconcile | `lease <= now`、`cancel_requested=1` | cancelled | run を lease_expired にする |
| claimed | reconcile | `lease <= now`、`cancel_requested=0`、attempts < max | queued | claim 系の列を消し、run を lease_expired にする |
| claimed | reconcile | `lease <= now`、`cancel_requested=0`、attempts ≥ max | failed | error `{code:'LEASE_EXPIRED_MAX_ATTEMPTS'}` |
| failed | retry | attempts < max_attempts | queued | claim 系の列を消し、`cancel_requested=0` にする。attempts は戻さない |
| done（同じ token） | complete | なし | done | 200 を返し、何も変えない（冪等） |
| failed / cancelled（同じ token） | fail | なし | 変わらず | 200 を返し、何も変えない |
| cancelled | cancel | なし | cancelled | 200 を返し、何も変えない |
| 上記以外 | どれでも | — | — | 409 |

- すべての遷移で job_events に 1 行書く（from_status / to_status / reason を入れる）。heartbeat は遷移ではないので書かない。
- lease の境界は `now >= lease_expires_at` を期限切れとする。

### delivery_outbox

| 元 | 操作 | 条件 | 先 |
|---|---|---|---|
| — | enqueue | idempotency_key が未登録 | pending |
| pending | claim | なし | sending（attempts+1、token、lease） |
| sending | markSent | token が一致（lease 切れでも受け付ける。送信はもう済んでいるので記録を優先する） | sent |
| sent（同じ token） | markSent | なし | sent（200、冪等） |
| sending | markFailed | token が一致、`retryable=true`、attempts < OUTBOX_MAX_ATTEMPTS | pending |
| sending | markFailed | token が一致、それ以外 | failed |
| sending | reconcile | `lease <= now`、attempts < max | pending（token を消す） |
| sending | reconcile | `lease <= now`、attempts ≥ max | failed |

- outbox の遷移は **jobs の行を一切変えない**（ジョブの結果と通知の結果は別々に管理する）。

## 6. HTTP API

### 共通
- 認証: `/healthz` 以外はすべて `Authorization: Bearer <JOB_API_TOKEN>` が要る。
- POST の本文は JSON。すべてのスキーマは strict で、知らないキーがあれば 400 にする。
- エラーの本文は必ず `{"error":{"code":"…","message":"…"}}` だけにする。スタック、入力値、トークンは入れない。
- ミドルウェアの順番: リクエストログ → レート制限 → 認証 → 本文サイズ上限 → ルート。例外は `app.onError()`、未知のルートは `app.notFound()` で、どちらも `{error:{code,message}}` にする。bodyLimit の onError も同じ形の 413 にする。
- Job の表現（snake_case）:
  - DB の列のうち、claim_token を除くすべての列を返す。
  - 時刻は ISO 文字列にする。cancel_requested は boolean、result と error はオブジェクトか null、artifact_urls は配列。
  - list の項目からは request_text と result を外す。

### エンドポイント

| メソッドとパス | 入力 | 成功時 | 主なエラー |
|---|---|---|---|
| GET `/healthz`（認証なし） | なし | 200 `{ok:true}` | 429 |
| POST `/jobs` | 下の「create の入力」 | 新規は 201 `{job, created:true}`、既存は 200 `{job, created:false}` | 400, 403 CHAT_NOT_ALLOWED, 409 IDEMPOTENCY_CONFLICT, 413 |
| GET `/jobs/:id` | なし | 200 `{job}` | 404 JOB_NOT_FOUND |
| GET `/jobs` | query: `status`, `source_chat_id`, `job_type`, `limit`（1〜100、既定 20） | 200 `{jobs:[…]}`。新しい順 | 400（limit が 0 や 101 以上、status が不正など） |
| GET `/jobs/:id/events` | query: `limit`（1〜100、既定 50） | 200 `{events:[…]}`。古い順 | 404 |
| POST `/jobs/claim` | `{worker_id, lease_seconds?, job_types?: string[]}` | 200 `{job, claim_token, lease_expires_at, run_id}`。対象がなければ 200 `{job:null}` | 400 |
| POST `/jobs/:id/claim` | `{worker_id, lease_seconds?}` | 200（上と同じ形） | 404, 409 JOB_NOT_CLAIMABLE |
| POST `/jobs/:id/heartbeat` | `{claim_token, lease_seconds?}` | 200 `{lease_expires_at, cancel_requested}` | 404, 409 INVALID_TRANSITION / CLAIM_TOKEN_MISMATCH / LEASE_EXPIRED |
| POST `/jobs/:id/complete` | `{claim_token, result: object, artifact_urls?: string[]}` | 200 `{job}` | 400, 404, 409（heartbeat と同じ） |
| POST `/jobs/:id/fail` | `{claim_token, error:{code, message}}` | 200 `{job}`。failed か cancelled | 400, 404, 409（heartbeat と同じ） |
| POST `/jobs/:id/cancel` | `{reason?}`（200 字以内） | 200 `{job}` | 404, 409 INVALID_TRANSITION |
| POST `/jobs/:id/retry` | `{reason?}` | 200 `{job}` | 404, 409 INVALID_TRANSITION / MAX_ATTEMPTS_REACHED |
| POST `/outbox` | `{job_id, idempotency_key, kind, body}` | 新規は 201 `{outbox, created:true}`、既存は 200 `{outbox, created:false}` | 400, 404 JOB_NOT_FOUND |
| POST `/outbox/claim` | `{worker_id, lease_seconds?, outbox_id?}` | 200 `{outbox, claim_token, lease_expires_at}`。対象がなければ 200 `{outbox:null}` | 400, 404 OUTBOX_NOT_FOUND, 409 OUTBOX_NOT_CLAIMABLE |
| POST `/outbox/:id/sent` | `{claim_token, external_ref?}`（256 字以内） | 200 `{outbox}` | 404, 409 INVALID_TRANSITION / CLAIM_TOKEN_MISMATCH |
| POST `/outbox/:id/failed` | `{claim_token, error:{code, message}, retryable?: boolean}`（retryable の既定は false） | 200 `{outbox}` | 404, 409（sent と同じ） |

### create の入力

| 項目 | 規則 | 既定 |
|---|---|---|
| source | `'imessage'` | 必須 |
| source_message_id | 1〜256 字 | 必須 |
| source_chat_id | 1〜256 字。ALLOWED_SOURCE_CHAT_IDS に入っているもの | 必須 |
| requester_id | 1〜256 字 | 必須 |
| job_type | `^[a-z][a-z0-9_.-]{0,63}$` | `general` |
| request_text | 1〜REQUEST_TEXT_MAX_CHARS 字（コードポイントで数える） | request_text と payload_ref のどちらかは必須 |
| payload_ref | 1〜512 字 | 同上 |
| priority | 整数 -10〜10 | 0 |
| scheduled_at | ISO 8601（タイムゾーン必須） | null |
| max_attempts | 整数 1〜10 | JOB_MAX_ATTEMPTS_DEFAULT |
| correlation_id | 1〜128 字 | null |
| parent_job_id | 存在する job_id | null |

- 既存のジョブと source_chat_id か requester_id が違う場合は 409 IDEMPOTENCY_CONFLICT にする。
- 本文（request_text）が違うだけなら、既存のジョブを返す。

### そのほかの入力の規則

| 項目 | 規則 |
|---|---|
| worker_id | `^[A-Za-z0-9._:-]{1,64}$` |
| lease_seconds | 10〜LEASE_SECONDS_MAX |
| result | JSON 化したときに RESULT_MAX_CHARS 字以内 |
| artifact_urls | 20 件以内。それぞれ https で 2048 字以内 |
| error.code | `^[A-Z0-9_]{1,64}$` |
| error.message | 1000 字以内。保存の前にマスクする |
| outbox の kind | 表の enum |
| outbox の body | 1〜1500 字 |
| idempotency_key | `^[A-Za-z0-9:._-]{1,128}$`（推奨は `job:<job_id>:<kind>`） |
| ジョブの :id | `^J-\d{6,}$` に合わない ID は 404 JOB_NOT_FOUND |
| outbox の :id | `^[1-9]\d{0,15}$` に合わない ID は 404 OUTBOX_NOT_FOUND |

### エラーコード

| HTTP | code | message |
|---|---|---|
| 400 | VALIDATION_ERROR | 入力が正しくありません |
| 400 | INVALID_JSON | JSON を読めません |
| 401 | UNAUTHORIZED | 認証が必要です |
| 403 | CHAT_NOT_ALLOWED | このトークからは受け付けません |
| 404 | NOT_FOUND / JOB_NOT_FOUND / OUTBOX_NOT_FOUND | 見つかりません |
| 409 | IDEMPOTENCY_CONFLICT | 同じメッセージ ID で内容が違います |
| 409 | JOB_NOT_CLAIMABLE / OUTBOX_NOT_CLAIMABLE | claim できる状態ではありません |
| 409 | INVALID_TRANSITION | この状態では実行できません |
| 409 | CLAIM_TOKEN_MISMATCH | claim_token が一致しません |
| 409 | LEASE_EXPIRED | lease の期限が切れています |
| 409 | MAX_ATTEMPTS_REACHED | 再実行の上限に達しています |
| 413 | PAYLOAD_TOO_LARGE | 本文が大きすぎます |
| 429 | RATE_LIMITED | リクエストが多すぎます（`Retry-After` ヘッダーを付ける） |
| 500 | INTERNAL | 内部エラーです |

- 409 の理由を決める順番: 状態 → token → lease。

## 7. Reconciler

- 形: `reconcile({db, clock, logger}, {queuedStaleMs, outboxStaleMs, limit=100}): ReconcileReport`
- 1 件ごとに CAS とトランザクションで処理する。2 回続けて呼んでも、2 回目は何も変えない。
- やること:
  1. lease が切れた claimed のジョブを、5 章の reconcile の行どおりに処理する。actor は `reconciler`、reason は `lease_expired`。
  2. lease が切れた sending の outbox を pending か failed に戻す。
  3. 次のものを報告するだけにする（何も変えない）。
     - `staleQueued`: claim できる queued のうち、created_at が queuedStaleMs より前のもの（Dispatcher が動いていない兆候）
     - `staleOutbox`: pending / sending / failed のうち、created_at が outboxStaleMs より前のもの
- 戻り値は `{requeued, failed, cancelled, outboxRequeued, outboxFailed, staleQueued, staleOutbox}`。中身は ID と経過ミリ秒だけで、本文は入れない。
- 配線: `main.ts` で RECONCILE_INTERVAL_SECONDS ごとに呼び、ログに件数と ID を出す。0 なら呼ばない。テストでは関数を直接呼ぶ。

## 8. Dispatcher

```ts
type WakePayload = { v: 1; event: 'jobs.available'; event_id: string /* UUID。wake ごとに新しく作る */ };
type WakeResult  = { accepted: boolean; status?: number; event_id: string; error?: string };
interface WakeDispatcher { wake(): Promise<WakeResult> }
```

- `createMockDispatcher({accept?: boolean})`: 呼び出しと本文を記録する。
- `createWebhookDispatcher({url, token, fetch, timeoutMs})`:
  - fetch を注入して使う。テストでのみ使い、main からは呼ばない。設定にも URL を持たない。
  - `POST`、`Authorization: Bearer`、`Content-Type: application/json` で送る。
  - 2xx なら `accepted:true`。それ以外や例外は `accepted:false` にし、例外は投げない。
- **2xx は「受理した」という意味で、「完了した」ではない**。wake の結果によってジョブの状態を変えない。
- `dispatchTick({db, dispatcher, clock, state, cooldownMs})`: claim できる queued があり、前回の wake から cooldownMs 以上たっていれば wake を 1 回だけ呼ぶ。成功しても失敗しても lastWakeAt を更新する。
- 本文には job_id、request_text、chat_id、source_message_id を載せない。トークンはログに出さない。

## 9. 設定（環境変数）

| 名前 | 必須 | 既定 | .env.example の値 |
|---|---|---|---|
| JOB_API_TOKEN | 必須（32 字以上。未設定か短いときは起動しない） | — | `change-me-to-a-long-random-string-000000` |
| ALLOWED_SOURCE_CHAT_IDS | 必須（カンマ区切り。空なら起動しない） | — | `chat-id-placeholder` |
| HOST | | `127.0.0.1` | `127.0.0.1` |
| PORT | | `3320` | `3320` |
| DATABASE_PATH | | `./data/jobs.sqlite` | 同じ |
| LEASE_SECONDS_DEFAULT / LEASE_SECONDS_MAX | | 300 / 3600 | |
| JOB_MAX_ATTEMPTS_DEFAULT | | 3 | |
| REQUEST_TEXT_MAX_CHARS | | 4000 | |
| RESULT_MAX_CHARS | | 16000 | |
| BODY_MAX_BYTES | | 65536 | |
| RATE_LIMIT_PER_MINUTE | | 120 | |
| OUTBOX_LEASE_SECONDS / OUTBOX_MAX_ATTEMPTS | | 120 / 5 | |
| QUEUED_STALE_SECONDS / OUTBOX_STALE_SECONDS | | 900 / 900 | |
| RECONCILE_INTERVAL_SECONDS | | 60（0 で止める） | |
| LOG_LEVEL | | `info` | |

- `.gitignore` に `.env`、`data/`、`.runs/` を入れる。

## 10. セキュリティ

- **認証**:
  - Bearer の値と設定の値は、どちらも SHA-256 にしてから `crypto.timingSafeEqual` で比べる（長さが違っても定数時間で比べられる）。
  - ヘッダーがないとき、方式が違うとき、値が違うときは、どれも同じ 401 にする。
- **レート制限**:
  - メモリ内の固定ウィンドウ（60 秒）。時計は注入する。
  - キーは注入できる関数で決める。既定は接続元のアドレスで、取れなければ `local`。
  - 認証の前に数えるので、認証に失敗した要求も数に入る。
  - 超えたら 429 と `Retry-After`（ウィンドウの終わりまでの秒数を切り上げ、1 以上）を返す。
- **入力**: zod の strict スキーマ、本文サイズの上限（Hono の bodyLimit で 413）、文字数の上限。
- **出力**: claim_token は claim の応答でしか返さない。list には request_text と result を入れない。
- **ログ**:
  - リクエストごとに method、path、status、ms、request_id を JSON 1 行で出す。本文とヘッダーは出さない。
  - `logger` は出力先を注入できる。値はすべて `mask()` を通す。
  - キーが `request_text`、`body`、`text`、`authorization`、`token`、`claim_token` の値は `[REDACTED]` にする。
- **`mask()` が伏せるもの**:
  - `Bearer <値>`
  - `[A-Za-z0-9_-]{32,}`（トークンらしい文字列）
  - メールアドレス
  - 電話番号（10 桁以上で、`+`、ハイフン、空白を含んでもよい）
  - `J-000123` と ISO の時刻は伏せない。
- **待ち受けと公開**:
  - 既定は 127.0.0.1 で待ち受ける。Funnel 用の設定は作らない。
  - tailnet のホスト名や IP はコード、テスト、文書に書かない。
- **データ**: 外部へ書き込む操作、シェルの実行、本文の評価はしない。

## 11. 元の指示との違い

### ちひろの決定（11/11 02:55）によるもの

| 決定 | 反映 |
|---|---|
| 入口と出口は Grok Bot 組み込みの Messages 機能（Genie ではない） | Phase 0 の案（Genie と Notion の「返事」DB）は採らない。outbox は `channel='imessage'`、`target_chat_id`、`in_reply_to` だけを持ち、Notion に依存する列は持たない。source_chat_id と source_message_id の形式は確認できていないので、中身を解釈しない文字列（256 字以内）として扱う。**リスク**: Phase 0 の調査では、SendIMessage は送るたびに承認が要り、Routine から出た承認カードは 30 分で期限切れになる。このため、無人の完了通知は pending のまま残る可能性がある。そのときは Reconciler の staleOutbox で見えるようにする（Phase 2/3 で確認する） |
| 自分宛てトークだけ受け付ける | ALLOWED_SOURCE_CHAT_IDS を必須にし、それ以外からの create は 403 にする。outbox の宛先はジョブから写し、入力では受け取らない |
| box→Mac mini は Tailscale の中だけ | 既定は 127.0.0.1 で待ち受ける。Phase 0 の第二候補（Funnel に `/jobs` を足す）、Webhook の HMAC、リプレイ対策は作らない（Phase 1 には外から受ける webhook がないため） |

### 元の指示や参考実装との違い（Phase 1 の設計判断）
- lease が切れたジョブは、max_attempts まで自動で queued に戻す（参考実装は自動で再試行しない。今回の依頼の指示に合わせた）。fail は自動で再試行せず、人の retry を待つ。
- retry できるのは failed だけで、attempts は 0 に戻さない（上限に達したジョブをもう一度動かす手段は Phase 1 では作らない）。
- 認可は API トークン 1 つで全権になる（ジョブ単位のアクセス制御は Phase 2 以降）。
- draft 状態、instance_id による本番と検証の区別は作らない。

### Phase 1 で作らないもの
- iMessage の取り込みと送信（自分のメッセージを除く処理、返信ループの防止を含む）
- Worker Adapter の実体（Routine）、MCP、管理コマンド
- Scheduler、launchd、Tailscale の設定、バックアップ、Runbook
- 実際の webhook への送信
- 15 章の 1〜7・13・14 の実機での確認（13 は create の chat 許可だけをテストする）


## 12. 補足（Codex の仕様確認を受けて決めたこと。上の記述と食い違うときはこちらが優先）

1. **テストの通し方**：HTTP の振る舞いは `app.request()`。設定、DB の開き直し、Reconciler、mask、Dispatcher は関数を直接呼ぶ。lint と typecheck は npm scripts（CI）で確かめる。500 のテストは、DB を close してから要求を送って起こす。
2. **同時実行の確かめ方**：G09・G20・G39 は、同じ一時ファイル DB を開いた `worker_threads`（`execArgv: ['--import', 'tsx']`）を複数動かし、`SharedArrayBuffer` と `Atomics.wait/notify` で開始をそろえてから store の関数を呼ぶ。加えて、トランザクションの途中失敗（テストで job_events への INSERT を失敗させるトリガーを置く）で本体の UPDATE も巻き戻ることを確かめる。
3. **期限切れの分岐は排他的**：reconcile の 3 行は `cancel_requested` と attempts で重ならない。どの経路でも job_runs を `outcome='lease_expired'`、`ended_at=now` にする。
4. **lease の境界**：`now >= lease_expires_at` を期限切れとする。heartbeat / complete / fail を「1ms 前・ちょうど・1ms 後」でテストする。fail の再送（failed / cancelled で同じ token）は 200 で event も run も増えない。claimed への cancel の再送（すでに cancel_requested=1）は 200 で event が増えない。
5. **outbox の token**：markSent / markFailed は「status='sending' かつ claim_token が一致」なら lease が切れていても受け付ける。reconcile で pending に戻すと claimed_by・claim_token・lease_expires_at を NULL にするので、古い送信者（A）の sent / failed は 409 CLAIM_TOKEN_MISMATCH になる。B が claim し直した後の A も同じ。
6. **outbox の冪等キーの再利用**：同じ idempotency_key で job_id・kind・body のどれかが違えば 409 IDEMPOTENCY_CONFLICT。すべて同じなら 200 `created:false`。
7. **通知の重複について**：Phase 1 が保証するのは「outbox の行が重複しない」「同じ行を 2 人が同時に送信中にしない」まで。送信は成功したが markSent の前に止まった場合は、lease 切れで pending に戻り再送されうる（at-least-once）。送信側（Phase 3）は idempotency_key を送信先の重複防止キーとして使う契約にする。
8. **complete と通知予定の間の中断**：complete / fail は任意で `notify: {body}` を受け取り、同じトランザクションで outbox（kind は done / failed、idempotency_key は `job:<job_id>:<kind>`）を作る。`notify` を使わずに後から `/outbox` で登録してもよい（同じキーなら冪等）。Reconciler は、done / failed のジョブのうち、その kind の outbox が無いまま outboxStaleMs を過ぎたものを `terminalWithoutOutbox` として報告する。
9. **jobs と outbox の分離**：outbox の enqueue（notify 経由を除く）、claim、sent、failed、reconcile は jobs の行を変えない。テストでは jobs の全列を前後で比べる。
10. **ログと監査に入れる任意入力**：
    - リクエストログの path は Hono のルートのパターン（例 `/jobs/:id`）を出し、生のパスは出さない。マッチしなかったものは `unmatched` とする。
    - 機密のキー（`request_text`, `body`, `text`, `authorization`, `token`, `claim_token`, `password`, `secret`, `api_key`, `cookie`）は、入れ子のオブジェクトの中でも再帰的に `[REDACTED]` にする。
    - event の reason、error.message、outbox の last_error、例外のメッセージは保存・出力の前に `mask()` を通す。
    - `mask()` が伏せるものに次を足す: `password=…` / `secret=…` / `token=…` 形式、`*.ts.net` のホスト名、RFC 6598 の共有アドレス範囲の IPv4。住所は形が決まらないので、自由入力をログに出さないことで防ぐ（mask では扱わない）。
11. **job_id の形**：`^J-\d{6,}$` に統一する（G08 も 6 桁以上）。
12. **Reconciler の limit**：「同じ対象を 2 回遷移させない」が冪等の意味。対象が limit 以下なら 2 回目は 0 件。limit を超えるときは、1 回目に limit 件、2 回目に残りを処理する。
13. **設定の範囲**：PORT 1〜65535、LEASE_SECONDS_DEFAULT 10〜LEASE_SECONDS_MAX、LEASE_SECONDS_MAX 10〜86400、JOB_MAX_ATTEMPTS_DEFAULT 1〜10、REQUEST_TEXT_MAX_CHARS 1〜100000、RESULT_MAX_CHARS 1〜1000000、BODY_MAX_BYTES 1024〜10485760、RATE_LIMIT_PER_MINUTE 1〜100000、OUTBOX_LEASE_SECONDS 10〜3600、OUTBOX_MAX_ATTEMPTS 1〜20、QUEUED_STALE_SECONDS / OUTBOX_STALE_SECONDS 1〜604800、RECONCILE_INTERVAL_SECONDS 0〜86400。範囲外は起動しない（値はメッセージに出さない）。
14. **scheduled_at**：`Z` か `±hh:mm` の付いた ISO 8601 だけを受け付け、UTC のミリ秒にして保存する。オフセットの無いものは 400。

## 13. 方針変更（ちひろ、11/11 03:11）：入口と出口は Mac mini の Genie

11 章の「入口と出口は Grok Bot 組み込みの Messages 機能」は取り消す。Routine の実行中には組み込みの Messages ツールが渡らないと分かったため。入口と出口は Mac mini の Genie（genie-in-messages）にする。受け付けるのは自分宛てのトークだけ。この章は 1〜12 章より優先する。

### 13.1 待ち受けを 2 つに分ける

| 待ち受け | 設定 | 既定 | 使う人 | ルート |
|---|---|---|---|---|
| Genie 用（Ingress） | `GENIE_HOST` / `GENIE_PORT` | `127.0.0.1` / `3321` | 同じ Mac mini の Genie | `GET /healthz`、`POST /ingress/genie`、`GET /genie/replies` |
| Job API（Worker 用） | `HOST` / `PORT` | `127.0.0.1` / `3320` | box の Worker（Tailscale 経由） | 6 章の Job API と `/healthz` |

- 2 つは別の Hono アプリ（`createIngressApp`、`createApp`）。互いのルートは出さない（Ingress に `/jobs` は無く、Job API に `/ingress` は無い）。
- `GENIE_HOST` は `127.0.0.1`、`::1`、`localhost` のどれかだけを許す。ほかは起動しない。
- `HOST` は Mac mini では tailnet 上の自分のアドレスを `.env` に書く（値はリポジトリに書かない）。`0.0.0.0` と `::` は起動しない（全部の口で待ち受けないため）。Funnel には出さない。
- トークンは分ける。`GENIE_TOKEN`（32 字以上。Ingress だけに効く）と `JOB_API_TOKEN`（Job API だけに効く）。同じ値なら起動しない。
- `GENIE_ALLOWED_CHAT_IDS`（必須、カンマ区切りの整数）。自分宛てトークの chat_id だけを書く。Ingress から作るジョブの source_chat_id はここに入っていなければならないので、`ALLOWED_SOURCE_CHAT_IDS` にも同じ値を入れる。

### 13.2 `POST /ingress/genie`（Genie の webhook をそのまま受ける）

- 認証: `Authorization: Bearer <GENIE_TOKEN>`。違えば 401。レート制限と本文サイズ上限は Job API と同じ。
- 本文（Genie の `WebhookPayload` と同じ。strict）:
  `{v:1, event:"message", idempotency_key:string, guid:string, chat_id:integer, text:string, created_at:string|null, sender_is_me:boolean, sender_name:string}`。`guid` と `idempotency_key` は 1〜256 字で同じ値。違えば 400。
- 判定の順番（上で決まったら終わり）:
  1. chat_id が `GENIE_ALLOWED_CHAT_IDS` に無い → 403 CHAT_NOT_ALLOWED（Genie は 4xx を再送しない）。
  2. `sender_is_me` が false → 200 `{status:"ignored", reason:"not_from_me"}`。
  3. 本文の先頭の空白・不可視文字と、先頭の 🪔（U+1FA94、続く U+FE0F と空白）を取り除く。残りの先頭が 🧞‍♂️（U+1F9DE U+200D U+2642、U+FE0F は任意。性別なしの 🧞 も含む）なら → 200 `{status:"ignored", reason:"bot_reply"}`（返信ループの防止）。
  4. 残りが空 → 200 `{status:"ignored", reason:"empty"}`。
  5. 同じ guid を前に受けていれば（ジョブでもコマンドでも）→ 200 で前回と同じ応答。行も outbox も増えない。
  6. 残りが `/help`、`/status <job_id>`、`/cancel <job_id>`、`/retry <job_id>` → 管理コマンド（13.3）。
  7. それ以外 → ジョブを作る（source=`imessage`、source_message_id=guid、source_chat_id=chat_id の 10 進文字列、requester_id=`self`、job_type=`general`、request_text=残りの本文）。同じトランザクションで受付の outbox（kind=`ack`、キー `job:<job_id>:ack`）を作る。応答は 201 `{status:"created", job_id}`。
- 受け付けた guid は `ingress_messages`（guid PRIMARY KEY、chat_id、kind（job / command / ignored）、job_id、outbox_id、received_at、created_at）に残す（受信時刻と受付時刻の記録）。本文は保存しない（ジョブの request_text を除く）。
- 本文、sender_name はログに出さない。

### 13.3 管理コマンド

| コマンド | 動き | 返信（outbox kind=`command`、キー `cmd:<guid>`） |
|---|---|---|
| `/help` | なし | 使い方の一覧 |
| `/status J-000123` | 何も変えない | ジョブ ID、状態（日本語: 受付済み / 実行中 / 完了 / 失敗 / キャンセル済み）、試行回数、キャンセル要求の有無 |
| `/cancel J-000123` | 6 章の cancel と同じ | 結果 |
| `/retry J-000123` | 6 章の retry と同じ | 結果（上限なら「再実行の上限に達しています」） |

- ジョブ単位のアクセス制御: コマンドで触れるのは、source_chat_id がそのメッセージの chat_id と同じジョブだけ。違うトークのジョブと存在しないジョブは、どちらも「見つかりません」と返す（存在を漏らさない）。
- 形が違う（ID なし、未知のコマンド）は `/help` と同じ返信に「コマンドを読めませんでした」を付ける。
- 応答は 200 `{status:"command", command}`。

### 13.4 返信の文面（10 章の例に合わせる）

- 受付: `依頼を受け付けました。\nジョブID：J-000123\n内容：<本文の先頭 40 字>\n状態：受付済み`
- 完了（complete の `notify` が無いときに Worker が使う既定文）: `ジョブ J-000123 が完了しました。\n\n結果：\n<summary>`（成果物 URL があれば `\n\n成果物：\n<URL>` を足す）
- 失敗: `ジョブ J-000123 の処理に失敗しました。\n\n原因：\n<安全に表示できるエラー概要>\n\n再実行する場合：\n/retry J-000123`
- 文面は 1500 字以内に切る。先頭に 🧞‍♂️ は付けない（Genie が 1 通目に印だけを送るため）。先頭を 🪔 にしない。

### 13.5 `GET /genie/replies`（Genie の `reply_fetch_url`）

Genie の `HTTPReplySource`（Sources/GenieCore/ReplySource.swift）の形に合わせる。

- 要求: `GET /genie/replies[?cursor=<文字列>]`、`Authorization: Bearer <GENIE_TOKEN>`（Genie の `reply-secret` に同じ値を入れる）。
- 応答 200:
  ```json
  {"cursor":"o:42","replies":[{"id":"je-42","chat_id":21,"text":"…","in_reply_to_guid":"<元の guid>","created_at":"2026-11-11T00:00:00.000Z"}]}
  ```
  - `id` は `je-<outbox_id>`。outbox の行ごとに別の id なので、同じ guid に受付・完了・コマンドの返信を何通でも送れる。
  - `chat_id` は数値（jobs.source_chat_id を整数にしたもの）。`in_reply_to_guid` は jobs.source_message_id（コマンドの返信はそのコマンドの guid）。
  - `created_at` は outbox の作成時刻（Genie はこれが `route_ttl_seconds` より古いと送らない）。
- 対象: `channel='genie'` かつ `status='pending'` かつ `outbox_id > cursor の数` の行を、outbox_id の昇順に `GENIE_REPLY_PAGE_LIMIT`（既定 50、1〜100）件まで。
- `cursor` は、返した最後の行の `o:<outbox_id>`。返す行が無ければ受け取った cursor をそのまま返す（無ければ null）。形が違う cursor は 400。
- **送信の記録（markSent）**: Genie は、ページの返事をすべて処理し終えたときだけ cursor を進める（Engine.pollReplies）。そこで、`cursor=o:N` で取りに来たら、まず `channel='genie'`、`status='pending'`、`outbox_id <= N` の行を同じトランザクションで `sent` にする（`external_ref='genie:cursor'`、event `outbox.sent`、actor `genie`）。SQLite は書き込みを 1 本ずつ通すので、N より小さい id の行が後から現れることはない。
- 制約（正直に書く）: Genie は「処理した」と「送れた」を分けて知らせない（期限切れや送り先不明で捨てた返事も処理済みになる）。そのため `sent` は「Genie が受け取って処理した」の意味になる。送信の成否は Genie のログで見る。Genie から送信結果を返す仕組みは次の段階の候補。
- `channel='genie'` の行は Genie だけが取る。6 章の `/outbox/claim` は `channel<>'genie'` の行だけを対象にする。Genie 経由のジョブ（Ingress で作ったもの）の outbox は `channel='genie'` にする（enqueue と complete/fail の `notify` も、ジョブの outbox の既定 channel に従う）。
- Reconciler の staleOutbox は genie の行も報告する（Genie が止まっている兆候）。

### 13.6 Worker（box の Grok Bot Routine）から Job API への経路

- box の tailscaled は userspace-networking で動いていて、SOCKS や HTTP のプロキシは無い。プロキシを足すには tailscaled の再起動が要り、そのあいだ他の受信も止まるので、前提にしない。
- そこで、Worker の HTTP クライアントは送受信の方法（Transport）を差し替えられるようにする。
  - 標準: `tailscale nc <Mac mini のホスト名> <PORT>` を子プロセスで起動し、標準入出力で HTTP/1.1（`Connection: close`、`Content-Length`）をやりとりする。応答は `Content-Length` と `Transfer-Encoding: chunked` の両方を読める。
  - テスト: 子プロセスの起動（spawn）を注入して偽物に差し替える。Transport ごとモックにもできる。
- 「届かない」の扱い: 次のどれかなら `{ok:false, unreachable:true, reason}` を返し、例外を投げない。ジョブは failed にしない。
  - `tailscale` が見つからない（ENOENT）→ `reason:"nc_not_found"`
  - 接続できない（応答が来ないまま子プロセスが終わる）→ `reason:"connect_failed"`
  - 時間切れ（既定 15 秒。子プロセスを止める）→ `reason:"timeout"`
- Worker の 1 回分（`runWorkerOnce`）: claim → 処理 → complete / fail。どの段階で届かなくなっても、何も書かずに `outcome:"unreachable"` で終わる。claim 済みなら lease が切れたあと Reconciler が queued に戻し、Dispatcher が起こし直したときに再開する（at-least-once）。処理関数の例外だけを fail にする。
- CLI（`node dist/worker-cli.js <claim|get|heartbeat|complete|fail|outbox> [JSON]`）を Routine から Shell で呼べるようにする。トークンは `JOB_API_TOKEN_FILE`（600 のファイル）から読み、引数や出力に出さない。終了コード: 0 成功、3 届かない、4 API のエラー、2 使い方の誤り。出力は JSON 1 行。
- 設定（Worker 側）: `JOB_API_TAILNET_HOST`、`JOB_API_PORT`、`JOB_API_TOKEN_FILE`、`TAILSCALE_BIN`（既定 `tailscale`）、`JOB_API_TIMEOUT_MS`（既定 15000）。値はリポジトリに書かない。
- 手順と理由は `docs/worker.md` に書く。実際の tailscale の設定変更や tailscaled の再起動はしない。

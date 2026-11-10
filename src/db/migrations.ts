import type Database from 'better-sqlite3';

function migrateV1(db: Database.Database): void {
  db.transaction(() => {
    const version = db.pragma('user_version', { simple: true });
    if (version === 1 || version === 2) return;
    if (version !== 0) throw new Error('Unsupported database version');
    db.exec(`
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

    PRAGMA user_version=1;
    `);
  }).immediate();
}


export function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true });
  if (version === 2) return;
  if (version !== 0 && version !== 1) throw new Error('Unsupported database version');
  if (version === 0) migrateV1(db);
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys=OFF');
  try {
    db.transaction(() => {
      if (db.pragma('user_version', { simple: true }) === 2) return;
      const sequence = db.prepare<[], {seq:number}>("SELECT seq FROM sqlite_sequence WHERE name='delivery_outbox'").get()?.seq ?? 0;
      const eventsSequence = db.prepare<[], {seq:number}>("SELECT seq FROM sqlite_sequence WHERE name='job_events'").get()?.seq ?? 0;
      for (const table of ['delivery_outbox', 'job_events']) {
        const original = db.prepare<[string], {sql:string}>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (!original) throw new Error('Missing migration table');
        const indexes = db.prepare<[string], {sql:string}>("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table);
        let sql = original.sql.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_v2`)
          .replace(/job_id(\s+)TEXT NOT NULL REFERENCES/, 'job_id$1TEXT REFERENCES');
        if (table === 'delivery_outbox') sql = sql.replace("'cancelled'))", "'cancelled','command'))").replace("channel IN ('imessage')", "channel IN ('imessage','genie')");
        db.exec(sql);
        db.exec(`INSERT INTO ${table}_v2 SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_v2 RENAME TO ${table};`);
        for (const index of indexes) db.exec(index.sql);
      }
      db.prepare("UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='delivery_outbox'").run(sequence);
      db.prepare("UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='job_events'").run(eventsSequence);
      db.exec(`CREATE TABLE ingress_messages (
        guid TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('job','command','ignored')),
        job_id TEXT REFERENCES jobs(job_id),
        outbox_id INTEGER REFERENCES delivery_outbox(outbox_id),
        received_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        command TEXT
      );
      CREATE INDEX ingress_job_idx ON ingress_messages(job_id,kind);
      PRAGMA user_version=2;`);
      const violations = db.pragma('foreign_key_check');
      if (!Array.isArray(violations) || violations.length) throw new Error('Migration foreign key check failed');
    }).immediate();
  } finally {
    db.pragma(`foreign_keys=${foreignKeys === 1 ? 'ON' : 'OFF'}`);
  }
}

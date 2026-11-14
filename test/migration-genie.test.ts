import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { migrate } from '../src/db/migrations.js';

test('JE-FP3 migration v1 to v4 preserves rows, references, sequence and supports owner notifications twice', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    db.exec(readFileSync(new URL('./fixtures/v1.sql', import.meta.url), 'utf8'));
    db.exec(`INSERT INTO jobs(job_id,source,source_message_id,source_chat_id,requester_id,job_type,request_text,status,created_at,updated_at,max_attempts)
      VALUES ('J-000001','imessage','old-guid','21','self','general','old request','queued',1,1,3);
      INSERT INTO delivery_outbox(outbox_id,job_id,idempotency_key,kind,target_chat_id,body,status,created_at,updated_at)
      VALUES (9,'J-000001','old-ack','ack','21','old reply','pending',1,1);
      INSERT INTO job_events(job_id,outbox_id,at,actor,type) VALUES ('J-000001',9,1,'api','outbox.enqueued');
      INSERT INTO delivery_outbox(outbox_id,job_id,idempotency_key,kind,target_chat_id,body,status,created_at,updated_at)
      VALUES (20,'J-000001','deleted','ack','21','deleted','pending',1,1);
      DELETE FROM delivery_outbox WHERE outbox_id=20;`);
    const before = ['jobs', 'delivery_outbox', 'job_events'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
    migrate(db);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(['jobs', 'delivery_outbox', 'job_events'].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toMatchObject(before);
    expect(db.prepare('SELECT sender_handle FROM jobs').all()).toEqual([{ sender_handle: null }]);
    const inserted = db.prepare(`INSERT INTO delivery_outbox(job_id,idempotency_key,kind,channel,target_chat_id,body,status,created_at,updated_at)
      VALUES (NULL,'owner:new','notify','genie','21','review','pending',2,2)`).run();
    expect(Number(inserted.lastInsertRowid)).toBeGreaterThan(20);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', {simple:true})).toBe(1);
    expect(() => db.prepare('SELECT received_at FROM ingress_messages').all()).not.toThrow();
  } finally { db.close(); }
});

test.each([0, 1, 2, 3])('JE-FP3 openDb migrates v%s to v4 and reopening preserves rows and sequences', async version => {
  const { fileDb } = await import('./helpers/context.js');
  const { openDb } = await import('../src/db/open.js');
  const fixture = fileDb();
  let db = new Database(fixture.path);
  try {
    if (version !== 0) {
      let sql = readFileSync(new URL('./fixtures/v1.sql', import.meta.url), 'utf8');
      if (version >= 2) sql = sql.replaceAll('job_id           TEXT NOT NULL REFERENCES', 'job_id           TEXT REFERENCES')
        .replaceAll('job_id      TEXT NOT NULL REFERENCES', 'job_id      TEXT REFERENCES')
        .replace("kind IN ('ack','progress','done','failed','cancelled')", "kind IN ('ack','progress','done','failed','cancelled','command')")
        .replace("channel IN ('imessage')", "channel IN ('imessage','genie')")
        .replace('PRAGMA user_version=1;', `CREATE TABLE ingress_messages (
          guid TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('job','command','ignored')),
          job_id TEXT REFERENCES jobs(job_id), outbox_id INTEGER REFERENCES delivery_outbox(outbox_id),
          received_at INTEGER NOT NULL, created_at INTEGER NOT NULL, command TEXT);
          CREATE INDEX ingress_job_idx ON ingress_messages(job_id,kind); PRAGMA user_version=2;`);
      if (version === 3) sql += "ALTER TABLE jobs ADD COLUMN sender_handle TEXT CHECK (sender_handle IS NULL OR length(sender_handle) BETWEEN 1 AND 256); PRAGMA user_version=3;";
      db.exec(sql);
      db.exec(`INSERT INTO jobs(job_id,source,source_message_id,source_chat_id,requester_id,job_type,request_text,status,created_at,updated_at,max_attempts)
        VALUES ('J-000001','imessage','old-guid','21','self','general','old request','queued',1,1,3);
        INSERT INTO delivery_outbox(outbox_id,job_id,idempotency_key,kind,target_chat_id,body,status,created_at,updated_at)
        VALUES (20,'J-000001','deleted','ack','21','deleted','pending',1,1);
        DELETE FROM delivery_outbox WHERE outbox_id=20;
        INSERT INTO job_events(event_id,job_id,at,actor,type) VALUES (30,'J-000001',1,'api','job.created');
        DELETE FROM job_events WHERE event_id=30;`);
    }
    const sequences = version === 0 ? [] : db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
    db.close();
    db = openDb(fixture.path);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(db.pragma('table_info(jobs)')).toContainEqual(expect.objectContaining({ name: 'sender_handle', type: 'TEXT', notnull: 0 }));
    if (version !== 0) {
      expect(db.prepare('SELECT sender_handle FROM jobs').all()).toEqual([{ sender_handle: null }]);
      expect(db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()).toEqual(sequences);
    }
    const before = db.prepare('SELECT * FROM jobs').all();
    for (let reopening = 0; reopening < 2; reopening++) {
      db.close(); db = openDb(fixture.path);
      expect(db.pragma('user_version', { simple: true })).toBe(4);
      expect(db.prepare('SELECT * FROM jobs').all()).toEqual(before);
      if (version !== 0) expect(db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()).toEqual(sequences);
    }
    expect(() => db.prepare(`INSERT INTO jobs(job_id,source,source_message_id,source_chat_id,requester_id,job_type,request_text,status,created_at,updated_at,max_attempts,sender_handle)
      VALUES ('J-000002','imessage','new-guid','21','member','general','request','queued',1,1,3,?)`).run('x'.repeat(257))).toThrow(/CHECK/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { if (db.open) db.close(); fixture.cleanup(); }
});

test('JE-FP3 refuses future v5 database', () => {
  const db = new Database(':memory:');
  try { db.pragma('user_version=5'); expect(() => migrate(db)).toThrow('Unsupported database version'); }
  finally { db.close(); }
});

test('JE-FP3 holds every nonterminal member job and leaves terminal and self policy empty', () => {
  const db = new Database(':memory:');
  try {
    db.exec(readFileSync(new URL('./fixtures/v1.sql', import.meta.url), 'utf8'));
    db.exec(`INSERT INTO jobs(job_id,source,source_message_id,source_chat_id,requester_id,job_type,request_text,status,created_at,updated_at,max_attempts,attempts,claimed_at,claimed_by,claim_token,lease_expires_at,heartbeat_at) VALUES
      ('J-000001','imessage','queued-member','21','member','general','safe request','queued',1,1,3,0,NULL,NULL,NULL,NULL,NULL),
      ('J-000002','imessage','claimed-member','21','member','general','old request','claimed',1,1,3,1,1,'dummy-worker','dummy-token',2,1),
      ('J-000003','imessage','queued-self','21','self','general','self request','queued',1,1,3,0,NULL,NULL,NULL,NULL,NULL),
      ('J-000004','imessage','done-member','21','member','general','old request','done',1,1,3,0,NULL,NULL,NULL,NULL,NULL),
      ('J-000005','imessage','cancelled-member','21','member','general','old request','cancelled',1,1,3,0,NULL,NULL,NULL,NULL,NULL),
      ('J-000006','imessage','failed-member','21','member','general','old request','failed',1,1,3,0,NULL,NULL,NULL,NULL,NULL);
      INSERT INTO job_runs(job_id,attempt,worker_id,started_at) VALUES ('J-000002',1,'dummy-worker',1);
      INSERT INTO delivery_outbox(outbox_id,job_id,idempotency_key,kind,target_chat_id,body,status,created_at,updated_at) VALUES (20,'J-000001','old-ack','ack','21','old reply','pending',1,1);
      INSERT INTO job_events(event_id,job_id,outbox_id,at,actor,type) VALUES (30,'J-000001',20,1,'api','outbox.enqueued');`);
    db.pragma('foreign_keys=ON');
    migrate(db);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(db.prepare('SELECT job_id,status,policy_decision,allowed_capabilities FROM jobs ORDER BY job_id').all()).toEqual([
      { job_id: 'J-000001', status: 'queued', policy_decision: 'hold', allowed_capabilities: '[]' },
      { job_id: 'J-000002', status: 'claimed', policy_decision: 'hold', allowed_capabilities: '[]' },
      { job_id: 'J-000003', status: 'queued', policy_decision: null, allowed_capabilities: null },
      { job_id: 'J-000004', status: 'done', policy_decision: null, allowed_capabilities: null },
      { job_id: 'J-000005', status: 'cancelled', policy_decision: null, allowed_capabilities: null },
      { job_id: 'J-000006', status: 'failed', policy_decision: null, allowed_capabilities: null },
    ]);
    expect(db.prepare('SELECT event_id,job_id,outbox_id FROM job_events').all()).toEqual([{ event_id: 30, job_id: 'J-000001', outbox_id: 20 }]);
    expect(db.prepare('INSERT INTO delivery_outbox(job_id,idempotency_key,kind,channel,target_chat_id,in_reply_to,body,status,created_at,updated_at) VALUES (NULL,\'owner:notice\',\'notify\',\'genie\',\'21\',NULL,\'review\',\'pending\',2,2)').run().changes).toBe(1);
    expect(db.prepare<[], { seq: number }>("SELECT seq FROM sqlite_sequence WHERE name='delivery_outbox'").get()?.seq).toBeGreaterThan(20);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get()?.sql).toMatch(/status IN \('queued','claimed','done','failed','cancelled'\)/);
    expect(() => db.prepare(`INSERT INTO jobs(job_id,source,source_message_id,source_chat_id,requester_id,job_type,request_text,status,created_at,updated_at,max_attempts)
      VALUES ('J-000005','imessage','held-status','21','member','general','request','hold',2,2,3)`).run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO delivery_outbox(job_id,idempotency_key,kind,target_chat_id,body,status,created_at,updated_at) VALUES (NULL,'bad:kind','unknown','21','x','pending',2,2)").run()).toThrow(/CHECK/);
  } finally { db.close(); }
});

test('JE-FP4 a v3 claimed member stays unclaimable after lease expiry requeues it', async () => {
  const { fileDb, context } = await import('./helpers/context.js');
  const { openDb } = await import('../src/db/open.js');
  const { JobStore } = await import('../src/store/jobs.js');
  const { reconcile } = await import('../src/reconciler/index.js');
  const fixture = fileDb();
  let db = new Database(fixture.path);
  try {
    let sql = readFileSync(new URL('./fixtures/v1.sql', import.meta.url), 'utf8');
    sql = sql.replaceAll('job_id           TEXT NOT NULL REFERENCES', 'job_id           TEXT REFERENCES')
      .replaceAll('job_id      TEXT NOT NULL REFERENCES', 'job_id      TEXT REFERENCES')
      .replace("kind IN ('ack','progress','done','failed','cancelled')", "kind IN ('ack','progress','done','failed','cancelled','command')")
      .replace("channel IN ('imessage')", "channel IN ('imessage','genie')")
      .replace('PRAGMA user_version=1;', `CREATE TABLE ingress_messages (
        guid TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('job','command','ignored')),
        job_id TEXT REFERENCES jobs(job_id), outbox_id INTEGER REFERENCES delivery_outbox(outbox_id),
        received_at INTEGER NOT NULL, created_at INTEGER NOT NULL, command TEXT);
        CREATE INDEX ingress_job_idx ON ingress_messages(job_id,kind); PRAGMA user_version=2;`);
    sql += "ALTER TABLE jobs ADD COLUMN sender_handle TEXT CHECK (sender_handle IS NULL OR length(sender_handle) BETWEEN 1 AND 256); PRAGMA user_version=3;";
    db.exec(sql);
    db.exec(`INSERT INTO jobs(job_id,source,source_message_id,source_chat_id,requester_id,job_type,request_text,status,created_at,updated_at,max_attempts,attempts,claimed_at,claimed_by,claim_token,lease_expires_at,heartbeat_at)
      VALUES ('J-000001','imessage','v3-claimed-member','21','member','general','old request','claimed',1,1,3,1,1,'dummy-worker','dummy-token',2,1);
      INSERT INTO job_runs(job_id,attempt,worker_id,started_at) VALUES ('J-000001',1,'dummy-worker',1);`);
    db.close();
    db = openDb(fixture.path);
    expect(db.prepare('SELECT policy_decision,allowed_capabilities FROM jobs WHERE job_id=?').get('J-000001')).toEqual({ policy_decision: 'hold', allowed_capabilities: '[]' });
    db.close();

    const c = context({ path: fixture.path });
    try {
      const report = reconcile(c, { queuedStaleMs: 1000, outboxStaleMs: 1000 });
      expect(report.requeued).toEqual(['J-000001']);
      expect(new JobStore(c).get('J-000001')).toMatchObject({ status: 'queued', policy_decision: 'hold', allowed_capabilities: '[]' });
      expect(new JobStore(c).claim({ worker_id: 'dummy-worker' })).toEqual({ job: null });
      expect(() => new JobStore(c).claim({ worker_id: 'dummy-worker' }, 'J-000001')).toThrow(expect.objectContaining({ code: 'JOB_NOT_CLAIMABLE' }));
    } finally { c.close(); }
  } finally { if (db.open) db.close(); fixture.cleanup(); }
});

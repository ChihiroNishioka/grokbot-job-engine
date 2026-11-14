import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { migrate } from '../src/db/migrations.js';

test('G63/G69 migration v1 to v3 preserves rows, references, sequence and supports standalone commands twice', () => {
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
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(['jobs', 'delivery_outbox', 'job_events'].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toMatchObject(before);
    expect(db.prepare('SELECT sender_handle FROM jobs').all()).toEqual([{ sender_handle: null }]);
    const inserted = db.prepare(`INSERT INTO delivery_outbox(job_id,idempotency_key,kind,channel,target_chat_id,body,status,created_at,updated_at)
      VALUES (NULL,'cmd:new','command','genie','21','help','pending',2,2)`).run();
    expect(Number(inserted.lastInsertRowid)).toBeGreaterThan(20);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', {simple:true})).toBe(1);
    expect(() => db.prepare('SELECT received_at FROM ingress_messages').all()).not.toThrow();
  } finally { db.close(); }
});

test.each([0, 1, 2])('JE-SH12 openDb migrates v%s to v3 and reopening preserves rows and sequences', async version => {
  const { fileDb } = await import('./helpers/context.js');
  const { openDb } = await import('../src/db/open.js');
  const fixture = fileDb();
  let db = new Database(fixture.path);
  try {
    if (version !== 0) {
      let sql = readFileSync(new URL('./fixtures/v1.sql', import.meta.url), 'utf8');
      if (version === 2) sql = sql.replaceAll('job_id           TEXT NOT NULL REFERENCES', 'job_id           TEXT REFERENCES')
        .replaceAll('job_id      TEXT NOT NULL REFERENCES', 'job_id      TEXT REFERENCES')
        .replace("kind IN ('ack','progress','done','failed','cancelled')", "kind IN ('ack','progress','done','failed','cancelled','command')")
        .replace("channel IN ('imessage')", "channel IN ('imessage','genie')")
        .replace('PRAGMA user_version=1;', `CREATE TABLE ingress_messages (
          guid TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('job','command','ignored')),
          job_id TEXT REFERENCES jobs(job_id), outbox_id INTEGER REFERENCES delivery_outbox(outbox_id),
          received_at INTEGER NOT NULL, created_at INTEGER NOT NULL, command TEXT);
          CREATE INDEX ingress_job_idx ON ingress_messages(job_id,kind); PRAGMA user_version=2;`);
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
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(db.pragma('table_info(jobs)')).toContainEqual(expect.objectContaining({ name: 'sender_handle', type: 'TEXT', notnull: 0 }));
    if (version !== 0) {
      expect(db.prepare('SELECT sender_handle FROM jobs').all()).toEqual([{ sender_handle: null }]);
      expect(db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()).toEqual(sequences);
    }
    const before = db.prepare('SELECT * FROM jobs').all();
    for (let reopening = 0; reopening < 2; reopening++) {
      db.close(); db = openDb(fixture.path);
      expect(db.pragma('user_version', { simple: true })).toBe(3);
      expect(db.prepare('SELECT * FROM jobs').all()).toEqual(before);
      if (version !== 0) expect(db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()).toEqual(sequences);
    }
    expect(() => db.prepare(`INSERT INTO jobs(job_id,source,source_message_id,source_chat_id,requester_id,job_type,request_text,status,created_at,updated_at,max_attempts,sender_handle)
      VALUES ('J-000002','imessage','new-guid','21','member','general','request','queued',1,1,3,?)`).run('x'.repeat(257))).toThrow(/CHECK/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { if (db.open) db.close(); fixture.cleanup(); }
});

test('JE-SH12 refuses future v4 database', () => {
  const db = new Database(':memory:');
  try { db.pragma('user_version=4'); expect(() => migrate(db)).toThrow('Unsupported database version'); }
  finally { db.close(); }
});

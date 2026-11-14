import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { migrate } from '../src/db/migrations.js';

test('G63/G69 migration v1 to v2 preserves rows, references, sequence and supports standalone commands twice', () => {
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
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(['jobs', 'delivery_outbox', 'job_events'].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    const inserted = db.prepare(`INSERT INTO delivery_outbox(job_id,idempotency_key,kind,channel,target_chat_id,body,status,created_at,updated_at)
      VALUES (NULL,'cmd:new','command','genie','21','help','pending',2,2)`).run();
    expect(Number(inserted.lastInsertRowid)).toBeGreaterThan(20);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', {simple:true})).toBe(1);
    expect(() => db.prepare('SELECT received_at FROM ingress_messages').all()).not.toThrow();
  } finally { db.close(); }
});

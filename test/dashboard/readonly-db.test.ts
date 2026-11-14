import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDb, openReadonlyDb } from '../../src/db/open.js';

test('D10 readonly open preserves version, schema, and rows and rejects writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-readonly-'));
  const path = join(dir, 'jobs.sqlite');
  const writeDb = openDb(path);
  writeDb.prepare("INSERT INTO jobs(job_id,source,source_message_id,source_chat_id,requester_id,job_type,request_text,status,created_at,updated_at,max_attempts) VALUES ('J-000001','imessage','m1','c1','self','general','dummy','queued',1,1,3)").run();
  const beforeSchema = writeDb.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all();
  const version = Number(writeDb.pragma('user_version', { simple: true }));
  writeDb.close();
  const readDb = openReadonlyDb(path);
  expect(Number(readDb.pragma('user_version', { simple: true }))).toBe(version);
  expect(readDb.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all()).toEqual(beforeSchema);
  expect(readDb.prepare('SELECT job_id FROM jobs').all()).toEqual([{ job_id: 'J-000001' }]);
  expect(() => readDb.prepare("UPDATE jobs SET status='done'").run()).toThrow();
  readDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('D37 v4 migration adds only operator_actions and is repeatable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-migration-'));
  const path = join(dir, 'jobs.sqlite');
  const db = openDb(path);
  db.prepare("INSERT INTO jobs(job_id,source,source_message_id,source_chat_id,requester_id,job_type,request_text,status,created_at,updated_at,max_attempts) VALUES ('J-000001','imessage','m1','c1','self','general','dummy','queued',1,1,3)").run();
  const before = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name!='operator_actions' ORDER BY name").all();
  db.close();
  const raw = new Database(path);
  raw.exec('DROP TABLE operator_actions; PRAGMA user_version=4;');
  raw.close();
  const migrated = openDb(path);
  expect(Number(migrated.pragma('user_version', { simple: true }))).toBe(5);
  expect(migrated.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name!='operator_actions' ORDER BY name").all()).toEqual(before);
  expect(migrated.prepare('SELECT job_id FROM jobs').all()).toEqual([{ job_id: 'J-000001' }]);
  const schema = migrated.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='operator_actions'").get();
  expect(schema).toBeTruthy();
  migrated.close();
  const again = openDb(path);
  expect(Number(again.pragma('user_version', { simple: true }))).toBe(5);
  expect(again.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='operator_actions'").get()).toEqual({ n: 1 });
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

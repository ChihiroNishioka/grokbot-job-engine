import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/open.js';
import { migrate } from '../src/db/migrations.js';
import { loadConfig } from '../src/config/index.js';
import { JobStore } from '../src/store/jobs.js';
import { OutboxStore } from '../src/store/outbox.js';
import { reconcile } from '../src/reconciler/index.js';
import { mask } from '../src/logging/mask.js';
import { createLogger } from '../src/logging/logger.js';
import { createApp } from '../src/api/app.js';
import { createMockDispatcher } from '../src/dispatcher/mock.js';
import { createWebhookDispatcher } from '../src/dispatcher/webhook.js';
import { dispatchTick } from '../src/dispatcher/tick.js';
import { FakeClock } from './helpers/context.js';

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });
function fixture(filename = ':memory:', env: Record<string, string> = {}) {
  const clock = new FakeClock();
  const config = loadConfig({ JOB_API_TOKEN: 'dummy-'.repeat(8), ALLOWED_SOURCE_CHAT_IDS: 'chat-a,21', GENIE_TOKEN: 'dummy-genie-'.repeat(4), GENIE_ALLOWED_CHAT_IDS: '21', ...env });
  const db = openDb(filename);
  disposers.push(() => { if (db.open) db.close(); });
  const lines: string[] = [];
  const logger = createLogger(line => lines.push(line));
  const deps = { db, clock, config, logger };
  const jobs = new JobStore(deps);
  const outbox = new OutboxStore(deps);
  const app = createApp(deps);
  let seq = 0;
  const create = (extra: Partial<Parameters<JobStore['create']>[0]> = {}) => jobs.create({ source: 'imessage', source_message_id: `m-${++seq}`, source_chat_id: 'chat-a', requester_id: 'requester', request_text: 'private-request-marker', ...extra }).job;
  const claim = (id: string, worker_id = 'worker-a') => {
    const result = jobs.claim({ worker_id, lease_seconds: 10 }, id);
    if (!result.job || !('claim_token' in result)) throw new Error('Expected a claimed job');
    return result;
  };
  const tick = (limit = 100) => reconcile(deps, { queuedStaleMs: 1000, outboxStaleMs: 1000, limit });
  const request = (url: string, body?: unknown) => app.request(url, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${config.JOB_API_TOKEN}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...deps, jobs, outbox, app, lines, create, claim, tick, request };
}
function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-restart-'));
  disposers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'jobs.sqlite');
}
function changes(report: ReturnType<typeof reconcile>) {
  return report.requeued.length + report.failed.length + report.cancelled.length + report.outboxRequeued.length + report.outboxFailed.length;
}
function count(db: ReturnType<typeof openDb>, table: 'jobs' | 'job_runs' | 'job_events' | 'delivery_outbox') {
  return z.object({ n: z.number() }).parse(db.prepare(`SELECT count(*) AS n FROM ${table}`).get());
}
function enqueue(f: ReturnType<typeof fixture>, id: string, suffix = 'a') {
  return f.outbox.enqueue({ job_id: id, kind: 'done', idempotency_key: `delivery:${suffix}`, body: 'private-notification-marker' }).outbox;
}
function claimOutbox(f: ReturnType<typeof fixture>, id: number, worker_id = 'sender-a') {
  const result = f.outbox.claim({ worker_id, lease_seconds: 10, outbox_id: id });
  if (!result.outbox || !('claim_token' in result)) throw new Error('Expected a claimed outbox');
  return result;
}
function sensitiveValues() {
  return ['dummy-token-'.repeat(4), ['user', 'example.com'].join('@'), ['090', '1234', '5678'].join(''), ['box', 'ts', 'net'].join('.'), [100, 64, 2, 3].join('.')];
}

describe('Core persistence and recovery', () => {
  test('G26 old worker cannot heartbeat or complete after recovery and another claim', () => {
    const f = fixture(); const job = f.create(); const a = f.claim(job.job_id);
    f.clock.advance(10000); f.tick(); const b = f.claim(job.job_id, 'worker-b');
    expect(() => f.jobs.complete(job.job_id, { claim_token: a.claim_token, result: {} })).toThrow(expect.objectContaining({ code: 'CLAIM_TOKEN_MISMATCH' }));
    expect(() => f.jobs.heartbeat(job.job_id, { claim_token: a.claim_token })).toThrow(expect.objectContaining({ code: 'CLAIM_TOKEN_MISMATCH' }));
    f.jobs.complete(job.job_id, { claim_token: b.claim_token, result: { answer: 'ok' } });
    expect(f.db.prepare('SELECT outcome FROM job_runs ORDER BY run_id').all()).toEqual([{ outcome: 'lease_expired' }, { outcome: 'done' }]);
  });
  test('G33 G35 lease recovery is exact, clears claims and is idempotent', () => {
    const f = fixture(); const job = f.create(); f.claim(job.job_id);
    f.clock.advance(9999); expect(changes(f.tick())).toBe(0);
    f.clock.advance(1); expect(f.tick().requeued).toEqual([job.job_id]);
    expect(f.jobs.get(job.job_id)).toMatchObject({ status: 'queued', claimed_at: null, claimed_by: null, claim_token: null, lease_expires_at: null, heartbeat_at: null, attempts: 1 });
    expect(f.db.prepare('SELECT outcome,ended_at FROM job_runs').get()).toEqual({ outcome: 'lease_expired', ended_at: f.clock.now() });
    expect(f.db.prepare("SELECT reason FROM job_events WHERE type='job.requeued'").get()).toEqual({ reason: 'lease_expired' });
    expect(changes(f.tick())).toBe(0);
    const another = f.create(); const c = f.claim(another.job_id); f.clock.advance(9999);
    f.jobs.heartbeat(another.job_id, { claim_token: c.claim_token, lease_seconds: 10 }); f.clock.advance(1);
    expect(changes(f.tick())).toBe(0); expect(f.jobs.get(another.job_id).status).toBe('claimed');
  });
  test.each([{ cancel: false, max: 2, status: 'queued' }, { cancel: false, max: 1, status: 'failed' }, { cancel: true, max: 2, status: 'cancelled' }, { cancel: true, max: 1, status: 'cancelled' }])('G34 G53 exclusive recovery cancel=$cancel max=$max', ({ cancel, max, status }) => {
    const f = fixture(); const job = f.create({ max_attempts: max }); f.claim(job.job_id);
    if (cancel) f.jobs.cancel(job.job_id, {});
    f.clock.advance(10000); expect(changes(f.tick())).toBe(1); const row = f.jobs.get(job.job_id);
    expect(row.status).toBe(status);
    if (status === 'failed') expect(JSON.parse(row.error ?? '{}')).toMatchObject({ code: 'LEASE_EXPIRED_MAX_ATTEMPTS' });
    expect(f.db.prepare('SELECT outcome,ended_at FROM job_runs').get()).toEqual({ outcome: 'lease_expired', ended_at: f.clock.now() });
  });
  test('G53 queued exhausted attempts never become claimable', () => {
    const f = fixture(); const job = f.create({ max_attempts: 1 });
    f.db.prepare('UPDATE jobs SET attempts=max_attempts WHERE job_id=?').run(job.job_id);
    expect(f.jobs.claim({ worker_id: 'worker' })).toEqual({ job: null });
  });
  test('G36 outbox recovery and stale reports contain IDs without private contents', () => {
    const f = fixture(':memory:', { OUTBOX_MAX_ATTEMPTS: '2' });
    const old = f.create(); const pending = enqueue(f, old.job_id, 'pending'); const sending = enqueue(f, old.job_id, 'sending'); const exhausted = enqueue(f, old.job_id, 'exhausted');
    claimOutbox(f, sending.outbox_id); claimOutbox(f, exhausted.outbox_id);
    f.db.prepare('UPDATE delivery_outbox SET attempts=2 WHERE outbox_id=?').run(exhausted.outbox_id);
    f.clock.advance(10000); const fresh = f.create(); const freshOutbox = enqueue(f, fresh.job_id, 'fresh');
    const report = f.tick(); expect(report.outboxRequeued).toEqual([sending.outbox_id]); expect(report.outboxFailed).toEqual([exhausted.outbox_id]);
    expect(f.db.prepare('SELECT status,claimed_by,claim_token,lease_expires_at FROM delivery_outbox WHERE outbox_id=?').get(sending.outbox_id)).toEqual({ status: 'pending', claimed_by: null, claim_token: null, lease_expires_at: null });
    expect(report.staleQueued.map(x => x.id)).toContain(old.job_id); expect(report.staleQueued.map(x => x.id)).not.toContain(fresh.job_id);
    expect(report.staleOutbox.map(x => x.id)).toEqual(expect.arrayContaining([pending.outbox_id, sending.outbox_id, exhausted.outbox_id]));
    expect(report.staleOutbox.map(x => x.id)).not.toContain(freshOutbox.outbox_id);
    expect(JSON.stringify(report)).not.toContain('private-');
    for (const item of [...report.staleQueued, ...report.staleOutbox]) expect(Object.keys(item).sort()).toEqual(['ageMs', 'id']);
  });
  test('G37 restart preserves queued, claimed, done and pending notification and accepts original token', async () => {
    const filename = tempDb(); const f = fixture(filename);
    const queued = f.create(); const running = f.create(); const c = f.claim(running.job_id); const done = f.create(); const d = f.claim(done.job_id);
    f.jobs.complete(done.job_id, { claim_token: d.claim_token, result: { answer: 42 } }); const notification = enqueue(f, done.job_id);
    const before = f.db.prepare('SELECT * FROM jobs ORDER BY job_id').all(); const version = f.db.pragma('user_version', { simple: true });
    f.db.close(); const reopened = openDb(filename); disposers.push(() => reopened.close()); migrate(reopened); migrate(reopened);
    expect(reopened.pragma('user_version', { simple: true })).toBe(version); expect(reopened.prepare('SELECT * FROM jobs ORDER BY job_id').all()).toEqual(before);
    const app = createApp({ db: reopened, clock: f.clock, config: f.config, logger: f.logger });
    const response = await app.request(`/jobs/${running.job_id}/complete`, { method: 'POST', headers: { authorization: `Bearer ${f.config.JOB_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ claim_token: c.claim_token, result: { resumed: true } }) });
    expect(response.status).toBe(200); expect(new JobStore({ db: reopened, clock: f.clock, config: f.config }).get(queued.job_id).status).toBe('queued');
    expect(reopened.prepare('SELECT status FROM delivery_outbox WHERE outbox_id=?').get(notification.outbox_id)).toEqual({ status: 'pending' });
  });
  test.each(['claim', 'complete'] as const)('G51 audit INSERT failure rolls back job and run during %s', operation => {
    const f = fixture(); const job = f.create(); const c = operation === 'complete' ? f.claim(job.job_id) : null;
    const beforeJobs = f.db.prepare('SELECT * FROM jobs').all(); const beforeRuns = f.db.prepare('SELECT * FROM job_runs').all(); const beforeEvents = f.db.prepare('SELECT * FROM job_events').all();
    f.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON job_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    expect(() => operation === 'claim' ? f.claim(job.job_id) : f.jobs.complete(job.job_id, { claim_token: c?.claim_token ?? '', result: { answer: 42 } })).toThrow();
    expect(f.db.prepare('SELECT * FROM jobs').all()).toEqual(beforeJobs); expect(f.db.prepare('SELECT * FROM job_runs').all()).toEqual(beforeRuns); expect(f.db.prepare('SELECT * FROM job_events').all()).toEqual(beforeEvents);
  });
  test('G54 stale sender is fenced before and after another sender claims', () => {
    const f = fixture(); const job = f.create(); const row = enqueue(f, job.job_id); const a = claimOutbox(f, row.outbox_id);
    f.clock.advance(10000); f.tick();
    const oldSent = () => f.outbox.markSent(row.outbox_id, { claim_token: a.claim_token }); const oldFailed = () => f.outbox.markFailed(row.outbox_id, { claim_token: a.claim_token, error: { code: 'SEND_FAILED', message: 'delivery unavailable' } });
    expect(oldSent).toThrow(expect.objectContaining({ code: 'CLAIM_TOKEN_MISMATCH' })); expect(oldFailed).toThrow(expect.objectContaining({ code: 'CLAIM_TOKEN_MISMATCH' }));
    const b = claimOutbox(f, row.outbox_id, 'sender-b'); expect(oldSent).toThrow(expect.objectContaining({ code: 'CLAIM_TOKEN_MISMATCH' })); expect(oldFailed).toThrow(expect.objectContaining({ code: 'CLAIM_TOKEN_MISMATCH' }));
    expect(f.outbox.markSent(row.outbox_id, { claim_token: b.claim_token }).outbox.status).toBe('sent');
    const late = enqueue(f, job.job_id, 'late'); const lateClaim = claimOutbox(f, late.outbox_id); f.clock.advance(10000);
    expect(f.outbox.markSent(late.outbox_id, { claim_token: lateClaim.claim_token }).outbox.status).toBe('sent');
  });
  test.each(['complete', 'fail'] as const)('G56 %s and notify are atomic and duplicate safe', operation => {
    const f = fixture(); const job = f.create(); const c = f.claim(job.job_id); const body = 'private-notification-marker';
    const perform = () => operation === 'complete' ? f.jobs.complete(job.job_id, { claim_token: c.claim_token, result: { answer: 42 }, notify: { body } }) : f.jobs.fail(job.job_id, { claim_token: c.claim_token, error: { code: 'WORK_FAILED', message: 'unavailable' }, notify: { body } });
    perform(); const before = count(f.db, 'job_events'); perform(); expect(count(f.db, 'job_events')).toEqual(before);
    expect(f.db.prepare('SELECT idempotency_key,kind,body FROM delivery_outbox').all()).toEqual([{ idempotency_key: `job:${job.job_id}:${operation === 'complete' ? 'done' : 'failed'}:1`, kind: operation === 'complete' ? 'done' : 'failed', body }]);
    const rollback = f.create(); const r = f.claim(rollback.job_id); const beforeJobs = f.db.prepare('SELECT * FROM jobs').all(); const beforeRuns = f.db.prepare('SELECT * FROM job_runs').all(); const beforeEvents = f.db.prepare('SELECT * FROM job_events').all(); const beforeOutbox = f.db.prepare('SELECT * FROM delivery_outbox').all();
    f.db.exec("CREATE TRIGGER reject_notification BEFORE INSERT ON delivery_outbox BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END");
    expect(() => operation === 'complete' ? f.jobs.complete(rollback.job_id, { claim_token: r.claim_token, result: {}, notify: { body } }) : f.jobs.fail(rollback.job_id, { claim_token: r.claim_token, error: { code: 'FAIL', message: 'unavailable' }, notify: { body } })).toThrow();
    expect(f.db.prepare('SELECT * FROM jobs').all()).toEqual(beforeJobs); expect(f.db.prepare('SELECT * FROM job_runs').all()).toEqual(beforeRuns); expect(f.db.prepare('SELECT * FROM job_events').all()).toEqual(beforeEvents); expect(f.db.prepare('SELECT * FROM delivery_outbox').all()).toEqual(beforeOutbox);
  });
  test('G56 terminal jobs missing matching notification are reported after stale threshold', () => {
    const f = fixture(); const missing = f.create(); const c = f.claim(missing.job_id); f.jobs.complete(missing.job_id, { claim_token: c.claim_token, result: {} });
    const failed = f.create(); const b = f.claim(failed.job_id); f.jobs.fail(failed.job_id, { claim_token: b.claim_token, error: { code: 'FAIL', message: 'unavailable' }, notify: { body: 'notice' } });
    expect(f.tick().terminalWithoutOutbox).toEqual([]); f.clock.advance(1001);
    expect(f.tick().terminalWithoutOutbox).toEqual([{ id: missing.job_id, ageMs: 1001 }]);
  });
  test('G57 every outbox operation preserves every job column', () => {
    const f = fixture(':memory:', { OUTBOX_MAX_ATTEMPTS: '2' }); const job = f.create(); const c = f.claim(job.job_id); f.jobs.complete(job.job_id, { claim_token: c.claim_token, result: { answer: 42 } });
    const before = f.db.prepare('SELECT * FROM jobs').all(); const unchanged = () => expect(f.db.prepare('SELECT * FROM jobs').all()).toEqual(before);
    f.clock.advance(100); const row = enqueue(f, job.job_id); unchanged(); const a = claimOutbox(f, row.outbox_id); unchanged();
    f.outbox.markFailed(row.outbox_id, { claim_token: a.claim_token, retryable: true, error: { code: 'SEND', message: 'temporary' } }); unchanged();
    const b = claimOutbox(f, row.outbox_id); unchanged(); f.clock.advance(10000); f.tick(); unchanged();
    expect(f.db.prepare('SELECT status FROM delivery_outbox WHERE outbox_id=?').get(row.outbox_id)).toEqual({ status: 'failed' });
    const delivered = enqueue(f, job.job_id, 'delivered'); unchanged(); const d = claimOutbox(f, delivered.outbox_id); unchanged(); f.outbox.markSent(delivered.outbox_id, { claim_token: d.claim_token }); unchanged();
    const final = enqueue(f, job.job_id, 'final'); unchanged(); const e = claimOutbox(f, final.outbox_id); unchanged(); f.outbox.markFailed(final.outbox_id, { claim_token: e.claim_token, retryable: false, error: { code: 'SEND', message: 'permanent' } }); unchanged();
    expect(b.outbox.attempts).toBe(2);
  });
  test('G59 reconciliation processes limit, remainder, then zero', () => {
    const f = fixture(); for (let i = 0; i < 3; i++) f.claim(f.create().job_id);
    f.clock.advance(10000); expect(changes(f.tick(2))).toBe(2); expect(changes(f.tick(2))).toBe(1); expect(changes(f.tick(2))).toBe(0);
  });
});

describe('Masking and request logging', () => {
  test('G44 masks credentials and contact details while preserving job IDs and ISO timestamps', () => {
    const values = sensitiveValues(); const phone = ['+81', '90-1234-5678'].join(' ');
    for (const value of [...values, phone, `Bearer ${'a'.repeat(24)}`]) expect(mask(value)).toBe('[REDACTED]');
    expect(mask('J-000123')).toBe('J-000123'); expect(mask('2026-11-11T00:00:00.000Z')).toBe('2026-11-11T00:00:00.000Z');
    for (const key of ['password', 'secret', 'token']) expect(mask(`${key}=shortvalue`)).not.toContain('shortvalue');
  });
  test('G45 logs omit request text, authorization, claim token and outbox body', async () => {
    const f = fixture(); const job = f.create(); await f.request(`/jobs/${job.job_id}`); const c = f.claim(job.job_id);
    await f.request('/jobs', { source: 'imessage', source_message_id: 'http-create', source_chat_id: 'chat-a', requester_id: 'requester', request_text: 'http-private-request-marker' });
    await f.request(`/jobs/${job.job_id}/complete`, { claim_token: c.claim_token, result: {}, notify: { body: 'http-private-outbox-marker' } });
    const output = f.lines.join('\n'); expect(f.lines.length).toBeGreaterThanOrEqual(3);
    for (const value of ['http-private-request-marker', 'http-private-outbox-marker', f.config.JOB_API_TOKEN, c.claim_token]) expect(output).not.toContain(value);
    for (const line of f.lines) expect(JSON.parse(line)).toMatchObject({ method: expect.any(String), path: expect.any(String), status: expect.any(Number), ms: expect.any(Number), request_id: expect.any(String) });
  });
  test('G58 route patterns and unmatched paths keep arbitrary input out of logs', async () => {
    const f = fixture(); const job = f.create(); await f.request(`/jobs/${job.job_id}`); await f.request('/x/secret-like-value');
    const requests = f.lines.map(line => z.object({ path: z.string() }).parse(JSON.parse(line))); expect(requests.map(x => x.path)).toEqual(['/jobs/:id', 'unmatched']);
    expect(f.lines.join('\n')).not.toContain('secret-like-value');
    f.logger.info({ nested: { request_text: 'nested-request', body: 'nested-body', text: 'nested-text', authorization: 'nested-auth', token: 'nested-token', claim_token: 'nested-claim', password: 'nested-password', secret: 'nested-secret', api_key: 'nested-key', cookie: 'nested-cookie' } });
    const parsed = z.object({ nested: z.record(z.string(), z.string()) }).parse(JSON.parse(f.lines.at(-1) ?? '{}')); expect(Object.values(parsed.nested)).toEqual(Array(10).fill('[REDACTED]'));
  });
  test('G58 stored reasons, errors and exception logs mask arbitrary credentials', async () => {
    const f = fixture(); const values = sensitiveValues(); const message = values.join(' '); const job = f.create(); const c = f.claim(job.job_id);
    f.jobs.cancel(job.job_id, { reason: message }); f.jobs.fail(job.job_id, { claim_token: c.claim_token, error: { code: 'FAIL', message } });
    const row = enqueue(f, job.job_id); const out = claimOutbox(f, row.outbox_id); f.outbox.markFailed(row.outbox_id, { claim_token: out.claim_token, error: { code: 'SEND', message } });
    const saved = JSON.stringify({ events: f.db.prepare('SELECT reason,detail FROM job_events').all(), errors: f.db.prepare('SELECT error FROM jobs').all(), last_error: f.db.prepare('SELECT last_error FROM delivery_outbox').all() });
    f.logger.error({ error: new Error(message), message }); f.db.close(); const response = await f.request(`/jobs/${job.job_id}`); expect(response.status).toBe(500);
    for (const value of values) { expect(saved).not.toContain(value); expect(f.lines.join('\n')).not.toContain(value); expect(await response.clone().text()).not.toContain(value); }
    expect(saved).toContain('[REDACTED]');
  });
});

describe('Dispatcher wakes without owning job state', () => {
  test('G46 mock payload is minimal and creates a unique UUID for every wake', async () => {
    const dispatcher = createMockDispatcher({}); await dispatcher.wake(); await dispatcher.wake(); expect(dispatcher.calls).toHaveLength(2);
    for (const payload of dispatcher.calls) { expect(Object.keys(payload).sort()).toEqual(['event', 'event_id', 'v']); expect(payload).toMatchObject({ v: 1, event: 'jobs.available', event_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) }); }
    expect(dispatcher.calls[0]?.event_id).not.toBe(dispatcher.calls[1]?.event_id);
    for (const key of ['job_id', 'request_text', 'source_chat_id', 'source_message_id']) expect(JSON.stringify(dispatcher.calls)).not.toContain(key);
  });
  test.each([200, 500, 429, 'exception'] as const)('G47 webhook %s returns acceptance without changing any job', async status => {
    const f = fixture(); f.create(); const before = f.db.prepare('SELECT * FROM jobs').all(); const token = 'webhook-dummy-'.repeat(4); const query = 'private-query-marker'; const calls: RequestInit[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => { if (!init) throw new Error('Missing fetch init'); calls.push(init); if (status === 'exception') throw new Error(`${token} ${query}`); return new Response(null, { status }); };
    const dispatcher = createWebhookDispatcher({ url: `https://example.com/wake?private=${query}`, token, fetch: fakeFetch, timeoutMs: 1000 });
    const result = await dispatcher.wake(); expect(result.accepted).toBe(status === 200); expect(calls).toHaveLength(1); expect(calls[0]?.method).toBe('POST');
    const headers = new Headers(calls[0]?.headers); expect(headers.get('authorization')).toBe(`Bearer ${token}`); expect(headers.get('content-type')).toBe('application/json');
    const payload = z.record(z.string(), z.unknown()).parse(JSON.parse(String(calls[0]?.body))); expect(Object.keys(payload).sort()).toEqual(['event', 'event_id', 'v']);
    expect(f.db.prepare('SELECT * FROM jobs').all()).toEqual(before); expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain(query); expect(f.lines.join('\n')).not.toContain(token); expect(f.lines.join('\n')).not.toContain(query);
  });
  test.each([true, false])('G48 tick wakes once, respects cooldown after accepted=%s, and ignores future/exhausted work', async accept => {
    const f = fixture(); const dispatcher = createMockDispatcher({ accept }); const state: { lastWakeAt?: number } = {}; const tick = () => dispatchTick({ db: f.db, clock: f.clock, dispatcher, state, cooldownMs: 1000 });
    await tick(); expect(dispatcher.calls).toHaveLength(0);
    f.create({ scheduled_at: new Date(f.clock.now() + 5000).toISOString() }); await tick(); expect(dispatcher.calls).toHaveLength(0);
    const exhausted = f.create({ max_attempts: 1 }); f.db.prepare('UPDATE jobs SET attempts=max_attempts WHERE job_id=?').run(exhausted.job_id); await tick(); expect(dispatcher.calls).toHaveLength(0);
    const job = f.create(); await tick(); expect(dispatcher.calls).toHaveLength(1); expect(state.lastWakeAt).toBe(f.clock.now()); await tick(); expect(dispatcher.calls).toHaveLength(1);
    f.clock.advance(1000); await tick(); expect(dispatcher.calls).toHaveLength(2); f.jobs.cancel(job.job_id, {}); await tick(); expect(dispatcher.calls).toHaveLength(2);
  });
});

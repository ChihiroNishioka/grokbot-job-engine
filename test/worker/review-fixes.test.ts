import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { completion, failure } from '../../src/lib/reply-text.js';
import { JobApiClient } from '../../src/worker/client.js';
import { runWorkerOnce } from '../../src/worker/run-once.js';
import type { Transport } from '../../src/worker/transport.js';
import { context, input, job, token } from '../helpers/context.js';

const contexts: ReturnType<typeof context>[] = [];
afterEach(() => { for (const c of contexts.splice(0)) c.close(); });
function worker(override?: Transport['request']) {
  const c = context(); contexts.push(c);
  const transport: Transport = { request: override ?? (async request => {
    const response = await c.app.request(request.path, { method: request.method, headers: request.headers, body: request.body });
    return { ok: true, status: response.status, body: await response.text() };
  }) };
  return { c, client: new JobApiClient(transport, token) };
}

test('fix4 completion reserves artifacts and fixed text before trimming summary', () => {
  const url = 'https://example.invalid/artifact';
  const body = completion('J-000001', '📝'.repeat(2000), [url]);
  expect([...body]).toHaveLength(1500);
  expect(body).toContain('ジョブ J-000001 が完了しました。');
  expect(body).toContain(url);
  expect(body.endsWith(url)).toBe(true);
});

test('fix5 failure maps codes to safe fixed explanations', () => {
  expect(failure('J-000001', '/private/internal.sqlite SELECT secret')).toContain('原因：\n処理中にエラーが起きました');
  expect(failure('J-000001', '/private/internal.sqlite SELECT secret')).not.toContain('internal.sqlite');
  expect(failure('J-000001', 'LEASE_EXPIRED_MAX_ATTEMPTS')).toContain('実行期限切れが再試行の上限に達しました');
});

test('fix5 processor exception is masked in storage and never echoed to user', async () => {
  const { c, client } = worker();
  const id = job(await c.req('POST', '/jobs', input())).job_id;
  await runWorkerOnce({ client, claim: { worker_id: 'worker-a' }, process: async () => { throw new Error(`SELECT /private/internal.sqlite Bearer ${token}`); } });
  expect(job(await c.req('GET', `/jobs/${id}`)).error?.message).toContain('internal.sqlite');
  expect(job(await c.req('GET', `/jobs/${id}`)).error?.message).not.toContain(token);
  const notification = c.db.prepare('SELECT body FROM delivery_outbox').get();
  expect(JSON.stringify(notification)).not.toContain('internal.sqlite');
  expect(JSON.stringify(notification)).toContain('処理中にエラーが起きました');
});

test('fix8 documentation links centralized implementation and verification status', () => {
  for (const path of ['README.md', 'docs/worker.md', 'docs/genie.md']) {
    const text = readFileSync(path, 'utf8');
    expect(text, path).toContain('status.md');
  }
  const status = readFileSync('docs/status.md', 'utf8');
  expect(status).toContain('main.ts は Dispatcher を起動しません');
  expect(status).toContain('実機で未確認');
});

test('fix14 processor gets job claimToken and heartbeat cancellation', async () => {
  const { c, client } = worker();
  const id = job(await c.req('POST', '/jobs', input())).job_id;
  let heartbeats = 0;
  await runWorkerOnce({ client, claim: { worker_id: 'worker-a', lease_seconds: 10 }, process: async context => {
    expect(context).toHaveProperty('job.job_id', id);
    expect(context).toHaveProperty('claimToken');
    expect(context).toHaveProperty('heartbeat');
    c.clock.advance(9000);
    expect(await context.heartbeat()).toBe(false); heartbeats++;
    await c.req('POST', `/jobs/${id}/cancel`, {});
    expect(await context.heartbeat()).toBe(true); heartbeats++;
    throw new Error('cancelled');
  } });
  expect(heartbeats).toBe(2);
  expect(job(await c.req('GET', `/jobs/${id}`)).status).toBe('cancelled');
});

test('fix14 unreachable heartbeat prevents terminal writes even when caught by process', async () => {
  const c = context(); contexts.push(c);
  await c.req('POST', '/jobs', input());
  const calls: string[] = [];
  const client = new JobApiClient({ async request(request) {
    calls.push(request.path);
    if (request.path.endsWith('/heartbeat')) return { ok: false, unreachable: true, reason: 'connect_failed' };
    const response = await c.app.request(request.path, { method: request.method, headers: request.headers, body: request.body });
    return { ok: true, status: response.status, body: await response.text() };
  } }, token);
  const result = await runWorkerOnce({ client, claim: { worker_id: 'worker-a' }, process: async context => {
    try { await context.heartbeat(); } catch { /* The transport failure must survive a processor catch. */ }
    return { result: {} };
  } });
  expect(result).toEqual({ outcome: 'unreachable', reason: 'connect_failed' });
  expect(calls.some(path => /\/(complete|fail)$/.test(path))).toBe(false);
});

test('fix14 non-string summary uses fixed default and hides structured result', async () => {
  const { c, client } = worker();
  await c.req('POST', '/jobs', input());
  await runWorkerOnce({ client, claim: { worker_id: 'worker-a' }, process: async () => ({ result: { summary: { internal: 'internal-marker' } } }) });
  const notification = JSON.stringify(c.db.prepare('SELECT body FROM delivery_outbox').get());
  expect(notification).toContain('結果を保存しました。');
  expect(notification).not.toContain('internal-marker');
});

test('fix4 oversized mandatory artifacts return an explicit notification error without throwing', async () => {
  const { c, client } = worker();
  const id = job(await c.req('POST', '/jobs', input())).job_id;
  const result = await runWorkerOnce({ client, claim: { worker_id: 'worker-a' }, process: async () => ({ result: { summary: 'ok' }, artifact_urls: ['https://example.invalid/' + 'x'.repeat(1500)] }) });
  expect(result).toEqual({ outcome: 'notification_error', job_id: id, code: 'ARTIFACT_NOTIFICATION_TOO_LONG' });
  expect(job(await c.req('GET', `/jobs/${id}`)).status).toBe('claimed');
});

test('fix4 oversized artifacts can complete with an explicit compact notification', async () => {
  const { c, client } = worker();
  await c.req('POST', '/jobs', input());
  expect(await runWorkerOnce({ client, claim: { worker_id: 'worker-a' }, process: async () => ({ result: {}, artifact_urls: ['https://example.invalid/' + 'x'.repeat(1500)], notify: { body: '成果物を保存しました。' } }) })).toMatchObject({ outcome: 'done' });
});

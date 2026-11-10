import { afterEach, expect, test } from 'vitest';
import { JobApiClient } from '../../src/worker/client.js';
import { runWorkerOnce } from '../../src/worker/run-once.js';
import type { Transport } from '../../src/worker/transport.js';
import { reconcile } from '../../src/reconciler/index.js';
import { context, input, job, token } from '../helpers/context.js';
const contexts: ReturnType<typeof context>[] = [];
afterEach(() => { for (const c of contexts.splice(0)) c.close(); });

test.each(['claim', 'complete', 'fail'])('G73 unreachable at %s leaves lease recovery to reconciler', async stage => {
  const c = context(); contexts.push(c);
  const id = job(await c.req('POST', '/jobs', input())).job_id;
  const calls: string[] = [];
  let disconnected = true;
  const transport: Transport = { async request(request) {
    calls.push(request.path);
    if (disconnected && request.path.endsWith('/' + stage)) return { ok: false, unreachable: true, reason: 'connect_failed' };
    const response = await c.app.request(request.path, { method: request.method, headers: request.headers, body: request.body });
    return { ok: true, status: response.status, body: await response.text() };
  } };
  const client = new JobApiClient(transport, token);
  const process = async () => { if (stage === 'fail') throw new Error('processor failed'); return { result: { summary: 'completed' } }; };
  expect(await runWorkerOnce({ client, claim: { worker_id: 'worker-a', lease_seconds: 10 }, process })).toMatchObject({ outcome: 'unreachable' });
  expect(calls.filter(path => path.endsWith('/fail'))).toHaveLength(stage === 'fail' ? 1 : 0);
  const after = job(await c.req('GET', '/jobs/' + id));
  expect(after.status).toBe(stage === 'claim' ? 'queued' : 'claimed');
  c.clock.advance(10000);
  const report = reconcile(c, { queuedStaleMs: 0, outboxStaleMs: 0 });
  expect(report.requeued).toEqual(stage === 'claim' ? [] : [id]);
  disconnected = false;
  expect(await runWorkerOnce({ client, claim: { worker_id: 'worker-b', lease_seconds: 10 }, process: async () => ({ result: { summary: 'completed' }, artifact_urls: ['https://example.invalid/result'] }) })).toMatchObject({ outcome: 'done', job_id: id });
  expect(job(await c.req('GET', '/jobs/' + id)).status).toBe('done');
  const outbox = c.db.prepare('SELECT body FROM delivery_outbox').get();
  expect(outbox).toEqual({ body: `ジョブ ${id} が完了しました。\n\n結果：\ncompleted\n\n成果物：\nhttps://example.invalid/result` });
});

test('G73 only processing exceptions fail; API errors do not trigger fail', async () => {
  const c = context(); contexts.push(c);
  const id = job(await c.req('POST', '/jobs', input())).job_id;
  const paths: string[] = [];
  const transport: Transport = { async request(request) {
    paths.push(request.path);
    if (request.path.endsWith('/complete')) return { ok: true, status: 409, body: '{"error":{"code":"LEASE_EXPIRED"}}' };
    const response = await c.app.request(request.path, { method: request.method, headers: request.headers, body: request.body });
    return { ok: true, status: response.status, body: await response.text() };
  } };
  expect(await runWorkerOnce({ client: new JobApiClient(transport, token), claim: { worker_id: 'worker-a' }, process: async () => ({ result: { summary: 'ok' } }) })).toMatchObject({ outcome: 'api_error', status: 409 });
  expect(paths).not.toContain(`/jobs/${id}/fail`);
});

test('G73 processing exception alone produces fail with safe default notification', async () => {
  const c = context(); contexts.push(c);
  const id = job(await c.req('POST', '/jobs', input())).job_id;
  const transport: Transport = { async request(request) {
    const response = await c.app.request(request.path, { method: request.method, headers: request.headers, body: request.body });
    return { ok: true, status: response.status, body: await response.text() };
  } };
  expect(await runWorkerOnce({ client: new JobApiClient(transport, token), claim: { worker_id: 'worker-a' }, process: async () => { throw new Error(`Bearer ${token}`); } })).toMatchObject({ outcome: 'failed', job_id: id });
  expect(job(await c.req('GET', '/jobs/' + id)).status).toBe('failed');
  const rows = c.db.prepare('SELECT body FROM delivery_outbox').all();
  expect(JSON.stringify(rows)).not.toContain(token);
  expect(JSON.stringify(rows)).toContain(`/retry ${id}`);
});

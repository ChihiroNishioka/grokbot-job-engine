import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { completion } from '../../src/lib/reply-text.js';
import type { Transport } from '../../src/worker/transport.js';
import { JobApiClient } from '../../src/worker/client.js';
import { runWorkerOnce } from '../../src/worker/run-once.js';
import { runWorkerCli } from '../../src/worker-cli.js';
import { reconcile } from '../../src/reconciler/index.js';
import { JobStore } from '../../src/store/jobs.js';
import { context, input, rows, token } from '../helpers/context.js';
import { setup, payload, page } from '../ingress/helpers.js';

const contexts: ReturnType<typeof context>[] = [];
afterEach(() => { for (const c of contexts.splice(0)) c.close(); });
function worker(maxAttempts = 1) {
  const c = context(); contexts.push(c);
  new JobStore(c).create({ ...input(), source: 'imessage', max_attempts: maxAttempts });
  const transport = { async request(request: Parameters<Transport['request']>[0]) {
    const response = await c.app.request(request.path, { method: request.method, headers: request.headers, body: request.body });
    return { ok: true as const, status: response.status, body: await response.text() };
  } };
  return { c, transport, client: new JobApiClient(transport, token) };
}
function cliEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'mids-notify-'));
  const file = join(dir, 'token');
  writeFileSync(file, token, { mode: 0o600 });
  return { env: { JOB_API_TAILNET_HOST: 'dummy-host', JOB_API_TOKEN_FILE: file }, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test.each([1, 2])('G85 Worker failure offers retry exactly when attempts < max_attempts (%i)', async max => {
  const { c, client } = worker(max);
  const result = await runWorkerOnce({ client, claim: { worker_id: 'worker-a' }, process: async () => ({ ok: false, code: 'TIMEOUT' }) });
  expect(result).toMatchObject({ outcome: 'failed' });
  const body = String(rows(c, 'delivery_outbox')[0]?.body);
  if (max === 1) {
    expect(body).not.toContain('再実行する場合');
    expect(body).toContain('再実行の上限（1 回）に達したため、/retry はできません。');
  } else expect(body).toContain('/retry J-000001');
});

test('G85 Reconciler exhausted lease and retry command explain the attempt limit', async () => {
  const c = setup({ JOB_MAX_ATTEMPTS_DEFAULT: '1' }); contexts.push(c);
  await c.request('/ingress/genie', payload());
  const store = new JobStore(c);
  store.claim({ worker_id: 'worker-a', lease_seconds: 10 });
  c.clock.advance(10000);
  reconcile(c, { queuedStaleMs: 0, outboxStaleMs: 0 });
  const failed = c.table('delivery_outbox').find(row => row.kind === 'failed');
  expect(String(failed?.body)).not.toContain('再実行する場合');
  expect(String(failed?.body)).toContain('上限（1 回）');
  await c.request('/ingress/genie', payload({ guid: 'retry-guid', idempotency_key: 'retry-guid', text: '/retry J-000001' }));
  const replies = page.parse((await c.request('/genie/replies')).body).replies;
  expect(replies.at(-1)?.text).toContain('試行回数 1 回');
  expect(replies.at(-1)?.text).not.toContain('失敗のため');
});

test.each([1, 2])('G85 CLI fail uses server attempt counts and no-notify stays silent (%i)', async max => {
  const { c, client, transport } = worker(max);
  const settings = cliEnv();
  try {
    const claim = await client.claim({ worker_id: 'worker-a' });
    if (!claim.ok || !claim.data.job) throw new Error('claim failed');
    const args = { job_id: claim.data.job.job_id, claim_token: claim.data.claim_token, error: { code: 'TIMEOUT', message: '' } };
    expect((await runWorkerCli(['fail', JSON.stringify(args)], settings.env, { transport })).exitCode).toBe(0);
    const body = String(rows(c, 'delivery_outbox')[0]?.body);
    expect(body.includes('再実行する場合')).toBe(max > 1);
    const second = new JobStore(c).create({ ...input(), source: 'imessage', source_message_id: 'second-job', max_attempts: max }).job;
    const claimed = new JobStore(c).claim({ worker_id: 'worker-a' }, second.job_id);
    if (!claimed.job) throw new Error('claim failed');
    expect((await runWorkerCli(['fail', JSON.stringify({ ...args, job_id: second.job_id, claim_token: claimed.claim_token }), '--no-notify'], settings.env, { transport })).exitCode).toBe(0);
    expect(rows(c, 'delivery_outbox')).toHaveLength(1);
  } finally { settings.close(); }
});

test('G86 completion preserves prefix, 200 summary codepoints and ordered whole URLs with omission count', () => {
  const first = 'https://example.invalid/first';
  const huge = 'https://example.invalid/' + 'x'.repeat(1800);
  const last = 'https://example.invalid/last';
  const body = completion('J-000001', '📝'.repeat(2000), [first, huge, last]);
  expect([...body].length).toBeLessThanOrEqual(1500);
  expect(body.startsWith('ジョブ J-000001 が完了しました。\n\n結果：\n')).toBe(true);
  expect(body.split('📝').length - 1).toBeGreaterThanOrEqual(200);
  expect(body.indexOf(first)).toBeLessThan(body.indexOf(last));
  expect(body).not.toContain(huge);
  expect(body).toContain('ほか 1 件の成果物 URL は結果に保存しました。');
  expect(completion('J-000001', '短い結果', [huge])).toContain('短い結果');
});

test('G86 oversized artifact notification completes once and never requeues after lease expiry', async () => {
  const { c, client } = worker(2);
  const urls = ['https://example.invalid/' + 'x'.repeat(1800)];
  let processed = 0;
  const process = async () => { processed++; return { result: { summary: '保存した結果' }, artifact_urls: urls }; };
  expect(await runWorkerOnce({ client, claim: { worker_id: 'worker-a', lease_seconds: 10 }, process })).toMatchObject({ outcome: 'done' });
  expect(rows(c, 'jobs')[0]).toMatchObject({ status: 'done', result: JSON.stringify({ summary: '保存した結果' }), artifact_urls: JSON.stringify(urls) });
  c.clock.advance(10001);
  reconcile(c, { queuedStaleMs: 0, outboxStaleMs: 0 });
  expect(await runWorkerOnce({ client, claim: { worker_id: 'worker-a' }, process })).toEqual({ outcome: 'idle' });
  expect(processed).toBe(1);
  expect(rows(c, 'delivery_outbox')).toHaveLength(1);
});

test.each(['complete', 'fail'] as const)('G87 %s custom notifications share truncation and replacement flags in Worker and CLI', async verb => {
  const settings = cliEnv();
  try {
    for (const body of ['📝'.repeat(1501), '🧞‍♂️ 🪔']) {
      const a = worker(2);
      const result = await runWorkerOnce({ client: a.client, claim: { worker_id: 'worker-a' }, process: async () => verb === 'complete' ? { result: { summary: '保存済み' }, notify: { body } } : { ok: false, code: 'TIMEOUT', notify: { body } } });
      const flags = body.startsWith('📝') ? { notify_truncated: true } : { notify_replaced: true };
      expect(result).toMatchObject(flags);
      const b = worker(2);
      const claimed = new JobStore(b.c).claim({ worker_id: 'worker-a' });
      if (!claimed.job) throw new Error('claim failed');
      const args = { job_id: claimed.job.job_id, claim_token: claimed.claim_token, notify: { body }, ...(verb === 'complete' ? { result: { summary: '保存済み' } } : { error: { code: 'TIMEOUT', message: '' } }) };
      const output = await runWorkerCli([verb, JSON.stringify(args)], settings.env, { transport: b.transport });
      expect(output.exitCode).toBe(0);
      expect(JSON.parse(output.output)).toMatchObject(flags);
      expect(rows(a.c, 'delivery_outbox')[0]?.body).toBe(rows(b.c, 'delivery_outbox')[0]?.body);
      expect([...String(rows(b.c, 'delivery_outbox')[0]?.body)].length).toBeLessThanOrEqual(1500);
    }
  } finally { settings.close(); }
});

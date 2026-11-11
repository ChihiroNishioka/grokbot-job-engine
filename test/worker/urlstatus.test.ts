import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { completion } from '../../src/lib/reply-text.js';
import { runWorkerOnce } from '../../src/worker/run-once.js';
import { runWorkerCli } from '../../src/worker-cli.js';
import { JobApiClient } from '../../src/worker/client.js';
import type { Transport } from '../../src/worker/transport.js';
import { JobStore } from '../../src/store/jobs.js';
import { reconcile } from '../../src/reconciler/index.js';
import { token } from '../helpers/context.js';
import { setup, payload, created, page } from '../ingress/helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const url = (length = 1200, suffix = 'x') => 'https://example.invalid/' + suffix.repeat(length - 24);
async function fixture() {
  const c = setup(); cleanups.push(() => c.close());
  const id = created.parse((await c.request('/ingress/genie', payload())).body).job_id;
  const paths: string[] = [];
  const transport: Transport = { async request(request) {
    paths.push(request.path);
    const response = await c.app.request(request.path, { method: request.method, headers: request.headers, body: request.body });
    return { ok: true, status: response.status, body: await response.text() };
  } };
  const client = new JobApiClient(transport, token);
  let seq = 0;
  const command = async (text: string, chat_id = 21) => {
    const guid = `status-${++seq}`;
    const p = payload({ text, chat_id, guid, idempotency_key: guid });
    const first = await c.request('/ingress/genie', p);
    expect(await c.request('/ingress/genie', p)).toEqual(first);
    const replies = page.parse((await c.request('/genie/replies')).body).replies;
    return replies.find(r => r.in_reply_to_guid === guid)?.text ?? '';
  };
  return { c, id, client, transport, paths, command };
}
function cliEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'urlstatus-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'token'); writeFileSync(file, token, { mode: 0o600 });
  return { JOB_API_TAILNET_HOST: 'dummy-host', JOB_API_TOKEN_FILE: file };
}

test('G90 completion points omitted URLs to status with the job ID within 1500 codepoints', () => {
  const text = completion('J-000001', '📝'.repeat(2000), [url(), url(1200, 'y')]);
  expect(text).toContain('ほか 1 件の成果物 URL は /status J-000001 で確認できます。');
  expect([...text].length).toBeLessThanOrEqual(1500);
  expect(text.split('📝').length - 1).toBeGreaterThanOrEqual(200);
});

test('G91 status pages deliver all whole URLs only to the original chat, with idempotent replies', async () => {
  const f = await fixture(); const urls = Array.from({ length: 20 }, (_, n) => url(1200, String.fromCharCode(97 + n)));
  expect(await runWorkerOnce({ client: f.client, claim: { worker_id: 'worker' }, process: async () => ({ result: { summary: 'ok' }, artifact_urls: urls }) })).toMatchObject({ outcome: 'done', artifact_urls_omitted: 19 });
  const found: string[] = [];
  for (let n = 1; n <= urls.length; n++) {
    const text = await f.command(`/status ${f.id}${n === 1 ? '' : ` ${n}`}`);
    expect([...text].length).toBeLessThanOrEqual(1500);
    expect(text).toContain(`ジョブID：${f.id}\n状態：完了\n`);
    found.push(...text.split('\n').filter(line => line.startsWith('https://')));
    if (n < urls.length) expect(text).toContain(`/status ${f.id} ${n + 1}`);
    else expect(text).not.toContain(`/status ${f.id} ${n + 1}`);
  }
  expect(found).toEqual(urls);
  const foreign = await f.command(`/status ${f.id}`, 22);
  expect(foreign).toBe(await f.command('/status J-999999', 22));
  expect(foreign).toBe('ジョブが見つかりません。');
  for (const cmd of ['cancel', 'retry']) expect(await f.command(`/${cmd} ${f.id}`, 22)).toBe('ジョブが見つかりません。');
  expect(await f.command('/help')).toContain('/status <job_id> [ページ]');
  expect(await f.command(`/status ${f.id} 21`)).toContain('ページがありません');
});

test.each(['0', '-1', '1.5', 'abc', '9007199254740992', '1 2'])('G92 status explains invalid page %s', async value => {
  const f = await fixture();
  expect(await f.command(`/status ${f.id} ${value}`)).toContain('ページ番号');
});

test.each([
  { length: 1200, suffix: 'x' }, { length: 1201, suffix: 'x' },
  { length: 1200, suffix: '📝' }, { length: 1201, suffix: '📝' },
])('G93 API and CLI agree on URL length boundary $length with $suffix', async ({ length, suffix }) => {
  const f = await fixture(); const env = cliEnv();
  const claimed = await f.client.claim({ worker_id: 'worker' });
  if (!claimed.ok || !claimed.data.job) throw Error('claim missing');
  const args = { job_id: f.id, claim_token: claimed.data.claim_token, result: {}, artifact_urls: [url(length, suffix)] };
  const cli = await runWorkerCli(['complete', JSON.stringify(args)], env, { transport: f.transport });
  expect(cli.exitCode).toBe(length === 1200 ? 0 : 2);
  const { job_id, ...body } = args;
  expect((await f.c.req('POST', `/jobs/${job_id}/complete`, body)).status).toBe(length === 1200 ? 200 : 400);
});

test.each([url(1201), 'http://example.invalid/file', 'not-a-url', 'https://example.invalid/\nfile'])('G94 invalid process artifacts fail once before complete and never requeue (%#)', async invalid => {
  const f = await fixture(); let calls = 0;
  const process = async () => { calls++; return { result: {}, artifact_urls: [invalid] }; };
  expect(await runWorkerOnce({ client: f.client, claim: { worker_id: 'worker', lease_seconds: 10 }, process })).toMatchObject({ outcome: 'failed' });
  const job = new JobStore(f.c).get(f.id);
  expect(job.status).toBe('failed'); expect(JSON.parse(job.error ?? '{}')).toMatchObject({ code: 'INVALID_ARTIFACT', message: expect.stringContaining('artifact_urls') });
  const notification = f.c.table('delivery_outbox').find(row => row.kind === 'failed')?.body;
  expect(notification).toBe(`ジョブ ${f.id} の処理に失敗しました。\n\n原因：\n処理結果の成果物 URL が規則に合いませんでした\n\n同じ処理を再実行しても成果物 URL の規則違反は直らないため、処理側の修正が必要です。`);
  expect(notification).not.toContain('/retry');
  expect(f.paths.filter(path => path.endsWith('/complete'))).toHaveLength(0);
  expect(f.paths.filter(path => path.endsWith('/fail'))).toHaveLength(1);
  f.c.clock.advance(10001); reconcile(f.c, { queuedStaleMs: 0, outboxStaleMs: 0 });
  expect(await runWorkerOnce({ client: f.client, claim: { worker_id: 'worker' }, process })).toEqual({ outcome: 'idle' });
  expect(calls).toBe(1);
});

test('G95 CLI reports omissions only on success and never marks failed notification responses', async () => {
  const f = await fixture(); const env = cliEnv();
  const claimed = await f.client.claim({ worker_id: 'worker' });
  if (!claimed.ok || !claimed.data.job) throw Error('claim missing');
  const args = { job_id: f.id, claim_token: claimed.data.claim_token, result: { summary: 'ok' }, artifact_urls: [url(), url(1200, 'y')] };
  const success = await runWorkerCli(['complete', JSON.stringify(args)], env, { transport: f.transport });
  expect(JSON.parse(success.output)).toMatchObject({ ok: true, artifact_urls_omitted: 1 });
  for (const notifyBody of ['長'.repeat(1501), '🧞‍♂️ 🪔']) for (const verb of ['complete', 'fail']) for (const transport of [f.transport, { request: async () => ({ ok: false as const, unreachable: true as const, reason: 'timeout' as const }) }]) {
    const input = { ...args, claim_token: 'wrong', notify: { body: notifyBody } };
    const data = verb === 'complete' ? input : { job_id: f.id, claim_token: 'wrong', error: { code: 'TIMEOUT', message: '' }, notify: input.notify };
    const failed = await runWorkerCli([verb, JSON.stringify(data)], env, { transport });
    expect(JSON.parse(failed.output)).toMatchObject({ ok: false });
    for (const flag of ['notify_truncated', 'notify_replaced', 'artifact_urls_omitted']) expect(JSON.parse(failed.output)).not.toHaveProperty(flag);
  }
});

test('G91 status without done artifacts stays one page and foreign pages hide job existence', async () => {
  const f = await fixture();
  expect(await f.command(`/status ${f.id}`)).not.toContain('成果物');
  expect(await f.command(`/status ${f.id} 2`)).toContain('ページがありません');
  for (const value of ['', ' 999', ' 0', ' abc']) {
    const missing = await f.command(`/status J-999999${value}`, 22);
    expect(await f.command(`/status ${f.id}${value}`, 22)).toBe(missing);
    expect(missing).toBe('ジョブが見つかりません。');
  }
  await runWorkerOnce({ client: f.client, claim: { worker_id: 'worker' }, process: async () => ({ result: {}, artifact_urls: [] }) });
  expect(await f.command(`/status ${f.id}`)).toContain('状態：完了');
  expect(await f.command(`/status ${f.id}`)).not.toContain('成果物');
});

test('G91 compact URLs pack together and legacy oversized URLs are never cut', async () => {
  const f = await fixture(); const urls = ['https://example.invalid/a', 'https://example.invalid/b'];
  await runWorkerOnce({ client: f.client, claim: { worker_id: 'worker' }, process: async () => ({ result: {}, artifact_urls: urls }) });
  expect(await f.command(`/status ${f.id}`)).toContain(urls.join('\n'));
  expect(await f.command(`/status ${f.id}`)).not.toContain('次のページ');
  f.c.db.prepare('UPDATE jobs SET artifact_urls=? WHERE job_id=?').run(JSON.stringify([urls[0], url(1800)]), f.id);
  const text = await f.command(`/status ${f.id}`);
  expect(text).toContain('表示上限'); expect(text).not.toContain('https://');
});

test.each([{ urls: ['https://example.invalid/\nfile'] }, { urls: Array.from({ length: 21 }, () => 'https://example.invalid/file') }])('G93 API and CLI reject invalid URL shape or count (%#)', async ({ urls }) => {
  const f = await fixture(); const env = cliEnv();
  const claimed = await f.client.claim({ worker_id: 'worker' });
  if (!claimed.ok || !claimed.data.job) throw Error('claim missing');
  const args = { job_id: f.id, claim_token: claimed.data.claim_token, result: {}, artifact_urls: urls };
  expect((await runWorkerCli(['complete', JSON.stringify(args)], env, { transport: f.transport })).exitCode).toBe(2);
  const { job_id: _id, ...body } = args;
  expect((await f.c.req('POST', `/jobs/${_id}/complete`, body)).status).toBe(400);
});

test('G95 omission counts reflect custom notifications and no-notify with no false default flags', async () => {
  const f = await fixture(); const urls = ['https://example.invalid/a', 'https://example.invalid/b'];
  expect(await runWorkerOnce({ client: f.client, claim: { worker_id: 'worker' }, process: async () => ({ result: {}, artifact_urls: urls, notify: { body: urls[0] ?? '' } }) })).toMatchObject({ outcome: 'done', artifact_urls_omitted: 1 });
  const g = await fixture();
  const claimed = await g.client.claim({ worker_id: 'worker' });
  if (!claimed.ok || !claimed.data.job) throw Error('claim missing');
  const args = { job_id: g.id, claim_token: claimed.data.claim_token, result: {}, artifact_urls: urls };
  const result = await runWorkerCli(['complete', JSON.stringify(args), '--no-notify'], cliEnv(), { transport: g.transport });
  expect(JSON.parse(result.output)).toMatchObject({ ok: true, artifact_urls_omitted: 2 });
  expect(g.c.table('delivery_outbox').filter(row => row.kind === 'done')).toHaveLength(0);
});


test.each([1, 3])('G94 CLI fail INVALID_ARTIFACT uses the same safe default as Worker with max_attempts %i', async maxAttempts => {
  const f = await fixture();
  f.c.db.prepare('UPDATE jobs SET max_attempts=? WHERE job_id=?').run(maxAttempts, f.id);
  const claimed = await f.client.claim({ worker_id: 'worker' });
  if (!claimed.ok || !claimed.data.job) throw Error('claim missing');
  const sent: unknown[] = [];
  const transport: Transport = { async request(request) {
    if (request.path.endsWith('/fail')) sent.push(JSON.parse(request.body ?? '{}'));
    return f.transport.request(request);
  } };
  const args = { job_id: f.id, claim_token: claimed.data.claim_token, error: { code: 'INVALID_ARTIFACT', message: 'internal diagnostic' } };
  const result = await runWorkerCli(['fail', JSON.stringify(args)], cliEnv(), { transport });
  expect(result.exitCode).toBe(0);
  expect(sent).toEqual([expect.objectContaining({ notify: {} })]);
  const notification = f.c.table('delivery_outbox').find(row => row.kind === 'failed')?.body;
  expect(notification).toBe(`ジョブ ${f.id} の処理に失敗しました。\n\n原因：\n処理結果の成果物 URL が規則に合いませんでした\n\n同じ処理を再実行しても成果物 URL の規則違反は直らないため、処理側の修正が必要です。`);
  expect(notification).not.toContain('/retry');
  expect(notification).not.toContain('internal diagnostic');
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runWorkerCli } from '../../src/worker-cli.js';
import { JobApiClient } from '../../src/worker/client.js';
import { runWorkerOnce } from '../../src/worker/run-once.js';
import type { Transport } from '../../src/worker/transport.js';
import { claimToken, context, input, job, rows, token } from '../helpers/context.js';

const contexts: ReturnType<typeof context>[] = [];
afterEach(() => { for (const c of contexts.splice(0)) c.close(); });

function worker() {
  const c = context();
  contexts.push(c);
  const paths: string[] = [];
  const transport: Transport = { async request(request) {
    paths.push(request.path);
    const response = await c.app.request(request.path, { method: request.method, headers: request.headers, body: request.body });
    return { ok: true, status: response.status, body: await response.text() };
  } };
  return { c, transport, paths, client: new JobApiClient(transport, token) };
}

function expectCancellation(c: ReturnType<typeof context>, id: string) {
  expect(rows(c, 'jobs')).toMatchObject([{ status: 'cancelled', result: null }]);
  expect(rows(c, 'job_runs')).toMatchObject([{ outcome: 'cancelled', error_code: 'PROCESSING_ERROR' }]);
  expect(rows(c, 'delivery_outbox')).toMatchObject([{ kind: 'cancelled', body: `ジョブ ${id} はキャンセルしました。` }]);
  expect(rows(c, 'delivery_outbox')).toHaveLength(1);
}

test('G89 Worker stops after heartbeat cancellation and sends fail with only the cancellation notification', async () => {
  const { c, client, paths } = worker();
  const id = job(await c.req('POST', '/jobs', input())).job_id;
  let continued = false;
  const result = await runWorkerOnce({ client, claim: { worker_id: 'worker-a' }, process: async ({ heartbeat }) => {
    expect((await c.req('POST', `/jobs/${id}/cancel`, {})).status).toBe(200);
    if (await heartbeat()) return { ok: false, code: 'PROCESSING_ERROR', notify: { body: '独自の失敗通知は使わない' } };
    continued = true;
    return { result: { summary: '続行しない' } };
  } });
  expect(result).toMatchObject({ outcome: 'cancelled', job_id: id });
  expect(continued).toBe(false);
  expect(paths).toEqual(['/jobs/claim', `/jobs/${id}/heartbeat`, `/jobs/${id}/fail`]);
  expectCancellation(c, id);
});

test('G89 CLI heartbeat and fail cancel a claimed job and ignore custom notify body', async () => {
  const { c, transport, paths } = worker();
  const id = job(await c.req('POST', '/jobs', input())).job_id;
  const claimed = await c.req('POST', '/jobs/claim', { worker_id: 'worker-a' });
  const claim_token = claimToken(claimed);
  await c.req('POST', `/jobs/${id}/cancel`, {});
  const dir = mkdtempSync(join(tmpdir(), 'mids-cancel-cli-'));
  const file = join(dir, 'token');
  writeFileSync(file, token, { mode: 0o600 });
  const env = { JOB_API_TAILNET_HOST: 'dummy-host', JOB_API_TOKEN_FILE: file };
  try {
    const heartbeat = await runWorkerCli(['heartbeat', JSON.stringify({ job_id: id, claim_token })], env, { transport });
    expect(heartbeat.exitCode).toBe(0);
    expect(JSON.parse(heartbeat.output)).toMatchObject({ ok: true, data: { cancel_requested: true } });
    const failed = await runWorkerCli(['fail', JSON.stringify({ job_id: id, claim_token, error: { code: 'PROCESSING_ERROR', message: 'キャンセル要求を確認' }, notify: { body: '独自の失敗通知は使わない' } })], env, { transport });
    expect(failed.exitCode).toBe(0);
    expect(JSON.parse(failed.output)).toMatchObject({ ok: true, data: { job: { status: 'cancelled' } } });
    expect(paths).toEqual([`/jobs/${id}/heartbeat`, `/jobs/${id}/fail`]);
    expectCancellation(c, id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('G89 completion without checking heartbeat still finishes a job with cancel_requested', async () => {
  const { c, client, paths } = worker();
  const id = job(await c.req('POST', '/jobs', input())).job_id;
  const result = await runWorkerOnce({ client, claim: { worker_id: 'worker-a' }, process: async () => {
    await c.req('POST', `/jobs/${id}/cancel`, {});
    return { result: { summary: '完了を優先しました' } };
  } });
  expect(result).toMatchObject({ outcome: 'done', job_id: id });
  expect(paths).toEqual(['/jobs/claim', `/jobs/${id}/complete`]);
  expect(rows(c, 'jobs')).toMatchObject([{ status: 'done', cancel_requested: 1 }]);
  expect(rows(c, 'job_runs')).toMatchObject([{ outcome: 'done' }]);
  expect(rows(c, 'delivery_outbox')).toMatchObject([{ kind: 'done', body: expect.stringContaining('完了を優先しました') }]);
});

test('G89 worker guide explains cancellation decisions at the processing step', () => {
  const guide = readFileSync('docs/worker.md', 'utf8').split('## 1 回分の処理')[1]?.split('## 利用者に伝える失敗原因')[0] ?? '';
  expect(guide).toContain('heartbeat() が true');
  expect(guide).toContain('処理を止め');
  expect(guide).toContain('PROCESSING_ERROR');
  expect(guide).toContain('notify.body');
  expect(guide).toContain('キャンセルしました');
  expect(guide).toContain('heartbeat を呼ばず');
  expect(guide).toContain('done');
});

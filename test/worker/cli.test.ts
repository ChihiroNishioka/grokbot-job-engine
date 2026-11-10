import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { runWorkerCli } from '../../src/worker-cli.js';
import type { Transport } from '../../src/worker/transport.js';

test('G74 CLI codes and JSON output never expose file token or API echo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-cli-'));
  const token = 'dummy-cli-'.repeat(5);
  const file = join(dir, 'token');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  const env = { JOB_API_TAILNET_HOST: 'dummy-host', JOB_API_PORT: '3320', JOB_API_TOKEN_FILE: file };
  try {
    const unreachable: Transport = { async request() { return { ok: false, unreachable: true, reason: 'nc_not_found' }; } };
    const api: Transport = { async request() { return { ok: true, status: 401, body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: token } }) }; } };
    const success: Transport = { async request() { return { ok: true, status: 200, body: JSON.stringify({ job: {job_id: 'J-000001', request_text: `Bearer ${token}`}, claim_token: 'dummy-claim-'.repeat(4) }) }; } };
    for (const [argv, transport, expected] of [
      [['claim', '{"worker_id":"worker-a"}'], unreachable, 3],
      [['claim', '{"worker_id":"worker-a"}'], api, 4],
      [['unknown'], success, 2], [['claim', '{'], success, 2],
      [['claim', '{"worker_id":"worker-a"}'], success, 0],
    ] satisfies [string[], Transport, number][]) {
      const result = await runWorkerCli(argv, env, { transport });
      expect(result.exitCode).toBe(expected);
      expect(result.output).not.toContain(token);
      expect(result.output.trim().split('\n')).toHaveLength(1);
      expect(() => JSON.parse(result.output)).not.toThrow();
      if (expected === 0) expect(JSON.parse(result.output).data.claim_token).toBe('dummy-claim-'.repeat(4));
    }
    chmodSync(file, 0o644);
    expect((await runWorkerCli(['claim', '{}'], env, { transport: success })).exitCode).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('G74 CLI validates arguments before requesting transport', async () => {
  const transport: Transport = { request() { throw new Error('must not request'); } };
  for (const argv of [[], ['unknown'], ['claim', '{}'], ['get', '{"job_id":"invalid"}'], ['claim', '{}', 'extra']]) {
    const result = await runWorkerCli(argv, {}, { transport });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, error: 'USAGE_ERROR', reason: expect.any(String) });
  }
});

test.each([
  ['claim', { worker_id: 'worker-a' }, 'POST', '/jobs/claim'],
  ['get', { job_id: 'J-000001' }, 'GET', '/jobs/J-000001'],
  ['heartbeat', { job_id: 'J-000001', claim_token: 'dummy-claim' }, 'POST', '/jobs/J-000001/heartbeat'],
  ['complete', { job_id: 'J-000001', claim_token: 'dummy-claim', result: { summary: 'ok' } }, 'POST', '/jobs/J-000001/complete'],
  ['fail', { job_id: 'J-000001', claim_token: 'dummy-claim', error: { code: 'FAILED', message: 'safe' } }, 'POST', '/jobs/J-000001/fail'],
  ['outbox', { worker_id: 'worker-a' }, 'POST', '/outbox/claim'],
])('G74 CLI %s sends expected Job API request', async (verb, input, method, path) => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-cli-verbs-'));
  const token = 'dummy-cli-secret-'.repeat(3);
  const file = join(dir, 'token');
  writeFileSync(file, token, { mode: 0o600 });
  const requests: { method: string; path: string; body?: string }[] = [];
  const transport: Transport = { async request(request) {
    requests.push(request);
    expect(request.headers.Authorization).toBe(`Bearer ${token}`);
    return { ok: true, status: 200, body: path.endsWith('/heartbeat') ? '{"cancel_requested":false}' : '{"job":null}' };
  } };
  try {
    const result = await runWorkerCli([verb, JSON.stringify(input)], { JOB_API_TAILNET_HOST: 'dummy-host', JOB_API_TOKEN_FILE: file }, { transport });
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method, path });
    if (method === 'GET') expect(requests[0]?.body).toBeUndefined();
    else expect(requests[0]?.body).not.toContain('job_id');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fix1-9 CLI explains bad JSON, commands, config and token failures without file contents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-cli-reasons-'));
  const file = join(dir, 'private-token');
  const token = 'dummy-reason-token-'.repeat(3);
  writeFileSync(file, token, { mode: 0o600 });
  const env = { JOB_API_TAILNET_HOST: 'dummy-host', JOB_API_TOKEN_FILE: file };
  const argv = ['claim', '{"worker_id":"worker-a"}'];
  const transport: Transport = { async request() { return { ok: true, status: 400, body: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: '入力が正しくありません' } }) }; } };
  const check = async (args: string[], settings: NodeJS.ProcessEnv, reason: string) => {
    const result = await runWorkerCli(args, settings, { transport });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toEqual({ ok: false, error: 'USAGE_ERROR', reason });
    expect(result.output).not.toContain(file);
    expect(result.output).not.toContain(token);
  };
  try {
    await check(['claim', '{'], env, 'BAD_JSON');
    await check(['unknown'], env, 'UNKNOWN_COMMAND');
    await check(argv, {}, 'MISSING_CONFIG');
    chmodSync(file, 0o644);
    await check(argv, env, 'TOKEN_FILE_MODE');
    chmodSync(file, 0o600);
    writeFileSync(file, 'short');
    await check(argv, env, 'TOKEN_TOO_SHORT');
    writeFileSync(file, token);
    const api = await runWorkerCli(argv, env, { transport });
    expect(api.exitCode).toBe(4);
    expect(JSON.parse(api.output)).toMatchObject({ code: 'VALIDATION_ERROR', message: '入力が正しくありません' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fix1-10 CLI supplies completion and failure notifications unless --no-notify', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-cli-notify-'));
  const file = join(dir, 'token');
  writeFileSync(file, 'dummy-notify-token-'.repeat(3), { mode: 0o600 });
  const env = { JOB_API_TAILNET_HOST: 'dummy-host', JOB_API_TOKEN_FILE: file };
  const bodies: Record<string, unknown>[] = [];
  const transport: Transport = { async request(request) {
    bodies.push(JSON.parse(request.body ?? '{}'));
    return { ok: true, status: 200, body: '{"job":null}' };
  } };
  try {
    const complete = { job_id: 'J-000001', claim_token: 'dummy-claim', result: { summary: '保存しました' }, artifact_urls: ['https://example.invalid/result'] };
    const fail = { job_id: 'J-000001', claim_token: 'dummy-claim', error: { code: 'UNKNOWN_CODE', message: 'private SQL detail' } };
    for (const [verb, input] of [['complete', complete], ['fail', fail]] as const) {
      expect((await runWorkerCli([verb, JSON.stringify(input)], env, { transport })).exitCode).toBe(0);
    }
    expect(bodies[0]).toMatchObject({ notify: { body: 'ジョブ J-000001 が完了しました。\n\n結果：\n保存しました\n\n成果物：\nhttps://example.invalid/result' } });
    expect(bodies[1]).toMatchObject({ notify: { body: 'ジョブ J-000001 の処理に失敗しました。\n\n原因：\n処理中にエラーが起きました\n\n再実行する場合：\n/retry J-000001' } });
    for (const [verb, input] of [['complete', complete], ['fail', fail]] as const) {
      expect((await runWorkerCli([verb, JSON.stringify(input), '--no-notify'], env, { transport })).exitCode).toBe(0);
    }
    expect(bodies[2]).not.toHaveProperty('notify');
    expect(bodies[3]).not.toHaveProperty('notify');
    expect((await runWorkerCli(['complete', JSON.stringify({ ...complete, notify: { body: '独自の通知。' } })], env, { transport })).exitCode).toBe(0);
    expect(bodies[4]).toMatchObject({ notify: { body: '独自の通知。' } });
    expect((await runWorkerCli(['complete', JSON.stringify({ ...complete, result: { summary: { private: 'detail' } } })], env, { transport })).exitCode).toBe(0);
    expect(bodies[5]).toMatchObject({ notify: { body: expect.stringContaining('結果を保存しました。') } });
    const oversized = await runWorkerCli(['complete', JSON.stringify({ ...complete, artifact_urls: ['https://example.invalid/' + 'x'.repeat(1500)] })], env, { transport });
    expect(oversized.exitCode).toBe(2);
    expect(JSON.parse(oversized.output)).toMatchObject({ reason: 'ARTIFACT_NOTIFICATION_TOO_LONG' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

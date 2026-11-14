import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { runWorkerCli } from '../../src/worker-cli.js';
import type { Transport } from '../../src/worker/transport.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'worker-stdin-'));
  const file = join(dir, 'token');
  writeFileSync(file, 'dummy-stdin-token-'.repeat(3), { mode: 0o600 });
  const env = { JOB_API_TAILNET_HOST: 'dummy-host', JOB_API_TOKEN_FILE: file };
  return { env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('G88 stdin waits for EOF and preserves multiline summaries and apostrophes', async () => {
  const { env, cleanup } = setup();
  const stdin = new PassThrough();
  const requests: string[] = [];
  const summary = "一行目の '引用'\n二行目\n" + '長い要約。'.repeat(1000);
  const transport: Transport = { async request(request) {
    requests.push(request.body ?? '');
    return { ok: true, status: 200, body: '{"job":null}' };
  } };
  let settled = false;
  try {
    const pending = runWorkerCli(['complete', '-'], env, { transport, stdin }).then(result => { settled = true; return result; });
    const body = Buffer.from(JSON.stringify({ job_id: 'J-000001', claim_token: 'dummy-claim', result: { summary } }));
    stdin.write(body.subarray(0, 80));
    stdin.write(body.subarray(80));
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(settled).toBe(false);
    expect(requests).toHaveLength(0);
    stdin.end();
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0] ?? '{}').result.summary).toBe(summary);
  } finally { stdin.destroy(); cleanup(); }
});

test('G88 stdin accepts exactly one MiB measured as bytes across UTF-8 chunks', async () => {
  const { env, cleanup } = setup();
  const stdin = new PassThrough();
  const json = JSON.stringify({ job_id: 'J-000001', claim_token: 'dummy-claim', result: { summary: '日'.repeat(100000) } });
  const body = Buffer.from(json + ' '.repeat(1024 * 1024 - Buffer.byteLength(json)));
  const transport: Transport = { async request() { return { ok: true, status: 200, body: '{"job":null}' }; } };
  try {
    const pending = runWorkerCli(['complete', '-'], env, { transport, stdin });
    stdin.write(body.subarray(0, 101));
    stdin.end(body.subarray(101));
    expect((await pending).exitCode).toBe(0);
  } finally { stdin.destroy(); cleanup(); }
});

test('G88 stdin rejects more than one MiB without exposing body or values', async () => {
  const stdin = new PassThrough();
  const transport: Transport = { request() { throw new Error('must not request'); } };
  const pending = runWorkerCli(['claim', '-'], {}, { transport, stdin });
  const marker = 'private-input-marker';
  stdin.write(Buffer.from(marker));
  stdin.end(Buffer.from('日'.repeat(Math.ceil(1024 * 1024 / 3))));
  const result = await pending;
  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.output)).toEqual({ ok: false, error: 'USAGE_ERROR', reason: 'STDIN_TOO_LARGE' });
  expect(result.output).not.toContain(marker);
  expect(result.output).not.toContain('日');
});

test.each(['', '{"private-input-marker":', '{"worker_id":"private-input-marker"} trailing'])('G88 stdin invalid JSON returns BAD_JSON without input values (%#)', async text => {
  const stdin = new PassThrough();
  const pending = runWorkerCli(['claim', '-'], {}, { stdin });
  stdin.end(text);
  const result = await pending;
  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.output)).toEqual({ ok: false, error: 'USAGE_ERROR', reason: 'BAD_JSON' });
  expect(result.output).not.toContain('private-input-marker');
});

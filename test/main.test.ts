import { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerType } from '@hono/node-server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const servers = vi.hoisted((): Server[] => []);
vi.mock('@hono/node-server', () => ({
  createAdaptorServer: () => { const server = new Server(); servers.push(server); return server; },
}));
let lines: string[];
let stderr: ReturnType<typeof vi.spyOn>;
let originalExitCode: typeof process.exitCode;
let signals: { int: ((signal: 'SIGINT') => void)[]; term: ((signal: 'SIGTERM') => void)[] };
let databaseDir: string;
beforeEach(() => {
  vi.resetModules();
  servers.length = 0;
  lines = [];
  originalExitCode = process.exitCode;
  signals = { int: process.listeners('SIGINT'), term: process.listeners('SIGTERM') };
  vi.stubEnv('JOB_API_TOKEN', 'dummy-job-'.repeat(5));
  vi.stubEnv('GENIE_TOKEN', 'dummy-genie-'.repeat(5));
  vi.stubEnv('DASHBOARD_TOKEN', 'dummy-dashboard-token-'.repeat(2));
  vi.stubEnv('DASHBOARD_ALIAS_KEY', 'dummy-dashboard-alias-key-'.repeat(2));
  vi.stubEnv('DASHBOARD_ALIASES', '{}');
  vi.stubEnv('ALLOWED_SOURCE_CHAT_IDS', '21');
  vi.stubEnv('GENIE_ALLOWED_CHAT_IDS', '21');
  databaseDir = mkdtempSync(join(tmpdir(), 'job-engine-main-'));
  vi.stubEnv('DATABASE_PATH', join(databaseDir, 'jobs.sqlite'));
  vi.stubEnv('RECONCILE_INTERVAL_SECONDS', '0');
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) { return this; });
});
afterEach(() => {
  for (const server of servers) server.close();
  for (const listener of process.listeners('SIGINT')) if (!signals.int.includes(listener)) process.removeListener('SIGINT', listener);
  for (const listener of process.listeners('SIGTERM')) if (!signals.term.includes(listener)) process.removeListener('SIGTERM', listener);
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(databaseDir, { recursive: true, force: true });
});

test.each([
  [0, 'job_api', 'EADDRINUSE'], [0, 'job_api', 'EADDRNOTAVAIL'],
  [1, 'genie', 'EADDRINUSE'], [1, 'genie', 'EADDRNOTAVAIL'],
  [2, 'dashboard', 'EADDRINUSE'], [2, 'dashboard', 'EADDRNOTAVAIL'],
] as const)('listen failure %s %s %s is one safe line and exit 1', async (index, listener, code) => {
  const { startMain } = await import('../src/main.js');
  startMain({ listen: () => undefined });
  const error = Object.assign(new Error('dummy-address-private'), { code, address: 'dummy-address-private' });
  expect(() => servers[index]?.emit('error', error)).not.toThrow();
  expect(process.exitCode).toBe(1);
  expect(lines).toEqual([JSON.stringify({ event: 'listen.failed', listener, code }) + '\n']);
  expect(stderr).not.toHaveBeenCalled();
});

test('startup reports invalid environment names without values', async () => {
  vi.stubEnv('PORT', 'dummy-private-value');
  vi.stubEnv('GENIE_HOST', 'dummy-private-host');
  const { startMain } = await import('../src/main.js');
  startMain({ listen: () => undefined });
  expect(lines).toEqual([JSON.stringify({ event: 'startup.failed', fields: ['GENIE_HOST', 'PORT'] }) + '\n']);
  expect(process.exitCode).toBe(1);
  expect(stderr).not.toHaveBeenCalled();
});


test('handlers precede injected listen and synchronous failure closes all listeners', async () => {
  const { startMain } = await import('../src/main.js');
  const close = vi.spyOn(Server.prototype, 'close');
  const listen = vi.fn((server: ServerType) => {
    expect(servers).toHaveLength(3);
    expect(servers.every(item => item.listenerCount('error') > 0)).toBe(true);
    server.emit('error', Object.assign(new Error('dummy-private-address'), { code: 'EADDRINUSE' }));
  });
  startMain({ listen });
  expect(listen).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(3);
  expect(process.exitCode).toBe(1);
  expect(lines).toEqual([JSON.stringify({ event: 'listen.failed', listener: 'job_api', code: 'EADDRINUSE' }) + '\n']);
  expect(stderr).not.toHaveBeenCalled();
});

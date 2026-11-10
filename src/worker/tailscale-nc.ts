import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { encodeRequest, decodeResponse } from './http.js';
import type { Transport, TransportResult } from './transport.js';

interface Child {
  stdin: Writable; stdout: Readable;
  once(event: 'error', listener: (error: Error & { code?: string }) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  kill(): boolean;
}
export interface Timer {
  set(callback: () => void, ms: number): ReturnType<typeof setTimeout> | number;
  clear(handle: ReturnType<typeof setTimeout> | number): void;
}
export interface NcOptions {
  host: string; port: number; binary?: string; timeoutMs?: number;
  spawn?: (binary: string, args: string[]) => Child;
  timer?: Timer;
}
const systemTimer: Timer = { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle) };
export function createTailscaleNcTransport(options: NcOptions): Transport {
  const spawn = options.spawn ?? ((binary, args) => nodeSpawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'] }));
  const timer = options.timer ?? systemTimer;
  return { request(request) {
    return new Promise<TransportResult>(resolve => {
      let child: Child;
      const state: { handle?: ReturnType<typeof setTimeout> | number } = {};
      let settled = false;
      const finish = (result: TransportResult) => {
        if (settled) return;
        settled = true;
        if (state.handle !== undefined) timer.clear(state.handle);
        resolve(result);
      };
      try { child = spawn(options.binary ?? 'tailscale', ['nc', options.host, String(options.port)]); }
      catch (error) { finish({ ok: false, unreachable: true, reason: error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'nc_not_found' : 'connect_failed' }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout.on('data', (data: Buffer | string) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { finish({ ok: false, unreachable: true, reason: 'connect_failed' }); child.kill(); return; }
        chunks.push(chunk);
      });
      child.once('error', error => finish({ ok: false, unreachable: true, reason: 'code' in error && error.code === 'ENOENT' ? 'nc_not_found' : 'connect_failed' }));
      child.stdin.on('error', () => { finish({ ok: false, unreachable: true, reason: 'connect_failed' }); child.kill(); });
      child.once('close', () => {
        const parsed = decodeResponse(Buffer.concat(chunks));
        finish(parsed ? { ok: true, ...parsed } : { ok: false, unreachable: true, reason: 'connect_failed' });
      });
      state.handle = timer.set(() => { finish({ ok: false, unreachable: true, reason: 'timeout' }); child.kill(); }, options.timeoutMs ?? 15000);
      try { child.stdin.end(encodeRequest(request, options.host, options.port)); }
      catch { finish({ ok: false, unreachable: true, reason: 'connect_failed' }); child.kill(); }
    });
  } };
}

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { encodeRequest } from '../../src/worker/http.js';
import { createTailscaleNcTransport } from '../../src/worker/tailscale-nc.js';

const request = { method: 'GET', path: '/healthz', headers: {} };
const ipv6 = '2001:db8::1';

test.each([
  { name: 'bare IPv6', host: ipv6, authority: `[${ipv6}]:3320` },
  { name: 'bracketed IPv6', host: `[${ipv6}]`, authority: `[${ipv6}]:3320` },
  { name: 'IPv4', host: '192.0.2.1', authority: '192.0.2.1:3320' },
  { name: 'hostname', host: 'dummy-host', authority: 'dummy-host:3320' },
])('G84 encodeRequest uses a valid Host for $name', async ({ host, authority }) => {
  const raw = encodeRequest(request, host, 3320).toString();
  const actualHost = /^Host: (.+)\r$/m.exec(raw)?.[1];
  expect(actualHost === authority).toBe(true);
  const app = new Hono();
  app.get('/healthz', c => c.json({ ok: true }));
  const response = await app.request(new URL('/healthz', `http://${actualHost}`), { headers: { Host: authority } });
  expect(response.status).toBe(200);
});

test('G84 tailscale nc receives bare IPv6 separately from the port and sends bracketed Host', async () => {
  class Child extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    kill = vi.fn(() => {
      this.stdin.destroy();
      this.stdout.destroy();
      this.emit('close', 0);
      return true;
    });
    constructor() {
      super();
      this.stdin.on('finish', () => {
        this.stdout.destroy();
        this.emit('close', 0);
      });
    }
  }
  const child = new Child();
  const spawn = vi.fn(() => child);
  let sent = '';
  child.stdin.on('data', data => {
    sent += String(data);
    queueMicrotask(() => child.stdout.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'));
  });
  const transport = createTailscaleNcTransport({
    host: ipv6, port: 3320, spawn,
    timer: { set: () => 1, clear: () => {} },
  });
  expect(await transport.request(request)).toEqual({ ok: true, status: 200, body: '{}' });
  const args = spawn.mock.calls[0];
  expect(JSON.stringify(args) === JSON.stringify(['tailscale', ['nc', ipv6, '3320']])).toBe(true);
  expect(sent.includes(`\r\nHost: [${ipv6}]:3320\r\n`)).toBe(true);
  expect(child.stdin.writableEnded).toBe(false);
  expect(child.kill).toHaveBeenCalledOnce();
});

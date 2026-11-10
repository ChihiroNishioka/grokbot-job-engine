import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { createTailscaleNcTransport } from '../../src/worker/tailscale-nc.js';

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  kill = vi.fn(() => true);
}
function setup() {
  const child = new Child();
  const spawn = vi.fn(() => child);
  let fire = () => {};
  const timer = { set: vi.fn((fn: () => void) => { fire = fn; return 1; }), clear: vi.fn() };
  const transport = createTailscaleNcTransport({ host: 'dummy-host', port: 3320, spawn, timer });
  return { child, spawn, timer, transport, timeout: () => fire() };
}
const request = { method: 'POST', path: '/jobs/claim', headers: { Authorization: `Bearer ${'dummy-worker-'.repeat(4)}` }, body: JSON.stringify({ worker_id: 'worker-a', note: '日本語' }) };
describe('tailscale nc transport', () => {
  test.each(['length', 'chunked'])('G71 HTTP/1.1 request and fragmented %s response', async framing => {
    const s = setup();
    let sent = '';
    s.child.stdin.on('data', data => { sent += String(data); });
    const pending = s.transport.request(request);
    expect(s.spawn).toHaveBeenCalledWith('tailscale', ['nc', 'dummy-host', '3320']);
    expect(sent).toContain('POST /jobs/claim HTTP/1.1\r\n');
    expect(sent).toContain(`Authorization: ${request.headers.Authorization}\r\n`);
    expect(sent).toContain(`Content-Length: ${Buffer.byteLength(request.body)}\r\n`);
    expect(sent).toContain('Connection: close\r\n');
    expect(sent).toContain('\r\n\r\n' + request.body);
    const body = '{"ok":"日本語"}';
    const payload = framing === 'length' ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : `Transfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(body).toString(16)};note=value\r\n${body}\r\n0\r\n\r\n`;
    const response = Buffer.from('HTTP/1.1 200 OK\r\n' + payload);
    for (let i = 0; i < response.length; i += 7) s.child.stdout.write(response.subarray(i, i + 7));
    s.child.emit('close', 0);
    expect(await pending).toEqual({ ok: true, status: 200, body });
    expect(s.timer.clear).toHaveBeenCalled();
  });
  test('G72 ENOENT is nc_not_found without throwing', async () => {
    const s = setup();
    const pending = s.transport.request(request);
    s.child.emit('error', Object.assign(new Error('hidden'), { code: 'ENOENT' }));
    expect(await pending).toEqual({ ok: false, unreachable: true, reason: 'nc_not_found' });
  });
  test('G72 empty response is connect_failed', async () => {
    const s = setup(); const pending = s.transport.request(request);
    s.child.emit('close', 1);
    expect(await pending).toEqual({ ok: false, unreachable: true, reason: 'connect_failed' });
  });
  test('G72 injected timeout kills child and late close cannot change result', async () => {
    const s = setup(); const pending = s.transport.request(request);
    s.timeout(); s.child.emit('close', 0);
    expect(await pending).toEqual({ ok: false, unreachable: true, reason: 'timeout' });
    expect(s.child.kill).toHaveBeenCalledOnce();
    expect(s.timer.set).toHaveBeenCalledWith(expect.any(Function), 15000);
  });
  test.each(['HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n{}', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{}'])('G72 truncated HTTP never succeeds', async raw => {
    const s = setup(); const pending = s.transport.request(request);
    s.child.stdout.write(raw); s.child.emit('close', 0);
    expect(await pending).toMatchObject({ ok: false });
  });
});

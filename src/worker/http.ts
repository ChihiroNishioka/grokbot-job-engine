import type { HttpRequest } from './transport.js';

export function encodeRequest(request: HttpRequest, host: string, port: number): Buffer {
  if (!/^[A-Z]+$/.test(request.method) || !/^\/[^\r\n ]*$/.test(request.path) || /[\r\n]/.test(host)) throw new Error('Invalid HTTP request');
  const body = request.body ?? '';
  const headers = Object.entries(request.headers).filter(([name]) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase()));
  if (headers.some(([name, value]) => !/^[A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(value))) throw new Error('Invalid HTTP headers');
  return Buffer.from(`${request.method} ${request.path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n${body}`);
}
export function decodeResponse(raw: Buffer): { status: number; body: string } | null {
  const boundary = raw.indexOf('\r\n\r\n');
  if (boundary < 0) return null;
  const [line, ...lines] = raw.subarray(0, boundary).toString('latin1').split('\r\n');
  const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: |$)/.exec(line ?? '');
  if (!match) return null;
  const headers = new Map<string, string>();
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index < 1) return null;
    const name = line.slice(0, index).toLowerCase();
    if (headers.has(name)) return null;
    headers.set(name, line.slice(index + 1).trim());
  }
  const payload = raw.subarray(boundary + 4);
  const transfer = headers.get('transfer-encoding');
  if (transfer) {
    if (transfer.toLowerCase() !== 'chunked' || headers.has('content-length')) return null;
    let offset = 0;
    const chunks: Buffer[] = [];
    while (offset < payload.length) {
      const end = payload.indexOf('\r\n', offset);
      if (end < 0) return null;
      const sizeText = payload.subarray(offset, end).toString('ascii').split(';')[0] ?? '';
      if (!/^[0-9a-f]+$/i.test(sizeText)) return null;
      const size = Number.parseInt(sizeText, 16);
      offset = end + 2;
      if (!Number.isSafeInteger(size)) return null;
      if (size === 0) {
        const trailers = payload.subarray(offset);
        if (!trailers.equals(Buffer.from('\r\n')) && trailers.indexOf('\r\n\r\n') < 0) return null;
        return { status: Number(match[1]), body: Buffer.concat(chunks).toString('utf8') };
      }
      if (offset + size + 2 > payload.length || payload.subarray(offset + size, offset + size + 2).toString() !== '\r\n') return null;
      chunks.push(payload.subarray(offset, offset + size));
      offset += size + 2;
    }
    return null;
  }
  const length = headers.get('content-length');
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || payload.length !== Number(length))) return null;
  return { status: Number(match[1]), body: payload.toString('utf8') };
}

import { mask } from './mask.js';

export interface Logger { info(value: unknown): void; error(value: unknown): void }
const sensitive = new Set(['request_text', 'body', 'text', 'authorization', 'token', 'claim_token', 'password', 'secret', 'api_key', 'cookie']);

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return mask(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) return { name: mask(value.name), message: mask(value.message) };
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.has(key.toLowerCase()) ? '[REDACTED]' : sanitize(item, seen)]));
}

export function createLogger(sink: (line: string) => void): Logger {
  const write = (value: unknown) => sink(JSON.stringify(sanitize(value, new WeakSet())));
  return { info: write, error: write };
}

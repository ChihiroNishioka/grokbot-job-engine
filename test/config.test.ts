import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config/index.js';

const valid = () => ({ JOB_API_TOKEN: 'dummy-'.repeat(8), ALLOWED_SOURCE_CHAT_IDS: 'chat-a,chat-b' });
const ranges = {
  PORT: [1, 65535], LEASE_SECONDS_DEFAULT: [10, 3600], LEASE_SECONDS_MAX: [10, 86400],
  JOB_MAX_ATTEMPTS_DEFAULT: [1, 10], REQUEST_TEXT_MAX_CHARS: [1, 100000],
  RESULT_MAX_CHARS: [1, 1000000], BODY_MAX_BYTES: [1024, 10485760],
  RATE_LIMIT_PER_MINUTE: [1, 100000], OUTBOX_LEASE_SECONDS: [10, 3600],
  OUTBOX_MAX_ATTEMPTS: [1, 20], QUEUED_STALE_SECONDS: [1, 604800],
  OUTBOX_STALE_SECONDS: [1, 604800], RECONCILE_INTERVAL_SECONDS: [0, 86400],
} satisfies Record<string, [number, number]>;

function rejected(env: NodeJS.ProcessEnv, secret?: string) {
  let error: unknown;
  try { loadConfig(env); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error && secret) expect(error.message).not.toContain(secret);
}

describe('configuration', () => {
  test('G01 missing and short tokens fail without leaking values', () => {
    rejected({ ALLOWED_SOURCE_CHAT_IDS: 'chat-a' });
    for (const token of ['', 'sensitive-dummy', 'x'.repeat(31)]) rejected({ ...valid(), JOB_API_TOKEN: token }, token);
    expect(loadConfig({ ...valid(), JOB_API_TOKEN: 'x'.repeat(32) })).toBeDefined();
  });
  test('G02 required chats, host default and numeric ranges', () => {
    rejected({ JOB_API_TOKEN: valid().JOB_API_TOKEN });
    rejected({ ...valid(), ALLOWED_SOURCE_CHAT_IDS: '' });
    rejected({ ...valid(), ALLOWED_SOURCE_CHAT_IDS: ' , ' });
    expect(loadConfig(valid())).toMatchObject({ HOST: '127.0.0.1', ALLOWED_SOURCE_CHAT_IDS: ['chat-a', 'chat-b'] });
    rejected({ ...valid(), PORT: '0' });
  });
  test('G60 all integer ranges and default lease relationship', () => {
    for (const [key, [min, max]] of Object.entries(ranges)) {
      for (const value of [String(min - 1), String(max + 1), '1.5', 'NaN', '']) rejected({ ...valid(), [key]: value }, value);
      const adjusted = key === 'LEASE_SECONDS_MAX' ? { LEASE_SECONDS_DEFAULT: '10' } : {};
      for (const value of [min, max]) expect(loadConfig({ ...valid(), ...adjusted, [key]: String(value) })).toBeDefined();
    }
    rejected({ ...valid(), LEASE_SECONDS_DEFAULT: '301', LEASE_SECONDS_MAX: '300' });
  });
});

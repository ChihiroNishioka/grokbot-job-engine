import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/index.js';

const valid = () => ({ JOB_API_TOKEN: 'dummy-'.repeat(8), ALLOWED_SOURCE_CHAT_IDS: 'chat-a,chat-b,21', GENIE_TOKEN: 'dummy-genie-'.repeat(4), DASHBOARD_TOKEN: 'dummy-dashboard-token-'.repeat(2), DASHBOARD_ALIAS_KEY: 'dummy-dashboard-alias-key-'.repeat(2), DASHBOARD_ALIASES: '{}', GENIE_ALLOWED_CHAT_IDS: '21', OWNER_NOTIFY_CHAT_ID: '21' });
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
  test.each(['0', '0.0.0.00', '0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::0', '::ffff:0.0.0.0', '0:0:0:0:0:ffff:0:0', '::FFFF:0:0', 'localhost', 'remote.invalid'])('G61 HOST rejects nonliteral or unspecified address %s', HOST => {
    rejected({ ...valid(), HOST }, HOST);
  });
  test.each(['127.0.0.1', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '192.0.2.10', '2001:db8::1'])('G61 HOST accepts specified IP literal %s', HOST => {
    expect(loadConfig({ ...valid(), HOST }).HOST).toBe(HOST);
  });
  test('G01 missing and short tokens fail without leaking values', () => {
    rejected({ ALLOWED_SOURCE_CHAT_IDS: 'chat-a' });
    for (const token of ['', 'sensitive-dummy', 'x'.repeat(31)]) rejected({ ...valid(), JOB_API_TOKEN: token }, token);
    expect(loadConfig({ ...valid(), JOB_API_TOKEN: 'x'.repeat(32) })).toBeDefined();
  });
  test('G02 required chats, host default and numeric ranges', () => {
    rejected({ JOB_API_TOKEN: valid().JOB_API_TOKEN });
    rejected({ ...valid(), ALLOWED_SOURCE_CHAT_IDS: '' });
    rejected({ ...valid(), ALLOWED_SOURCE_CHAT_IDS: ' , ' });
    expect(loadConfig(valid())).toMatchObject({ HOST: '127.0.0.1', ALLOWED_SOURCE_CHAT_IDS: ['chat-a', 'chat-b', '21'] });
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


test('G61 separated listeners and Genie configuration reject unsafe values without revealing them', () => {
  const bad = {
    GENIE_HOST: ['0.0.0.0', 'remote.invalid'], HOST: ['0.0.0.0', '::'],
    GENIE_TOKEN: ['', 'dummy-short', valid().JOB_API_TOKEN],
    GENIE_ALLOWED_CHAT_IDS: ['', ' ', '21,no', '1.5', '9007199254740992', '22'],
    GENIE_PORT: ['0', '65536'], GENIE_REPLY_PAGE_LIMIT: ['0', '101'],
  };
  for (const [key, values] of Object.entries(bad)) {
    for (const value of values) rejected({ ...valid(), [key]: value }, value);
  }
  rejected({ ...valid(), GENIE_TOKEN: undefined });
  rejected({ ...valid(), GENIE_ALLOWED_CHAT_IDS: undefined });
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    expect(loadConfig({ ...valid(), GENIE_HOST: host })).toMatchObject({
      GENIE_HOST: host, GENIE_PORT: 3321, GENIE_REPLY_PAGE_LIMIT: 50, GENIE_ALLOWED_CHAT_IDS: [21],
    });
  }
});

test.each([undefined, '', ' ', ', ,', '22', '22,', ' 22, ,22 '])('JE-SH1 group chats parse empty elements and default disabled (%s)', value => {
  const config = loadConfig({ ...valid(), ALLOWED_SOURCE_CHAT_IDS: '21,22', GENIE_ALLOWED_CHAT_IDS: '21,22', GENIE_GROUP_CHAT_IDS: value });
  expect(config).toMatchObject({ GENIE_GROUP_CHAT_IDS: value?.includes('22') ? value.match(/22/g)?.map(Number) : [] });
});

test.each([
  { GENIE_GROUP_CHAT_IDS: '23', GENIE_ALLOWED_CHAT_IDS: '21,22' },
  { GENIE_GROUP_CHAT_IDS: 'x', GENIE_ALLOWED_CHAT_IDS: '21,22' },
  { GENIE_GROUP_CHAT_IDS: '1.5', GENIE_ALLOWED_CHAT_IDS: '21,22' },
  { GENIE_GROUP_CHAT_IDS: '9007199254740992', GENIE_ALLOWED_CHAT_IDS: '21,22' },
  { GENIE_GROUP_CHAT_IDS: '22', GENIE_ALLOWED_CHAT_IDS: '21' },
])('JE-SH1/A6 group chats must be safe integers and a Genie subset (%s)', overrides => {
  let error: unknown;
  try { loadConfig({ ...valid(), ALLOWED_SOURCE_CHAT_IDS: '21,22', ...overrides }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ConfigError);
  expect(error).toMatchObject({ fields: ['GENIE_GROUP_CHAT_IDS'] });
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) expect(error.message).not.toContain(overrides.GENIE_GROUP_CHAT_IDS);
});

test.each([
  ['missing owner chat', undefined, ['21', '22'], ['22']],
  ['empty owner chat', '', ['21', '22'], ['22']],
  ['invalid owner chat', 'not-a-chat', ['21', '22'], ['22']],
  ['owner chat outside allowed set', '23', ['21', '22'], ['22']],
  ['owner chat overlaps group', '22', ['21', '22'], ['22']],
])('JE-FP1 rejects %s without revealing the configured value', (_name, owner, allowed, groups) => {
  let error: unknown;
  try {
    loadConfig({ ...valid(), ALLOWED_SOURCE_CHAT_IDS: allowed.join(','), GENIE_ALLOWED_CHAT_IDS: allowed.join(','), GENIE_GROUP_CHAT_IDS: groups.join(','), OWNER_NOTIFY_CHAT_ID: owner });
  } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ConfigError);
  expect(error).toMatchObject({ fields: ['OWNER_NOTIFY_CHAT_ID'] });
  if (error instanceof Error && owner) expect(error.message).not.toContain(owner);
});

test('JE-FP1 owner chat defaults empty and a valid private chat is accepted', () => {
  expect(loadConfig({ ...valid(), OWNER_NOTIFY_CHAT_ID: undefined }).OWNER_NOTIFY_CHAT_ID).toBeNull();
  expect(loadConfig({ ...valid(), ALLOWED_SOURCE_CHAT_IDS: '21,22', GENIE_ALLOWED_CHAT_IDS: '21,22', GENIE_GROUP_CHAT_IDS: '22', OWNER_NOTIFY_CHAT_ID: '21' }).OWNER_NOTIFY_CHAT_ID).toBe(21);
});

import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { JobStore } from '../../src/store/jobs.js';
import { statusReply } from '../../src/ingress/status-text.js';
import { payload, setup, created, page } from './helpers.js';

const phone = ['+1', '555', '010', '0000'].join('');
const H = `tel:${phone}`;
const E = 'email:family@example.com';
const short = ['555', '0100'].join('');
const contexts: ReturnType<typeof setup>[] = [];
afterEach(() => { for (const c of contexts.splice(0)) c.close(); });
function fixture(env: Record<string, string> = { GENIE_GROUP_CHAT_IDS: '22' }) {
  const c = setup(env); contexts.push(c); return c;
}
function family(overrides: Record<string, unknown> = {}) {
  return payload({ chat_id: 22, sender_is_me: false, sender_handle: H, text: '🪔 天気を調べて', ...overrides });
}
const noRows = (c: ReturnType<typeof setup>) => {
  for (const table of ['jobs', 'delivery_outbox', 'ingress_messages'] as const) expect(c.table(table), table).toHaveLength(0);
};

test('JE-SH2 default group config ignores valid family handle', async () => {
  const c = fixture({});
  expect(await c.request('/ingress/genie', family({ chat_id: 21 }))).toEqual({ status: 200, body: { status: 'ignored', reason: 'not_from_me' } });
  noRows(c);
});

test.each([H, E])('JE-SH3 accepted family job stores first handle (%#)', async handle => {
  const c = fixture();
  const r = await c.request('/ingress/genie', family({ sender_handle: handle }));
  expect(r.status).toBe(201);
  const id = created.parse(r.body).job_id;
  expect(c.table('jobs')).toHaveLength(1);
  expect(c.table('jobs')[0]).toMatchObject({ job_id: id, requester_id: 'member', sender_handle: handle, source_chat_id: '22', request_text: '天気を調べて' });
  expect(c.table('delivery_outbox')).toHaveLength(1);
  expect(c.table('delivery_outbox')[0]).toMatchObject({ kind: 'ack', channel: 'genie', target_chat_id: '22', job_id: id });
  expect(c.table('ingress_messages')).toHaveLength(1);
  expect(c.table('ingress_messages')[0]).toMatchObject({ kind: 'job', job_id: id });
  expect(JSON.stringify(c.table('job_events'))).not.toContain(handle);
  expect(JSON.stringify(c.table('ingress_messages'))).not.toContain(handle);
});

test.each([{ chat_id: 22, sender_handle: undefined }, { chat_id: 21 }])('JE-SH4 family requires both group and handle (%#)', async overrides => {
  const c = fixture();
  expect(await c.request('/ingress/genie', family(overrides))).toEqual({ status: 200, body: { status: 'ignored', reason: 'not_from_me' } });
  noRows(c);
});

const maxMail = `email:${'a'.repeat(64)}@${'b'.repeat(180)}.com`;
const accepted = [H, `tel:${['090', '0000', '0000'].join('')}`, `tel:${short}`, E, maxMail];
const rejected: unknown[] = ['', null, 1, phone, `TEL:${phone}`, 'tel:+1 555', 'tel:+', 'tel:++1', 'tel:1-555', 'email:Family@example.com', 'email:family@exämple.com', 'email:family', 'email:a@b', ` ${H}`, `${H} `, `${H}\u0000`, `${H}\n`, maxMail + 'xx', 'mailto:family@example.com', `tel:${'1'.repeat(21)}`];
test.each(accepted)('JE-SH5 RED accepted contract table (%#)', async handle => {
  const c = fixture();
  expect(await c.request('/ingress/genie', family({ sender_handle: handle }))).toMatchObject({ status: 201 });
  expect(c.table('jobs')[0]?.sender_handle).toBe(handle);
});
test.each(rejected)('JE-SH5 regression invalid contract table (%#)', async handle => {
  const c = fixture();
  const r = await c.request('/ingress/genie', family({ sender_handle: handle }));
  expect(r).toEqual({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: '入力が正しくありません' } } });
  noRows(c);
  const output = JSON.stringify([r.body, c.logs]);
  if (typeof handle === 'string' && handle.length > 1) expect(output).not.toContain(handle);
});

test('JE-SH6 self rejects handle and self without handle retains null', async () => {
  const c = fixture();
  expect((await c.request('/ingress/genie', payload({ sender_handle: H }))).status).toBe(400);
  noRows(c);
  expect((await c.request('/ingress/genie', payload())).status).toBe(201);
  expect(c.table('jobs')[0]).toMatchObject({ requester_id: 'self', sender_handle: null });
});
test('JE-SH7 regression strict ingress and Job API', async () => {
  const c = fixture();
  expect((await c.request('/ingress/genie', payload({ extra: true }))).status).toBe(400);
  expect((await c.req('POST', '/jobs', { source: 'imessage', source_chat_id: '22', source_message_id: 'api', requester_id: 'self', request_text: 'test', sender_handle: H })).status).toBe(400);
  noRows(c);
});

test('JE-SH8 A8 family commands have no side effects; owner cancels queued and claimed family jobs', async () => {
  const c = fixture();
  const owner = await c.request('/ingress/genie', payload({ chat_id: 22 }));
  const ownerId = created.parse(owner.body).job_id;
  const before = c.table('jobs');
  for (const text of ['/help', `/status ${ownerId}`, `/cancel ${ownerId}`, `/retry ${ownerId}`, '/cancel invalid']) {
    const guid = `family-command-${text}`;
    expect(await c.request('/ingress/genie', family({ guid, idempotency_key: guid, text }))).toEqual({ status: 200, body: { status: 'ignored', reason: 'command_not_allowed' } });
    expect(c.table('jobs')).toEqual(before);
    expect(c.table('delivery_outbox')).toHaveLength(1);
    expect(c.table('ingress_messages')).toHaveLength(1);
  }
  const store = new JobStore(c);
  for (const claimed of [false, true]) {
    const guid = `family-${claimed}`;
    const id = created.parse((await c.request('/ingress/genie', family({ guid, idempotency_key: guid }))).body).job_id;
    if (claimed) expect(store.claim({ worker_id: 'dummy-worker' }, id).job).not.toBeNull();
    const cancelGuid = `owner-cancel-${claimed}`;
    expect((await c.request('/ingress/genie', payload({ chat_id: 22, guid: cancelGuid, idempotency_key: cancelGuid, text: `/cancel ${id}` }))).body).toEqual({ status: 'command', command: 'cancel' });
    expect(store.get(id)).toMatchObject(claimed ? { status: 'claimed', cancel_requested: 1 } : { status: 'cancelled' });
  }
});

test('JE-SH9 family too_long precedes command restriction and is idempotent', async () => {
  const c = fixture({ GENIE_GROUP_CHAT_IDS: '22', REQUEST_TEXT_MAX_CHARS: '10' });
  const p = family({ text: '/help ' + 'a'.repeat(5) });
  for (let n = 0; n < 2; n++) expect(await c.request('/ingress/genie', p)).toEqual({ status: 200, body: { status: 'rejected', reason: 'too_long' } });
  expect(c.table('delivery_outbox')).toHaveLength(1);
  expect(c.table('delivery_outbox')[0]).toMatchObject({ idempotency_key: 'cmd:guid-a', kind: 'command' });
  expect(c.table('jobs')).toHaveLength(0);
});
test.each([['🧞‍♂️ 返事', 'bot_reply'], ['🪔', 'empty']])('JE-SH10 family filtering (%#)', async (text, reason) => {
  const c = fixture();
  expect(await c.request('/ingress/genie', family({ text }))).toEqual({ status: 200, body: { status: 'ignored', reason } });
  noRows(c);
});

test('JE-SH11 guid wins over sender changes and concurrent redelivery; missing handle remains ignored', async () => {
  const c = fixture();
  const first = await c.request('/ingress/genie', family());
  expect(first.status).toBe(201);
  const before = c.table('jobs');
  for (const result of [await c.request('/ingress/genie', family({ sender_handle: E })), ...await Promise.all([H, E, H].map(sender_handle => c.request('/ingress/genie', family({ sender_handle })))), await c.request('/ingress/genie', payload({ chat_id: 22 }))]) {
    expect(result).toEqual({ status: 200, body: first.body });
  }
  expect(await c.request('/ingress/genie', family({ sender_handle: undefined }))).toEqual({ status: 200, body: { status: 'ignored', reason: 'not_from_me' } });
  expect(c.table('jobs')).toEqual(before);
  expect(c.table('delivery_outbox')).toHaveLength(1);
  expect(c.table('ingress_messages')).toHaveLength(1);
  expect(before[0]).toMatchObject({ sender_handle: H, requester_id: 'member' });
});

test.each([H, E])('JE-SH15 A2 A4 status and completion redact handles while preserving URL content (%#)', async handle => {
  const c = fixture();
  const id = created.parse((await c.request('/ingress/genie', family({ sender_handle: handle }))).body).job_id;
  const store = new JobStore(c);
  const claim = store.claim({ worker_id: 'dummy-worker' }, id);
  if (!claim.job) throw Error('Missing claim');
  const bare = handle.slice(handle.indexOf(':') + 1);
  const urls = [`https://example.com/x/${bare}/y`, `https://example.com/${'a'.repeat(40)}`, 'https://example.com/result?key=abc&view=all'];
  store.complete(id, { claim_token: claim.claim_token, result: {}, used_capabilities: ['lookup'], artifact_urls: urls, notify: { body: urls.join('\n') } });
  const original = statusReply(store.get(id), true);
  for (const [n, suffix] of ['', ' 1'].entries()) {
    const guid = `owner-status-${n}`;
    expect((await c.request('/ingress/genie', payload({ chat_id: 22, guid, idempotency_key: guid, text: `/status ${id}${suffix}` }))).status).toBe(200);
    const text = z.string().parse(c.table('delivery_outbox').at(-1)?.body);
    expect(text).not.toContain(handle);
    expect(text).not.toContain(bare);
    expect(text).not.toContain('tel:');
    expect(text).toBe(original.replaceAll(bare, '[REDACTED]'));
    expect(text).toContain('https://example.com/x/[REDACTED]/y');
    expect(text).toContain(urls[1]);
    expect(text).toContain(urls[2]);
  }
  const completed = c.table('delivery_outbox').find(row => row.kind === 'done');
  expect(completed?.body).toBe(urls.join('\n').replaceAll(bare, '[REDACTED]'));
});

test('JE-SH15b denied member email requests do not expose the private text', async () => {
  const c = fixture();
  const response = await c.request('/ingress/genie', family({ sender_handle: E, text: '🪔 今日の天気は？ メールの内容を教えて' }));
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ status: 'rejected', reason: 'policy_denied' });
  const reply = z.string().parse(c.table('delivery_outbox')[0]?.body);
  expect(reply).not.toContain('メールの内容');
  expect(reply).not.toContain('family@example.com');
  const replies = page.parse((await c.request('/genie/replies')).body);
  expect(replies.replies[0]?.text).not.toContain('family@example.com');
});

test('JE-SH15 regression self ack and status preserve text and URLs', async () => {
  const c = fixture();
  const id = created.parse((await c.request('/ingress/genie', payload({ chat_id: 22, text: '🪔 family@example.com に連絡' }))).body).job_id;
  expect(c.table('delivery_outbox')[0]?.body).toEqual(expect.stringContaining('family@example.com'));
  const store = new JobStore(c);
  const claimed = store.claim({ worker_id: 'dummy-worker' }, id);
  if (!claimed.job) throw Error('Missing claim');
  store.complete(id, { claim_token: claimed.claim_token, result: {}, used_capabilities: ['lookup'], artifact_urls: ['https://example.com/x/family@example.com/y'] });
  await c.request('/ingress/genie', payload({ chat_id: 22, guid: 'status', idempotency_key: 'status', text: `/status ${id}` }));
  expect(c.table('delivery_outbox').at(-1)?.body).toBe(statusReply(store.get(id), true));
});

test('JE-SH16 full lifecycle logs never contain saved handles', async () => {
  const c = fixture();
  const handle = `tel:${short}`;
  const id = created.parse((await c.request('/ingress/genie', family({ sender_handle: handle }))).body).job_id;
  const first = await c.req('POST', `/jobs/${id}/claim`, { worker_id: 'dummy-worker' });
  const claimToken = z.string().parse(first.body.claim_token);
  expect((await c.req('POST', `/jobs/${id}/heartbeat`, { claim_token: claimToken })).status).toBe(200);
  expect((await c.req('POST', `/jobs/${id}/fail`, { claim_token: claimToken, error: { code: 'PROCESSING_ERROR', message: `${handle} ${phone} failed` } })).status).toBe(200);
  expect((await c.req('POST', `/jobs/${id}/retry`, {})).status).toBe(200);
  const second = await c.req('POST', `/jobs/${id}/claim`, { worker_id: 'dummy-worker' });
  expect((await c.req('POST', `/jobs/${id}/complete`, { claim_token: second.body.claim_token, result: {}, used_capabilities: ['lookup'] })).status).toBe(200);
  expect((await c.request('/genie/replies')).status).toBe(200);
  for (const value of [H, phone, short, E, 'family@example.com']) expect(c.logs.join('\n')).not.toContain(value);
});

test('JE-SH18 regression fixed errors for conflict and internal failure; A7 schema precedes chat permission', async () => {
  const c = fixture();
  const forbidden = await c.request('/ingress/genie', family({ chat_id: 23, sender_handle: 'invalid' }));
  expect(forbidden).toEqual({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: '入力が正しくありません' } } });
  expect(await c.request('/ingress/genie', payload({ chat_id: 23 }))).toEqual({ status: 403, body: { error: { code: 'CHAT_NOT_ALLOWED', message: 'このトークからは受け付けません' } } });
  expect((await c.request('/ingress/genie', payload())).status).toBe(201);
  expect(await c.request('/ingress/genie', payload({ chat_id: 22 }))).toEqual({ status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT', message: '同じメッセージ ID で内容が違います' } } });
  c.db.exec("CREATE TRIGGER dummy_failure BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'dummy failure'); END");
  const failed = await c.request('/ingress/genie', payload({ guid: 'failed', idempotency_key: 'failed' }));
  expect(failed).toEqual({ status: 500, body: { error: { code: 'INTERNAL', message: '内部エラーです' } } });
  expect(c.table('jobs')).toHaveLength(1);
  for (const value of [H, phone, E]) expect(JSON.stringify([failed, c.logs])).not.toContain(value);
});


test('JE-SH5 exact 256 and 257 length boundary', async () => {
  const c = fixture();
  const value = maxMail + 'x';
  expect(value).toHaveLength(256);
  expect((await c.request('/ingress/genie', family({ sender_handle: value }))).status).toBe(201);
  const guid = 'over-length';
  expect((await c.request('/ingress/genie', family({ guid, idempotency_key: guid, sender_handle: value + 'x' }))).status).toBe(400);
  expect(c.table('jobs')).toHaveLength(1);
});

test('JE-SH15 A2 redacted URL growth preserves status limits without cutting the URL', async () => {
  const c = fixture();
  const id = created.parse((await c.request('/ingress/genie', family({ sender_handle: `tel:${short}` }))).body).job_id;
  const store = new JobStore(c);
  const claimed = store.claim({ worker_id: 'dummy-worker' }, id);
  if (!claimed.job) throw Error('Missing claim');
  const url = `https://example.com/${short.repeat(160)}/end`;
  store.complete(id, { claim_token: claimed.claim_token, result: {}, used_capabilities: ['lookup'], artifact_urls: [url], notify: { body: url } });
  const guid = 'status-expanded';
  await c.request('/ingress/genie', payload({ chat_id: 22, guid, idempotency_key: guid, text: `/status ${id}` }));
  const body = z.string().parse(c.table('delivery_outbox').at(-1)?.body);
  expect(body).toContain('表示上限');
  expect(body).toContain('試行回数');
  expect(body).not.toContain('https://');
  expect([...body].length).toBeLessThanOrEqual(1500);
  const notification = z.string().parse(c.table('delivery_outbox').find(row => row.kind === 'done')?.body);
  expect([...notification].length).toBeLessThanOrEqual(1500);
  expect(notification).toBe([...url.replaceAll(short, '[REDACTED]')].slice(0,1500).join(''));
  expect(notification).not.toContain(short);
});

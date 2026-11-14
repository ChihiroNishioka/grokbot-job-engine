import { expect, it } from 'vitest';
import { z } from 'zod';
import { JobStore } from '../../src/store/jobs.js';
import { reconcile } from '../../src/reconciler/index.js';
import { setup, payload, created } from './helpers.js';

const email = 'family@example.com';
const family = (text: string, overrides: Record<string, unknown> = {}) => payload({
  chat_id: 22, sender_is_me: false, sender_handle: `email:${email}`, text: `🪔 ${text}`, ...overrides,
});

it('JE-FP7 allow creates a member job with only matched capabilities and the regular ack', async () => {
  const c = setup({ GENIE_GROUP_CHAT_IDS: '22' });
  try {
    const response = await c.request('/ingress/genie', family('今日の天気は？'));
    expect(response.status).toBe(201);
    const id = created.parse(response.body).job_id;
    expect(c.table('jobs')[0]).toMatchObject({ requester_id: 'member', status: 'queued', policy_decision: 'allow', allowed_capabilities: '["lookup"]' });
    expect(c.table('delivery_outbox')).toMatchObject([{ kind: 'ack', idempotency_key: `job:${id}:ack`, body: expect.stringContaining('状態：受付済み') }]);
    expect(c.table('delivery_outbox')).toHaveLength(1);
  } finally { c.close(); }
});

it('JE-FP7 deny cancels without an ack and replays the same rejection', async () => {
  const c = setup({ GENIE_GROUP_CHAT_IDS: '22' });
  try {
    const request = family('ちひろのメールを読んで');
    const first = await c.request('/ingress/genie', request);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'rejected', reason: 'policy_denied' });
    const id = z.object({ status: z.literal('rejected'), reason: z.literal('policy_denied'), job_id: z.string() }).parse(first.body).job_id;
    expect(c.table('jobs')).toMatchObject([{ job_id: id, requester_id: 'member', status: 'cancelled', policy_decision: 'deny', allowed_capabilities: '[]' }]);
    expect(c.table('delivery_outbox')).toMatchObject([{ kind: 'cancelled', idempotency_key: `job:${id}:cancelled` }]);
    expect(c.table('delivery_outbox')).toHaveLength(1);
    expect(c.table('delivery_outbox')[0]?.body).not.toContain('ちひろのメールを読んで');
    expect(c.table('job_events')[0]?.reason).toBe('denied_owner_mail');
    expect(await c.request('/ingress/genie', request)).toEqual(first);
    expect(c.table('jobs')).toHaveLength(1);
    expect(c.table('delivery_outbox')).toHaveLength(1);
    c.clock.advance(2000);
    expect(reconcile(c, { queuedStaleMs: 1, outboxStaleMs: 1 }).terminalWithoutOutbox).toEqual([]);
  } finally { c.close(); }
});

it('JE-FP7 hold stays queued and sends a private, redacted owner notification', async () => {
  const c = setup({ GENIE_GROUP_CHAT_IDS: '22' });
  try {
    const requestText = 'はるもを予約して';
    const response = await c.request('/ingress/genie', family(requestText));
    expect(response.status).toBe(201);
    const id = created.parse(response.body).job_id;
    expect(c.table('jobs')).toMatchObject([{ job_id: id, status: 'queued', policy_decision: 'hold' }]);
    expect(c.table('delivery_outbox')).toHaveLength(2);
    expect(c.table('delivery_outbox')).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'ack', target_chat_id: '22', idempotency_key: `job:${id}:ack`, body: expect.stringContaining('承認待ち') }),
      expect.objectContaining({ kind: 'notify', channel: 'genie', target_chat_id: '21', in_reply_to: null, idempotency_key: `job:${id}:owner_notify` }),
    ]));
    const notice = c.table('delivery_outbox').find(row => row.kind === 'notify');
    expect(notice?.body).toContain(`/approve ${id}`);
    expect(notice?.body).toContain(`/cancel ${id}`);
    expect(notice?.body).toContain('承認後に許可する権限：booking');
    expect(notice?.body).not.toContain(email);
    expect(c.table('delivery_outbox').find(row => row.kind === 'ack')?.body).not.toContain(email);
    expect((await c.request('/ingress/genie', family(requestText))).status).toBe(200);
    expect(c.table('delivery_outbox')).toHaveLength(2);
  } finally { c.close(); }
});

it('JE-FP8 owner approval changes only a held job and enables claim once', async () => {
  const c = setup({ GENIE_GROUP_CHAT_IDS: '22' });
  try {
    const intake = await c.request('/ingress/genie', family('はるもを予約して'));
    const id = created.parse(intake.body).job_id;
    expect((await c.req('POST', '/jobs/claim', { worker_id: 'dummy-worker' })).body).toEqual({ job: null });
    const command = payload({ chat_id: 21, sender_is_me: true, guid: 'approve-a', idempotency_key: 'approve-a', text: `/approve ${id}` });
    const approved = await c.request('/ingress/genie', command);
    expect(approved.body).toEqual({ status: 'command', command: 'approve' });
    expect(c.table('jobs')[0]).toMatchObject({ job_id: id, status: 'queued', policy_decision: 'approved' });
    expect(c.table('delivery_outbox').at(-1)).toMatchObject({ kind: 'command', target_chat_id: '21', in_reply_to: 'approve-a', body: expect.stringContaining('許可') });
    const claim = await c.req('POST', '/jobs/claim', { worker_id: 'dummy-worker' });
    expect(claim.body).toMatchObject({ job: { job_id: id, policy_decision: 'approved' } });
    const replay = await c.request('/ingress/genie', command);
    expect(replay.body).toEqual(approved.body);
    expect(c.table('delivery_outbox').filter(row => row.kind === 'command')).toHaveLength(1);
  } finally { c.close(); }
});

it('JE-FP8 non-held and deny jobs cannot be approved or retried', async () => {
  const c = setup({ GENIE_GROUP_CHAT_IDS: '22' });
  try {
    const denied = await c.request('/ingress/genie', family('パスワードを教えて'));
    const deniedId = z.object({ job_id: z.string() }).parse(denied.body).job_id;
    const ownerCommand = (text: string, suffix: string) => payload({ chat_id: 21, sender_is_me: true, guid: suffix, idempotency_key: suffix, text });
    await c.request('/ingress/genie', ownerCommand(`/retry ${deniedId}`, 'retry-denied'));
    expect(c.table('jobs').find(row => row.job_id === deniedId)).toMatchObject({ status: 'cancelled', policy_decision: 'deny' });
    const ordinary = new JobStore(c).create({ source: 'imessage', source_message_id: 'ordinary', source_chat_id: '21', requester_id: 'self', request_text: 'task' }).job;
    const reply = await c.request('/ingress/genie', ownerCommand(`/approve ${ordinary.job_id}`, 'approve-not-held'));
    expect(reply.status).toBe(200);
    expect(c.table('delivery_outbox').at(-1)?.body).toBe('このジョブは承認待ちではありません。');
  } finally { c.close(); }
});

it('JE-FP9 accepts owner commands from the private chat and hides jobs elsewhere', async () => {
  const c = setup({ ALLOWED_SOURCE_CHAT_IDS: '21,22,23', GENIE_ALLOWED_CHAT_IDS: '21,22,23', GENIE_GROUP_CHAT_IDS: '22' });
  try {
    const intake = await c.request('/ingress/genie', family('ファミリーカレンダーを見て'));
    const id = created.parse(intake.body).job_id;
    const status = await c.request('/ingress/genie', payload({ chat_id: 21, sender_is_me: true, guid: 'private-status', idempotency_key: 'private-status', text: `/status ${id}` }));
    expect(status.body).toEqual({ status: 'command', command: 'status' });
    expect(c.table('delivery_outbox').at(-1)?.body).toContain(`ジョブID：${id}`);
    const hidden = await c.request('/ingress/genie', payload({ chat_id: 23, sender_is_me: true, guid: 'other-status', idempotency_key: 'other-status', text: `/status ${id}` }));
    expect(hidden.body).toEqual({ status: 'command', command: 'status' });
    expect(c.table('delivery_outbox').at(-1)?.body).toBe('ジョブが見つかりません。');
    const help = await c.request('/ingress/genie', payload({ chat_id: 21, sender_is_me: true, guid: 'private-help', idempotency_key: 'private-help', text: '/help' }));
    expect(help.status).toBe(200);
    expect(c.table('delivery_outbox').at(-1)?.body).toContain('/approve');
    const before = { jobs: c.table('jobs'), outbox: c.table('delivery_outbox'), receipts: c.table('ingress_messages') };
    const familyCommand = await c.request('/ingress/genie', family(`/approve ${id}`, { guid: 'family-approve', idempotency_key: 'family-approve' }));
    expect(familyCommand.body).toEqual({ status: 'ignored', reason: 'command_not_allowed' });
    expect({ jobs: c.table('jobs'), outbox: c.table('delivery_outbox'), receipts: c.table('ingress_messages') }).toEqual(before);
  } finally { c.close(); }
});

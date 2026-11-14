import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JobStore } from '../src/store/jobs.js';
import { OutboxStore } from '../src/store/outbox.js';
import { reconcile } from '../src/reconciler/index.js';
import { createLogger } from '../src/logging/logger.js';
import { context, claimToken, rows } from './helpers/context.js';
import type { CreateInput } from '../src/store/types.js';

const phone = ['+1', '555', '010', '0000'].join('');
const short = ['555', '0100'].join('');
const email = 'family@example.com';
const handles = [`tel:${short}`, `tel:${phone}`, `email:${email}`];
const longUrl = `https://example.com/${'aB7c'.repeat(10)}?download=1&view=full`;
const responseJob = z.object({ sender_handle: z.string().nullable() });
const responseOutbox = z.looseObject({ body: z.string() });
function fixture(handle?: string) {
  const c = context();
  const store = new JobStore(c);
  const input: CreateInput = { source: 'imessage', source_message_id: 'sender-store', source_chat_id: '21', requester_id: handle === undefined ? 'self' : 'member', request_text: '今日の天気は？', ...(handle === undefined ? {} : { sender_handle: handle }) };
  const id = store.create(input).job.job_id;
  const claim = async () => {
    const reply = await c.req('POST', `/jobs/${id}/claim`, { worker_id: 'dummy-worker', lease_seconds: 10 });
    expect(reply.status).toBe(200);
    return claimToken(reply);
  };
  return { c, store, input, id, claim };
}

describe('sender handle storage and authenticated API', () => {
  it('JE-SH11 store replay retains the first handle and requester conflicts remain 409', () => {
    const { c, store, input, id } = fixture(handles[0]);
    try {
      const replay = store.create({ ...input, sender_handle: `email:${email}` });
      expect(replay.created).toBe(false);
      expect(replay.job.job_id).toBe(id);
      expect(replay.job).toHaveProperty('sender_handle', handles[0]);
      expect(() => store.create({ ...input, requester_id: 'self' })).toThrow('IDEMPOTENCY_CONFLICT');
      expect(rows(c, 'jobs')).toHaveLength(1);
    } finally { c.close(); }
  });
  it.each(['get', 'claim-next', 'claim-id', 'complete', 'fail', 'cancel', 'retry'])('JE-SH13 A5 %s exposes the stored handle', async operation => {
    const { c, id, claim } = fixture(`tel:${phone}`);
    try {
      let reply;
      if (operation === 'get') reply = await c.req('GET', `/jobs/${id}`);
      else if (operation === 'claim-next') reply = await c.req('POST', '/jobs/claim', { worker_id: 'dummy-worker' });
      else if (operation === 'claim-id') reply = await c.req('POST', `/jobs/${id}/claim`, { worker_id: 'dummy-worker' });
      else if (operation === 'cancel') reply = await c.req('POST', `/jobs/${id}/cancel`, {});
      else {
        const token = await claim();
        if (operation === 'complete') reply = await c.req('POST', `/jobs/${id}/complete`, { claim_token: token, result: {}, used_capabilities: ['lookup'] });
        else {
          reply = await c.req('POST', `/jobs/${id}/fail`, { claim_token: token, error: { code: 'DUMMY', message: 'failed' } });
          if (operation === 'retry') reply = await c.req('POST', `/jobs/${id}/retry`, {});
        }
      }
      expect(reply.status).toBe(200);
      expect(responseJob.parse(reply.body.job).sender_handle).toBe(`tel:${phone}`);
    } finally { c.close(); }
  });
  it('JE-SH13 self get and claim carry null while list and events exclude handles', async () => {
    const { c, id } = fixture();
    try {
      expect(responseJob.parse((await c.req('GET', `/jobs/${id}`)).body.job).sender_handle).toBeNull();
      const claimed = await c.req('POST', `/jobs/${id}/claim`, { worker_id: 'dummy-worker' });
      expect(claimed.status).toBe(200);
      expect(responseJob.parse(claimed.body.job).sender_handle).toBeNull();
      const list = await c.req('GET', '/jobs');
      for (const item of list.body.jobs ?? []) expect(item).not.toHaveProperty('sender_handle');
      expect(JSON.stringify((await c.req('GET', `/jobs/${id}/events`)).body)).not.toContain('sender_handle');
    } finally { c.close(); }
  });
  it('JE-SH13 list and events omit a family handle even after transitions', async () => {
    const { c, id, claim } = fixture(`tel:${phone}`);
    try {
      await claim();
      const list = await c.req('GET', '/jobs');
      expect(list.body.jobs).toHaveLength(1);
      for (const item of list.body.jobs ?? []) expect(item).not.toHaveProperty('sender_handle');
      const events = await c.req('GET', `/jobs/${id}/events`);
      for (const text of [JSON.stringify(list.body), JSON.stringify(events.body)]) {
        expect(text).not.toContain(phone);
        expect(text).not.toContain('sender_handle');
      }
    } finally { c.close(); }
  });
});

describe('sender handle redaction at outbound boundaries', () => {
  it.each(handles.flatMap(handle => ['complete', 'fail', 'outbox'].map(operation => ({ handle, operation }))))('JE-SH17 A2 A4 $operation redacts a handle and its suffix', async ({ handle, operation }) => {
    const { c, id, claim } = fixture(handle);
    try {
      const suffix = handle.slice(handle.indexOf(':') + 1);
      const body = `依頼者 ${handle.toUpperCase()} / ${suffix.toUpperCase()} ${longUrl}`;
      if (operation === 'outbox') {
        const value = { job_id: id, idempotency_key: 'sender-outbox', kind: 'done', body };
        const first = await c.req('POST', '/outbox', value);
        expect(first.status).toBe(201);
        const replay = await c.req('POST', '/outbox', value);
        expect(replay.status).toBe(200);
        expect(responseOutbox.parse(first.body.outbox).body).toBe(`依頼者 [REDACTED] / [REDACTED] ${longUrl}`);
      } else {
        const token = await claim();
        const value = operation === 'complete' ? { claim_token: token, result: {}, used_capabilities: ['lookup'], notify: { body } } : { claim_token: token, error: { code: 'DUMMY', message: 'failure' }, notify: { body } };
        expect((await c.req('POST', `/jobs/${id}/${operation}`, value)).status).toBe(200);
      }
      expect(rows(c, 'delivery_outbox').at(-1)?.body).toBe(`依頼者 [REDACTED] / [REDACTED] ${longUrl}`);
      expect(JSON.stringify(rows(c, 'delivery_outbox'))).not.toContain('sender_handle');
    } finally { c.close(); }
  });
  it('JE-SH17 fail masks a short handle in the stored error before returning it', async () => {
    const { c, id, claim } = fixture(`tel:${short}`);
    try {
      const token = await claim();
      const reply = await c.req('POST', `/jobs/${id}/fail`, { claim_token: token, error: { code: 'DUMMY', message: `TEL:${short} / ${short} failed` } });
      expect(reply.status).toBe(200);
      expect(rows(c, 'jobs')[0]?.error).toBe(JSON.stringify({ code: 'DUMMY', message: '[REDACTED] / [REDACTED] failed' }));
      expect(JSON.stringify(reply.body)).not.toContain(`TEL:${short}`);
    } finally { c.close(); }
  });
  it.each(['complete', 'fail', 'outbox'])('JE-SH17 A2 regression %s preserves a notification byte for byte without a handle', async operation => {
    const { c, id, claim } = fixture();
    try {
      const body = `依頼者 tel:${short} / ${short} ${longUrl}`;
      if (operation === 'outbox') expect((await c.req('POST', '/outbox', { job_id: id, idempotency_key: 'unchanged', kind: 'done', body })).status).toBe(201);
      else {
        const token = await claim();
        const value = operation === 'complete' ? { claim_token: token, result: {}, used_capabilities: ['lookup'], notify: { body } } : { claim_token: token, error: { code: 'DUMMY', message: 'failure' }, notify: { body } };
        expect((await c.req('POST', `/jobs/${id}/${operation}`, value)).status).toBe(200);
      }
      expect(rows(c, 'delivery_outbox').at(-1)?.body).toBe(body);
    } finally { c.close(); }
  });
  it('JE-SH16 logger redacts sender_handle keys including short nested values', () => {
    const logs: string[] = [];
    const logger = createLogger(line => logs.push(line));
    logger.info({ sender_handle: `tel:${short}`, nested: { sender_handle: `tel:${phone}` } });
    expect(JSON.parse(logs[0] ?? '')).toEqual({ sender_handle: '[REDACTED]', nested: { sender_handle: '[REDACTED]' } });
  });
  it('JE-SH16 full API lifecycle logs omit handles and error text', async () => {
    const { c, id, claim } = fixture(`tel:${short}`);
    try {
      let token = await claim();
      await c.req('POST', `/jobs/${id}/heartbeat`, { claim_token: token });
      await c.req('POST', `/jobs/${id}/fail`, { claim_token: token, error: { code: 'DUMMY', message: `tel:${short} ${short}` } });
      await c.req('POST', `/jobs/${id}/retry`, {});
      token = await claim();
      await c.req('POST', `/jobs/${id}/complete`, { claim_token: token, result: {}, notify: { body: `tel:${short}` } });
      const logs = c.logs.join('\n');
      for (const value of [short, phone, email, `email:${email}`]) expect(logs).not.toContain(value);
    } finally { c.close(); }
  });
  it.each(['cancel', 'retry'])('JE-SH13 events redact a handle copied into %s reason', async operation => {
    const { c, id, claim } = fixture(`tel:${short}`);
    try {
      if (operation === 'retry') {
        const token = await claim();
        await c.req('POST', `/jobs/${id}/fail`, { claim_token: token, error: { code: 'DUMMY', message: 'failed' } });
      }
      const reply = await c.req('POST', `/jobs/${id}/${operation}`, { reason: `tel:${short} / ${short}` });
      expect(reply.status).toBe(200);
      expect(rows(c, 'job_events').at(-1)?.reason).toBe('[REDACTED] / [REDACTED]');
    } finally { c.close(); }
  });
  it('JE-SH18 regression API conflicts have a fixed safe envelope', async () => {
    const { c, id } = fixture(`tel:${short}`);
    try {
      const reply = await c.req('POST', `/jobs/${id}/complete`, { claim_token: 'dummy-wrong-token', result: {} });
      expect(reply.status).toBe(409);
      expect(reply.body).toEqual({ error: { code: 'INVALID_TRANSITION', message: expect.any(String) } });
      expect(JSON.stringify(reply.body)).not.toContain(short);
      expect(c.logs.join('\n')).not.toContain(short);
    } finally { c.close(); }
  });
  it('JE-SH19 regression reconcile reports and events exclude handles and notify Genie once', () => {
    const { c, store, id } = fixture(`tel:${short}`);
    try {
      const ack = new OutboxStore(c).enqueue({ job_id: id, idempotency_key: `job:${id}:ack`, kind: 'ack', body: 'ack' }).outbox;
      c.db.prepare("UPDATE delivery_outbox SET channel='genie' WHERE outbox_id=? AND status='pending'").run(ack.outbox_id);
      for (let attempt = 0; attempt < 3; attempt++) {
        store.claim({ worker_id: 'dummy-worker', lease_seconds: 10 }, id);
        c.clock.advance(10000);
        const report = reconcile(c, { queuedStaleMs: 1, outboxStaleMs: 1 });
        expect(JSON.stringify(report)).not.toContain(short);
        if (attempt === 2) expect(report.failed).toEqual([id]);
      }
      reconcile(c, { queuedStaleMs: 1, outboxStaleMs: 1 });
      expect(rows(c, 'delivery_outbox').filter(row => row.kind === 'failed')).toHaveLength(1);
      for (const value of [JSON.stringify(rows(c, 'job_events')), JSON.stringify(rows(c, 'delivery_outbox'))]) {
        expect(value).not.toContain(short);
        expect(value).not.toContain('sender_handle');
      }
    } finally { c.close(); }
  });
});

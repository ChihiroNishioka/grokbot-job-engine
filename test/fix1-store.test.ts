import { it, expect } from 'vitest';
import { JobStore } from '../src/store/jobs.js';
import { OutboxStore } from '../src/store/outbox.js';
import { reconcile } from '../src/reconciler/index.js';
import { setup, payload, created } from './ingress/helpers.js';

const options = { queuedStaleMs: 1, outboxStaleMs: 1 };
function fixture(max_attempts = 3) {
 const c = setup();
 const store = new JobStore(c);
 const id = store.create({ source: 'imessage', source_message_id: 'fix1-job', source_chat_id: '21', requester_id: 'self', request_text: 'work', max_attempts }).job.job_id;
 const claim = () => { const result = store.claim({ worker_id: 'dummy-worker', lease_seconds: 10 }, id); if (!result.job) throw Error('Missing claim'); return result; };
 return { c, store, id, claim };
}
it('fix1-2 notify keys distinguish retry attempts while resends stay idempotent', () => {
 const { c, store, id, claim } = fixture(); try {
  const first = claim(); const fail = { claim_token: first.claim_token, error: { code: 'DUMMY', message: 'first' }, notify: { body: 'first failure' } };
  store.fail(id, fail); store.fail(id, fail); store.retry(id);
  const second = claim(); store.fail(id, { ...fail, claim_token: second.claim_token, notify: { body: 'second failure' } });
  expect(c.table('delivery_outbox').map(o => o.idempotency_key)).toEqual([`job:${id}:failed:1`, `job:${id}:failed:2`]);
  store.retry(id); const third = claim(); store.complete(id, { claim_token: third.claim_token, result: {}, notify: { body: 'done' } });
  expect(c.table('delivery_outbox').at(-1)?.idempotency_key).toBe(`job:${id}:done:3`);
 } finally { c.close(); }
});
it('fix1-2 terminalWithoutOutbox checks the latest attempt kind', () => {
 const { c, store, id, claim } = fixture(); try {
  let run = claim(); store.fail(id, { claim_token: run.claim_token, error: { code: 'DUMMY', message: '' }, notify: { body: 'first' } });
  store.retry(id); run = claim(); store.fail(id, { claim_token: run.claim_token, error: { code: 'DUMMY', message: '' } }); c.clock.advance(2);
  expect(reconcile(c, options).terminalWithoutOutbox.map(j => j.id)).toEqual([id]);
 } finally { c.close(); }
});
it('fix1-6 fail with cancellation uses cancelled kind and no retry advice', () => {
 const { c, store, id, claim } = fixture(); try {
  const run = claim(); store.cancel(id); store.fail(id, { claim_token: run.claim_token, error: { code: 'DUMMY', message: 'internal' }, notify: { body: 'failure /retry' } });
  expect(c.table('delivery_outbox')).toMatchObject([{ kind: 'cancelled', idempotency_key: `job:${id}:cancelled:1`, body: `ジョブ ${id} はキャンセルしました。` }]);
 } finally { c.close(); }
});
it.each(['/tmp を掃除して', '/unknown', '/status-file を読む'])('fix1-7 unknown slash input becomes a job %s', async text => {
 const c = setup(); try { expect((await c.request('/ingress/genie', payload({ text }))).status).toBe(201); expect(c.table('jobs')[0]?.request_text).toBe(text); } finally { c.close(); }
});
it('fix1-7 known commands trim trailing whitespace and report malformed IDs', async () => {
 const c = setup(); try {
  const id = created.parse((await c.request('/ingress/genie', payload())).body).job_id;
  for (const [i, text] of [` /status ${id} \n\u3000`, '/cancel', '/help extra'].entries()) await c.request('/ingress/genie', payload({ text, guid: `command-${i}`, idempotency_key: `command-${i}` }));
  const replies = c.table('delivery_outbox').filter(o => o.kind === 'command');
  expect(replies[0]?.body).toContain('状態：受付済み');
  expect(replies[1]?.body).toContain('コマンドを読めませんでした。');
  expect(replies[2]?.body).toContain('コマンドを読めませんでした。');
 } finally { c.close(); }
});
it.each([false, true])('fix1-11 reconciler notifies Genie terminal transitions atomically cancelled=%s', cancelled => {
 const { c, store, id, claim } = fixture(1); try {
  const ack = new OutboxStore(c).enqueue({ job_id: id, idempotency_key: `job:${id}:ack`, kind: 'ack', body: 'ack' }).outbox;
  c.db.prepare("UPDATE delivery_outbox SET channel='genie' WHERE outbox_id=?").run(ack.outbox_id);
  claim(); if (cancelled) store.cancel(id); c.clock.advance(10000);
  const status = cancelled ? 'cancelled' : 'failed'; reconcile(c, options); reconcile(c, options);
  expect(c.table('delivery_outbox').filter(o => o.kind === status)).toMatchObject([{ channel: 'genie', idempotency_key: `job:${id}:${status}:1`, body: cancelled ? `ジョブ ${id} はキャンセルしました。` : expect.stringContaining('再実行する場合') }]);
  expect(c.table('delivery_outbox').filter(o => o.kind === status)).toHaveLength(1);
 } finally { c.close(); }
});
it('fix1-11 notification insertion failure rolls back reconciled job and run', () => {
 const { c, store, id, claim } = fixture(1); try {
  const ack = new OutboxStore(c).enqueue({ job_id: id, idempotency_key: 'genie-ack', kind: 'ack', body: 'ack' }).outbox;
  c.db.prepare("UPDATE delivery_outbox SET channel='genie' WHERE outbox_id=?").run(ack.outbox_id); claim(); c.clock.advance(10000);
  c.db.exec("CREATE TRIGGER reject_terminal BEFORE INSERT ON delivery_outbox BEGIN SELECT RAISE(ABORT, 'dummy failure'); END");
  expect(() => reconcile(c, options)).toThrow('dummy failure'); expect(store.get(id).status).toBe('claimed');
  expect(c.db.prepare('SELECT outcome FROM job_runs WHERE job_id=?').get(id)).toEqual({ outcome: 'running' });
 } finally { c.close(); }
});
it('fix1-12 command replies explain help and cancel retry outcomes', async () => {
 const { c, store, id, claim } = fixture(); try {
  const send = async (text: string, guid: string) => { await c.request('/ingress/genie', payload({ text, guid, idempotency_key: guid })); return c.table('delivery_outbox').at(-1)?.body; };
  expect(await send('/help', 'help')).toContain('/status <job_id>：状態を確認します。');
  expect(await send('/status J-999999', 'missing')).toBe('ジョブが見つかりません。');
  const run = claim(); expect(await send(`/cancel ${id}`, 'cancel')).toContain('キャンセルを受け付けました。実行中の処理が止まるのを待っています。');
  store.fail(id, { claim_token: run.claim_token, error: { code: 'DUMMY', message: '' } });
  const other = store.create({ source: 'imessage', source_message_id: 'retryable', source_chat_id: '21', requester_id: 'self', request_text: 'work' }).job.job_id;
  const retryRun = store.claim({ worker_id: 'dummy-worker' }, other); if (!retryRun.job) throw Error('Missing claim'); store.fail(other, { claim_token: retryRun.claim_token, error: { code: 'DUMMY', message: '' } });
  expect(await send(`/retry ${other}`, 'retry')).toContain('再実行を受け付けました。\n');
  const queued = store.create({ source: 'imessage', source_message_id: 'cancel-queued', source_chat_id: '21', requester_id: 'self', request_text: 'work' }).job.job_id;
  expect(await send(`/cancel ${queued}`, 'cancel-queued')).toContain('キャンセルしました。');
 } finally { c.close(); }
});
it('fix1-13 too long requests return a durable idempotent rejection reply', async () => {
 const c = setup({ REQUEST_TEXT_MAX_CHARS: '5' }); try {
  const p = payload({ text: '🌱'.repeat(6) }); const first = await c.request('/ingress/genie', p);
  expect(first).toEqual({ status: 200, body: { status: 'rejected', reason: 'too_long' } });
  expect(await c.request('/ingress/genie', { ...p, text: 'short' })).toEqual(first);
  expect(c.table('jobs')).toHaveLength(0);
  expect(c.table('delivery_outbox')).toMatchObject([{ kind: 'command', idempotency_key: 'cmd:guid-a', body: '依頼が長すぎます（最大 5 字）。短くして送り直してください。' }]);
  expect(c.table('delivery_outbox')).toHaveLength(1); expect(c.table('ingress_messages')).toHaveLength(1);
 } finally { c.close(); }
});

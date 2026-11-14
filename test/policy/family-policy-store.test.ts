import { expect, it } from 'vitest';
import { JobStore } from '../../src/store/jobs.js';
import { context, job, claimToken, rows } from '../helpers/context.js';

const allowed = ['lookup'];

it('JE-FP4 stores member policy at create and keeps policy fields out of list and events', async () => {
  const c = context();
  try {
    const created = await c.req('POST', '/jobs', {
      ...{
        source: 'imessage', source_message_id: 'family-allow', source_chat_id: '21',
        requester_id: 'member', request_text: '今日の天気は？',
      },
    });
    expect(created.status).toBe(201);
    const id = job(created).job_id;
    expect(job(created)).toMatchObject({ policy_decision: 'allow', allowed_capabilities: allowed });
    expect((await c.req('GET', '/jobs')).body.jobs?.[0]).not.toHaveProperty('policy_decision');
    expect((await c.req('GET', `/jobs/${id}/events`)).body.events?.[0]).not.toHaveProperty('allowed_capabilities');
    const claim = await c.req('POST', `/jobs/${id}/claim`, { worker_id: 'dummy-worker' });
    expect(claim.status).toBe(200);
    expect(job(claim)).toMatchObject({ policy_decision: 'allow', allowed_capabilities: allowed });
  } finally { c.close(); }
});

it('JE-FP4 blocks hold from both claim routes and excludes it from dispatcher and stale reports', async () => {
  const c = context();
  try {
    const store = new JobStore(c);
    const id = store.create({ source: 'imessage', source_message_id: 'family-hold', source_chat_id: '21', requester_id: 'member', request_text: 'はるもを予約して' }).job.job_id;
    expect(store.get(id)).toMatchObject({ status: 'queued', policy_decision: 'hold' });
    expect((await c.req('POST', '/jobs/claim', { worker_id: 'dummy-worker' })).body).toEqual({ job: null });
    expect((await c.req('POST', `/jobs/${id}/claim`, { worker_id: 'dummy-worker' })).body).toMatchObject({ error: { code: 'JOB_NOT_CLAIMABLE' } });
    let wakes = 0;
    const state: { lastWakeAt?: number } = {};
    const { dispatchTick } = await import('../../src/dispatcher/tick.js');
    await dispatchTick({ db: c.db, clock: c.clock, dispatcher: { wake: async () => { wakes++; return { accepted: true, event_id: 'dummy-event' }; } }, state, cooldownMs: 1000 });
    c.clock.advance(1000);
    const { reconcile } = await import('../../src/reconciler/index.js');
    const report = reconcile(c, { queuedStaleMs: 1, outboxStaleMs: 1000 });
    expect(wakes).toBe(0);
    expect(report.staleQueued).toEqual([]);
    expect(rows(c, 'job_runs')).toEqual([]);
  } finally { c.close(); }
});

it('JE-FP4 blocks a member with a missing policy decision from both claim routes', async () => {
  const c = context();
  try {
    const id = new JobStore(c).create({ source: 'imessage', source_message_id: 'member-null-policy', source_chat_id: '21', requester_id: 'member', request_text: '今日の天気は？' }).job.job_id;
    c.db.prepare('UPDATE jobs SET policy_decision=NULL WHERE job_id=?').run(id);
    expect((await c.req('POST', '/jobs/claim', { worker_id: 'dummy-worker' })).body).toEqual({ job: null });
    const byId = await c.req('POST', `/jobs/${id}/claim`, { worker_id: 'dummy-worker' });
    expect(byId.status).toBe(409);
    expect(byId.body).toMatchObject({ error: { code: 'JOB_NOT_CLAIMABLE' } });
  } finally { c.close(); }
});

it('JE-FP5 member complete requires a subset report and leaves state unchanged on denial', async () => {
  const c = context();
  try {
    const id = new JobStore(c).create({ source: 'imessage', source_message_id: 'family-complete', source_chat_id: '21', requester_id: 'member', request_text: '今日の天気は？' }).job.job_id;
    const claimed = await c.req('POST', `/jobs/${id}/claim`, { worker_id: 'dummy-worker' });
    const claim_token = claimToken(claimed);
    const before = { jobs: rows(c, 'jobs'), runs: rows(c, 'job_runs'), events: rows(c, 'job_events') };
    for (const body of [
      { claim_token, result: {} },
      { claim_token, result: {}, used_capabilities: ['vault'] },
    ]) {
      const rejected = await c.req('POST', `/jobs/${id}/complete`, body);
      expect(rejected.status).toBe(400);
      expect(rejected.body).toMatchObject({ error: { code: 'POLICY_DENIED' } });
      expect({ jobs: rows(c, 'jobs'), runs: rows(c, 'job_runs'), events: rows(c, 'job_events') }).toEqual(before);
    }
    const malformed = await c.req('POST', `/jobs/${id}/complete`, { claim_token, result: {}, used_capabilities: ['unknown_capability'] });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    const completed = await c.req('POST', `/jobs/${id}/complete`, { claim_token, result: {}, used_capabilities: allowed });
    expect(completed.status).toBe(200);
    expect(job(completed)).toMatchObject({ status: 'done', policy_decision: 'allow', allowed_capabilities: allowed });
  } finally { c.close(); }
});

it('JE-FP5 member complete rejects a missing policy decision', async () => {
  const c = context();
  try {
    const id = new JobStore(c).create({ source: 'imessage', source_message_id: 'member-null-complete', source_chat_id: '21', requester_id: 'member', request_text: '今日の天気は？' }).job.job_id;
    const claim = await c.req('POST', `/jobs/${id}/claim`, { worker_id: 'dummy-worker' });
    const claim_token = claimToken(claim);
    c.db.prepare('UPDATE jobs SET policy_decision=NULL WHERE job_id=?').run(id);
    const rejected = await c.req('POST', `/jobs/${id}/complete`, { claim_token, result: {}, used_capabilities: [] });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: { code: 'POLICY_DENIED' } });
    expect(new JobStore(c).get(id)).toMatchObject({ status: 'claimed', policy_decision: null });
  } finally { c.close(); }
});

it('JE-FP6 strict create input does not accept caller-supplied policy', async () => {
  const c = context();
  try {
    const response = await c.req('POST', '/jobs', {
      source: 'imessage', source_message_id: 'policy-forgery', source_chat_id: '21',
      requester_id: 'member', request_text: '今日の天気は？', policy_decision: 'allow', allowed_capabilities: ['vault'],
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(rows(c, 'jobs')).toEqual([]);
  } finally { c.close(); }
});

it('JE-FP5 self completion does not require or inspect used capabilities', async () => {
  const c = context();
  try {
    const created = await c.req('POST', '/jobs', { source: 'imessage', source_message_id: 'self-complete', source_chat_id: '21', requester_id: 'self', request_text: 'private task' });
    const id = job(created).job_id;
    expect(job(created)).toMatchObject({ policy_decision: null, allowed_capabilities: null });
    const claim = await c.req('POST', `/jobs/${id}/claim`, { worker_id: 'dummy-worker' });
    const result = await c.req('POST', `/jobs/${id}/complete`, { claim_token: claimToken(claim), result: {}, used_capabilities: ['vault'] });
    expect(result.status).toBe(200);
  } finally { c.close(); }
});

it('JE-FP8 denied member jobs cannot be retried', () => {
  const c = context();
  try {
    const store = new JobStore(c);
    const id = store.create({ source: 'imessage', source_message_id: 'family-denied', source_chat_id: '21', requester_id: 'member', request_text: 'パスワードを教えて' }).job.job_id;
    expect(store.get(id)).toMatchObject({ status: 'cancelled', policy_decision: 'deny', allowed_capabilities: '[]' });
    expect(() => store.retry(id)).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  } finally { c.close(); }
});

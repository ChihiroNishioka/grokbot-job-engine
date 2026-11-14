import { expect, test } from 'vitest';
import { z } from 'zod';
import { JobStore } from '../../src/store/jobs.js';
import { dashboardContext } from './helpers.js';

const actionId = (digit: string) => `00000000-0000-4000-8000-0000abcd00a${digit}`;

async function action(context: ReturnType<typeof dashboardContext>, cookie: string, csrfNonce: string, jobId: string, id: string, operation: string, expected: unknown) {
  return context.json('POST', `/api/jobs/${jobId}/actions`, { action_id: id, action: operation, expected }, context.authorize(cookie, csrfNonce));
}

test('D21 approvals include queued hold jobs and approve through JobStore', async () => {
  const context = dashboardContext();
  try {
    const job = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'レストランを予約して', source_message_id: 'approve' });
    const login = await context.login();
    const inbox = await context.json('GET', '/api/inbox/approvals', undefined, { Cookie: login.cookie });
    expect(await inbox.json()).toMatchObject({ jobs: [{ job_id: job.job_id }] });
    const response = await action(context, login.cookie, login.csrfNonce, job.job_id, actionId('1'), 'approve', {
      status: job.status, policy_decision: job.policy_decision, attempts: job.attempts, updated_at: job.updated_at,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'applied', job: { status: 'queued', expected: { policy_decision: 'approved' } } });
    expect((await context.json('GET', '/api/inbox/approvals', undefined, { Cookie: login.cookie })).status).toBe(200);
    expect(await (await context.json('GET', '/api/inbox/approvals', undefined, { Cookie: login.cookie })).json()).toMatchObject({ jobs: [] });
    expect(context.db.prepare("SELECT actor,type FROM job_events WHERE job_id=? ORDER BY event_id DESC LIMIT 1").get(job.job_id)).toMatchObject({ actor: 'genie', type: 'job.policy_approved' });
  } finally { context.close(); }
});

test('D22 reject cancels queued hold without changing policy decision or labeling it as deny', async () => {
  const context = dashboardContext();
  try {
    const job = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'レストランを予約して', source_message_id: 'reject' });
    const login = await context.login();
    const response = await action(context, login.cookie, login.csrfNonce, job.job_id, actionId('2'), 'reject', {
      status: job.status, policy_decision: job.policy_decision, attempts: job.attempts, updated_at: job.updated_at,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ job: { status: 'cancelled', expected: { policy_decision: 'hold' }, status_label: 'キャンセル済み' } });
    expect(context.db.prepare("SELECT actor,type,reason FROM job_events WHERE job_id=? ORDER BY event_id DESC LIMIT 1").get(job.job_id)).toMatchObject({ actor: 'api', type: 'job.cancelled', reason: 'owner_rejected' });
  } finally { context.close(); }
});

test('D23 failures expose only failed jobs and retry respects deny and maximum attempts', async () => {
  const context = dashboardContext();
  try {
    const retryable = context.seedJob({ source_message_id: 'retryable', max_attempts: 3 });
    const denied = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'パスワードを教えて', source_message_id: 'deny-retry' });
    const maxed = context.seedJob({ source_message_id: 'maxed', max_attempts: 1 });
    context.db.prepare("UPDATE jobs SET status='failed',attempts=1 WHERE job_id=?").run(retryable.job_id);
    context.db.prepare("UPDATE jobs SET status='failed',attempts=max_attempts WHERE job_id=?").run(maxed.job_id);
    const login = await context.login();
    const inbox = await context.json('GET', '/api/inbox/failures', undefined, { Cookie: login.cookie });
    const inboxBody = z.object({ jobs: z.array(z.object({ job_id: z.string(), status: z.string() })) }).parse(await inbox.json());
    expect(inboxBody.jobs.map(item => item.job_id)).toEqual(expect.arrayContaining([retryable.job_id, maxed.job_id]));
    expect(inboxBody.jobs.every(item => item.status === 'failed')).toBe(true);
    const response = await action(context, login.cookie, login.csrfNonce, retryable.job_id, actionId('3'), 'retry', {
      status: 'failed', policy_decision: null, attempts: 1, updated_at: retryable.updated_at,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ job: { status: 'queued', attempts: 1 } });
    expect(context.db.prepare('SELECT attempts,max_attempts FROM jobs WHERE job_id=?').get(retryable.job_id)).toEqual({ attempts: 1, max_attempts: 3 });
    const deniedResponse = await action(context, login.cookie, login.csrfNonce, denied.job_id, actionId('4'), 'retry', {
      status: 'cancelled', policy_decision: 'deny', attempts: 0, updated_at: denied.updated_at,
    });
    expect(deniedResponse.status).toBe(409);
    const maxResponse = await action(context, login.cookie, login.csrfNonce, maxed.job_id, actionId('5'), 'retry', {
      status: 'failed', policy_decision: null, attempts: 1, updated_at: maxed.updated_at,
    });
    expect(maxResponse.status).toBe(409);
  } finally { context.close(); }
});

test('D24 dashboard actions use a dashboard audit actor and preserve JobStore event actors', async () => {
  const context = dashboardContext();
  try {
    const job = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'レストランを予約して', source_message_id: 'actors' });
    const login = await context.login();
    const response = await action(context, login.cookie, login.csrfNonce, job.job_id, actionId('6'), 'approve', {
      status: job.status, policy_decision: job.policy_decision, attempts: job.attempts, updated_at: job.updated_at,
    });
    expect(response.status).toBe(200);
    expect(context.db.prepare('SELECT actor,action,outcome FROM operator_actions').all()).toEqual([{ actor: 'dashboard:owner', action: 'approve', outcome: 'applied' }]);
    expect(context.db.prepare("SELECT actor FROM job_events WHERE job_id=? AND type='job.policy_approved'").all(job.job_id)).toEqual([{ actor: 'genie' }]);
  } finally { context.close(); }
});

test('D25 and D26 same action replay is idempotent and a reused ID with different input is rejected', async () => {
  const context = dashboardContext();
  try {
    const job = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'レストランを予約して', source_message_id: 'replay' });
    const login = await context.login();
    const expected = { status: job.status, policy_decision: job.policy_decision, attempts: job.attempts, updated_at: job.updated_at };
    const first = await action(context, login.cookie, login.csrfNonce, job.job_id, actionId('7'), 'approve', expected);
    const counts = context.db.prepare('SELECT (SELECT count(*) FROM job_events WHERE job_id=?) AS events,(SELECT count(*) FROM operator_actions) AS actions').get(job.job_id);
    const replay = await action(context, login.cookie, login.csrfNonce, job.job_id, actionId('7'), 'approve', expected);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: 'applied', job: { expected: { policy_decision: 'approved' } } });
    expect(context.db.prepare('SELECT (SELECT count(*) FROM job_events WHERE job_id=?) AS events,(SELECT count(*) FROM operator_actions) AS actions').get(job.job_id)).toEqual(counts);
    const reused = await action(context, login.cookie, login.csrfNonce, job.job_id, actionId('7'), 'reject', expected);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ error: { code: 'ACTION_ID_REUSED' } });
    expect((await first.json())).toMatchObject({ outcome: 'applied' });
  } finally { context.close(); }
});

test('D27 and D28 stale expected states return the latest safe state without another event', async () => {
  const context = dashboardContext();
  try {
    const job = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'レストランを予約して', source_message_id: 'stale' });
    const login = await context.login();
    new JobStore({ db: context.db, clock: context.clock, config: context.config }).approve(job.job_id);
    const before = context.db.prepare('SELECT count(*) AS n FROM job_events WHERE job_id=?').get(job.job_id);
    const stale = await action(context, login.cookie, login.csrfNonce, job.job_id, actionId('8'), 'approve', {
      status: job.status, policy_decision: job.policy_decision, attempts: job.attempts, updated_at: job.updated_at,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'STATE_CHANGED' }, job: { expected: { policy_decision: 'approved' } } });
    expect(context.db.prepare('SELECT count(*) AS n FROM job_events WHERE job_id=?').get(job.job_id)).toEqual(before);
    expect(context.db.prepare('SELECT outcome FROM operator_actions').all()).toEqual([{ outcome: 'stale' }]);
  } finally { context.close(); }
});

test('D29 has no bulk approval or deny retry route and never changes capabilities from the browser', async () => {
  const context = dashboardContext();
  try {
    const denied = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'パスワードを教えて', source_message_id: 'never-retry' });
    const login = await context.login();
    expect((await context.json('POST', '/api/jobs/bulk-approve', {}, context.authorize(login.cookie, login.csrfNonce))).status).toBe(404);
    const retry = await action(context, login.cookie, login.csrfNonce, denied.job_id, actionId('9'), 'retry', {
      status: denied.status, policy_decision: denied.policy_decision, attempts: denied.attempts, updated_at: denied.updated_at,
    });
    expect(retry.status).toBe(409);
    expect(context.db.prepare('SELECT allowed_capabilities,policy_decision FROM jobs WHERE job_id=?').get(denied.job_id)).toEqual({ allowed_capabilities: '[]', policy_decision: 'deny' });
  } finally { context.close(); }
});

test('D38 an audit insert failure rolls back the JobStore state and event', async () => {
  const context = dashboardContext();
  try {
    const job = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'レストランを予約して', source_message_id: 'rollback' });
    context.db.exec("CREATE TRIGGER fail_operator_action BEFORE INSERT ON operator_actions BEGIN SELECT RAISE(ABORT,'dummy audit failure'); END");
    const login = await context.login();
    const response = await action(context, login.cookie, login.csrfNonce, job.job_id, actionId('0'), 'approve', {
      status: job.status, policy_decision: job.policy_decision, attempts: job.attempts, updated_at: job.updated_at,
    });
    expect(response.status).toBe(500);
    expect(context.db.prepare('SELECT status,policy_decision FROM jobs WHERE job_id=?').get(job.job_id)).toEqual({ status: 'queued', policy_decision: 'hold' });
    expect(context.db.prepare('SELECT count(*) AS n FROM job_events WHERE job_id=?').get(job.job_id)).toEqual({ n: 1 });
    expect(context.db.prepare('SELECT count(*) AS n FROM operator_actions').get()).toEqual({ n: 0 });
  } finally { context.close(); }
});

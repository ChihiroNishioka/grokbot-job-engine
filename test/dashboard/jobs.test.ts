import { expect, test } from 'vitest';
import { dashboardContext } from './helpers.js';

test('job detail and trace return allowlisted job, event, and run fields only', async () => {
  const context = dashboardContext();
  try {
    const job = context.seedJob({ source_message_id: 'detail', request_text: 'private request detail' });
    context.db.prepare("UPDATE jobs SET status='failed',error=? WHERE job_id=?").run(JSON.stringify({ code: 'FAILED_CODE', message: 'private full error' }), job.job_id);
    context.db.prepare("INSERT INTO job_events(job_id,at,actor,type,from_status,to_status,reason,detail) VALUES (?,?,?,?,?,?,?,?)").run(job.job_id, context.clock.now(), 'api', 'job.failed', 'claimed', 'failed', 'lease_expired', 'private event detail');
    context.db.prepare("INSERT INTO job_runs(job_id,attempt,worker_id,started_at,ended_at,outcome,error_code) VALUES (?,?,?,?,?,?,?)").run(job.job_id, 1, 'worker-test', context.clock.now() - 100, context.clock.now(), 'failed', 'FAILED_CODE');
    const login = await context.login();
    const details = await context.json('GET', `/api/jobs/${job.job_id}`, undefined, { Cookie: login.cookie });
    expect(await details.json()).toMatchObject({ job: {
      job_id: job.job_id, status_label: '失敗', requester: '本人', request_present: true, result_present: false,
      error_code: 'FAILED_CODE', expected: { status: 'failed' },
    } });
    const trace = await context.json('GET', `/api/jobs/${job.job_id}/trace`, undefined, { Cookie: login.cookie });
    const traceBody = await trace.json() as { events: unknown[]; runs: unknown[] };
    expect(traceBody.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'job.failed', reason_code: 'lease_expired' })]));
    expect(traceBody.runs).toMatchObject([{ worker_id: 'worker-test', error_code: 'FAILED_CODE' }]);
    const missing = await context.json('GET', '/api/jobs/J-999999', undefined, { Cookie: login.cookie });
    expect(missing.status).toBe(404);
  } finally { context.close(); }
});

test('detail lists stored capabilities and reason codes without exposing editable policy fields', async () => {
  const context = dashboardContext();
  try {
    const job = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'レストランを予約して', source_message_id: 'capabilities' });
    const login = await context.login();
    const response = await context.json('GET', `/api/jobs/${job.job_id}`, undefined, { Cookie: login.cookie });
    const body = await response.text();
    expect(body).toContain('booking');
    expect(body).not.toContain('allowed_capabilities=');
    expect(body).not.toContain('policy_decision=');
    expect(body).not.toContain('email:member@example.com');
  } finally { context.close(); }
});

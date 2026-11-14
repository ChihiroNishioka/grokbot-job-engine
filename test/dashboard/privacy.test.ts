import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { createAliasResolver } from '../../src/dashboard/aliases.js';
import { dashboardContext } from './helpers.js';

test('D09 HMAC aliases are stable, distinct, and never expose sender handles', async () => {
  const context = dashboardContext();
  try {
    const handleA = 'email:member-a@example.com';
    const handleB = 'email:member-b@example.com';
    const resolver = createAliasResolver({ key: context.config.DASHBOARD_ALIAS_KEY, aliases: {}, handles: [handleA, handleB] });
    expect(resolver('member', handleA)).toBe(resolver('member', handleA));
    expect(resolver('member', handleA)).not.toBe(resolver('member', handleB));
    expect(resolver('self', handleA)).toBe('本人');
    expect(resolver('member', null)).toBe('家族（識別なし）');
    const job = context.seedJob({ requester_id: 'member', sender_handle: handleA, request_text: 'dummy request', source_message_id: 'alias' });
    const login = await context.login();
    const response = await context.json('GET', `/api/jobs/${job.job_id}`, undefined, { Cookie: login.cookie });
    const body = await response.text();
    expect(body).toContain(resolver('member', handleA));
    expect(body).not.toContain(handleA);
    const key = createHmac('sha256', context.config.DASHBOARD_ALIAS_KEY).update(handleA).digest('hex');
    const mapped = createAliasResolver({ key: context.config.DASHBOARD_ALIAS_KEY, aliases: { [key]: '家族B' }, handles: [handleA] });
    expect(mapped('member', handleA)).toBe('家族B');
  } finally { context.close(); }
});

test('D19 ordinary job and trace responses omit body, result, full error, handles, source IDs, and claim tokens', async () => {
  const context = dashboardContext();
  try {
    const handle = 'email:private-member@example.com';
    const job = context.seedJob({ requester_id: 'member', sender_handle: handle, request_text: 'request-secret-marker', source_message_id: 'private-message-id', source_chat_id: 'chat-a' });
    context.db.prepare("UPDATE jobs SET status='failed',result=?,error=?,claim_token='dummy-claim-token-secret' WHERE job_id=?").run(JSON.stringify({ value: 'result-secret-marker' }), JSON.stringify({ code: 'WORKER_FAILED', message: 'full-error-secret-marker' }), job.job_id);
    context.db.prepare("INSERT INTO job_events(job_id,at,actor,type,detail,reason) VALUES (?,?,?,?,?,?)").run(job.job_id, context.clock.now(), 'api', 'job.failed', JSON.stringify({ detail: 'event-secret-marker' }), 'reason-secret-marker');
    const login = await context.login();
    for (const path of [`/api/jobs/${job.job_id}`, `/api/jobs/${job.job_id}/trace`, '/api/inbox/failures']) {
      const response = await context.json('GET', path, undefined, { Cookie: login.cookie });
      const body = await response.text();
      for (const privateValue of ['request-secret-marker', 'result-secret-marker', 'full-error-secret-marker', handle, 'private-message-id', 'private-chat-id', 'dummy-claim-token-secret', 'event-secret-marker', 'reason-secret-marker']) {
        expect(body).not.toContain(privateValue);
      }
    }
  } finally { context.close(); }
});

test('D20 reveal reads only the requested masked text and audits only the part and action ID', async () => {
  const context = dashboardContext();
  try {
    const handle = 'email:member@example.com';
    const requestText = `本文 <em>ダミー</em> ${handle} dummy-request-token-12345678901234567890`;
    const resultText = JSON.stringify({ html: '<strong>結果</strong>', note: `${handle} result-secret-marker` });
    const job = context.seedJob({ requester_id: 'member', sender_handle: handle, request_text: requestText, source_message_id: 'reveal' });
    context.db.prepare('UPDATE jobs SET status=\'done\',result=? WHERE job_id=?').run(resultText, job.job_id);
    const login = await context.login();
    const requestId = '00000000-0000-4000-8000-000000000020';
    const revealedRequest = await context.json('POST', `/api/jobs/${job.job_id}/reveal`, { action_id: requestId, part: 'request' }, context.authorize(login.cookie, login.csrfNonce));
    expect(revealedRequest.status).toBe(200);
    const requestBody = await revealedRequest.json();
    expect(requestBody).toMatchObject({ part: 'request' });
    expect(JSON.stringify(requestBody)).toContain('<em>');
    expect(JSON.stringify(requestBody)).toContain('[REDACTED]');
    expect(JSON.stringify(requestBody)).not.toContain(handle);
    expect(JSON.stringify(requestBody)).not.toContain('result-secret-marker');
    const audit = context.db.prepare('SELECT actor,action,request_hash,outcome,reason_code FROM operator_actions').get();
    expect(audit).toMatchObject({ actor: 'dashboard:owner', action: 'reveal_request', outcome: 'revealed' });
    expect(JSON.stringify(audit)).not.toContain(requestText);
    expect(JSON.stringify(audit)).not.toContain(resultText);
    const revealedResult = await context.json('POST', `/api/jobs/${job.job_id}/reveal`, {
      action_id: '00000000-0000-4000-8000-000000000021', part: 'result',
    }, context.authorize(login.cookie, login.csrfNonce));
    const resultBody = JSON.stringify(await revealedResult.json());
    expect(resultBody).toContain('<strong>');
    expect(resultBody).not.toContain(requestText);
    const response = await context.json('GET', `/api/jobs/${job.job_id}`, undefined, { Cookie: login.cookie });
    expect(await response.text()).not.toContain(requestText);
  } finally { context.close(); }
});

test('D30 trace allowlists event reasons and run values', async () => {
  const context = dashboardContext();
  try {
    const job = context.seedJob({ source_message_id: 'trace' });
    context.db.prepare("INSERT INTO job_events(job_id,at,actor,type,from_status,to_status,reason,detail) VALUES (?,?,?,?,?,?,?,?)").run(job.job_id, context.clock.now(), 'api', 'job.created', null, 'queued', 'arbitrary-reason-secret', 'arbitrary-detail-secret');
    context.db.prepare("INSERT INTO job_runs(job_id,attempt,worker_id,started_at,outcome,error_code) VALUES (?,?,?,?,?,?)").run(job.job_id, 1, 'worker-safe', context.clock.now(), 'failed', 'SAFE_ERROR');
    const login = await context.login();
    const response = await context.json('GET', `/api/jobs/${job.job_id}/trace`, undefined, { Cookie: login.cookie });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('worker-safe');
    expect(body).toContain('SAFE_ERROR');
    expect(body).not.toContain('arbitrary-reason-secret');
    expect(body).not.toContain('arbitrary-detail-secret');
  } finally { context.close(); }
});

import { expect, test } from 'vitest';
import { dashboardContext } from './helpers.js';

test('D07 session returns a csrf nonce and every authenticated POST checks origin, fetch site, and nonce', async () => {
  const context = dashboardContext();
  try {
    const login = await context.login();
    expect(login.csrfNonce).toBeTruthy();
    const request = { action_id: '00000000-0000-4000-8000-000000000001', action: 'approve', expected: { status: 'queued', policy_decision: 'hold', attempts: 0, updated_at: context.clock.now() } };
    const path = '/api/jobs/J-000001/actions';
    const invalidHeaders = [
      { Cookie: login.cookie },
      { ...context.sameOrigin, Cookie: login.cookie },
      { ...context.sameOrigin, Cookie: login.cookie, 'X-CSRF-Token': 'wrong-dummy' },
      { ...context.sameOrigin, Origin: 'http://evil.invalid', Cookie: login.cookie, 'X-CSRF-Token': login.csrfNonce },
      { ...context.sameOrigin, 'Sec-Fetch-Site': 'cross-site', Cookie: login.cookie, 'X-CSRF-Token': login.csrfNonce },
    ];
    for (const headers of invalidHeaders) expect((await context.json('POST', path, request, headers)).status).toBe(403);
    const audit = context.db.prepare('SELECT count(*) AS n FROM operator_actions').get();
    expect(audit).toEqual({ n: 0 });
    const valid = await context.json('POST', '/reauth', { token: context.config.DASHBOARD_TOKEN }, context.authorize(login.cookie, login.csrfNonce));
    expect(valid.status).toBe(200);
  } finally { context.close(); }
});

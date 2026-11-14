import { expect, test } from 'vitest';
import { dashboardContext } from './helpers.js';
import { dashboardToken } from './env.js';

test('D04 unauthenticated HTML is Japanese and API authentication uses only the dashboard token', async () => {
  const context = dashboardContext();
  try {
    const html = await context.app.request('/');
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('ログイン');
    for (const token of [context.config.JOB_API_TOKEN, context.config.GENIE_TOKEN, 'wrong-dummy-token']) {
      const result = await context.json('POST', '/login', { token }, context.sameOrigin);
      expect(result.status).toBe(401);
      expect(result.headers.get('set-cookie')).toBeNull();
    }
    expect(dashboardToken).not.toBe(context.config.JOB_API_TOKEN);
  } finally { context.close(); }
});

test('D05 and D06 login keeps credentials out of responses and creates a protected strict cookie session', async () => {
  const context = dashboardContext();
  try {
    const login = await context.login();
    expect(login.response.status).toBe(200);
    const cookie = login.response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain(context.config.DASHBOARD_TOKEN);
    expect(await login.response.text()).not.toContain(context.config.DASHBOARD_TOKEN);
    const protectedResponse = await context.json('GET', '/api/overview?period=today&dimension=status', undefined, { Cookie: login.cookie });
    expect(protectedResponse.status).toBe(200);
    context.clock.advance(12 * 60 * 60 * 1000);
    const afterExpiry = await context.json('GET', '/api/overview?period=today&dimension=status', undefined, { Cookie: login.cookie });
    expect(afterExpiry.status).toBe(401);
    const publicHtml = await context.app.request('/login');
    expect(await publicHtml.text()).not.toContain(context.config.DASHBOARD_TOKEN);
    expect(context.config.DASHBOARD_TOKEN).toBe(dashboardToken);
  } finally { context.close(); }
});

test('D08 mutations allow exactly fifteen minutes after token verification and reject older sessions', async () => {
  for (const [delta, expectedStatus] of [[15 * 60 * 1000, 200], [15 * 60 * 1000 + 1, 403]] as const) {
    const context = dashboardContext();
    try {
      const job = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'レストランを予約して' });
      const login = await context.login();
      context.clock.advance(delta);
      const response = await context.json('POST', `/api/jobs/${job.job_id}/actions`, {
        action_id: `00000000-0000-4000-8000-0000abcd00a${delta === 15 * 60 * 1000 ? '1' : '2'}`,
        action: 'approve', expected: { status: job.status, policy_decision: job.policy_decision, attempts: job.attempts, updated_at: job.updated_at },
      }, context.authorize(login.cookie, login.csrfNonce));
      expect(response.status).toBe(expectedStatus);
    } finally { context.close(); }
  }
});

test('D08 reauthentication refreshes the write window without replacing the session', async () => {
  const context = dashboardContext();
  try {
    const login = await context.login();
    context.clock.advance(16 * 60 * 1000);
    const reauth = await context.json('POST', '/reauth', { token: context.config.DASHBOARD_TOKEN }, context.authorize(login.cookie, login.csrfNonce));
    expect(reauth.status).toBe(200);
    expect(reauth.headers.get('set-cookie')).toBeNull();
    const session = await context.json('GET', '/api/session', undefined, { Cookie: login.cookie });
    expect(session.status).toBe(200);
  } finally { context.close(); }
});

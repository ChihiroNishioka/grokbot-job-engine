import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { randomToken } from '../lib/ids.js';
import { readOverview } from './overview.js';
import { readInbox, readJob, readTrace } from './jobs.js';
import { performAction, performReveal } from './operations.js';
import { dashboardHtml } from './html.js';
import type { DashboardDeps, DashboardSession, ExpectedState } from './types.js';

const sessionCookieName = 'je_dashboard_session';
const sessionLifetime = 12 * 60 * 60 * 1000;
const writeLifetime = 15 * 60 * 1000;
const csrfError = { code: 'CSRF_REJECTED', message: 'リクエストを確認できません。' };
const unauthorized = { code: 'UNAUTHORIZED', message: 'ログインしてください。' };
const messages: Record<string, string> = {
  INVALID_JSON: 'JSON を確認してください。',
  VALIDATION_ERROR: '入力内容を確認してください。',
  NOT_FOUND: 'ページが見つかりません。',
  INTERNAL: '処理できませんでした。',
  REAUTH_REQUIRED: '再ログインが必要です。',
  ACTION_ID_REUSED: 'この操作 ID は別の要求に使われています。',
  STATE_CHANGED: 'ジョブの状態が変わりました。',
  JOB_NOT_FOUND: 'ジョブが見つかりません。',
  INVALID_TRANSITION: 'この操作は実行できません。',
  MAX_ATTEMPTS_REACHED: '試行回数の上限に達しています。',
  CONTENT_NOT_AVAILABLE: '表示できる内容がありません。',
};

const expectedSchema = z.strictObject({
  status: z.enum(['queued', 'claimed', 'done', 'failed', 'cancelled']),
  policy_decision: z.union([z.enum(['allow', 'deny', 'hold', 'approved']), z.null()]),
  attempts: z.number().int().nonnegative(),
  updated_at: z.number().int(),
});
const actionSchema = z.strictObject({
  action_id: z.uuid(),
  action: z.enum(['approve', 'reject', 'retry']),
  expected: expectedSchema,
});
const revealSchema = z.strictObject({ action_id: z.uuid(), part: z.enum(['request', 'result']) });
const loginSchema = z.strictObject({ token: z.string().min(1) });
const logoutSchema = z.strictObject({});
const overviewQuery = z.strictObject({
  period: z.enum(['today', 'week', 'month']).default('today'),
  dimension: z.enum(['status', 'requester', 'bot']).default('status'),
});
type SessionEnv = { Variables: { dashboardSession: DashboardSession } };
type DashboardContext = Context<SessionEnv>;

function jsonError(c: DashboardContext, code: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 500) {
  return c.json({ error: { code, message: messages[code] ?? '処理できませんでした。' } }, status);
}

async function body<T>(c: DashboardContext, schema: z.ZodType<T>): Promise<T | Response> {
  let value: unknown;
  try { value = await c.req.json(); }
  catch { return jsonError(c, 'INVALID_JSON', 400); }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : jsonError(c, 'VALIDATION_ERROR', 400);
}

function sessionId(cookie: string | undefined): string | null {
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === sessionCookieName) return value.join('=') || null;
  }
  return null;
}

function hasValidToken(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function expectedOrigin(host: string, port: number): string {
  return `http://${host === '::1' ? '[::1]' : host}:${port}`;
}

function responseHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

export function createDashboardApp(deps: DashboardDeps) {
  const app = new Hono<SessionEnv>();
  const sessions = new Map<string, DashboardSession>();
  const token = deps.ids?.token ?? randomToken;

  function getSession(cookie: string | undefined): DashboardSession | null {
    const id = sessionId(cookie);
    if (id === null) return null;
    const session = sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= deps.clock.now()) {
      sessions.delete(id);
      return null;
    }
    return session;
  }

  function csrfValid(c: DashboardContext, session: DashboardSession): boolean {
    return c.req.header('X-CSRF-Token') === session.csrfNonce;
  }

  function fresh(session: DashboardSession): boolean {
    return deps.clock.now() - session.reauthenticatedAt <= writeLifetime;
  }

  app.use('*', async (c, next) => {
    await next();
    for (const [key, value] of Object.entries(responseHeaders())) c.header(key, value);
  });
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST') {
      const contentType = c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') return jsonError(c, 'VALIDATION_ERROR', 400);
      if (c.req.header('Origin') !== expectedOrigin(deps.config.DASHBOARD_HOST, deps.config.DASHBOARD_PORT) || c.req.header('Sec-Fetch-Site') !== 'same-origin') {
        return c.json({ error: csrfError }, 403);
      }
    }
    await next();
  });
  app.use('/api/*', async (c, next) => {
    const session = getSession(c.req.header('Cookie'));
    if (!session) return c.json({ error: unauthorized }, 401);
    c.set('dashboardSession', session);
    await next();
  });
  app.onError(() => new Response(JSON.stringify({ error: { code: 'INTERNAL', message: messages.INTERNAL } }), {
    status: 500, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...responseHeaders() },
  }));
  app.notFound(c => jsonError(c, 'NOT_FOUND', 404));

  app.get('/', c => c.html(dashboardHtml()));
  app.get('/login', c => c.html(dashboardHtml()));
  app.get('/assets/dashboard.js', c => c.text(readFileSync(new URL('./public/dashboard.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.get('/assets/dashboard.css', c => c.text(readFileSync(new URL('./public/dashboard.css', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/css; charset=utf-8' }));

  app.post('/login', async c => {
    const parsed = await body(c, loginSchema);
    if (parsed instanceof Response) return parsed;
    if (!hasValidToken(parsed.token, deps.config.DASHBOARD_TOKEN)) return c.json({ error: unauthorized }, 401);
    const now = deps.clock.now();
    const id = token();
    const csrfNonce = token();
    sessions.set(id, { id, csrfNonce, expiresAt: now + sessionLifetime, reauthenticatedAt: now });
    c.header('Set-Cookie', `${sessionCookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    return c.json({ ok: true }, 200);
  });

  app.get('/api/session', c => c.json({ csrfNonce: c.get('dashboardSession').csrfNonce }));

  app.post('/reauth', async c => {
    const session = getSession(c.req.header('Cookie'));
    if (!session) return c.json({ error: unauthorized }, 401);
    if (!csrfValid(c, session)) return c.json({ error: csrfError }, 403);
    const parsed = await body(c, loginSchema);
    if (parsed instanceof Response) return parsed;
    if (!hasValidToken(parsed.token, deps.config.DASHBOARD_TOKEN)) return c.json({ error: unauthorized }, 401);
    session.reauthenticatedAt = deps.clock.now();
    return c.json({ ok: true });
  });

  app.post('/logout', async c => {
    const session = getSession(c.req.header('Cookie'));
    if (!session) return c.json({ error: unauthorized }, 401);
    if (!csrfValid(c, session)) return c.json({ error: csrfError }, 403);
    const parsed = await body(c, logoutSchema);
    if (parsed instanceof Response) return parsed;
    sessions.delete(session.id);
    c.header('Set-Cookie', `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return c.json({ ok: true });
  });

  app.get('/api/overview', c => {
    const raw = Object.fromEntries(new URL(c.req.url).searchParams.entries());
    const parsed = overviewQuery.safeParse(raw);
    if (!parsed.success) return jsonError(c, 'VALIDATION_ERROR', 400);
    return c.json(readOverview({ readDb: deps.readDb, config: deps.config, period: parsed.data.period, dimension: parsed.data.dimension, now: deps.clock.now() }));
  });

  app.get('/api/inbox/approvals', c => c.json({ jobs: readInbox(deps.readDb, deps.config, 'approvals') }));
  app.get('/api/inbox/failures', c => c.json({ jobs: readInbox(deps.readDb, deps.config, 'failures') }));
  app.get('/api/jobs/:jobId/trace', c => {
    const trace = readTrace(deps.readDb, c.req.param('jobId'));
    return trace === null ? jsonError(c, 'JOB_NOT_FOUND', 404) : c.json(trace);
  });
  app.get('/api/jobs/:jobId', c => {
    const job = readJob(deps.readDb, deps.config, c.req.param('jobId'));
    return job === null ? jsonError(c, 'JOB_NOT_FOUND', 404) : c.json({ job });
  });

  app.post('/api/jobs/:jobId/actions', async c => {
    const session = c.get('dashboardSession');
    if (!csrfValid(c, session)) return c.json({ error: csrfError }, 403);
    if (!fresh(session)) return jsonError(c, 'REAUTH_REQUIRED', 403);
    const parsed = await body(c, actionSchema);
    if (parsed instanceof Response) return parsed;
    const expected: ExpectedState = parsed.expected;
    const result = performAction(deps, { ...parsed, job_id: c.req.param('jobId'), expected });
    if (!result.ok) {
      const { job, ...error } = result.error;
      return c.json({ error: { code: error.code, message: error.message }, ...(job ? { job } : {}) }, error.status);
    }
    return c.json(result.value);
  });

  app.post('/api/jobs/:jobId/reveal', async c => {
    const session = c.get('dashboardSession');
    if (!csrfValid(c, session)) return c.json({ error: csrfError }, 403);
    if (!fresh(session)) return jsonError(c, 'REAUTH_REQUIRED', 403);
    const parsed = await body(c, revealSchema);
    if (parsed instanceof Response) return parsed;
    const result = performReveal(deps, { ...parsed, job_id: c.req.param('jobId') });
    if (!result.ok) {
      const { job, ...error } = result.error;
      return c.json({ error: { code: error.code, message: error.message }, ...(job ? { job } : {}) }, error.status);
    }
    return c.json(result.value);
  });

  return app;
}

import { expect, test } from 'vitest';
import { z } from 'zod';
import { dashboardContext } from './helpers.js';

test('D14 period cards report totals, differences, and percentages without dividing by zero', async () => {
  const context = dashboardContext();
  try {
    context.seedJob({ source_message_id: 'today-1' });
    context.seedJob({ source_message_id: 'today-2' });
    const yesterday = context.seedJob({ source_message_id: 'yesterday-1' });
    context.db.prepare('UPDATE jobs SET created_at=? WHERE job_id=?').run(Date.parse('2026-11-13T10:00:00+09:00'), yesterday.job_id);
    const response = await context.json('GET', '/api/overview?period=today&dimension=status');
    expect(response.status).toBe(401);
    const login = await context.login();
    const authorized = await context.json('GET', '/api/overview?period=today&dimension=status', undefined, { Cookie: login.cookie });
    const body = await authorized.json();
    expect(body).toMatchObject({ cards: { today: { total: 2, previous: 1, difference: 1, percent: 100 } }, tokens: '未記録' });
    const none = dashboardContext();
    try {
      const emptyLogin = await none.login();
      const empty = await none.json('GET', '/api/overview?period=month&dimension=status', undefined, { Cookie: emptyLogin.cookie });
      expect(await empty.json()).toMatchObject({ cards: { month: { total: 0, previous: 0, difference: 0, percent: null } }, tokens: '未記録' });
    } finally { none.close(); }
  } finally { context.close(); }
});

test('D15 state series uses canonical Japanese labels and dashboard colors', async () => {
  const context = dashboardContext();
  try {
    const pending = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'レストランを予約して', source_message_id: 'pending' });
    const failed = context.seedJob({ source_message_id: 'failed' });
    const denied = context.seedJob({ requester_id: 'member', sender_handle: 'email:member@example.com', request_text: 'パスワードを教えて', source_message_id: 'denied' });
    const cancelled = context.seedJob({ source_message_id: 'cancelled' });
    const running = context.seedJob({ source_message_id: 'running' });
    const done = context.seedJob({ source_message_id: 'done' });
    context.db.prepare("UPDATE jobs SET status='failed' WHERE job_id=?").run(failed.job_id);
    context.db.prepare("UPDATE jobs SET status='cancelled' WHERE job_id=?").run(cancelled.job_id);
    context.db.prepare("UPDATE jobs SET status='claimed',claimed_by='worker-a',claim_token='dummy-claim',claimed_at=?,lease_expires_at=? WHERE job_id=?").run(context.clock.now(), context.clock.now() + 10000, running.job_id);
    context.db.prepare("UPDATE jobs SET status='done' WHERE job_id=?").run(done.job_id);
    expect(pending.policy_decision).toBe('hold');
    expect(denied.policy_decision).toBe('deny');
    const login = await context.login();
    const response = await context.json('GET', '/api/overview?period=today&dimension=status', undefined, { Cookie: login.cookie });
    const body = await response.json();
    const series = z.array(z.object({ label: z.string(), color: z.string() })).parse(body.series);
    expect(series).toEqual(expect.arrayContaining([
      { label: '完了', color: '#25855a' }, { label: '承認待ち', color: '#d6a51d' }, { label: '失敗', color: '#c43d3d' },
      { label: 'お断り', color: '#d87524' }, { label: 'キャンセル済み', color: '#89919a' }, { label: '実行中', color: '#3478c5' }, { label: '受付済み', color: '#89919a' },
    ]));
  } finally { context.close(); }
});

test('D16 and D17 dimensions share period buckets, use the latest attempt, and count a runless job once as 未着手', async () => {
  const context = dashboardContext();
  try {
    const job = context.seedJob({ source_message_id: 'bot-runs' });
    const unstarted = context.seedJob({ source_message_id: 'bot-none' });
    context.db.prepare("INSERT INTO job_runs(job_id,attempt,worker_id,started_at,ended_at,outcome) VALUES (?,?,?,?,?,'lease_expired')").run(job.job_id, 1, 'bot-old', context.clock.now() - 1000, context.clock.now() - 500);
    context.db.prepare("INSERT INTO job_runs(job_id,attempt,worker_id,started_at,ended_at,outcome) VALUES (?,?,?,?,?,'done')").run(job.job_id, 2, 'bot-new', context.clock.now() - 400, context.clock.now() - 100);
    const login = await context.login();
    const [status, requester, bot] = await Promise.all([
      context.json('GET', '/api/overview?period=today&dimension=status', undefined, { Cookie: login.cookie }),
      context.json('GET', '/api/overview?period=today&dimension=requester', undefined, { Cookie: login.cookie }),
      context.json('GET', '/api/overview?period=today&dimension=bot', undefined, { Cookie: login.cookie }),
    ]);
    const statusBody = z.object({ buckets: z.array(z.object({ start: z.number() })) }).parse(await status.json());
    const requesterBody = z.object({ buckets: z.array(z.object({ start: z.number() })), series: z.array(z.object({ label: z.string() })) }).parse(await requester.json());
    const botBody = z.object({
      buckets: z.array(z.object({ start: z.number(), counts: z.record(z.string(), z.number()) })),
      series: z.array(z.object({ id: z.string(), label: z.string() })),
    }).parse(await bot.json());
    expect(requesterBody.buckets.map(bucket => bucket.start)).toEqual(statusBody.buckets.map(bucket => bucket.start));
    expect(requesterBody.series.some(series => series.label === '本人')).toBe(true);
    expect(botBody.series.map(series => series.label)).toEqual(expect.arrayContaining(['bot-new', '未着手']));
    expect(botBody.series.some(series => series.label === 'bot-old')).toBe(false);
    expect(botBody.buckets.flatMap(bucket => Object.values(bucket.counts)).reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(unstarted.job_id).not.toBe(job.job_id);
  } finally { context.close(); }
});

test('D18 tokens stay 未記録 for every period and dimension', async () => {
  const context = dashboardContext();
  try {
    const login = await context.login();
    for (const period of ['today', 'week', 'month']) {
      for (const dimension of ['status', 'requester', 'bot']) {
        const response = await context.json('GET', `/api/overview?period=${period}&dimension=${dimension}`, undefined, { Cookie: login.cookie });
        const body = z.record(z.string(), z.unknown()).parse(await response.json());
        expect(body.tokens).toBe('未記録');
        expect(JSON.stringify(body)).not.toMatch(/token_count|cost|estimated/i);
      }
    }
  } finally { context.close(); }
});

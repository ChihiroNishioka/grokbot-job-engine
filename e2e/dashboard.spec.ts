import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const token = 'dummy-dashboard-token-00000000000000000000000000000000';
const jobId = 'J-000001';
const safeJob = {
  job_id: jobId, status: 'queued', status_label: '承認待ち', requester: '家族A', created_at: '2026-11-14T00:00:00.000Z',
  attempts: 0, max_attempts: 3, allowed_capabilities: ['booking'], reason_code: 'needs_review',
  expected: { status: 'queued', policy_decision: 'hold', attempts: 0, updated_at: 1794600000000 },
  request_present: true, result_present: false, error_code: null,
};
const emptyOverview = {
  period: 'today', dimension: 'status',
  cards: {
    today: { total: 0, previous: 0, difference: 0, percent: null },
    week: { total: 0, previous: 0, difference: 0, percent: null },
    month: { total: 0, previous: 0, difference: 0, percent: null },
  },
  series: [], buckets: [], jobs: [], tokens: '未記録',
};

async function screenshot(page: Page, info: TestInfo, name: string) {
  const directory = process.env.SCREENSHOT_DIR ?? tmpdir();
  mkdirSync(directory, { recursive: true });
  const width = page.viewportSize()?.width ?? 'unknown';
  await page.screenshot({ path: join(directory, `dashboard-${width}-${name}.png`), fullPage: true });
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

async function mockData(page: Page) {
  await page.route('**/api/overview?*', route => route.fulfill({ json: emptyOverview }));
  await page.route('**/api/inbox/approvals', route => route.fulfill({ json: { jobs: [safeJob] } }));
  await page.route('**/api/inbox/failures', route => route.fulfill({ json: { jobs: [{ ...safeJob, status: 'failed', status_label: '失敗' }] } }));
  await page.route(`**/api/jobs/${jobId}/trace`, route => route.fulfill({ json: { events: [], runs: [] } }));
  await page.route(`**/api/jobs/${jobId}`, route => route.fulfill({ json: { job: safeJob } }));
  await page.route(`**/api/jobs/${jobId}/reveal`, route => route.fulfill({ json: { part: 'request', text: '本文 <em>ダミー</em>' } }));
}

async function login(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible();
  await page.locator('#login-token').fill(token);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page.getByRole('heading', { name: '概況' })).toBeVisible();
}

for (const width of [1280, 390]) {
  test(`D31 and D32 dashboard states at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await mockData(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible();
    await screenshot(page, info, 'login');
    await expectNoHorizontalOverflow(page);
    await page.locator('#login-token').fill(token);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(page.getByRole('heading', { name: '概況' })).toBeVisible();
    await expect(page.locator('.period-tabs').first().getByRole('button', { name: '今日' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('該当するジョブはありません')).toBeVisible();
    await screenshot(page, info, 'empty');
    await expectNoHorizontalOverflow(page);

    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.unroute('**/api/overview?*');
    await page.route('**/api/overview?*', async route => { await gate; await route.fulfill({ json: emptyOverview }); });
    await page.locator('.period-tabs').first().getByRole('button', { name: '今週' }).click();
    await expect(page.getByText('読み込み中')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(1);
    await screenshot(page, info, 'loading');
    await expectNoHorizontalOverflow(page);
    release?.();
    await expect(page.getByText('該当するジョブはありません')).toBeVisible();

    await page.unroute('**/api/overview?*');
    await page.route('**/api/overview?*', route => route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: '更新できません' } } }));
    await page.locator('.period-tabs').first().getByRole('button', { name: '今月' }).click();
    await expect(page.getByText('更新できません')).toBeVisible();
    await expect(page.getByRole('button', { name: '再試行' })).toBeVisible();
    await screenshot(page, info, 'error');
    await expectNoHorizontalOverflow(page);
    await page.unroute('**/api/overview?*');
    await page.route('**/api/overview?*', route => route.fulfill({ json: emptyOverview }));
    await page.getByRole('button', { name: '再試行' }).click();
    await expect(page.getByText('該当するジョブはありません')).toBeVisible();

    await page.getByRole('button', { name: '承認待ち' }).click();
    await expect(page.getByRole('heading', { name: '承認待ち' })).toBeVisible();
    await expect(page.getByText(jobId)).toBeVisible();
    await screenshot(page, info, 'approvals');
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: '失敗' }).click();
    await expect(page.getByRole('heading', { name: '失敗' })).toBeVisible();
    await expect(page.getByText(jobId)).toBeVisible();
    await screenshot(page, info, 'failures');
    await expectNoHorizontalOverflow(page);
    await page.getByText(jobId).click();
    await expect(page.getByRole('heading', { name: `ジョブ ${jobId}` })).toBeVisible();
    await screenshot(page, info, 'detail');
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: '本文を表示' }).click();
    await expect(page.getByText('本文 <em>ダミー</em>', { exact: true })).toBeVisible();
    await expect(page.locator('main em')).toHaveCount(0);
    await screenshot(page, info, 'reveal');
    await expectNoHorizontalOverflow(page);
  });
}

test('D31 failed overview refresh leaves mutations unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockData(page);
  await login(page);
  await page.route('**/api/overview?*', route => route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: '更新できません' } } }));
  await page.locator('.period-tabs').first().getByRole('button', { name: '今週' }).click();
  await expect(page.getByText('更新できません')).toBeVisible();
  await expect(page.getByRole('button', { name: '承認する' })).toHaveCount(0);
});

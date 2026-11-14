import type Database from 'better-sqlite3';
import { statusLabel } from '../ingress/status-text.js';
import type { Config } from '../config/index.js';
import { bucketContains, periodWindows, type Period } from './periods.js';
import { readJobsInRange } from './jobs.js';
import type { BotMetrics, Dimension, Overview, OverviewBucket, OverviewCard, Series } from './types.js';
import type { Job } from '../store/types.js';

const statusColors: Record<string, string> = {
  '完了': '#25855a',
  '承認待ち': '#d6a51d',
  '失敗': '#c43d3d',
  'お断り': '#d87524',
  'キャンセル済み': '#89919a',
  '実行中': '#3478c5',
  '受付済み': '#89919a',
};
const dimensionColors = ['#6d5bd0', '#008c95', '#a34d91', '#597d2b', '#bd6b30', '#4075a4', '#7b6337', '#b04462'];
const allStatusLabels = Object.keys(statusColors);

function countJobs(readDb: Database.Database, start: number, end: number): number {
  return readDb.prepare<[number, number], { count: number }>(
    'SELECT count(*) AS count FROM jobs WHERE created_at>=? AND created_at<=?',
  ).get(start, end)?.count ?? 0;
}

function card(readDb: Database.Database, period: Period, now: number): OverviewCard {
  const windows = periodWindows(period, now);
  const total = countJobs(readDb, windows.current.start, windows.current.end);
  const previous = countJobs(readDb, windows.previous.start, windows.previous.end);
  return {
    total,
    previous,
    difference: total - previous,
    percent: previous === 0 ? null : Math.round((total - previous) / previous * 100),
  };
}

function statusFor(job: Pick<Job, 'status' | 'policy_decision'>): string {
  return statusLabel(job);
}

function seriesKey(dimension: Dimension, label: string): string {
  return `${dimension}:${label}`;
}

function keyFor(dimension: Dimension, job: { status: Job['status']; expected: { policy_decision: Job['policy_decision'] }; requester: string }, workerId: string | null): { id: string; label: string } {
  if (dimension === 'requester') return { id: seriesKey(dimension, job.requester), label: job.requester };
  if (dimension === 'bot') {
    const label = workerId ?? '未着手';
    return { id: seriesKey(dimension, label), label };
  }
  const label = statusFor({ status: job.status, policy_decision: job.expected.policy_decision });
  return { id: seriesKey(dimension, label), label };
}

function stableColor(key: string): string {
  let hash = 0x811c9dc5;
  for (const character of key) {
    const point = character.codePointAt(0);
    if (point !== undefined) hash = Math.imul(hash ^ point, 16777619);
  }
  return dimensionColors[(hash >>> 0) % dimensionColors.length] ?? dimensionColors[0] ?? '#6d5bd0';
}

function seriesFor(dimension: Dimension, jobs: ReturnType<typeof readJobsInRange>): Series[] {
  if (dimension === 'status') return allStatusLabels.map(label => ({ id: seriesKey(dimension, label), label, color: statusColors[label] ?? '#89919a' }));
  const values = new Map<string, Series>();
  for (const item of jobs) {
    const key = keyFor(dimension, item.job, item.worker_id);
    values.set(key.id, { ...key, color: stableColor(key.id) });
  }
  return [...values.values()].sort((left, right) => left.label.localeCompare(right.label, 'ja'));
}

function botMetrics(readDb: Database.Database, current: ReturnType<typeof readJobsInRange>, start: number, end: number): BotMetrics[] {
  const lastRunJobs = new Map<string, number>();
  for (const item of current) {
    const worker = item.worker_id ?? '未着手';
    lastRunJobs.set(worker, (lastRunJobs.get(worker) ?? 0) + 1);
  }
  const runs = readDb.prepare<[number, number], { worker_id: string; outcome: string; count: number }>(`SELECT worker_id,outcome,count(*) AS count
    FROM job_runs WHERE started_at>=? AND started_at<=? GROUP BY worker_id,outcome`).all(start, end);
  const metrics = new Map<string, BotMetrics>();
  for (const [workerId, count] of lastRunJobs) metrics.set(workerId, { worker_id: workerId, last_run_jobs: count, run_count: 0, success_count: 0, failure_count: 0 });
  for (const row of runs) {
    const currentValue = metrics.get(row.worker_id) ?? { worker_id: row.worker_id, last_run_jobs: 0, run_count: 0, success_count: 0, failure_count: 0 };
    currentValue.run_count += row.count;
    if (row.outcome === 'done') currentValue.success_count += row.count;
    if (row.outcome === 'failed') currentValue.failure_count += row.count;
    metrics.set(row.worker_id, currentValue);
  }
  return [...metrics.values()].sort((left, right) => left.worker_id.localeCompare(right.worker_id, 'ja'));
}

function buildBuckets(
  dimension: Dimension,
  current: ReturnType<typeof readJobsInRange>,
  previous: ReturnType<typeof readJobsInRange>,
  series: Series[],
  currentBuckets: ReturnType<typeof periodWindows>['current']['buckets'],
  previousBuckets: ReturnType<typeof periodWindows>['previous']['buckets'],
): OverviewBucket[] {
  const counts = currentBuckets.map((bucket, index) => {
    const seriesCounts: Record<string, number> = Object.fromEntries(series.map(item => [item.id, 0]));
    const jobs: OverviewBucket['jobs'] = [];
    return {
      ...bucket,
      counts: seriesCounts,
      previous_total: index < previousBuckets.length ? 0 : null,
      jobs,
    };
  });
  for (const item of current) {
    const index = counts.findIndex(bucket => bucketContains(bucket, item.created_at));
    const bucket = counts[index];
    if (!bucket) continue;
    const key = keyFor(dimension, item.job, item.worker_id);
    bucket.counts[key.id] = (bucket.counts[key.id] ?? 0) + 1;
    bucket.jobs.push({ series_id: key.id, job: item.job });
  }
  for (const item of previous) {
    const index = previousBuckets.findIndex(bucket => bucketContains(bucket, item.created_at));
    const bucket = counts[index];
    if (bucket) bucket.previous_total = (bucket.previous_total ?? 0) + 1;
  }
  return counts;
}

export function readOverview(input: {
  readDb: Database.Database;
  config: Config;
  period: Period;
  dimension: Dimension;
  now: number;
}): Overview {
  const { readDb, config, period, dimension, now } = input;
  const cards = {
    today: card(readDb, 'today', now),
    week: card(readDb, 'week', now),
    month: card(readDb, 'month', now),
  } satisfies Record<Period, OverviewCard>;
  const windows = periodWindows(period, now);
  const current = readJobsInRange(readDb, config, windows.current.start, windows.current.end);
  const previous = readJobsInRange(readDb, config, windows.previous.start, windows.previous.end);
  const series = seriesFor(dimension, current);
  const buckets = buildBuckets(dimension, current, previous, series, windows.current.buckets, windows.previous.buckets);
  return {
    period,
    dimension,
    cards,
    series,
    buckets,
    jobs: current.map(item => item.job),
    bot_metrics: botMetrics(readDb, current, windows.current.start, windows.current.end),
    tokens: '未記録',
  };
}

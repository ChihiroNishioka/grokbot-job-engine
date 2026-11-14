import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { Config } from '../config/index.js';
import { parseGrantableCapabilities } from '../policy/family-policy.js';
import { statusLabel } from '../ingress/status-text.js';
import { mask } from '../logging/mask.js';
import { redactHandle } from '../logging/redact-handle.js';
import type { Event, Job } from '../store/types.js';
import { createAliasResolver, type AliasResolver } from './aliases.js';
import type { SafeJob } from './types.js';

const errorSchema = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,64}$/) }).passthrough();
const safeReasons = new Set([
  'allowed', 'approved', 'needs_review', 'owner_rejected', 'dashboard_retry', 'lease_expired',
  'denied_vault', 'denied_owner_mail', 'denied_owner_line', 'denied_owner_personal_event_write',
  'denied_purchase', 'denied_message_others', 'denied_dev_settings',
]);
const safeEventTypes = new Set([
  'job.created', 'job.claimed', 'job.done', 'job.failed', 'job.cancelled', 'job.cancel_requested',
  'job.requeued', 'job.retried', 'job.policy_approved', 'outbox.enqueued', 'outbox.claimed',
  'outbox.sent', 'outbox.failed', 'outbox.requeued',
]);
const safeStatuses = new Set(['queued', 'claimed', 'done', 'failed', 'cancelled']);

export interface JobForOverview {
  job: SafeJob;
  created_at: number;
  worker_id: string | null;
}

interface JobOverviewRow extends Job { latest_worker_id: string | null }

function aliasResolver(readDb: Database.Database, config: Config): AliasResolver {
  const handles = readDb.prepare<[], { sender_handle: string }>(
    'SELECT DISTINCT sender_handle FROM jobs WHERE sender_handle IS NOT NULL',
  ).all().map(row => row.sender_handle);
  return createAliasResolver({ key: config.DASHBOARD_ALIAS_KEY, aliases: config.DASHBOARD_ALIASES, handles });
}

function safeReason(readDb: Database.Database, job: Job, errorCode: string | null): string | null {
  if (errorCode !== null) return errorCode;
  if (job.policy_decision === 'hold') return 'needs_review';
  if (job.policy_decision === 'approved') return 'approved';
  const reason = readDb.prepare<[string], { reason: string | null }>(
    "SELECT reason FROM job_events WHERE job_id=? AND reason IS NOT NULL ORDER BY event_id DESC LIMIT 1",
  ).get(job.job_id)?.reason;
  return reason !== undefined && reason !== null && safeReasons.has(reason) ? reason : null;
}

function errorCode(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = errorSchema.safeParse(parsed);
    return result.success ? result.data.code : null;
  } catch { return null; }
}

function projectJob(readDb: Database.Database, row: Job, resolver: AliasResolver, workerId: string | null): SafeJob {
  const code = errorCode(row.error);
  const isApproval = row.status === 'queued' && row.policy_decision === 'hold';
  return {
    job_id: row.job_id,
    status: row.status,
    status_label: statusLabel(row),
    requester: resolver(row.requester_id === 'self' ? 'self' : 'member', row.sender_handle),
    bot_worker_id: workerId,
    created_at: new Date(row.created_at).toISOString(),
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    allowed_capabilities: parseGrantableCapabilities(row.allowed_capabilities),
    reason_code: safeReason(readDb, row, code),
    expected: { status: row.status, policy_decision: row.policy_decision, attempts: row.attempts, updated_at: row.updated_at },
    request_present: row.request_text !== null,
    result_present: row.result !== null,
    error_code: code,
    can_approve: isApproval,
    can_reject: isApproval,
    can_retry: row.status === 'failed' && row.attempts < row.max_attempts && row.policy_decision !== 'deny',
  };
}

export function safeJob(readDb: Database.Database, config: Config, row: Job): SafeJob {
  const worker = readDb.prepare<[string], { worker_id: string }>(
    'SELECT worker_id FROM job_runs WHERE job_id=? ORDER BY attempt DESC LIMIT 1',
  ).get(row.job_id);
  return projectJob(readDb, row, aliasResolver(readDb, config), worker?.worker_id ?? null);
}

function jobIdIsValid(jobId: string): boolean {
  return /^J-\d{6,}$/.test(jobId);
}

export function readJob(readDb: Database.Database, config: Config, jobId: string): SafeJob | null {
  if (!jobIdIsValid(jobId)) return null;
  const row = readDb.prepare<[string], JobOverviewRow>(`SELECT jobs.*,
    (SELECT worker_id FROM job_runs WHERE job_runs.job_id=jobs.job_id ORDER BY attempt DESC LIMIT 1) AS latest_worker_id
    FROM jobs WHERE job_id=?`).get(jobId);
  return row ? projectJob(readDb, row, aliasResolver(readDb, config), row.latest_worker_id) : null;
}

export function readInbox(readDb: Database.Database, config: Config, kind: 'approvals' | 'failures'): SafeJob[] {
  const sql = kind === 'approvals'
    ? "SELECT jobs.*,(SELECT worker_id FROM job_runs WHERE job_runs.job_id=jobs.job_id ORDER BY attempt DESC LIMIT 1) AS latest_worker_id FROM jobs WHERE status='queued' AND policy_decision='hold' ORDER BY created_at DESC,job_id DESC"
    : "SELECT jobs.*,(SELECT worker_id FROM job_runs WHERE job_runs.job_id=jobs.job_id ORDER BY attempt DESC LIMIT 1) AS latest_worker_id FROM jobs WHERE status='failed' ORDER BY created_at DESC,job_id DESC";
  const resolver = aliasResolver(readDb, config);
  return readDb.prepare<[], JobOverviewRow>(sql).all().map(row => projectJob(readDb, row, resolver, row.latest_worker_id));
}

export function readJobsInRange(readDb: Database.Database, config: Config, start: number, end: number): JobForOverview[] {
  const rows = readDb.prepare<[number, number], JobOverviewRow>(`SELECT jobs.*,
    (SELECT worker_id FROM job_runs WHERE job_runs.job_id=jobs.job_id ORDER BY attempt DESC LIMIT 1) AS latest_worker_id
    FROM jobs WHERE created_at>=? AND created_at<=? ORDER BY created_at,job_id`).all(start, end);
  const resolver = aliasResolver(readDb, config);
  return rows.map(row => ({
    job: projectJob(readDb, row, resolver, row.latest_worker_id),
    created_at: row.created_at,
    worker_id: row.latest_worker_id,
  }));
}

function safeActor(actor: string): string {
  if (actor === 'api' || actor === 'genie' || actor === 'reconciler') return actor;
  return /^worker:[A-Za-z0-9._:-]{1,64}$/.test(actor) ? actor : 'system';
}

function safeEvent(row: Event) {
  return {
    at: new Date(row.at).toISOString(),
    type: safeEventTypes.has(row.type) ? row.type : 'job.updated',
    actor: safeActor(row.actor),
    from_status: row.from_status !== null && safeStatuses.has(row.from_status) ? row.from_status : null,
    to_status: row.to_status !== null && safeStatuses.has(row.to_status) ? row.to_status : null,
    reason_code: row.reason !== null && safeReasons.has(row.reason) ? row.reason : null,
  };
}

export function readTrace(readDb: Database.Database, jobId: string): { events: ReturnType<typeof safeEvent>[]; runs: { attempt: number; worker_id: string; started_at: string; ended_at: string | null; outcome: string; error_code: string | null }[] } | null {
  if (!jobIdIsValid(jobId)) return null;
  const exists = readDb.prepare<[string], { job_id: string }>('SELECT job_id FROM jobs WHERE job_id=?').get(jobId);
  if (!exists) return null;
  const events = readDb.prepare<[string], Event>(
    'SELECT * FROM job_events WHERE job_id=? ORDER BY event_id',
  ).all(jobId).map(safeEvent);
  const runs = readDb.prepare<[string], { attempt: number; worker_id: string; started_at: number; ended_at: number | null; outcome: string; error_code: string | null }>(
    'SELECT attempt,worker_id,started_at,ended_at,outcome,error_code FROM job_runs WHERE job_id=? ORDER BY attempt',
  ).all(jobId).map(run => ({
    attempt: run.attempt,
    worker_id: /^[A-Za-z0-9._:-]{1,64}$/.test(run.worker_id) ? run.worker_id : 'unknown',
    started_at: new Date(run.started_at).toISOString(),
    ended_at: run.ended_at === null ? null : new Date(run.ended_at).toISOString(),
    outcome: run.outcome,
    error_code: run.error_code !== null && /^[A-Z0-9_]{1,64}$/.test(run.error_code) ? run.error_code : null,
  }));
  return { events, runs };
}

export function revealText(readDb: Database.Database, config: Config, jobId: string, part: 'request' | 'result'): string | null {
  if (!jobIdIsValid(jobId)) return null;
  const row = readDb.prepare<[string], Job>('SELECT * FROM jobs WHERE job_id=?').get(jobId);
  if (!row) return null;
  const text = part === 'request'
    ? row.request_text
    : row.result === null ? null : JSON.stringify(JSON.parse(row.result), null, 2) ?? '';
  if (text === null) return null;
  return redactHandle(mask(text), row.sender_handle);
}

import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { Config } from '../config/index.js';
import type { Clock } from '../lib/clock.js';
import type { GrantableCapability, PolicyDecision } from '../policy/family-policy.js';
import type { Job } from '../store/types.js';
import type { Bucket, Period } from './periods.js';

export type Dimension = 'status' | 'requester' | 'bot';
export type DashboardAction = 'approve' | 'reject' | 'retry';
export type RevealPart = 'request' | 'result';
export type ExpectedState = Pick<Job, 'status' | 'policy_decision' | 'attempts' | 'updated_at'>;

export interface SafeJob {
  job_id: string;
  status: Job['status'];
  status_label: string;
  requester: string;
  bot_worker_id: string | null;
  created_at: string;
  attempts: number;
  max_attempts: number;
  allowed_capabilities: readonly GrantableCapability[] | null;
  reason_code: string | null;
  expected: ExpectedState;
  request_present: boolean;
  result_present: boolean;
  error_code: string | null;
  can_approve: boolean;
  can_reject: boolean;
  can_retry: boolean;
}

export interface OverviewCard {
  total: number;
  previous: number;
  difference: number;
  percent: number | null;
}

export interface Series {
  id: string;
  label: string;
  color: string;
}

export interface BucketJob {
  series_id: string;
  job: SafeJob;
}

export interface OverviewBucket extends Bucket {
  counts: Record<string, number>;
  previous_total: number | null;
  jobs: BucketJob[];
}

export interface BotMetrics {
  worker_id: string;
  last_run_jobs: number;
  run_count: number;
  success_count: number;
  failure_count: number;
}

export interface Overview {
  period: Period;
  dimension: Dimension;
  cards: Record<Period, OverviewCard>;
  series: Series[];
  buckets: OverviewBucket[];
  jobs: SafeJob[];
  bot_metrics: BotMetrics[];
  tokens: '未記録';
}

export interface DashboardDeps {
  db: Database.Database;
  readDb: Database.Database;
  config: Config;
  clock: Clock;
  ids?: { token?: () => string; uuid?: () => string };
}

export type DashboardApp = Hono<{ Variables: { dashboardSession: DashboardSession } }>;
export interface DashboardSession {
  id: string;
  csrfNonce: string;
  expiresAt: number;
  reauthenticatedAt: number;
}

export interface ActionCommand {
  action_id: string;
  job_id: string;
  action: DashboardAction;
  expected: ExpectedState;
}

export interface RevealCommand {
  action_id: string;
  job_id: string;
  part: RevealPart;
}

export interface OperationError {
  code: 'ACTION_ID_REUSED' | 'STATE_CHANGED' | 'JOB_NOT_FOUND' | 'INVALID_TRANSITION' | 'MAX_ATTEMPTS_REACHED' | 'CONTENT_NOT_AVAILABLE';
  message: string;
  status: 404 | 409;
  job?: SafeJob;
}

export interface ActionResult {
  outcome: 'applied' | 'stale' | 'rejected';
  job: SafeJob;
}

export interface RevealResult {
  outcome: 'revealed';
  part: RevealPart;
  text: string;
}

export interface DashboardErrorBody {
  error: { code: string; message: string };
}

export type PolicyValue = PolicyDecision | null;

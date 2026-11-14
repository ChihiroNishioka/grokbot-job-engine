import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Config } from '../config/index.js';
import { JobStore } from '../store/jobs.js';
import { StoreError } from '../store/errors.js';
import type { Job } from '../store/types.js';
import { revealText, safeJob } from './jobs.js';
import type { ActionCommand, ActionResult, DashboardDeps, ExpectedState, OperationError, RevealCommand, RevealResult } from './types.js';

interface StoredAction {
  action_id: string;
  job_id: string;
  action: string;
  request_hash: string;
  outcome: 'applied' | 'stale' | 'rejected' | 'revealed';
  reason_code: string | null;
}

type ActionResponse = { ok: true; value: ActionResult } | { ok: false; error: OperationError };
type RevealResponse = { ok: true; value: RevealResult } | { ok: false; error: OperationError };
type SafeState = Pick<ExpectedState, 'status' | 'policy_decision' | 'attempts' | 'updated_at'>;

function expectedState(row: Job): SafeState {
  return { status: row.status, policy_decision: row.policy_decision, attempts: row.attempts, updated_at: row.updated_at };
}

function serializeExpected(state: ExpectedState): string {
  return JSON.stringify({
    status: state.status,
    policy_decision: state.policy_decision,
    attempts: state.attempts,
    updated_at: state.updated_at,
  });
}

function actionHash(command: ActionCommand): string {
  return createHash('sha256').update(JSON.stringify({
    job_id: command.job_id,
    action: command.action,
    expected: {
      status: command.expected.status,
      policy_decision: command.expected.policy_decision,
      attempts: command.expected.attempts,
      updated_at: command.expected.updated_at,
    },
  })).digest('hex');
}

function revealHash(command: RevealCommand): string {
  const action = command.part === 'request' ? 'reveal_request' : 'reveal_result';
  return createHash('sha256').update(JSON.stringify({ job_id: command.job_id, action, part: command.part })).digest('hex');
}

function latestAction(db: Database.Database, actionId: string): StoredAction | undefined {
  return db.prepare<[string], StoredAction>(`SELECT action_id,job_id,action,request_hash,outcome,reason_code
    FROM operator_actions WHERE action_id=?`).get(actionId);
}

function insertAction(db: Database.Database, input: {
  command: ActionCommand | RevealCommand;
  action: string;
  requestHash: string;
  expectedState: string | null;
  outcome: StoredAction['outcome'];
  reasonCode: string | null;
  resultState: string | null;
  at: number;
}): void {
  db.prepare(`INSERT INTO operator_actions(action_id,job_id,actor,action,expected_state,request_hash,outcome,reason_code,result_state,at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    input.command.action_id, input.command.job_id, 'dashboard:owner', input.action,
    input.expectedState, input.requestHash, input.outcome, input.reasonCode, input.resultState, input.at,
  );
}

function currentJob(db: Database.Database, jobId: string): Job | null {
  if (!/^J-\d{6,}$/.test(jobId)) return null;
  return db.prepare<[string], Job>('SELECT * FROM jobs WHERE job_id=?').get(jobId) ?? null;
}

function operationError(code: OperationError['code'], message: string, status: OperationError['status'], job?: OperationError['job']): OperationError {
  return { code, message, status, ...(job ? { job } : {}) };
}

function rejectedCode(action: ActionCommand['action'], row: Job): string | null {
  if ((action === 'approve' || action === 'reject') && (row.status !== 'queued' || row.policy_decision !== 'hold')) return 'POLICY_NOT_PENDING';
  if (action === 'retry' && row.policy_decision === 'deny') return 'POLICY_DENIED';
  if (action === 'retry' && row.status === 'failed' && row.attempts >= row.max_attempts) return 'MAX_ATTEMPTS_REACHED';
  if (action === 'retry' && row.status !== 'failed') return 'INVALID_TRANSITION';
  return null;
}

function storedActionResponse(input: {
  existing: StoredAction;
  requestHash: string;
  db: Database.Database;
  readDb: Database.Database;
  config: Config;
  jobId: string;
}): ActionResponse {
  if (input.existing.request_hash !== input.requestHash || input.existing.job_id !== input.jobId) {
    return { ok: false, error: operationError('ACTION_ID_REUSED', 'この操作 ID は別の要求に使われています。', 409) };
  }
  const row = currentJob(input.db, input.jobId);
  if (row === null) return { ok: false, error: operationError('JOB_NOT_FOUND', 'ジョブが見つかりません。', 404) };
  const job = safeJob(input.readDb, input.config, row);
  if (input.existing.outcome === 'stale') {
    return { ok: false, error: operationError('STATE_CHANGED', 'ジョブの状態が変わりました。', 409, job) };
  }
  if (input.existing.outcome === 'rejected') {
    const code = input.existing.reason_code === 'MAX_ATTEMPTS_REACHED' ? 'MAX_ATTEMPTS_REACHED' : 'INVALID_TRANSITION';
    return { ok: false, error: operationError(code, 'この操作は実行できません。', 409, job) };
  }
  return { ok: true, value: { outcome: 'applied', job } };
}

export function performAction(deps: DashboardDeps, command: ActionCommand): ActionResponse {
  const requestHash = actionHash(command);
  try {
    return deps.db.transaction((): ActionResponse => {
      const existing = latestAction(deps.db, command.action_id);
      if (existing) return storedActionResponse({ existing, requestHash, db: deps.db, readDb: deps.readDb, config: deps.config, jobId: command.job_id });
      const store = new JobStore({ db: deps.db, clock: deps.clock, config: deps.config });
      const row = store.get(command.job_id);
      const current = expectedState(row);
      if (serializeExpected(current) !== serializeExpected(command.expected)) {
        insertAction(deps.db, {
          command, action: command.action, requestHash, expectedState: serializeExpected(command.expected),
          outcome: 'stale', reasonCode: 'STATE_CHANGED', resultState: JSON.stringify(current), at: deps.clock.now(),
        });
        return { ok: false, error: operationError('STATE_CHANGED', 'ジョブの状態が変わりました。', 409, safeJob(deps.readDb, deps.config, row)) };
      }
      const reason = rejectedCode(command.action, row);
      if (reason !== null) {
        insertAction(deps.db, {
          command, action: command.action, requestHash, expectedState: serializeExpected(command.expected),
          outcome: 'rejected', reasonCode: reason, resultState: JSON.stringify(current), at: deps.clock.now(),
        });
        const code = reason === 'MAX_ATTEMPTS_REACHED' ? 'MAX_ATTEMPTS_REACHED' : 'INVALID_TRANSITION';
        return { ok: false, error: operationError(code, 'この操作は実行できません。', 409, safeJob(deps.readDb, deps.config, row)) };
      }
      try {
        if (command.action === 'approve') store.approve(command.job_id);
        else if (command.action === 'reject') store.cancel(command.job_id, { reason: 'owner_rejected' });
        else store.retry(command.job_id, { reason: 'dashboard_retry' });
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        const refreshed = store.get(command.job_id);
        const code = error.code;
        insertAction(deps.db, {
          command, action: command.action, requestHash, expectedState: serializeExpected(command.expected),
          outcome: 'rejected', reasonCode: code, resultState: JSON.stringify(expectedState(refreshed)), at: deps.clock.now(),
        });
        return { ok: false, error: operationError(code === 'MAX_ATTEMPTS_REACHED' ? 'MAX_ATTEMPTS_REACHED' : 'INVALID_TRANSITION', 'この操作は実行できません。', 409, safeJob(deps.readDb, deps.config, refreshed)) };
      }
      const updated = store.get(command.job_id);
      const snapshot = expectedState(updated);
      insertAction(deps.db, {
        command, action: command.action, requestHash, expectedState: serializeExpected(command.expected),
        outcome: 'applied', reasonCode: null, resultState: JSON.stringify(snapshot), at: deps.clock.now(),
      });
      return { ok: true, value: { outcome: 'applied', job: safeJob(deps.readDb, deps.config, updated) } };
    }).immediate();
  } catch (error) {
    if (error instanceof StoreError && error.code === 'JOB_NOT_FOUND') return { ok: false, error: operationError('JOB_NOT_FOUND', 'ジョブが見つかりません。', 404) };
    throw error;
  }
}

export function performReveal(deps: DashboardDeps, command: RevealCommand): RevealResponse {
  const requestHash = revealHash(command);
  const action = command.part === 'request' ? 'reveal_request' : 'reveal_result';
  try {
    return deps.db.transaction((): RevealResponse => {
      const existing = latestAction(deps.db, command.action_id);
      if (existing) {
        if (existing.request_hash !== requestHash || existing.job_id !== command.job_id || existing.action !== action) {
          return { ok: false, error: operationError('ACTION_ID_REUSED', 'この操作 ID は別の要求に使われています。', 409) };
        }
        const text = revealText(deps.readDb, deps.config, command.job_id, command.part);
        if (text === null) return { ok: false, error: operationError('CONTENT_NOT_AVAILABLE', '表示できる内容がありません。', 409) };
        return { ok: true, value: { outcome: 'revealed', part: command.part, text } };
      }
      const text = revealText(deps.readDb, deps.config, command.job_id, command.part);
      if (text === null) {
        const exists = deps.readDb.prepare<[string], { job_id: string }>('SELECT job_id FROM jobs WHERE job_id=?').get(command.job_id);
        if (!exists) return { ok: false, error: operationError('JOB_NOT_FOUND', 'ジョブが見つかりません。', 404) };
        insertAction(deps.db, {
          command, action, requestHash, expectedState: null, outcome: 'rejected',
          reasonCode: 'CONTENT_NOT_AVAILABLE', resultState: null, at: deps.clock.now(),
        });
        return { ok: false, error: operationError('CONTENT_NOT_AVAILABLE', '表示できる内容がありません。', 409) };
      }
      insertAction(deps.db, {
        command, action, requestHash, expectedState: null, outcome: 'revealed',
        reasonCode: null, resultState: null, at: deps.clock.now(),
      });
      return { ok: true, value: { outcome: 'revealed', part: command.part, text } };
    }).immediate();
  } catch (error) {
    if (error instanceof StoreError && error.code === 'JOB_NOT_FOUND') return { ok: false, error: operationError('JOB_NOT_FOUND', 'ジョブが見つかりません。', 404) };
    throw error;
  }
}

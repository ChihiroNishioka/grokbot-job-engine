import { prepareNotification, type NotificationFlags } from './notification.js';
import type { ClaimInput } from '../store/types.js';
import { mask } from '../logging/mask.js';
import { completion, failure, type FailureCode } from '../lib/reply-text.js';
import { JobApiClient, type ApiResult, type WorkerJob } from './client.js';

export type ProcessResult =
  | { ok?: true; result: Record<string, unknown>; artifact_urls?: string[]; notify?: { body: string } }
  | { ok: false; code: FailureCode; message?: string; notify?: { body: string } };
export interface ProcessContext { job: WorkerJob; claimToken: string; heartbeat(): Promise<boolean> }
type Outcome = { outcome: 'idle' } | { outcome: 'done' | 'failed' | 'cancelled'; job_id: string } & NotificationFlags | { outcome: 'unreachable'; reason: string } | { outcome: 'api_error'; status: number; code: string };
function failedResult(result: Exclude<ApiResult<unknown>, { ok: true }>): Outcome {
  return result.unreachable ? { outcome: 'unreachable', reason: result.reason } : { outcome: 'api_error', status: result.status, code: result.code };
}
export async function runWorkerOnce({ client, claim, process }: { client: JobApiClient; claim: ClaimInput; process: (context: ProcessContext) => Promise<ProcessResult> }): Promise<Outcome> {
  const claimed = await client.claim(claim);
  if (!claimed.ok) return failedResult(claimed);
  if (claimed.data.job === null) return { outcome: 'idle' };
  const { job, claim_token } = claimed.data;
  const heartbeatState: { failure?: Exclude<ApiResult<unknown>, { ok: true }> } = {};
  const heartbeat = async (): Promise<boolean> => {
    if (heartbeatState.failure) throw new Error('HEARTBEAT_FAILED');
    const reply = await client.heartbeat(job.job_id, { claim_token, ...(claim.lease_seconds === undefined ? {} : { lease_seconds: claim.lease_seconds }) });
    if (!reply.ok) {
      heartbeatState.failure = reply;
      throw new Error('HEARTBEAT_FAILED');
    }
    return reply.data.cancel_requested;
  };
  let result: ProcessResult;
  try { result = await process({ job, claimToken: claim_token, heartbeat }); }
  catch (error) {
    result = { ok: false, code: 'PROCESSING_ERROR', message: error instanceof Error ? error.message : '処理中にエラーが起きました' };
  }
  if (heartbeatState.failure) return failedResult(heartbeatState.failure);
  if (result.ok === false) {
    const message = [...mask(result.message ?? '')].slice(0, 1000).join('');
    const notification = prepareNotification(result.notify?.body, () => failure(job.job_id, result.code, { canRetry: job.attempts < job.max_attempts, maxAttempts: job.max_attempts }));
    const failed = await client.fail(job.job_id, { claim_token, error: { code: result.code, message }, notify: { body: notification.body } });
    if (!failed.ok) return failedResult(failed);
    const cancelled = typeof failed.data === 'object' && failed.data !== null && 'job' in failed.data && typeof failed.data.job === 'object' && failed.data.job !== null && 'status' in failed.data.job && failed.data.job.status === 'cancelled';
    return { outcome: cancelled ? 'cancelled' : 'failed', job_id: job.job_id, ...notification.flags };
  }
  const summary = typeof result.result.summary === 'string' ? result.result.summary : '結果を保存しました。';
  const notification = prepareNotification(result.notify?.body, () => completion(job.job_id, summary, result.artifact_urls));
  const completed = await client.complete(job.job_id, { claim_token, result: result.result, ...(result.artifact_urls ? { artifact_urls: result.artifact_urls } : {}), notify: { body: notification.body } });
  return completed.ok ? { outcome: 'done', job_id: job.job_id, ...notification.flags } : failedResult(completed);
}

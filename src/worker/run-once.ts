import { artifactUrls, artifactOmissionFlags } from '../lib/artifact-urls.js';
import { prepareNotification, type NotificationFlags } from './notification.js';
import type { ClaimInput } from '../store/types.js';
import { mask } from '../logging/mask.js';
import { completion, failure, type FailureCode } from '../lib/reply-text.js';
import { JobApiClient, type ApiResult, type WorkerJob } from './client.js';
import type { Capability } from '../policy/family-policy.js';

export type ProcessResult =
  | { ok?: true; result: Record<string, unknown>; artifact_urls?: string[]; used_capabilities?: Capability[]; notify?: { body: string } }
  | { ok: false; code: FailureCode; message?: string; notify?: { body: string } };
export interface ProcessContext { job: WorkerJob; claimToken: string; heartbeat(): Promise<boolean>; can(capability: Capability): boolean; require(capability: Capability): void }
function capabilityGate(job: WorkerJob): Pick<ProcessContext, 'can' | 'require'> {
  const allowed = new Set<Capability>(job.allowed_capabilities ?? []);
  const unrestricted = job.requester_id === 'self';
  const can = (capability: Capability) => unrestricted || allowed.has(capability);
  const require = (capability: Capability) => { if (!can(capability)) throw new Error('POLICY_DENIED'); };
  return { can, require };
}
type Outcome = { outcome: 'idle' } | { outcome: 'done' | 'failed' | 'cancelled'; job_id: string } & NotificationFlags & { artifact_urls_omitted?: number } | { outcome: 'unreachable'; reason: string } | { outcome: 'api_error'; status: number; code: string };
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
  try { result = await process({ job, claimToken: claim_token, heartbeat, ...capabilityGate(job) }); }
  catch (error) {
    result = { ok: false, code: 'PROCESSING_ERROR', message: error instanceof Error ? error.message : '処理中にエラーが起きました' };
  }
  if (heartbeatState.failure) return failedResult(heartbeatState.failure);
  if (result.ok !== false && !artifactUrls.safeParse(result.artifact_urls ?? []).success) {
    result = { ok: false, code: 'INVALID_ARTIFACT', message: 'artifact_urls は20件以内、各1200コードポイント以内の HTTPS URL が必要です。' };
  }
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
  const completed = await client.complete(job.job_id, { claim_token, result: result.result, ...(result.artifact_urls ? { artifact_urls: result.artifact_urls } : {}), ...(result.used_capabilities ? { used_capabilities: result.used_capabilities } : {}), notify: { body: notification.body } });
  return completed.ok ? { outcome: 'done', job_id: job.job_id, ...notification.flags, ...artifactOmissionFlags(result.artifact_urls, notification.body) } : failedResult(completed);
}

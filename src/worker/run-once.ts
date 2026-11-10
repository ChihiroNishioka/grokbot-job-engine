import type { ClaimInput } from '../store/types.js';
import { mask } from '../logging/mask.js';
import { completion, failure, truncate } from '../lib/reply-text.js';
import { JobApiClient, type ApiResult, type WorkerJob } from './client.js';

export interface ProcessResult { result: Record<string, unknown>; artifact_urls?: string[]; notify?: { body: string } }
type Outcome = { outcome: 'idle' } | { outcome: 'done' | 'failed'; job_id: string } | { outcome: 'unreachable'; reason: string } | { outcome: 'api_error'; status: number; code: string };
function failedResult(result: Exclude<ApiResult<unknown>, { ok: true }>): Outcome {
  return result.unreachable ? { outcome: 'unreachable', reason: result.reason } : { outcome: 'api_error', status: result.status, code: result.code };
}
function text(value: string): string {
  return truncate(value.replace(/^[\s\u200B-\u200F\uFEFF]*(?:🪔|🧞(?:\u200D♂)?)[\uFE0F]*\s*/u, ''));
}
export async function runWorkerOnce({ client, claim, process }: { client: JobApiClient; claim: ClaimInput; process: (job: WorkerJob) => Promise<ProcessResult> }): Promise<Outcome> {
  const claimed = await client.claim(claim);
  if (!claimed.ok) return failedResult(claimed);
  if (claimed.data.job === null) return { outcome: 'idle' };
  const { job, claim_token } = claimed.data;
  let result: ProcessResult;
  try { result = await process(job); }
  catch (error) {
    const message = mask(error instanceof Error ? error.message : '処理中にエラーが発生しました');
    const failed = await client.fail(job.job_id, { claim_token, error: { code: 'PROCESSING_ERROR', message: [...message].slice(0, 1000).join('') }, notify: { body: failure(job.job_id, message) } });
    return failed.ok ? { outcome: 'failed', job_id: job.job_id } : failedResult(failed);
  }
  const summary = typeof result.result.summary === 'string' ? result.result.summary : JSON.stringify(result.result);
  const notification = result.notify?.body ?? completion(job.job_id, summary, result.artifact_urls);
  const completed = await client.complete(job.job_id, { claim_token, ...result, notify: { body: text(notification) } });
  return completed.ok ? { outcome: 'done', job_id: job.job_id } : failedResult(completed);
}

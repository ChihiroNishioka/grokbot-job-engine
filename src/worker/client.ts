import { z } from 'zod';
import type { ClaimInput, TokenInput, CompleteInput, FailInput, OutboxClaimInput } from '../store/types.js';
import type { Transport, Unreachable } from './transport.js';

export type ApiResult<T> = { ok: true; data: T } | Unreachable | { ok: false; unreachable: false; status: number; code: string; message?: string };
const claimedJob = z.looseObject({ job_id: z.string().regex(/^J-\d{6,}$/), request_text: z.string().nullable(), attempts: z.number().int().nonnegative(), max_attempts: z.number().int().min(1).max(10) });
export type WorkerJob = z.infer<typeof claimedJob>;
const heartbeatReply = z.object({ cancel_requested: z.boolean(), lease_expires_at: z.string().optional() });
const claimReply = z.union([z.object({ job: z.null() }), z.object({ job: claimedJob, claim_token: z.string().min(1) })]);
export class JobApiClient {
  constructor(private readonly transport: Transport, private readonly token: string) {}
  async request(method: string, path: string, input?: unknown): Promise<ApiResult<unknown>> {
    const reply = await this.transport.request({ method, path, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (!reply.ok) return reply;
    let data: unknown;
    try { data = JSON.parse(reply.body); } catch { return { ok: false, unreachable: false, status: reply.status, code: 'INVALID_RESPONSE' }; }
    if (reply.status < 200 || reply.status >= 300) {
      const parsed = z.object({ error: z.object({ code: z.string().regex(/^[A-Z0-9_]{1,64}$/), message: z.string() }) }).safeParse(data);
      return { ok: false, unreachable: false, status: reply.status, code: parsed.success ? parsed.data.error.code : 'API_ERROR', ...(parsed.success ? { message: parsed.data.error.message } : {}) };
    }
    return { ok: true, data };
  }
  async claim(input: ClaimInput): Promise<ApiResult<z.infer<typeof claimReply>>> {
    const result = await this.request('POST', '/jobs/claim', input);
    if (!result.ok) return result;
    const parsed = claimReply.safeParse(result.data);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, unreachable: false, status: 200, code: 'INVALID_RESPONSE' };
  }
  get(jobId: string) { return this.request('GET', `/jobs/${encodeURIComponent(jobId)}`); }
  async heartbeat(jobId: string, input: TokenInput): Promise<ApiResult<z.infer<typeof heartbeatReply>>> {
    const result = await this.request('POST', `/jobs/${encodeURIComponent(jobId)}/heartbeat`, input);
    if (!result.ok) return result;
    const parsed = heartbeatReply.safeParse(result.data);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, unreachable: false, status: 200, code: 'INVALID_RESPONSE' };
  }
  complete(jobId: string, input: CompleteInput) { return this.request('POST', `/jobs/${encodeURIComponent(jobId)}/complete`, input); }
  fail(jobId: string, input: FailInput) { return this.request('POST', `/jobs/${encodeURIComponent(jobId)}/fail`, input); }
  outbox(input: OutboxClaimInput) { return this.request('POST', '/outbox/claim', input); }
}

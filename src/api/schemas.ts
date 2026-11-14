import { artifactUrls } from '../lib/artifact-urls.js';
import { z } from 'zod';
import type { Config } from '../config/index.js';

export function schemas(config: Config) {
  const chars = (min: number, max: number) => z.string().refine(s => [...s].length >= min && [...s].length <= max);
  const jobType = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
  const worker = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
  const lease = z.number().int().min(10).max(config.LEASE_SECONDS_MAX).optional();
  const token = z.string().min(1);
  const reason = z.strictObject({ reason: chars(0,200).optional() });
  const error = z.strictObject({code:z.string().regex(/^[A-Z0-9_]{1,64}$/),message:chars(0,1000)});
  const notify = z.strictObject({body:chars(1,1500)}).optional();
  const limit = z.coerce.number().int().min(1).max(100);
  const status = z.enum(['queued','claimed','done','failed','cancelled']);
  return {
    create: z.strictObject({
      source:z.literal('imessage'), source_message_id:chars(1,256), source_chat_id:chars(1,256), requester_id:chars(1,256),
      job_type:jobType.optional(), request_text:chars(1,config.REQUEST_TEXT_MAX_CHARS).optional(), payload_ref:chars(1,512).optional(),
      priority:z.number().int().min(-10).max(10).optional(),
      scheduled_at:z.iso.datetime({offset:true}).optional(), max_attempts:z.number().int().min(1).max(10).optional(),
      correlation_id:chars(1,128).optional(), parent_job_id:z.string().regex(/^J-\d{6,}$/).optional(),
    }).refine(value => value.request_text !== undefined || value.payload_ref !== undefined),
    list:z.strictObject({status:status.optional(),source_chat_id:chars(1,256).optional(),job_type:jobType.optional(),limit:limit.default(20)}),
    events:z.strictObject({limit:limit.default(50)}),
    claim:z.strictObject({worker_id:worker,lease_seconds:lease,job_types:z.array(jobType).optional()}),
    claimById:z.strictObject({worker_id:worker,lease_seconds:lease}),
    heartbeat:z.strictObject({claim_token:token,lease_seconds:lease}),
    complete:z.strictObject({claim_token:token,result:z.record(z.string(),z.unknown()).refine(value=>[...JSON.stringify(value)].length<=config.RESULT_MAX_CHARS),artifact_urls:artifactUrls.optional(),notify}),
    fail:z.strictObject({claim_token:token,error,notify:z.strictObject({body:chars(1,1500).optional()}).optional()}),
    reason,
    enqueue:z.strictObject({job_id:z.string().regex(/^J-\d{6,}$/),idempotency_key:z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/),kind:z.enum(['ack','progress','done','failed','cancelled']),body:chars(1,1500)}),
    outboxClaim:z.strictObject({worker_id:worker,lease_seconds:lease,outbox_id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}),
    sent:z.strictObject({claim_token:token,external_ref:chars(0,256).optional()}),
    failed:z.strictObject({claim_token:token,error,retryable:z.boolean().optional()}),
  };
}
export type Schemas = ReturnType<typeof schemas>;

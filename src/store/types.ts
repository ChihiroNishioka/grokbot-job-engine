import type Database from 'better-sqlite3';
import type { Config } from '../config/index.js';
import type { Clock } from '../lib/clock.js';
export interface Deps { db: Database.Database; clock: Clock; config: Config; ids?: { token?: () => string; uuid?: () => string } }
export type Status = 'queued'|'claimed'|'done'|'failed'|'cancelled';
export interface Job {
 job_id:string;source:string;source_message_id:string;source_chat_id:string;requester_id:string;job_type:string;
 request_text:string|null;payload_ref:string|null;status:Status;priority:number;scheduled_at:number|null;
 created_at:number;updated_at:number;claimed_at:number|null;claimed_by:string|null;claim_token:string|null;lease_expires_at:number|null;heartbeat_at:number|null;
 attempts:number;max_attempts:number;cancel_requested:number;result:string|null;artifact_urls:string;error:string|null;correlation_id:string|null;parent_job_id:string|null;
}
export interface Outbox {outbox_id:number;job_id:string|null;idempotency_key:string;kind:string;channel:string;target_chat_id:string;in_reply_to:string|null;body:string;status:'pending'|'sending'|'sent'|'failed';attempts:number;claimed_by:string|null;claim_token:string|null;lease_expires_at:number|null;last_error:string|null;external_ref:string|null;created_at:number;updated_at:number;sent_at:number|null}
export interface Event {event_id:number;job_id:string|null;outbox_id:number|null;at:number;actor:string;type:string;from_status:string|null;to_status:string|null;reason:string|null;detail:string|null}
export interface CreateInput {source:'imessage';source_message_id:string;source_chat_id:string;requester_id:string;job_type?:string;request_text?:string;payload_ref?:string;priority?:number;scheduled_at?:string;max_attempts?:number;correlation_id?:string;parent_job_id?:string}
export interface ClaimInput {worker_id:string;lease_seconds?:number;job_types?:string[]}
export interface TokenInput {claim_token:string;lease_seconds?:number}
export interface CompleteInput extends TokenInput {result:Record<string,unknown>;artifact_urls?:string[];notify?:{body:string}}
export interface FailInput extends TokenInput {error:{code:string;message:string};notify?:{body:string}}
export interface EnqueueInput {job_id:string;idempotency_key:string;kind:string;body:string}
export interface OutboxClaimInput extends ClaimInput {outbox_id?:number}
export interface ListInput {status?:Status;source_chat_id?:string;job_type?:string;limit?:number}

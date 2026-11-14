import type { Job, Outbox, Event } from '../store/types.js';

export function iso(value: number | null): string | null { return value === null ? null : new Date(value).toISOString(); }
export function jobJson(row: Job, summary = false) {
  const {claim_token, ...rest} = row;
  void claim_token;
  const full = {...rest, scheduled_at:iso(row.scheduled_at),created_at:iso(row.created_at),updated_at:iso(row.updated_at),claimed_at:iso(row.claimed_at),lease_expires_at:iso(row.lease_expires_at),heartbeat_at:iso(row.heartbeat_at),cancel_requested:row.cancel_requested===1,result:parse(row.result),error:parse(row.error),artifact_urls:parse(row.artifact_urls)};
  if (!summary) return full;
  const {request_text,result,sender_handle,...item}=full;
  void request_text; void result; void sender_handle;
  return item;
}
export function outboxJson(row: Outbox) {
  const {claim_token,...rest}=row;
  void claim_token;
  return {...rest, created_at:iso(row.created_at),updated_at:iso(row.updated_at),lease_expires_at:iso(row.lease_expires_at),sent_at:iso(row.sent_at),last_error:parse(row.last_error)};
}
export function eventJson(row: Event) { return {...row,at:iso(row.at),detail:parse(row.detail)}; }
function parse(value: string | null): unknown { return value === null ? null : JSON.parse(value); }

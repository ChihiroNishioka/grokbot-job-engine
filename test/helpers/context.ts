import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createApp } from '../../src/api/app.js';
import { loadConfig } from '../../src/config/index.js';
import { openDb } from '../../src/db/open.js';
import { createLogger } from '../../src/logging/logger.js';
import type { CreateInput } from '../../src/store/types.js';

export class FakeClock {
  constructor(public time = Date.parse('2026-11-11T00:00:00.000Z')) {}
  now() { return this.time; }
  advance(ms: number) { this.time += ms; }
}
export const token = 'dummy-test-token-'.repeat(3);
export const validEnv = { JOB_API_TOKEN: token, RATE_LIMIT_PER_MINUTE: '10000', GENIE_TOKEN: 'dummy-genie-token-'.repeat(3), GENIE_ALLOWED_CHAT_IDS: '21', OWNER_NOTIFY_CHAT_ID: '21', ALLOWED_SOURCE_CHAT_IDS: 'chat-a,chat-b,21' };
export function input(): CreateInput;
export function input(overrides: Partial<CreateInput>): CreateInput;
export function input(overrides: Record<string, unknown>): Record<string, unknown>;
export function input(overrides: Partial<CreateInput> | Record<string, unknown> = {}): unknown {
  return { source: 'imessage', source_message_id: 'message-a', source_chat_id: 'chat-a', requester_id: 'self', request_text: 'request-marker', ...overrides };
}
const object = z.record(z.string(), z.unknown());
export const jobSchema = z.looseObject({
  job_id: z.string(), status: z.string(), attempts: z.number(), max_attempts: z.number(),
  source_chat_id: z.string(), source_message_id: z.string(), job_type: z.string(),
  cancel_requested: z.boolean(), lease_expires_at: z.string().nullable(),
  result: object.nullable(), error: z.object({ code: z.string(), message: z.string().optional() }).nullable(),
  artifact_urls: z.array(z.string()), updated_at: z.string(),
});
export const outboxSchema = z.looseObject({
  outbox_id: z.number(), job_id: z.string(), status: z.string(), attempts: z.number(),
  target_chat_id: z.string(), in_reply_to: z.string().nullable(), sent_at: z.string().nullable(),
});
export const eventSchema = z.looseObject({ event_id: z.number(), type: z.string(), from_status: z.string().nullable(), to_status: z.string().nullable() });
const envelope = z.looseObject({ job: z.unknown().optional(), outbox: z.unknown().optional(), jobs: z.array(jobSchema.omit({result:true})).optional(), events: z.array(eventSchema).optional(), created: z.boolean().optional(), claim_token: z.string().optional(), lease_expires_at: z.string().optional(), run_id: z.number().optional(), cancel_requested: z.boolean().optional(), error: z.object({code:z.string(), message:z.string()}).optional(), ok:z.boolean().optional() });
export type Reply = { status: number; headers: Headers; body: z.infer<typeof envelope> };
export const job = (r: Reply) => jobSchema.parse(r.body.job);
export const outbox = (r: Reply) => outboxSchema.parse(r.body.outbox);
export function claimToken(r: Reply): string { return z.string().parse(r.body.claim_token); }
export function context(opts: { env?: Record<string,string>; path?: string; clock?: FakeClock; rateLimitKey?: Parameters<typeof createApp>[0]['rateLimitKey'] } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const config = loadConfig({ ...validEnv, ...opts.env });
  const db = openDb(opts.path ?? ':memory:');
  const logs: string[] = [];
  const logger = createLogger((line: string) => logs.push(line));
  const deps = { db, clock, config, logger, ...(opts.rateLimitKey ? {rateLimitKey:opts.rateLimitKey}: {}) };
  const app = createApp(deps);
  async function req(method: string, path: string, body?: unknown, headers: Record<string,string> = {}): Promise<Reply> {
    const response = await app.request(path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...headers }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
    return {status:response.status, headers:response.headers, body:envelope.parse(await response.json())};
  }
  return { ...deps, app, req, logs, close() { if(db.open) db.close(); } };
}
export function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), 'job-engine-api-'));
  return { path: join(dir,'jobs.sqlite'), cleanup() { rmSync(dir,{recursive:true,force:true}); } };
}
export const rowsSchema = z.array(z.record(z.string(),z.unknown()));
export function rows(c: ReturnType<typeof context>, table: 'jobs'|'job_runs'|'job_events'|'delivery_outbox') { return rowsSchema.parse(c.db.prepare(`SELECT * FROM ${table}`).all()); }

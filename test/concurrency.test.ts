import { afterEach, expect, test } from 'vitest';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { JobStore } from '../src/store/jobs.js';
import { OutboxStore } from '../src/store/outbox.js';
import { context, fileDb } from './helpers/context.js';

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });
const messageSchema = z.object({ ready: z.boolean().optional(), error: z.string().optional(), result: z.record(z.string(), z.unknown()).optional() });
type Result = z.infer<typeof messageSchema>;
async function race(filename: string, operation: 'create' | 'claim' | 'outbox', opts: { jobId?: string; outboxId?: number } = {}) {
  const barrier = new SharedArrayBuffer(4); const shared = new Int32Array(barrier); let ready = 0;
  const pending = Array.from({ length: 4 }, (_, index) => new Promise<Result>((resolve, reject) => {
    const worker = new Worker(new URL('./helpers/thread-worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'], workerData: { filename, operation, barrier, index, ...opts } });
    disposers.push(() => { void worker.terminate(); });
    worker.on('error', reject);
    worker.on('exit', code => { if (code !== 0) reject(new Error('Worker exited unsuccessfully')); });
    worker.on('message', (raw: unknown) => {
      const message = messageSchema.parse(raw);
      if (message.ready) { if (++ready === 4) { Atomics.store(shared, 0, 1); Atomics.notify(shared, 0, 4); } }
      else resolve(message);
    });
  }));
  return Promise.all(pending);
}

test('G09 G50 four threads create the same source message exactly once', async () => {
  const tmp = fileDb(); disposers.push(tmp.cleanup); const f = context({ path: tmp.path }); disposers.push(f.close);
  const results = await race(tmp.path, 'create'); expect(results.every(r => !r.error)).toBe(true);
  expect(results.filter(r => r.result?.created === true)).toHaveLength(1);
  expect(new Set(results.map(r => z.object({ job_id: z.string() }).parse(r.result?.job).job_id)).size).toBe(1);
  expect(f.db.prepare('SELECT * FROM jobs').all()).toHaveLength(1); expect(f.db.prepare("SELECT * FROM job_events WHERE type='job.created'").all()).toHaveLength(1);
}, 20000);

test('G20 G50 four threads claim one job with one winning CAS and one run', async () => {
  const tmp = fileDb(); disposers.push(tmp.cleanup); const f = context({ path: tmp.path }); disposers.push(f.close); const jobs = new JobStore(f);
  const job = jobs.create({ source: 'imessage', source_message_id: 'claim-race', source_chat_id: 'chat-a', requester_id: 'self', request_text: 'claim race' }).job;
  const results = await race(tmp.path, 'claim', { jobId: job.job_id }); expect(results.filter(r => r.result?.job)).toHaveLength(1); expect(results.filter(r => r.error === 'JOB_NOT_CLAIMABLE')).toHaveLength(3);
  expect(f.db.prepare('SELECT * FROM job_runs').all()).toHaveLength(1); expect(jobs.get(job.job_id).attempts).toBe(1);
}, 20000);

test('G39 G50 four threads claim one outbox with one sending winner', async () => {
  const tmp = fileDb(); disposers.push(tmp.cleanup); const f = context({ path: tmp.path }); disposers.push(f.close);
  const job = new JobStore(f).create({ source: 'imessage', source_message_id: 'outbox-race', source_chat_id: 'chat-a', requester_id: 'self', request_text: 'outbox race' }).job;
  const row = new OutboxStore(f).enqueue({ job_id: job.job_id, idempotency_key: 'race:outbox', kind: 'done', body: 'notice' }).outbox;
  const results = await race(tmp.path, 'outbox', { outboxId: row.outbox_id }); expect(results.filter(r => r.result?.outbox)).toHaveLength(1); expect(results.filter(r => r.error === 'OUTBOX_NOT_CLAIMABLE')).toHaveLength(3);
  expect(f.db.prepare("SELECT * FROM delivery_outbox WHERE status='sending'").all()).toHaveLength(1);
  expect(f.db.prepare("SELECT * FROM job_events WHERE type='outbox.claimed'").all()).toHaveLength(1);
}, 20000);

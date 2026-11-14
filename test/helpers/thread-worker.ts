import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { loadConfig } from '../../src/config/index.js';
import { openDb } from '../../src/db/open.js';
import { JobStore } from '../../src/store/jobs.js';
import { OutboxStore } from '../../src/store/outbox.js';

const data = z.object({ filename: z.string(), operation: z.enum(['create', 'claim', 'outbox']), barrier: z.instanceof(SharedArrayBuffer), jobId: z.string().optional(), outboxId: z.number().optional(), index: z.number() }).parse(workerData);
const db = openDb(data.filename);
const config = loadConfig({ JOB_API_TOKEN: 'dummy-'.repeat(8), ALLOWED_SOURCE_CHAT_IDS: 'chat-a,21', GENIE_TOKEN: 'dummy-genie-'.repeat(4), DASHBOARD_TOKEN: 'dummy-dashboard-token-'.repeat(2), DASHBOARD_ALIAS_KEY: 'dummy-dashboard-alias-key-'.repeat(2), DASHBOARD_ALIASES: '{}', GENIE_ALLOWED_CHAT_IDS: '21' });
const deps = { db, config, clock: { now: () => Date.parse('2026-11-11T00:00:00.000Z') } };
const barrier = new Int32Array(data.barrier);
parentPort?.postMessage({ ready: true });
Atomics.wait(barrier, 0, 0);
try {
  const jobs = new JobStore(deps); const outbox = new OutboxStore(deps);
  const result = data.operation === 'create'
    ? jobs.create({ source: 'imessage', source_message_id: 'concurrent-message', source_chat_id: 'chat-a', requester_id: 'self', request_text: 'concurrent request' })
    : data.operation === 'claim'
      ? jobs.claim({ worker_id: `worker-${data.index}`, lease_seconds: 10 }, data.jobId)
      : outbox.claim({ worker_id: `sender-${data.index}`, lease_seconds: 10, outbox_id: data.outboxId });
  parentPort?.postMessage({ result });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error && 'code' in error ? String(error.code) : 'UNEXPECTED' });
} finally { db.close(); }

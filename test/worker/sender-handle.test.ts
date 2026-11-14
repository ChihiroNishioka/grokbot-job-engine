import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { JobStore } from '../../src/store/jobs.js';
import { JobApiClient } from '../../src/worker/client.js';
import { runWorkerOnce } from '../../src/worker/run-once.js';
import type { Transport } from '../../src/worker/transport.js';
import { context, token } from '../helpers/context.js';

const contexts: ReturnType<typeof context>[] = [];
afterEach(() => { for (const c of contexts.splice(0)) c.close(); });
const phone = 'tel:' + ['+1', '555', '010', '0000'].join('');
const email = 'email:family@example.com';

test.each([
  { name: 'member phone', handle: phone, legacy: false },
  { name: 'member email', handle: email, legacy: false },
  { name: 'self', handle: null, legacy: false },
  { name: 'old server without key', handle: null, legacy: true },
])('JE-SH14 Worker receives nullable handle for $name without exposing it in Outcome', async ({ handle, legacy }) => {
  const c = context(); contexts.push(c);
  const created = new JobStore(c).create({
    source: 'imessage', source_message_id: 'worker-sender-guid', source_chat_id: '21',
    requester_id: handle === null ? 'self' : 'member', request_text: '調べてください',
    ...(handle === null ? {} : { sender_handle: handle }),
  });
  const transport: Transport = { async request(request) {
    const response = await c.app.request(request.path, {
      method: request.method, headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    let body = await response.text();
    if (legacy && request.path === '/jobs/claim') {
      const parsed = z.object({ job: z.record(z.string(), z.unknown()), claim_token: z.string() }).parse(JSON.parse(body));
      delete parsed.job.sender_handle;
      body = JSON.stringify(parsed);
    }
    return { ok: true, status: response.status, body };
  } };
  const received: unknown[] = [];
  const outcome = await runWorkerOnce({
    client: new JobApiClient(transport, token), claim: { worker_id: 'sender-worker' },
    process: async ({ job, heartbeat }) => {
      received.push(job.sender_handle);
      expect(await heartbeat()).toBe(false);
      return { result: { summary: '確認しました' } };
    },
  });
  expect(received).toEqual([handle]);
  expect(outcome).toEqual({ outcome: 'done', job_id: created.job.job_id });
  expect(JSON.stringify(outcome)).not.toContain('sender_handle');
  expect(JSON.stringify(outcome)).not.toContain(phone);
  expect(JSON.stringify(outcome)).not.toContain(email);
});

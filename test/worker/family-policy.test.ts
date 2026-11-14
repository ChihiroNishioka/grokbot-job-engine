import { expect, it, test } from 'vitest';
import { JobApiClient } from '../../src/worker/client.js';
import { runWorkerOnce } from '../../src/worker/run-once.js';
import type { Transport } from '../../src/worker/transport.js';
import { context, job, token } from '../helpers/context.js';

async function runClaimedJob(claimedJob: Record<string, unknown>, process: Parameters<typeof runWorkerOnce>[0]['process']) {
  const requests: string[] = [];
  const transport: Transport = { async request(request) {
    requests.push(request.path);
    if (request.path === '/jobs/claim') {
      return { ok: true, status: 200, body: JSON.stringify({ job: claimedJob, claim_token: 'dummy-claim-token' }) };
    }
    return { ok: true, status: 200, body: '{}' };
  } };
  const outcome = await runWorkerOnce({
    client: new JobApiClient(transport, token),
    claim: { worker_id: 'dummy-worker' },
    process,
  });
  return { outcome, requests };
}

const claimedJobWithoutPolicy = { job_id: 'J-000001', request_text: 'request', attempts: 1, max_attempts: 3 };

it('JE-FP6 parses policy fields and defaults missing fields from an older server', async () => {
  const transport: Transport = { async request() {
    return { ok: true, status: 200, body: JSON.stringify({ job: claimedJobWithoutPolicy, claim_token: 'dummy-claim-token' }) };
  } };
  const result = await new JobApiClient(transport, token).claim({ worker_id: 'dummy-worker' });
  expect(result).toMatchObject({ ok: true, data: { job: { policy_decision: null, allowed_capabilities: null } } });
});

test.each([
  { name: 'missing', job: claimedJobWithoutPolicy },
  { name: 'null', job: { ...claimedJobWithoutPolicy, allowed_capabilities: null } },
  { name: 'empty', job: { ...claimedJobWithoutPolicy, allowed_capabilities: [] } },
  { name: 'null requester', job: { ...claimedJobWithoutPolicy, requester_id: null, allowed_capabilities: [] } },
  { name: 'unfamiliar requester', job: { ...claimedJobWithoutPolicy, requester_id: 'unknown', allowed_capabilities: [] } },
])('old or restricted job with $name grants denies capability use before side effects', async ({ job: claimed }) => {
  const sideEffects: string[] = [];
  const { outcome, requests } = await runClaimedJob(claimed, async ({ can, require }) => {
    expect(can('vault')).toBe(false);
    require('vault');
    sideEffects.push('vault');
    return { result: { summary: '処理しました。' } };
  });
  expect(outcome).toMatchObject({ outcome: 'failed' });
  expect(sideEffects).toEqual([]);
  expect(requests.some(path => path.endsWith('/complete'))).toBe(false);
  expect(requests.some(path => path.endsWith('/fail'))).toBe(true);
});

it('missing requester_id can use only the capability present in allowed_capabilities', async () => {
  const sideEffects: string[] = [];
  const { outcome, requests } = await runClaimedJob(
    { ...claimedJobWithoutPolicy, allowed_capabilities: ['lookup'] },
    async ({ can, require }) => {
      expect(can('lookup')).toBe(true);
      expect(can('vault')).toBe(false);
      require('lookup');
      sideEffects.push('lookup');
      return { result: { summary: '調べました。' } };
    },
  );
  expect(outcome).toMatchObject({ outcome: 'done', job_id: 'J-000001' });
  expect(sideEffects).toEqual(['lookup']);
  expect(requests.some(path => path.endsWith('/complete'))).toBe(true);
});

it('member can use an allowed capability', async () => {
  const sideEffects: string[] = [];
  const { outcome, requests } = await runClaimedJob(
    { ...claimedJobWithoutPolicy, requester_id: 'member', allowed_capabilities: ['lookup'] },
    async ({ can, require }) => {
      expect(can('lookup')).toBe(true);
      require('lookup');
      sideEffects.push('lookup');
      return { result: { summary: '調べました。' } };
    },
  );
  expect(outcome).toMatchObject({ outcome: 'done', job_id: 'J-000001' });
  expect(sideEffects).toEqual(['lookup']);
  expect(requests.some(path => path.endsWith('/complete'))).toBe(true);
});

it('JE-FP6 gives the process policy data and forwards its actual capability report', async () => {
  const c = context();
  try {
    const created = await c.req('POST', '/jobs', {
      source: 'imessage', source_message_id: 'worker-family', source_chat_id: '21',
      requester_id: 'member', request_text: '今日の天気は？',
    });
    const id = job(created).job_id;
    const requests: { path: string; body?: string }[] = [];
    const transport: Transport = { async request(request) {
      requests.push({ path: request.path, ...(request.body === undefined ? {} : { body: request.body }) });
      const response = await c.app.request(request.path, { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
      return { ok: true, status: response.status, body: await response.text() };
    } };
    const result = await runWorkerOnce({
      client: new JobApiClient(transport, token),
      claim: { worker_id: 'dummy-worker' },
      process: async ({ job: workerJob }) => {
        expect(workerJob).toMatchObject({ job_id: id, policy_decision: 'allow', allowed_capabilities: ['lookup'] });
        return { result: { summary: '天気を確認しました。' }, used_capabilities: ['lookup'] };
      },
    });
    expect(result).toMatchObject({ outcome: 'done', job_id: id });
    const complete = requests.find(request => request.path.endsWith('/complete'));
    expect(JSON.parse(complete?.body ?? '{}')).toMatchObject({ used_capabilities: ['lookup'] });
    expect(job(await c.req('GET', `/jobs/${id}`)).status).toBe('done');
  } finally { c.close(); }
});

test.each(['vault', 'family_calendar_add'] as const)('member processing blocks %s before its side effect', async capability => {
  const c = context();
  try {
    const created = await c.req('POST', '/jobs', {
      source: 'imessage', source_message_id: `worker-deny-${capability}`, source_chat_id: '21',
      requester_id: 'member', request_text: '今日の天気は？',
    });
    const id = job(created).job_id;
    const requests: string[] = [];
    const transport: Transport = { async request(request) {
      requests.push(request.path);
      const response = await c.app.request(request.path, { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
      return { ok: true, status: response.status, body: await response.text() };
    } };
    let allowedAtGate: boolean | undefined;
    const sideEffects: string[] = [];
    const result = await runWorkerOnce({
      client: new JobApiClient(transport, token),
      claim: { worker_id: 'dummy-worker' },
      process: async ({ can, require }) => {
        allowedAtGate = can(capability);
        require(capability);
        sideEffects.push(capability);
        return { result: { summary: '処理しました。' } };
      },
    });
    expect(allowedAtGate).toBe(false);
    expect(sideEffects).toEqual([]);
    expect(result).toMatchObject({ outcome: 'failed', job_id: id });
    expect(requests.some(path => path.endsWith('/complete'))).toBe(false);
    expect(job(await c.req('GET', `/jobs/${id}`)).status).toBe('failed');
  } finally { c.close(); }
});

it('self processing can use a capability without a saved grant', async () => {
  const c = context();
  try {
    const created = await c.req('POST', '/jobs', {
      source: 'imessage', source_message_id: 'worker-self-capability', source_chat_id: '21',
      requester_id: 'self', request_text: '確認してください',
    });
    const id = job(created).job_id;
    const requests: string[] = [];
    const transport: Transport = { async request(request) {
      requests.push(request.path);
      const response = await c.app.request(request.path, { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
      return { ok: true, status: response.status, body: await response.text() };
    } };
    let allowedAtGate: boolean | undefined;
    const sideEffects: string[] = [];
    const result = await runWorkerOnce({
      client: new JobApiClient(transport, token),
      claim: { worker_id: 'dummy-worker' },
      process: async ({ can, require }) => {
        allowedAtGate = can('vault');
        require('vault');
        sideEffects.push('vault');
        return { result: { summary: '確認しました。' } };
      },
    });
    expect(allowedAtGate).toBe(true);
    expect(sideEffects).toEqual(['vault']);
    expect(result).toMatchObject({ outcome: 'done', job_id: id });
    expect(requests.some(path => path.endsWith('/complete'))).toBe(true);
  } finally { c.close(); }
});

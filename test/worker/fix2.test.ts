import { afterEach, expect, test } from 'vitest';
import { failure } from '../../src/lib/reply-text.js';
import { JobApiClient } from '../../src/worker/client.js';
import { runWorkerOnce } from '../../src/worker/run-once.js';
import { context, input, token } from '../helpers/context.js';

const contexts: ReturnType<typeof context>[] = [];
afterEach(() => { for (const c of contexts.splice(0)) c.close(); });
function worker() {
  const c = context(); contexts.push(c);
  const client = new JobApiClient({ async request(request) {
    const response = await c.app.request(request.path, { method: request.method, headers: request.headers, body: request.body });
    return { ok: true, status: response.status, body: await response.text() };
  } }, token);
  return { c, client };
}
const reasons = [
  ['TIMEOUT', '処理が時間切れになりました'],
  ['SOURCE_UNAVAILABLE', '参照先を利用できません'],
  ['INVALID_REQUEST', '依頼の内容を確認してください'],
  ['PERMISSION_REQUIRED', '処理に必要な権限がありません'],
  ['PROCESSING_ERROR', '処理中にエラーが起きました'],
] as const;
test.each(reasons)('fix2-4 processor selects safe failure code %s', async (code, reason) => {
  const { c, client } = worker();
  const id = (await c.req('POST', '/jobs', input())).body.job;
  expect(id).toBeDefined();
  const result = await runWorkerOnce({ client, claim: { worker_id: 'dummy-worker' }, process: async () => ({ ok: false, code, message: `Bearer ${token}` }) });
  expect(result).toMatchObject({ outcome: 'failed' });
  const saved = c.db.prepare('SELECT error FROM jobs').get();
  expect(JSON.stringify(saved)).toContain(code);
  expect(JSON.stringify(saved)).not.toContain(token);
  const notification = c.db.prepare('SELECT body FROM delivery_outbox').get();
  expect(JSON.stringify(notification)).toContain(reason);
  expect(JSON.stringify(notification)).not.toContain(token);
  expect(failure('J-000123', code)).toContain(reason);
});
test.each(['🧞', '🪔', ' 🧞‍♂️ 🪔 \n', '\u200B🪔'])('fix2-6 empty normalized completion uses default (%#)', async body => {
  const { c, client } = worker();
  await c.req('POST', '/jobs', input());
  expect(await runWorkerOnce({ client, claim: { worker_id: 'dummy-worker' }, process: async () => ({ result: { summary: '保存済み' }, notify: { body } }) })).toMatchObject({ outcome: 'done' });
  expect(c.db.prepare('SELECT body FROM delivery_outbox').get()).toMatchObject({ body: expect.stringContaining('保存済み') });
});
test('fix2-6 empty normalized failure uses default', async () => {
  const { c, client } = worker();
  await c.req('POST', '/jobs', input());
  expect(await runWorkerOnce({ client, claim: { worker_id: 'dummy-worker' }, process: async () => ({ ok: false, code: 'TIMEOUT', notify: { body: '🧞 🪔' } }) })).toMatchObject({ outcome: 'failed' });
  expect(c.db.prepare('SELECT body FROM delivery_outbox').get()).toMatchObject({ body: expect.stringContaining('処理が時間切れになりました') });
});

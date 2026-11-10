import { expect, test } from 'vitest';
import { JobStore } from '../../src/store/jobs.js';
import { setup, payload } from './helpers.js';

test.each(['queued', 'claimed', 'done', 'failed', 'cancelled'] as const)('fix2-7 refused commands explain ID state and reason (%s)', async status => {
  const c = setup();
  try {
    const store = new JobStore(c);
    const id = store.create({ source: 'imessage', source_message_id: 'dummy-command-job', source_chat_id: '21', requester_id: 'self', request_text: 'dummy', max_attempts: 1 }).job.job_id;
    if (status === 'cancelled') store.cancel(id);
    if (status === 'claimed' || status === 'done' || status === 'failed') {
      const claimed = store.claim({ worker_id: 'dummy-worker' }, id);
      if (!claimed.job) throw Error('Missing claim');
      if (status === 'done') store.complete(id, { claim_token: claimed.claim_token, result: {} });
      if (status === 'failed') store.fail(id, { claim_token: claimed.claim_token, error: { code: 'PROCESSING_ERROR', message: '' } });
    }
    const descriptions = { queued: '実行待ち', claimed: '実行中', done: '完了済み', failed: '失敗', cancelled: 'キャンセル済み' };
    const commands = status === 'done' || status === 'failed' ? ['cancel', 'retry'] : ['retry'];
    for (const command of commands) {
      const guid = `dummy-${command}`;
      await c.request('/ingress/genie', payload({ guid, idempotency_key: guid, text: `/${command} ${id}` }));
      const body = c.table('delivery_outbox').at(-1)?.body;
      expect(body).toEqual(expect.stringContaining(id));
      expect(body).toEqual(expect.stringContaining(descriptions[status]));
      expect(body).toEqual(expect.stringMatching(/ため|不要|上限/));
    }
  } finally { c.close(); }
});

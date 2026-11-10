import { expect, test } from 'vitest';
import { mask } from '../src/logging/mask.js';
import { JobStore } from '../src/store/jobs.js';
import { context, input } from './helpers/context.js';

const secrets = [
  'dummy.J-000123' + '@example.com',
  'J-000123-' + 'dummy-token'.repeat(4),
  'Bearer J-000123',
  'token=J-000123',
  'J-000123' + '.ts' + '.net',
];
test.each(secrets)('fix2-1 masks a credential containing a job ID at every sink (%#)', value => {
  const c = context();
  try {
    const message = `${value} J-000456`;
    const expected = `${value.startsWith('token=') ? 'token=' : ''}[REDACTED] J-000456`;
    expect(mask(message)).toBe(expected);
    const store = new JobStore(c);
    const id = store.create({ ...input(), source: 'imessage' }).job.job_id;
    const claimed = store.claim({ worker_id: 'dummy-worker' }, id);
    if (!claimed.job) throw Error('Missing claim');
    store.cancel(id, { reason: message });
    store.fail(id, { claim_token: claimed.claim_token, error: { code: 'PROCESSING_ERROR', message } });
    expect(JSON.parse(store.get(id).error ?? '{}')).toMatchObject({ message: expected });
    expect(c.db.prepare("SELECT reason FROM job_events WHERE type='job.cancel_requested'").get()).toEqual({ reason: expected });
    c.logger.error({ message, error: new Error(message) });
    expect(JSON.parse(c.logs.at(-1) ?? '{}')).toMatchObject({ message: expected, error: { message: expected } });
  } finally { c.close(); }
});

test('fix2-1 keeps standalone long job IDs after credential masking', () => {
  const id = 'J-' + '1'.repeat(40);
  expect(mask(id)).toBe(id);
});

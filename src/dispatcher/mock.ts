import { randomId } from '../lib/ids.js';
import type { WakeDispatcher, WakePayload } from './types.js';

export function createMockDispatcher(opts: { accept?: boolean; uuid?: () => string } = {}): WakeDispatcher & { calls: WakePayload[] } {
  const calls: WakePayload[] = [];
  return { calls, async wake() {
    const payload: WakePayload = { v: 1, event: 'jobs.available', event_id: (opts.uuid ?? randomId)() };
    calls.push(payload);
    return { accepted: opts.accept ?? true, event_id: payload.event_id };
  } };
}

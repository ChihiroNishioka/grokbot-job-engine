import { randomId } from '../lib/ids.js';
import type { WakeDispatcher, WakePayload } from './types.js';

export function createWebhookDispatcher(opts: { url: string; token: string; fetch: typeof fetch; timeoutMs: number; uuid?: () => string }): WakeDispatcher {
  return { async wake() {
    const payload: WakePayload = { v: 1, event: 'jobs.available', event_id: (opts.uuid ?? randomId)() };
    try {
      const response = await opts.fetch(opts.url, { method: 'POST', headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(opts.timeoutMs) });
      const accepted = response.status >= 200 && response.status < 300;
      await response.body?.cancel().catch(() => undefined);
      return { accepted, status: response.status, event_id: payload.event_id };
    } catch {
      return { accepted: false, event_id: payload.event_id, error: 'WEBHOOK_FAILED' };
    }
  } };
}

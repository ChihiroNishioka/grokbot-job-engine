import { replyText } from '../ingress/text.js';
import { truncate } from '../lib/reply-text.js';

export interface NotificationFlags { notify_truncated?: true; notify_replaced?: true }
export function prepareNotification(body: string | undefined, fallback: () => string): { body: string; flags: NotificationFlags } {
  const cleaned = replyText(body ?? '', Infinity);
  if (!cleaned) return { body: fallback(), flags: body === undefined ? {} : { notify_replaced: true } };
  return { body: truncate(cleaned), flags: [...cleaned].length > 1500 ? { notify_truncated: true } : {} };
}

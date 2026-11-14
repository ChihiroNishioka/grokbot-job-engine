import type Database from 'better-sqlite3';
import type { Clock } from '../lib/clock.js';
import type { WakeDispatcher } from './types.js';

export async function dispatchTick(deps: { db: Database.Database; clock: Clock; dispatcher: WakeDispatcher; state: { lastWakeAt?: number }; cooldownMs: number }): Promise<void> {
  const now = deps.clock.now();
  if (deps.state.lastWakeAt !== undefined && now - deps.state.lastWakeAt < deps.cooldownMs) return;
  const row = deps.db.prepare("SELECT job_id FROM jobs WHERE status='queued' AND cancel_requested=0 AND attempts<max_attempts AND (scheduled_at IS NULL OR scheduled_at<=?) LIMIT 1").get(now);
  if (!row) return;
  deps.state.lastWakeAt = now;
  await deps.dispatcher.wake();
}

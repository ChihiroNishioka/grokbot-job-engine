import type { Deps, Job, Outbox } from '../store/types.js';
import { OutboxStore } from '../store/outbox.js';
import { failure } from '../lib/reply-text.js';
import { writeEvent } from '../store/events.js';

export interface ReconcileReport {
  requeued: string[];
  failed: string[];
  cancelled: string[];
  outboxRequeued: number[];
  outboxFailed: number[];
  staleQueued: { id: string; ageMs: number }[];
  staleOutbox: { id: number; ageMs: number }[];
  terminalWithoutOutbox: { id: string; ageMs: number }[];
}

export function reconcile(
  { db, clock, config }: Deps,
  { queuedStaleMs, outboxStaleMs, limit = 100 }: { queuedStaleMs: number; outboxStaleMs: number; limit?: number },
): ReconcileReport {
  const now = clock.now();
  const report: ReconcileReport = { requeued: [], failed: [], cancelled: [], outboxRequeued: [], outboxFailed: [], staleQueued: [], staleOutbox: [], terminalWithoutOutbox: [] };
  const candidates = db.prepare<[number, number], Pick<Job, 'job_id'>>(
    "SELECT job_id FROM jobs WHERE status='claimed' AND lease_expires_at<=? ORDER BY lease_expires_at,job_id LIMIT ?",
  ).all(now, limit);
  const jobUpdate = db.prepare(`
    UPDATE jobs SET
      status=CASE WHEN cancel_requested=1 THEN 'cancelled' WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,
      updated_at=@now,
      error=CASE WHEN cancel_requested=0 AND attempts>=max_attempts THEN @error ELSE error END,
      claimed_at=CASE WHEN cancel_requested=0 AND attempts<max_attempts THEN NULL ELSE claimed_at END,
      claimed_by=CASE WHEN cancel_requested=0 AND attempts<max_attempts THEN NULL ELSE claimed_by END,
      claim_token=CASE WHEN cancel_requested=0 AND attempts<max_attempts THEN NULL ELSE claim_token END,
      lease_expires_at=CASE WHEN cancel_requested=0 AND attempts<max_attempts THEN NULL ELSE lease_expires_at END,
      heartbeat_at=CASE WHEN cancel_requested=0 AND attempts<max_attempts THEN NULL ELSE heartbeat_at END
    WHERE job_id=@id AND status='claimed' AND lease_expires_at<=@now
  `);
  const reconcileJob = db.transaction((id: string) => {
    if (jobUpdate.run({ id, now, error: JSON.stringify({ code: 'LEASE_EXPIRED_MAX_ATTEMPTS' }) }).changes !== 1) return null;
    const job = db.prepare<[string], Job>('SELECT * FROM jobs WHERE job_id=?').get(id);
    if (!job) throw new Error('Recovered job is missing');
    const run = db.prepare("UPDATE job_runs SET outcome='lease_expired', ended_at=? WHERE job_id=? AND attempt=? AND outcome='running'").run(now, id, job.attempts);
    if (run.changes !== 1) throw new Error('Running attempt is missing');
    const type = job.status === 'queued' ? 'job.requeued' : `job.${job.status}`;
    writeEvent(db, { job_id: id, at: now, actor: 'reconciler', type, from_status: 'claimed', to_status: job.status, reason: 'lease_expired' });
    if ((job.status === 'failed' || job.status === 'cancelled') && db.prepare("SELECT 1 FROM delivery_outbox WHERE job_id=? AND channel='genie' LIMIT 1").get(id)) {
      new OutboxStore({ db, clock, config }).enqueue({ job_id: id, kind: job.status, idempotency_key: `job:${id}:${job.status}:${job.attempts}`, body: job.status === 'cancelled' ? `ジョブ ${id} はキャンセルしました。` : failure(id, 'LEASE_EXPIRED_MAX_ATTEMPTS', { canRetry: false, maxAttempts: job.max_attempts }) });
    }
    return job;
  });
  for (const { job_id } of candidates) {
    const job = reconcileJob.immediate(job_id);
    if (job?.status === 'queued') report.requeued.push(job_id);
    else if (job?.status === 'failed') report.failed.push(job_id);
    else if (job?.status === 'cancelled') report.cancelled.push(job_id);
  }
  const remaining = limit - report.requeued.length - report.failed.length - report.cancelled.length;
  const outboxCandidates = db.prepare<[number, number], Pick<Outbox, 'outbox_id'>>(
    "SELECT outbox_id FROM delivery_outbox WHERE status='sending' AND lease_expires_at<=? ORDER BY lease_expires_at,outbox_id LIMIT ?",
  ).all(now, remaining);
  const outboxUpdate = db.prepare(`
    UPDATE delivery_outbox SET
      status=CASE WHEN attempts<@max THEN 'pending' ELSE 'failed' END,
      updated_at=@now,
      claimed_by=CASE WHEN attempts<@max THEN NULL ELSE claimed_by END,
      claim_token=CASE WHEN attempts<@max THEN NULL ELSE claim_token END,
      lease_expires_at=CASE WHEN attempts<@max THEN NULL ELSE lease_expires_at END
    WHERE outbox_id=@id AND status='sending' AND lease_expires_at<=@now
  `);
  const reconcileOutbox = db.transaction((id: number) => {
    if (outboxUpdate.run({ id, now, max: config.OUTBOX_MAX_ATTEMPTS }).changes !== 1) return null;
    const outbox = db.prepare<[number], Outbox>('SELECT * FROM delivery_outbox WHERE outbox_id=?').get(id);
    if (!outbox) throw new Error('Recovered notification is missing');
    writeEvent(db, { job_id: outbox.job_id, outbox_id: id, at: now, actor: 'reconciler', type: outbox.status === 'pending' ? 'outbox.requeued' : 'outbox.failed', from_status: 'sending', to_status: outbox.status, reason: 'lease_expired' });
    return outbox;
  });
  for (const { outbox_id } of outboxCandidates) {
    const outbox = reconcileOutbox.immediate(outbox_id);
    if (outbox?.status === 'pending') report.outboxRequeued.push(outbox_id);
    else if (outbox?.status === 'failed') report.outboxFailed.push(outbox_id);
  }
  report.staleQueued = db.prepare<[number, number, number, number], { id: string; ageMs: number }>(`
    SELECT job_id AS id, ?-created_at AS ageMs FROM jobs
    WHERE status='queued' AND cancel_requested=0 AND attempts<max_attempts
      AND (scheduled_at IS NULL OR scheduled_at<=?) AND created_at<?
    ORDER BY created_at,job_id LIMIT ?
  `).all(now, now, now - queuedStaleMs, limit);
  report.staleOutbox = db.prepare<[number, number, number], { id: number; ageMs: number }>(`
    SELECT outbox_id AS id, ?-created_at AS ageMs FROM delivery_outbox
    WHERE status IN ('pending','sending','failed') AND created_at<?
    ORDER BY created_at,outbox_id LIMIT ?
  `).all(now, now - outboxStaleMs, limit);
  report.terminalWithoutOutbox = db.prepare<[number, number, number], { id: string; ageMs: number }>(`
    SELECT j.job_id AS id, ?-j.updated_at AS ageMs FROM jobs AS j
    WHERE j.status IN ('done','failed','cancelled') AND j.updated_at<?
      AND NOT EXISTS (SELECT 1 FROM delivery_outbox AS o WHERE o.job_id=j.job_id AND o.kind=j.status AND o.idempotency_key='job:' || j.job_id || ':' || j.status || ':' || j.attempts)
    ORDER BY j.updated_at,j.job_id LIMIT ?
  `).all(now, now - outboxStaleMs, limit);
  return report;
}

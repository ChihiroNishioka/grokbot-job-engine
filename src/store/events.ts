import type Database from 'better-sqlite3';
import { mask } from '../logging/mask.js';
import type { Event } from './types.js';

type EventInput = Pick<Event, 'job_id'|'at'|'actor'|'type'> & Partial<Pick<Event,'outbox_id'|'from_status'|'to_status'|'reason'|'detail'>>;
export function writeEvent(db: Database.Database, event: EventInput): void {
  db.prepare(`INSERT INTO job_events(job_id,outbox_id,at,actor,type,from_status,to_status,reason,detail)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(event.job_id,event.outbox_id??null,event.at,mask(event.actor),event.type,
    event.from_status??null,event.to_status??null,event.reason ? mask(event.reason) : null,event.detail ? mask(event.detail) : null);
}
export function readEvents(db: Database.Database, id: string, limit=50): Event[] {
  return db.prepare<[string,number],Event>('SELECT * FROM job_events WHERE job_id=? ORDER BY event_id LIMIT ?').all(id,limit);
}

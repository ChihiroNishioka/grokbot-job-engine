import type { Hono } from 'hono';
import type { OutboxStore } from '../../store/outbox.js';
import type { Schemas } from '../schemas.js';
import { iso,outboxJson } from '../serialize.js';
import { body,outboxId } from './parse.js';

export function outboxRoutes(app:Hono,store:OutboxStore,s:Schemas) {
  app.post('/outbox',async c=> {const result=store.enqueue(await body(c,s.enqueue));return c.json({outbox:outboxJson(result.outbox),created:result.created},result.created?201:200);});
  app.post('/outbox/claim',async c=> {const result=store.claim(await body(c,s.outboxClaim));if(!result.outbox)return c.json({outbox:null});return c.json({...result,outbox:outboxJson(result.outbox),lease_expires_at:iso(result.lease_expires_at)});});
  app.post('/outbox/:id/sent',async c=> c.json({outbox:outboxJson(store.markSent(outboxId(c),await body(c,s.sent)).outbox)}));
  app.post('/outbox/:id/failed',async c=> c.json({outbox:outboxJson(store.markFailed(outboxId(c),await body(c,s.failed)).outbox)}));
}

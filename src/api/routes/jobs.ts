import type { Hono } from 'hono';
import type { JobStore } from '../../store/jobs.js';
import { StoreError } from '../../store/errors.js';
import type { Schemas } from '../schemas.js';
import { iso, jobJson, eventJson } from '../serialize.js';
import { body,validate,jobId } from './parse.js';

export function jobsRoutes(app:Hono,store:JobStore,s:Schemas) {
  app.post('/jobs',async c=> {
    const input=await body(c,s.create);
    if(input.parent_job_id) {
      try { store.get(input.parent_job_id); }
      catch(error) { if(error instanceof StoreError && error.code==='JOB_NOT_FOUND')throw new StoreError('VALIDATION_ERROR');throw error; }
    }
    const result=store.create(input);
    return c.json({job:jobJson(result.job),created:result.created},result.created?201:200);
  });
  app.get('/jobs',c=>c.json({jobs:store.list(validate(s.list,c.req.query())).map(row=>jobJson(row,true))}));
  app.post('/jobs/claim',async c=> {const result=store.claim(await body(c,s.claim));if(!result.job)return c.json({job:null});return c.json({...result,job:jobJson(result.job),lease_expires_at:iso(result.lease_expires_at)});});
  app.get('/jobs/:id',c=>c.json({job:jobJson(store.get(jobId(c)))}));
  app.get('/jobs/:id/events',c=>c.json({events:store.events(jobId(c),validate(s.events,c.req.query()).limit).map(eventJson)}));
  app.post('/jobs/:id/claim',async c=> {const result=store.claim(await body(c,s.claimById),jobId(c));if(!result.job)return c.json({job:null});return c.json({...result,job:jobJson(result.job),lease_expires_at:iso(result.lease_expires_at)});});
  app.post('/jobs/:id/heartbeat',async c=> {const result=store.heartbeat(jobId(c),await body(c,s.heartbeat));return c.json({...result,lease_expires_at:iso(result.lease_expires_at)});});
  app.post('/jobs/:id/complete',async c=> c.json({job:jobJson(store.complete(jobId(c),await body(c,s.complete)).job)}));
  app.post('/jobs/:id/fail',async c=> c.json({job:jobJson(store.fail(jobId(c),await body(c,s.fail)).job)}));
  app.post('/jobs/:id/cancel',async c=> c.json({job:jobJson(store.cancel(jobId(c),await body(c,s.reason)).job)}));
  app.post('/jobs/:id/retry',async c=> c.json({job:jobJson(store.retry(jobId(c),await body(c,s.reason)).job)}));
}

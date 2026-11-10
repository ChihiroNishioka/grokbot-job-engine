import { afterEach, expect, test } from 'vitest';
import { context, input } from './helpers/context.js';
import { JobStore } from '../src/store/jobs.js';
import { OutboxStore } from '../src/store/outbox.js';
const contexts: ReturnType<typeof context>[]=[];
afterEach(()=>{for(const c of contexts.splice(0))c.close();});
test.each([true,false])('G41 failed delivery audits sender identity retryable=%s',retryable=>{
  const c=context();contexts.push(c);
  const jobs=new JobStore(c); const outbox=new OutboxStore(c);
  const job=jobs.create({...input(),source:'imessage'}).job;
  const row=outbox.enqueue({job_id:job.job_id,idempotency_key:'audit',kind:'done',body:'dummy'}).outbox;
  const claim=outbox.claim({worker_id:'sender-a',outbox_id:row.outbox_id});
  if(!claim.outbox)throw Error('Expected a claim');
  outbox.markFailed(row.outbox_id,{claim_token:claim.claim_token,retryable,error:{code:'SEND_FAILED',message:'safe'}});
  expect(c.db.prepare('SELECT actor FROM job_events ORDER BY event_id DESC LIMIT 1').get()).toEqual({actor:'worker:sender-a'});
});

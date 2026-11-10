import { afterEach, expect, test } from 'vitest';
import { context, input } from './helpers/context.js';
import { JobStore } from '../src/store/jobs.js';
const contexts:ReturnType<typeof context>[]=[];
afterEach(()=>{for(const c of contexts.splice(0))c.close();});
test.each(['complete','fail'] as const)('G51 %s rolls back when the running attempt cannot be updated',operation=>{
  const c=context();contexts.push(c); const store=new JobStore(c);
  const job=store.create({...input(),source:'imessage'}).job;
  const claim=store.claim({worker_id:'worker-a'},job.job_id);
  if(!claim.job)throw Error('Expected a claim');
  const before={job:store.get(job.job_id),runs:c.db.prepare('SELECT * FROM job_runs').all(),events:store.events(job.job_id)};
  c.db.exec('CREATE TRIGGER skip_run BEFORE UPDATE ON job_runs BEGIN SELECT RAISE(IGNORE); END');
  expect(()=>operation==='complete'
    ?store.complete(job.job_id,{claim_token:claim.claim_token,result:{}})
    :store.fail(job.job_id,{claim_token:claim.claim_token,error:{code:'FAIL',message:'safe'}})).toThrow();
  expect({job:store.get(job.job_id),runs:c.db.prepare('SELECT * FROM job_runs').all(),events:store.events(job.job_id)}).toEqual(before);
});

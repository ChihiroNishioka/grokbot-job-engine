import {it,expect} from 'vitest';
import {JobStore} from '../../src/store/jobs.js';
import {setup,payload,created} from './helpers.js';
it('G67 help, malformed commands, status, cancel and retry are idempotent',async()=>{const c=setup();try{
 const id=created.parse((await c.request('/ingress/genie',payload())).body).job_id;
 let n=0;const command=async(text:string)=>{const guid=`cmd-${++n}`;const p=payload({text,guid,idempotency_key:guid});const a=await c.request('/ingress/genie',p);expect(a.status).toBe(200);expect(await c.request('/ingress/genie',p)).toEqual(a);return c.table('delivery_outbox').find(o=>o.idempotency_key===`cmd:${guid}`);};
 expect(await command('/help')).toMatchObject({kind:'command',channel:'genie',in_reply_to:'cmd-1',body:expect.stringContaining('/status')});
 expect(await command('/status')).toMatchObject({body:expect.stringContaining('コマンドを読めませんでした')});
 expect(await command(`/status ${id}`)).toMatchObject({body:expect.stringContaining('受付済み')});
 expect(await command(`/cancel ${id}`)).toMatchObject({body:expect.stringContaining('キャンセル')});expect(new JobStore(c).get(id).status).toBe('cancelled');
 const second=new JobStore(c).create({source:'imessage',source_message_id:'second',source_chat_id:'21',requester_id:'self',request_text:'work'}).job;
 const claim=new JobStore(c).claim({worker_id:'dummy-worker'},second.job_id);if(!claim.job)throw Error('claim missing');new JobStore(c).fail(second.job_id,{claim_token:claim.claim_token,error:{code:'DUMMY',message:'safe'}});
 expect(await command(`/retry ${second.job_id}`)).toMatchObject({body:expect.stringContaining('受付済み')});expect(new JobStore(c).get(second.job_id).status).toBe('queued');
 expect(c.table('delivery_outbox').filter(o=>o.kind==='command')).toHaveLength(5);
}finally{c.close();}});
it('G67 status hides other chat jobs just like missing jobs',async()=>{const c=setup();try{const id=created.parse((await c.request('/ingress/genie',payload())).body).job_id;for(const [i,text] of [`/status ${id}`,'/status J-999999'].entries())await c.request('/ingress/genie',payload({chat_id:22,text,guid:`private-${i}`,idempotency_key:`private-${i}`}));const commands=c.table('delivery_outbox').filter(o=>o.kind==='command');expect(commands.map(o=>o.body)).toEqual(['ジョブが見つかりません。','ジョブが見つかりません。']);}finally{c.close();}});
it('G67 command replay uses stored name and claimed cancel preserves running state',async()=>{const c=setup();try{
 const id=created.parse((await c.request('/ingress/genie',payload())).body).job_id;const store=new JobStore(c);store.claim({worker_id:'dummy-worker'},id);
 const p=payload({guid:'cancel-once',idempotency_key:'cancel-once',text:`/cancel ${id}`});const first=await c.request('/ingress/genie',p);
 expect(first.body).toEqual({status:'command',command:'cancel'});expect((await c.request('/ingress/genie',{...p,text:'/help'})).body).toEqual(first.body);
 expect(store.get(id)).toMatchObject({status:'claimed',cancel_requested:1,attempts:1});expect(c.table('job_events').filter(e=>e.type==='job.cancel_requested')).toHaveLength(1);
 await c.request('/ingress/genie',payload({guid:'check-status',idempotency_key:'check-status',text:`/status ${id}`}));
 expect(c.table('delivery_outbox').at(-1)?.body).toContain('状態：実行中\n試行回数：1\nキャンセル要求：あり');
}finally{c.close();}});
it('G67 retry reports exhausted attempts',async()=>{const c=setup();try{const store=new JobStore(c);const id=store.create({source:'imessage',source_message_id:'exhausted',source_chat_id:'21',requester_id:'self',request_text:'work',max_attempts:1}).job.job_id;const claim=store.claim({worker_id:'dummy-worker'},id);if(!claim.job)throw Error('claim missing');store.fail(id,{claim_token:claim.claim_token,error:{code:'DUMMY',message:'safe'}});await c.request('/ingress/genie',payload({text:`/retry ${id}`}));expect(c.table('delivery_outbox').at(-1)?.body).toBe(`ジョブ ${id} は失敗しました。試行回数 1 回で再実行の上限（1 回）に達したため、/retry はできません。`);expect(store.get(id).status).toBe('failed');}finally{c.close();}});

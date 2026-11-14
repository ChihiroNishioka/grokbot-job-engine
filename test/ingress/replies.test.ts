import {it,expect} from 'vitest';
import {OutboxStore} from '../../src/store/outbox.js';
import {JobStore} from '../../src/store/jobs.js';
import {setup,payload,created,page} from './helpers.js';
it('G68 paginates pending replies and retries a page unchanged',async()=>{const c=setup({GENIE_REPLY_PAGE_LIMIT:'1'});try{
 for(const guid of ['one','two'])await c.request('/ingress/genie',payload({guid,idempotency_key:guid}));
 const a=page.parse((await c.request('/genie/replies')).body);expect(a.replies).toHaveLength(1);expect(a).toEqual(page.parse((await c.request('/genie/replies')).body));expect(a.replies[0]).toMatchObject({id:'je-1',chat_id:21,in_reply_to_guid:'one',created_at:new Date(c.clock.now()).toISOString()});expect(a.cursor).toBe('o:1');
 const b=page.parse((await c.request(`/genie/replies?cursor=${a.cursor}`)).body);expect(b.replies[0]).toMatchObject({id:'je-2',in_reply_to_guid:'two'});expect(b).toEqual(page.parse((await c.request(`/genie/replies?cursor=${a.cursor}`)).body));
 const empty=page.parse((await c.request(`/genie/replies?cursor=${b.cursor}`)).body);expect(empty).toEqual({cursor:'o:2',replies:[]});
}finally{c.close();}});
it('G69 cursor acknowledges only genie pending rows and never mutates jobs',async()=>{const c=setup();try{
 const id=created.parse((await c.request('/ingress/genie',payload())).body).job_id;
 const old=new JobStore(c).create({source:'imessage',source_message_id:'old',source_chat_id:'21',requester_id:'self',request_text:'old'}).job;
 new OutboxStore(c).enqueue({job_id:old.job_id,idempotency_key:'old:ack',kind:'ack',body:'old'});
 const jobs=c.table('jobs');const response=await c.request('/genie/replies?cursor=o:1');expect(page.parse(response.body).replies).toHaveLength(0);expect(c.table('jobs')).toEqual(jobs);
 expect(c.table('delivery_outbox')).toMatchObject([{job_id:id,status:'sent',external_ref:'genie:cursor',sent_at:c.clock.now()},{job_id:old.job_id,status:'pending',channel:'imessage'}]);
 expect(c.table('job_events').filter(e=>e.type==='outbox.sent')).toMatchObject([{actor:'genie',outbox_id:1}]);
 await c.request('/genie/replies?cursor=o:1');expect(c.table('job_events').filter(e=>e.type==='outbox.sent')).toHaveLength(1);
}finally{c.close();}});
it('G69 outbox claims skip genie even for explicit row ids',async()=>{const c=setup();try{await c.request('/ingress/genie',payload());expect(new OutboxStore(c).claim({worker_id:'dummy-worker'})).toEqual({outbox:null});expect(()=>new OutboxStore(c).claim({worker_id:'dummy-worker',outbox_id:1})).toThrow('OUTBOX_NOT_CLAIMABLE');}finally{c.close();}});
it.each(['abc','o:-1','o:1.5','o:','o:9007199254740992'])('G69 rejects invalid cursor %s',async(cursor)=>{const c=setup();try{expect((await c.request(`/genie/replies?cursor=${cursor}`)).status).toBe(400);}finally{c.close();}});
it('G68 empty replies use null cursor and standalone help routes to command guid',async()=>{const c=setup();try{expect(page.parse((await c.request('/genie/replies')).body)).toEqual({cursor:null,replies:[]});await c.request('/ingress/genie',payload({text:'/help'}));expect(c.table('jobs')).toHaveLength(0);expect(c.table('delivery_outbox')).toMatchObject([{job_id:null,kind:'command'}]);expect(page.parse((await c.request('/genie/replies')).body).replies[0]).toMatchObject({chat_id:21,in_reply_to_guid:'guid-a',text:expect.stringContaining('/help')});await c.request('/genie/replies?cursor=o:1');expect(c.table('job_events')).toMatchObject([{job_id:null,type:'outbox.enqueued'},{job_id:null,type:'outbox.sent'}]);}finally{c.close();}});
it('G69 strips signal prefixes from custom notify and enqueue replies',async()=>{const c=setup();try{
 const id=created.parse((await c.request('/ingress/genie',payload())).body).job_id;
 for(const [i,text] of ['🪔 custom','  🧞‍♂️ custom','🪔 🧞 custom'].entries())new OutboxStore(c).enqueue({job_id:id,idempotency_key:`custom:${i}`,kind:'progress',body:text});
 const reply=page.parse((await c.request('/genie/replies')).body);
 expect(reply.replies.slice(1).map(r=>r.text)).toEqual(['custom','custom','custom']);
}finally{c.close();}});

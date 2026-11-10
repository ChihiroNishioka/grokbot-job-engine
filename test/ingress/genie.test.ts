import { describe,it,expect } from 'vitest';
import { setup,payload,created } from './helpers.js';
describe('Genie acceptance',()=>{
 it('G63 creates queued job, acknowledgement and receipt atomically',async()=>{
  const c=setup();try {
   const response=await c.request('/ingress/genie',payload());expect(response.status).toBe(201);
   const id=created.parse(response.body).job_id;
   expect(c.table('jobs')).toMatchObject([{job_id:id,status:'queued',source:'imessage',source_message_id:'guid-a',source_chat_id:'21',requester_id:'self',job_type:'general',request_text:'調べてください'}]);
   expect(c.table('delivery_outbox')).toMatchObject([{channel:'genie',kind:'ack',idempotency_key:`job:${id}:ack`,body:`依頼を受け付けました。\nジョブID：${id}\n内容：調べてください\n状態：受付済み`}]);
   expect(c.table('ingress_messages')).toMatchObject([{guid:'guid-a',kind:'job',job_id:id,received_at:c.clock.now(),created_at:c.clock.now()}]);
   expect(c.logs.join('')).not.toContain('調べてください');expect(c.logs.join('')).not.toContain('dummy-self');
  }finally{c.close();}
 });
 it('G64 concurrent resends retain one job, ack and receipt',async()=>{
  const c=setup();try{const first=await c.request('/ingress/genie',payload());const copies=await Promise.all([c.request('/ingress/genie',payload()),c.request('/ingress/genie',payload())]);for(const copy of copies){expect(copy.status).toBe(200);expect(copy.body).toEqual(first.body);}for(const t of ['jobs','delivery_outbox','ingress_messages'] as const)expect(c.table(t)).toHaveLength(1);}finally{c.close();}
 });
 it('G65 rejects other chats before sender checks and ignores other senders',async()=>{
  const c=setup();try{expect((await c.request('/ingress/genie',payload({chat_id:99,sender_is_me:false}))).status).toBe(403);expect(c.table('ingress_messages')).toHaveLength(0);expect((await c.request('/ingress/genie',payload({sender_is_me:false}))).body).toEqual({status:'ignored',reason:'not_from_me'});expect(c.table('jobs')).toHaveLength(0);expect(c.table('delivery_outbox')).toHaveLength(0);}finally{c.close();}
 });
 it.each([{v:2},{extra:true},{chat_id:21.5},{idempotency_key:'different'},{guid:''},{sender_is_me:'true'},{created_at:2}])('G63 rejects malformed strict payload %j',async(change)=>{const c=setup();try{expect((await c.request('/ingress/genie',payload(change))).status).toBe(400);expect(c.table('jobs')).toHaveLength(0);}finally{c.close();}});
});
it('G63 outbox failure rolls back job, counter and receipt',async()=>{const c=setup();try{c.db.exec("CREATE TRIGGER reject_ack BEFORE INSERT ON delivery_outbox BEGIN SELECT RAISE(ABORT, 'dummy failure'); END");expect((await c.request('/ingress/genie',payload())).status).toBe(500);for(const name of ['jobs','delivery_outbox','ingress_messages'] as const)expect(c.table(name)).toHaveLength(0);c.db.exec('DROP TRIGGER reject_ack');const response=await c.request('/ingress/genie',payload());expect(created.parse(response.body).job_id).toBe('J-000001');}finally{c.close();}});
it('G63 ack preview counts code points and keeps body bounded',async()=>{const c=setup();try{await c.request('/ingress/genie',payload({text:'🪔 '+ '🌱'.repeat(41)}));expect(c.table('delivery_outbox')[0]?.body).toContain(`内容：${'🌱'.repeat(40)}\n状態：`);}finally{c.close();}});
it('G63 accepts a payload without created_at because Swift omits nil optionals',async()=>{const c=setup();try{const body=payload() as Record<string,unknown>;delete body.created_at;const response=await c.request('/ingress/genie',body);expect(response.status).toBe(201);expect(c.table('jobs')).toHaveLength(1);}finally{c.close();}});

import { z } from 'zod';
import { context } from '../helpers/context.js';
import { createIngressApp } from '../../src/ingress/app.js';
export const genieToken='dummy-genie-token-'.repeat(3);
export const payload=(overrides:Record<string,unknown>={})=>({v:1,event:'message',idempotency_key:'guid-a',guid:'guid-a',chat_id:21,text:'🪔 調べてください',created_at:null,sender_is_me:true,sender_name:'dummy-self',...overrides});
export function setup(env:Record<string,string>={}) {
 const c=context({env:{GENIE_TOKEN:genieToken,GENIE_ALLOWED_CHAT_IDS:'21,22',ALLOWED_SOURCE_CHAT_IDS:'21,22',...env}});
 const ingress=createIngressApp(c);
 async function request(path:string,body?:unknown,auth=genieToken) {
  const response=await ingress.request(path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const parsedBody:unknown=await response.json();
  return {status:response.status,body:parsedBody};
 }
 const table=(name:'jobs'|'delivery_outbox'|'ingress_messages'|'job_events')=>z.array(z.record(z.string(),z.unknown())).parse(c.db.prepare(`SELECT * FROM ${name}`).all());
 return {...c,ingress,request,table};
}
export const created=z.object({status:z.literal('created'),job_id:z.string()});
export const page=z.object({cursor:z.string().nullable(),replies:z.array(z.object({id:z.string(),chat_id:z.number().int(),text:z.string(),in_reply_to_guid:z.string(),created_at:z.iso.datetime()}))});

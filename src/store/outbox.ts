import type {Deps,Outbox,EnqueueInput,OutboxClaimInput,TokenInput} from './types.js';
import { randomToken } from '../lib/ids.js';
import { mask } from '../logging/mask.js';
import { StoreError } from './errors.js';
import { writeEvent } from './events.js';

export class OutboxStore {
  constructor(readonly deps:Deps) {}
  get(id:number):Outbox {
    const row=this.deps.db.prepare<[number],Outbox>('SELECT * FROM delivery_outbox WHERE outbox_id=?').get(id);
    if(!row)throw new StoreError('OUTBOX_NOT_FOUND');
    return row;
  }
  enqueue(input:EnqueueInput):{outbox:Outbox;created:boolean} {
    const {db,clock}=this.deps;
    return db.transaction(()=>{
      const existing=db.prepare<[string],Outbox>('SELECT * FROM delivery_outbox WHERE idempotency_key=?').get(input.idempotency_key);
      if(existing){
        if(existing.job_id!==input.job_id||existing.kind!==input.kind||existing.body!==input.body)throw new StoreError('IDEMPOTENCY_CONFLICT');
        return {outbox:existing,created:false};
      }
      const job=db.prepare<[string],{source_chat_id:string;source_message_id:string}>('SELECT source_chat_id,source_message_id FROM jobs WHERE job_id=?').get(input.job_id);
      if(!job)throw new StoreError('JOB_NOT_FOUND');
      const now=clock.now();
      const channel=db.prepare<[string,string],{channel:string}>("SELECT 'genie' AS channel WHERE EXISTS (SELECT 1 FROM ingress_messages WHERE job_id=? AND kind='job') OR EXISTS (SELECT 1 FROM delivery_outbox WHERE job_id=? AND channel='genie')").get(input.job_id,input.job_id)?.channel??'imessage';
      const inserted=db.prepare("INSERT INTO delivery_outbox(job_id,idempotency_key,kind,channel,target_chat_id,in_reply_to,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)").run(input.job_id,input.idempotency_key,input.kind,channel,job.source_chat_id,job.source_message_id,input.body,now,now);
      const id=Number(inserted.lastInsertRowid);
      writeEvent(db,{job_id:input.job_id,outbox_id:id,at:now,actor:'api',type:'outbox.enqueued',to_status:'pending'});
      return {outbox:this.get(id),created:true};
    }).immediate();
  }
  claim(input:OutboxClaimInput):{outbox:Outbox;claim_token:string;lease_expires_at:number}|{outbox:null} {
    const {db,clock,config}=this.deps;
    return db.transaction(()=>{
      const now=clock.now();const token=this.deps.ids?.token?.()??randomToken();
      const expires=now+(input.lease_seconds??config.OUTBOX_LEASE_SECONDS)*1000;
      const selector=input.outbox_id!==undefined?'?':"(SELECT outbox_id FROM delivery_outbox WHERE status='pending' AND channel<>'genie' ORDER BY created_at,outbox_id LIMIT 1)";
      const changed=db.prepare(`UPDATE delivery_outbox SET status='sending',attempts=attempts+1,claimed_by=?,claim_token=?,lease_expires_at=?,updated_at=? WHERE outbox_id=${selector} AND status='pending' AND channel<>'genie'`).run(input.worker_id,token,expires,now,...(input.outbox_id!==undefined?[input.outbox_id]:[])).changes;
      if(changed!==1){if(input.outbox_id!==undefined){this.get(input.outbox_id);throw new StoreError('OUTBOX_NOT_CLAIMABLE');}return {outbox:null};}
      const row=db.prepare<[string],Outbox>('SELECT * FROM delivery_outbox WHERE claim_token=?').get(token);
      if(!row)throw new Error('Missing claimed outbox');
      writeEvent(db,{job_id:row.job_id,outbox_id:row.outbox_id,at:now,actor:`worker:${input.worker_id}`,type:'outbox.claimed',from_status:'pending',to_status:'sending'});
      return {outbox:row,claim_token:token,lease_expires_at:expires};
    }).immediate();
  }
  markSent(id:number,input:TokenInput & {external_ref?:string}):{outbox:Outbox} {
    const {db,clock}=this.deps;
    return db.transaction(()=>{
      const now=clock.now();
      const changed=db.prepare("UPDATE delivery_outbox SET status='sent',sent_at=?,updated_at=?,external_ref=? WHERE outbox_id=? AND status='sending' AND claim_token=?").run(now,now,input.external_ref??null,id,input.claim_token).changes;
      const row=this.get(id);
      if(changed!==1){
        if(row.claim_token!==input.claim_token)throw new StoreError('CLAIM_TOKEN_MISMATCH');
        if(row.status==='sent')return {outbox:row};
        throw new StoreError('INVALID_TRANSITION');
      }
      writeEvent(db,{job_id:row.job_id,outbox_id:id,at:now,actor:`worker:${row.claimed_by}`,type:'outbox.sent',from_status:'sending',to_status:'sent'});
      return {outbox:row};
    }).immediate();
  }
  markFailed(id:number,input:TokenInput & {error:{code:string;message:string};retryable?:boolean}):{outbox:Outbox} {
    const {db,clock,config}=this.deps;
    return db.transaction(()=>{
      const now=clock.now();
      const error=JSON.stringify({code:input.error.code,message:mask(input.error.message)});
      const changed=db.prepare(`UPDATE delivery_outbox SET status=CASE WHEN ?=1 AND attempts<? THEN 'pending' ELSE 'failed' END,last_error=?,updated_at=? WHERE outbox_id=? AND status='sending' AND claim_token=?`).run(input.retryable?1:0,config.OUTBOX_MAX_ATTEMPTS,error,now,id,input.claim_token).changes;
      const row=this.get(id);
      if(changed!==1){if(row.claim_token!==input.claim_token)throw new StoreError('CLAIM_TOKEN_MISMATCH');throw new StoreError('INVALID_TRANSITION');}
      writeEvent(db,{job_id:row.job_id,outbox_id:id,at:now,actor:`worker:${row.claimed_by}`,type:row.status==='pending'?'outbox.requeued':'outbox.failed',from_status:'sending',to_status:row.status});
      const cleared=db.prepare('UPDATE delivery_outbox SET claimed_by=NULL,claim_token=NULL,lease_expires_at=NULL WHERE outbox_id=? AND status=? AND claim_token=?').run(id,row.status,input.claim_token).changes;
      if(cleared!==1)throw new Error('Notification claim cleanup failed');
      return {outbox:this.get(id)};
    }).immediate();
  }
}

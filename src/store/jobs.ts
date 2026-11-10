import type { Deps,CreateInput,ClaimInput,TokenInput,CompleteInput,FailInput,ListInput,Job,Event } from './types.js';
import { randomToken } from '../lib/ids.js';
import { mask } from '../logging/mask.js';
import { StoreError } from './errors.js';
import { readEvents, writeEvent } from './events.js';
import { OutboxStore } from './outbox.js';

const clearClaim = 'claimed_at=NULL,claimed_by=NULL,claim_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL';
export class JobStore {
  constructor(readonly deps: Deps) {}
  get(id: string): Job {
    if (!/^J-\d{6,}$/.test(id)) throw new StoreError('JOB_NOT_FOUND');
    const row = this.deps.db.prepare<[string],Job>('SELECT * FROM jobs WHERE job_id=?').get(id);
    if (!row) throw new StoreError('JOB_NOT_FOUND');
    return row;
  }
  create(input: CreateInput): {job:Job;created:boolean} {
    const {db,clock,config}=this.deps;
    if (!config.ALLOWED_SOURCE_CHAT_IDS.includes(input.source_chat_id)) throw new StoreError('CHAT_NOT_ALLOWED');
    return db.transaction(() => {
      const existing=db.prepare<[string,string],Job>('SELECT * FROM jobs WHERE source=? AND source_message_id=?').get(input.source,input.source_message_id);
      if (existing) {
        if(existing.source_chat_id!==input.source_chat_id || existing.requester_id!==input.requester_id) throw new StoreError('IDEMPOTENCY_CONFLICT');
        return {job:existing,created:false};
      }
      if(input.parent_job_id) this.get(input.parent_job_id);
      const counter=db.prepare<[],{value:number}>("UPDATE id_counters SET value=value+1 WHERE name='job' RETURNING value").get();
      if(!counter) throw new Error('Missing job counter');
      const id=`J-${String(counter.value).padStart(6,'0')}`;
      const now=clock.now();
      db.prepare(`INSERT INTO jobs(job_id,source,source_message_id,source_chat_id,requester_id,job_type,request_text,payload_ref,status,priority,scheduled_at,created_at,updated_at,max_attempts,correlation_id,parent_job_id)
        VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?)`).run(id,input.source,input.source_message_id,input.source_chat_id,input.requester_id,input.job_type??'general',input.request_text??null,input.payload_ref??null,input.priority??0,input.scheduled_at?Date.parse(input.scheduled_at):null,now,now,input.max_attempts??config.JOB_MAX_ATTEMPTS_DEFAULT,input.correlation_id??null,input.parent_job_id??null);
      writeEvent(db,{job_id:id,at:now,actor:'api',type:'job.created',to_status:'queued'});
      return {job:this.get(id),created:true};
    }).immediate();
  }
  list(input: ListInput={}): Job[] {
    const where: string[]=[]; const values:(string|number)[]=[];
    for(const key of ['status','source_chat_id','job_type'] as const) {
      const value=input[key]; if(value!==undefined){where.push(`${key}=?`);values.push(value);}
    }
    return this.deps.db.prepare<(string|number)[],Job>(`SELECT * FROM jobs ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC,job_id DESC LIMIT ?`).all(...values,input.limit??20);
  }
  events(id:string,limit=50): Event[] { this.get(id);return readEvents(this.deps.db,id,limit); }
  claim(input:ClaimInput,id?:string): {job:Job;claim_token:string;lease_expires_at:number;run_id:number}|{job:null} {
    const {db,clock,config}=this.deps;
    return db.transaction(()=>{
      const now=clock.now(); const token=this.deps.ids?.token?.()??randomToken();
      const expires=now+(input.lease_seconds??config.LEASE_SECONDS_DEFAULT)*1000;
      const eligible="status='queued' AND cancel_requested=0 AND attempts<max_attempts AND (scheduled_at IS NULL OR scheduled_at<=?)";
      const types=input.job_types;
      const typeClause=types ? (types.length?` AND job_type IN (${types.map(()=>'?').join(',')})`:' AND 0') : '';
      const select=id?'?':`(SELECT job_id FROM jobs WHERE ${eligible}${typeClause} ORDER BY priority DESC,created_at,job_id LIMIT 1)`;
      const candidates:(string|number)[]=id?[id]:[now,...(types??[])];
      const changed=db.prepare(`UPDATE jobs SET status='claimed',attempts=attempts+1,claimed_at=?,claimed_by=?,claim_token=?,lease_expires_at=?,heartbeat_at=?,updated_at=?
        WHERE job_id=${select} AND ${eligible}`).run(now,input.worker_id,token,expires,now,now,...candidates,now).changes;
      if(changed!==1) {if(id){this.get(id);throw new StoreError('JOB_NOT_CLAIMABLE');}return {job:null};}
      const row=db.prepare<[string],Job>('SELECT * FROM jobs WHERE claim_token=?').get(token);
      if(!row)throw new Error('Missing claimed job');
      const run=db.prepare("INSERT INTO job_runs(job_id,attempt,worker_id,started_at) VALUES (?,?,?,?)").run(row.job_id,row.attempts,input.worker_id,now);
      writeEvent(db,{job_id:row.job_id,at:now,actor:`worker:${input.worker_id}`,type:'job.claimed',from_status:'queued',to_status:'claimed'});
      return {job:row,claim_token:token,lease_expires_at:expires,run_id:Number(run.lastInsertRowid)};
    }).immediate();
  }
  private rejectWorker(id:string,input:TokenInput,operation:'heartbeat'|'complete'|'fail'):Job {
    const row=this.get(id);
    if(operation==='complete' && row.status==='done' && row.claim_token===input.claim_token) return row;
    if(operation==='fail' && (row.status==='failed'||row.status==='cancelled') && row.claim_token===input.claim_token) return row;
    if(row.status!=='claimed')throw new StoreError('INVALID_TRANSITION');
    if(row.claim_token!==input.claim_token)throw new StoreError('CLAIM_TOKEN_MISMATCH');
    if(row.lease_expires_at===null || row.lease_expires_at<=this.deps.clock.now())throw new StoreError('LEASE_EXPIRED');
    throw new StoreError('INVALID_TRANSITION');
  }
  heartbeat(id:string,input:TokenInput):{lease_expires_at:number;cancel_requested:boolean} {
    const {db,clock,config}=this.deps;
    return db.transaction(()=>{
      const now=clock.now();const expires=now+(input.lease_seconds??config.LEASE_SECONDS_DEFAULT)*1000;
      const changed=db.prepare("UPDATE jobs SET lease_expires_at=?,heartbeat_at=?,updated_at=? WHERE job_id=? AND status='claimed' AND claim_token=? AND lease_expires_at>?").run(expires,now,now,id,input.claim_token,now).changes;
      if(changed!==1)this.rejectWorker(id,input,'heartbeat');
      return {lease_expires_at:expires,cancel_requested:this.get(id).cancel_requested===1};
    }).immediate();
  }
  complete(id:string,input:CompleteInput):{job:Job} {
    const {db,clock}=this.deps;
    return db.transaction(()=>{
      const now=clock.now();
      const changed=db.prepare("UPDATE jobs SET status='done',result=?,artifact_urls=?,updated_at=? WHERE job_id=? AND status='claimed' AND claim_token=? AND lease_expires_at>?").run(JSON.stringify(input.result),JSON.stringify(input.artifact_urls??[]),now,id,input.claim_token,now).changes;
      if(changed!==1)return {job:this.rejectWorker(id,input,'complete')};
      const row=this.get(id);
      const run=db.prepare("UPDATE job_runs SET outcome='done',ended_at=? WHERE job_id=? AND attempt=? AND outcome='running'").run(now,id,row.attempts);
      if(run.changes!==1)throw new Error('Running attempt is missing');
      writeEvent(db,{job_id:id,at:now,actor:`worker:${row.claimed_by}`,type:'job.done',from_status:'claimed',to_status:'done'});
      if(input.notify)new OutboxStore(this.deps).enqueue({job_id:id,idempotency_key:`job:${id}:done`,kind:'done',body:input.notify.body});
      return {job:row};
    }).immediate();
  }
  fail(id:string,input:FailInput):{job:Job} {
    const {db,clock}=this.deps;
    return db.transaction(()=>{
      const now=clock.now(); const error=JSON.stringify({code:input.error.code,message:mask(input.error.message)});
      const changed=db.prepare("UPDATE jobs SET status=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'failed' END,error=?,updated_at=? WHERE job_id=? AND status='claimed' AND claim_token=? AND lease_expires_at>?").run(error,now,id,input.claim_token,now).changes;
      if(changed!==1)return {job:this.rejectWorker(id,input,'fail')};
      const row=this.get(id);
      const run=db.prepare("UPDATE job_runs SET outcome=?,ended_at=?,error_code=? WHERE job_id=? AND attempt=? AND outcome='running'").run(row.status,now,input.error.code,id,row.attempts);
      if(run.changes!==1)throw new Error('Running attempt is missing');
      writeEvent(db,{job_id:id,at:now,actor:`worker:${row.claimed_by}`,type:`job.${row.status}`,from_status:'claimed',to_status:row.status});
      if(input.notify)new OutboxStore(this.deps).enqueue({job_id:id,idempotency_key:`job:${id}:failed`,kind:'failed',body:input.notify.body});
      return {job:row};
    }).immediate();
  }
  cancel(id:string,input:{reason?:string}={}):{job:Job} {
    const {db,clock}=this.deps;
    return db.transaction(()=>{
      const now=clock.now();
      const changed=db.prepare("UPDATE jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,cancel_requested=1,updated_at=? WHERE job_id=? AND (status='queued' OR (status='claimed' AND cancel_requested=0))").run(now,id).changes;
      const row=this.get(id);
      if(changed!==1){if(row.status==='cancelled'||(row.status==='claimed'&&row.cancel_requested===1))return {job:row};throw new StoreError('INVALID_TRANSITION');}
      writeEvent(db,{job_id:id,at:now,actor:'api',type:row.status==='cancelled'?'job.cancelled':'job.cancel_requested',from_status:row.status==='cancelled'?'queued':'claimed',to_status:row.status,reason:input.reason});
      return {job:row};
    }).immediate();
  }
  retry(id:string,input:{reason?:string}={}):{job:Job} {
    const {db,clock}=this.deps;
    return db.transaction(()=>{
      const now=clock.now();
      const changed=db.prepare(`UPDATE jobs SET status='queued',${clearClaim},cancel_requested=0,updated_at=? WHERE job_id=? AND status='failed' AND attempts<max_attempts`).run(now,id).changes;
      const row=this.get(id);
      if(changed!==1){if(row.status==='failed'&&row.attempts>=row.max_attempts)throw new StoreError('MAX_ATTEMPTS_REACHED');throw new StoreError('INVALID_TRANSITION');}
      writeEvent(db,{job_id:id,at:now,actor:'api',type:'job.retried',from_status:'failed',to_status:'queued',reason:input.reason});
      return {job:row};
    }).immediate();
  }
}

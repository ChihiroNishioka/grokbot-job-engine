import { statusLabel,statusReply } from './status-text.js';
import { redactHandle } from '../logging/redact-handle.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppDeps } from '../api/app.js';
import { auth } from '../api/middleware/auth.js';
import { rateLimit } from '../api/middleware/rateLimit.js';
import { requestLog } from '../api/middleware/requestLog.js';
import { errorResponse,handleError } from '../api/middleware/errors.js';
import { body,validate } from '../api/routes/parse.js';
import { JobStore } from '../store/jobs.js';
import { StoreError } from '../store/errors.js';
import { writeEvent } from '../store/events.js';
import type { Outbox,Job } from '../store/types.js';
import { acknowledgement,requestText,truncate,replyText } from './text.js';

const senderHandle=z.string().min(1).max(256).refine(value=>!/\s/.test(value)).regex(/^(?:tel:\+?[0-9]{1,20}|email:[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/);
const payloadSchema=z.strictObject({v:z.literal(1),event:z.literal('message'),idempotency_key:z.string().min(1).max(256),guid:z.string().min(1).max(256),chat_id:z.number().int().safe(),text:z.string(),created_at:z.string().nullable().optional(),sender_is_me:z.boolean(),sender_name:z.string(),sender_handle:senderHandle.optional()}).refine(p=>p.guid===p.idempotency_key).refine(p=>!p.sender_is_me||p.sender_handle===undefined);
type Payload=z.infer<typeof payloadSchema>;
type Command='help'|'status'|'cancel'|'retry'|'approve';
type Receipt={guid:string;chat_id:number;kind:'job'|'command'|'ignored';job_id:string|null;outbox_id:number|null;command:Command|'too_long'|null};
type GenieOutboxInput={job_id:string|null;idempotency_key:string;kind:'ack'|'cancelled'|'command'|'notify';target_chat_id:string;in_reply_to:string|null;body:string};
const help='/help：使い方を表示します。\n/status <job_id> [ページ]：状態と成果物 URL を確認します。\n/cancel <job_id>：キャンセルします。\n/retry <job_id>：失敗したジョブを再実行します。\n/approve <job_id>：承認待ちの依頼を許可します。';
function enqueueGenieOutbox(db:AppDeps['db'],input:GenieOutboxInput,now:number):number {
 const inserted=db.prepare("INSERT INTO delivery_outbox(job_id,idempotency_key,kind,channel,target_chat_id,in_reply_to,body,status,created_at,updated_at) VALUES (?,?,?,'genie',?,?,?,'pending',?,?)").run(input.job_id,input.idempotency_key,input.kind,input.target_chat_id,input.in_reply_to,input.body,now,now);
 const outboxId=Number(inserted.lastInsertRowid);
 writeEvent(db,{job_id:input.job_id,outbox_id:outboxId,at:now,actor:'genie',type:'outbox.enqueued',to_status:'pending'});
 return outboxId;
}
function parseCommand(text:string):{command:Command;id?:string;page?:number;pageInvalid?:boolean;invalid:boolean} {
 text=text.trim();
 if(text==='/help')return {command:'help',invalid:false};
 const status=/^\/status\s+(J-\d{6,})(?:\s+(.+))?$/s.exec(text);
 if(status){
  const raw=status[2];
  const page=raw===undefined?1:Number(raw);
  return {command:'status',id:status[1],page,invalid:false,pageInvalid:raw!==undefined&&(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(page))};
 }
 const match=/^\/(status|cancel|retry|approve|許可)\s+(J-\d{6,})$/.exec(text);
 const name=match?.[1];
 if(name==='approve'||name==='許可')return {command:'approve',id:match?.[2],invalid:false};
 if((name==='status'||name==='cancel'||name==='retry')&&match?.[2])return {command:name,id:match[2],invalid:false};
 return {command:'help',invalid:true};
}
function executeCommand(deps:AppDeps,chat:number,text:string):{command:Command;job_id:string|null;text:string} {
 const parsed=parseCommand(text);
 if(parsed.command==='help')return {command:'help',job_id:null,text:(parsed.invalid?'コマンドを読めませんでした。\n':'')+help};
 const store=new JobStore(deps);
 const fromOwnerChat=deps.config.OWNER_NOTIFY_CHAT_ID===chat;
 let job:Job;
 try {job=store.get(parsed.id??'');}catch(error){if(error instanceof StoreError&&error.code==='JOB_NOT_FOUND')return {command:parsed.command,job_id:null,text:parsed.command==='approve'&&fromOwnerChat?'このジョブは承認待ちではありません。':'ジョブが見つかりません。'};throw error;}
 if(job.source_chat_id!==String(chat)&&!fromOwnerChat)return {command:parsed.command,job_id:null,text:'ジョブが見つかりません。'};
 if(parsed.command==='status'){
  if(parsed.pageInvalid)return {command:'status',job_id:job.job_id,text:`ページ番号は1以上の整数で指定してください。\n/status ${job.job_id} [ページ]`};
  return {command:'status',job_id:job.job_id,text:statusReply(job,true,parsed.page)};
 }
 try {
  if(parsed.command==='approve'){
   job=store.approve(job.job_id).job;
   return {command:'approve',job_id:job.job_id,text:redactHandle(`ジョブID：${job.job_id}\n許可されたので進めます。`,job.sender_handle)};
  }
  if(parsed.command==='cancel')job=store.cancel(job.job_id).job;
  if(parsed.command==='retry')job=store.retry(job.job_id).job;
  const action=parsed.command==='cancel'?(job.status==='cancelled'?'キャンセルしました。\n':'キャンセルを受け付けました。実行中の処理が止まるのを待っています。\n'):parsed.command==='retry'?'再実行を受け付けました。\n':'';
  return {command:parsed.command,job_id:job.job_id,text:redactHandle(`${action}ジョブID：${job.job_id}\n状態：${statusLabel(job)}\n試行回数：${job.attempts}\nキャンセル要求：${job.cancel_requested?'あり':'なし'}`,job.sender_handle)};
 }catch(error){
  if(!(error instanceof StoreError))throw error;
  const states={queued:'実行待ち',claimed:'実行中',done:'完了済み',failed:'失敗',cancelled:'キャンセル済み'};
  if(error.code==='POLICY_NOT_PENDING')return {command:'approve',job_id:job.job_id,text:'このジョブは承認待ちではありません。'};
  const reason=error.code==='MAX_ATTEMPTS_REACHED'?'試行の上限に達しています。':parsed.command==='cancel'?'キャンセルできません。':job.status==='queued'||job.status==='claimed'?'再実行は不要です。':'再実行できません。失敗したジョブだけが対象です。';
  const message=error.code==='MAX_ATTEMPTS_REACHED'?`ジョブ ${job.job_id} は失敗しました。試行回数 ${job.attempts} 回で試行の上限（${job.max_attempts} 回）に達したため、/retry はできません。`:`ジョブ ${job.job_id} は${states[job.status]}のため、${reason}`;
  return {command:parsed.command,job_id:job.job_id,text:redactHandle(message,job.sender_handle)};
 }
}
function receive(deps:AppDeps,p:Payload) {
 if(!deps.config.GENIE_ALLOWED_CHAT_IDS.includes(p.chat_id))throw new StoreError('CHAT_NOT_ALLOWED');
 if(!p.sender_is_me&&(!deps.config.GENIE_GROUP_CHAT_IDS.includes(p.chat_id)||p.sender_handle===undefined))return {status:200 as const,body:{status:'ignored',reason:'not_from_me'}};
 const text=requestText(p.text);
 if(text.startsWith('🧞'))return {status:200 as const,body:{status:'ignored',reason:'bot_reply'}};
 if(text.length===0)return {status:200 as const,body:{status:'ignored',reason:'empty'}};
 const {db,clock}=deps;
 return db.transaction(()=>{
  const previous=db.prepare<[string],Receipt>('SELECT * FROM ingress_messages WHERE guid=?').get(p.guid);
  if(previous){
   if(previous.chat_id!==p.chat_id)throw new StoreError('IDEMPOTENCY_CONFLICT');
   const previousJob=previous.kind==='job'&&previous.job_id?new JobStore(deps).get(previous.job_id):null;
   return {status:200 as const,body:previous.command==='too_long'?{status:'rejected',reason:'too_long'}:previous.kind==='command'?{status:'command',command:previous.command}:previousJob?.policy_decision==='deny'?{status:'rejected',reason:'policy_denied',job_id:previous.job_id}:{status:'created',job_id:previous.job_id}};
  }
  const now=clock.now();
  const tooLong=[...text].length>deps.config.REQUEST_TEXT_MAX_CHARS;
  const isCommand=/^\/(help|status|cancel|retry|approve|許可)(?=\s|$)/.test(text.trim());
  if(!tooLong&&isCommand&&!p.sender_is_me)return {status:200 as const,body:{status:'ignored',reason:'command_not_allowed'}};
  if(tooLong || isCommand) {
   const result=tooLong?{command:'too_long' as const,job_id:null,text:`依頼が長すぎます（最大 ${deps.config.REQUEST_TEXT_MAX_CHARS} 字）。短くして送り直してください。`}:executeCommand(deps,p.chat_id,text);
   const outboxId=enqueueGenieOutbox(db,{job_id:result.job_id,idempotency_key:`cmd:${p.guid}`,kind:'command',target_chat_id:String(p.chat_id),in_reply_to:p.guid,body:truncate(result.text)},now);
   db.prepare("INSERT INTO ingress_messages(guid,chat_id,kind,job_id,outbox_id,received_at,created_at,command) VALUES (?,?,?,?,?,?,?,?)").run(p.guid,p.chat_id,tooLong?'ignored':'command',result.job_id,outboxId,now,now,result.command);
   return {status:200 as const,body:tooLong?{status:'rejected',reason:'too_long'}:{status:'command',command:result.command}};
  }
  const result=new JobStore(deps).create({source:'imessage',source_message_id:p.guid,source_chat_id:String(p.chat_id),requester_id:p.sender_is_me?'self':'member',...(p.sender_handle===undefined?{}:{sender_handle:p.sender_handle}),job_type:'general',request_text:text});
  const id=result.job.job_id;
  const target=String(p.chat_id);
  if(result.policy?.decision==='deny'){
   const outboxId=enqueueGenieOutbox(db,{job_id:id,idempotency_key:`job:${id}:cancelled`,kind:'cancelled',target_chat_id:target,in_reply_to:p.guid,body:redactHandle(result.policy.groupReply,result.job.sender_handle)},now);
   db.prepare("INSERT INTO ingress_messages(guid,chat_id,kind,job_id,outbox_id,received_at,created_at) VALUES (?,?,'job',?,?,?,?)").run(p.guid,p.chat_id,id,outboxId,now,now);
   return {status:200 as const,body:{status:'rejected',reason:'policy_denied',job_id:id}};
  }
  const safeText=redactHandle(text,result.job.sender_handle);
  const reply=result.job.policy_decision==='hold'?redactHandle(`状態：承認待ち\n${result.policy?.groupReply??'ちひろの確認が必要です。'}\nジョブID：${id}`,result.job.sender_handle):acknowledgement(id,safeText);
  const ackId=enqueueGenieOutbox(db,{job_id:id,idempotency_key:`job:${id}:ack`,kind:'ack',target_chat_id:target,in_reply_to:p.guid,body:reply},now);
  const outboxId=ackId;
  if(result.policy?.decision==='hold'&&result.policy.ownerNotify){
   const ownerChat=deps.config.OWNER_NOTIFY_CHAT_ID;
   if(ownerChat===null)throw new Error('Missing owner notification chat');
   const preview=truncate(safeText,40);
   const permissions=result.policy.capabilities.join('、')||'なし';
   const body=truncate(`家族からの依頼の確認。\nジョブID：${id}\n内容：${preview}\n承認後に許可する権限：${permissions}\n許可する場合：/approve ${id}\nやめる場合：/cancel ${id}`);
   enqueueGenieOutbox(db,{job_id:id,idempotency_key:`job:${id}:owner_notify`,kind:'notify',target_chat_id:String(ownerChat),in_reply_to:null,body},now);
  }
  db.prepare("INSERT INTO ingress_messages(guid,chat_id,kind,job_id,outbox_id,received_at,created_at) VALUES (?,?,'job',?,?,?,?)").run(p.guid,p.chat_id,id,outboxId,now,now);
  return {status:201 as const,body:{status:'created',job_id:id}};
 }).immediate();
}
const cursorSchema=z.string().regex(/^o:(0|[1-9]\d*)$/).refine(s=>Number.isSafeInteger(Number(s.slice(2))));
function replies(deps:AppDeps,cursor:string|undefined) {
 if(cursor!==undefined)validate(cursorSchema,cursor);
 const since=cursor===undefined?0:Number(cursor.slice(2));
 const {db,clock}=deps;
 return db.transaction(()=>{
  const sent=db.prepare<[number],Outbox>("SELECT * FROM delivery_outbox WHERE channel='genie' AND status='pending' AND outbox_id<=? ORDER BY outbox_id").all(since);
  const now=clock.now();
  for(const row of sent){
   const changed=db.prepare("UPDATE delivery_outbox SET status='sent',external_ref='genie:cursor',sent_at=?,updated_at=? WHERE outbox_id=? AND channel='genie' AND status='pending'").run(now,now,row.outbox_id).changes;
   if(changed===1)writeEvent(db,{job_id:row.job_id,outbox_id:row.outbox_id,at:now,actor:'genie',type:'outbox.sent',from_status:'pending',to_status:'sent'});
  }
  const rows=db.prepare<[number,number],Outbox>("SELECT * FROM delivery_outbox WHERE channel='genie' AND status='pending' AND outbox_id>? ORDER BY outbox_id LIMIT ?").all(since,deps.config.GENIE_REPLY_PAGE_LIMIT);
  const last=rows.at(-1);
  return {cursor:last?`o:${last.outbox_id}`:cursor??null,replies:rows.map(row=>({id:`je-${row.outbox_id}`,chat_id:Number(row.target_chat_id),text:replyText(row.body),in_reply_to_guid:row.in_reply_to,created_at:new Date(row.created_at).toISOString()}))};
 }).immediate();
}
export function createIngressApp(deps:AppDeps):Hono {
 const app=new Hono();
 app.onError((error,c)=>handleError(error,c,deps.logger));
 app.notFound(c=>errorResponse(c,'NOT_FOUND'));
 app.use('*',requestLog(deps.clock,deps.logger,deps.ids?.uuid));
 app.use('*',rateLimit(deps.clock,deps.config.RATE_LIMIT_PER_MINUTE,deps.rateLimitKey));
 app.use('*',auth(deps.config.GENIE_TOKEN));
 app.use('*',bodyLimit({maxSize:deps.config.BODY_MAX_BYTES,onError:c=>errorResponse(c,'PAYLOAD_TOO_LARGE')}));
 app.get('/healthz',c=>c.json({ok:true}));
 app.post('/ingress/genie',async c=>{const result=receive(deps,await body(c,payloadSchema));return c.json(result.body,result.status);});
 app.get('/genie/replies',c=>c.json(replies(deps,c.req.query('cursor'))));
 return app;
}

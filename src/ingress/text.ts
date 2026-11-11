import { truncate } from '../lib/reply-text.js';
export { truncate } from '../lib/reply-text.js';

export function requestText(text:string):string {
 const leading=/^[\s\p{Default_Ignorable_Code_Point}\p{Cc}]*/u;
 let result=text.replace(leading,'');
 if(result.startsWith('🪔'))result=result.slice('🪔'.length).replace(/^\uFE0F/u,'').replace(leading,'');
 return result;
}
export function acknowledgement(id:string,text:string):string {
 return truncate(`依頼を受け付けました。\nジョブID：${id}\n内容：${truncate(text,40)}\n状態：受付済み`);
}

export function replyText(text:string,max=1500):string {
 let result=requestText(text);
 while(result.startsWith('🧞')||result.startsWith('🪔')){
  result=result.startsWith('🧞')?result.replace(/^🧞(?:\u200D♂)?\uFE0F?/u,''):result.slice('🪔'.length);
  result=requestText(result);
 }
 return truncate(result,max);
}

import { mask } from '../logging/mask.js';

export const truncate=(text:string,max=1500)=>[...text].slice(0,max).join('');
export function completion(id:string,summary:string,urls:string[]=[]):string {
 return truncate(`ジョブ ${id} が完了しました。\n\n結果：\n${summary}${urls.length?'\n\n成果物：\n'+urls.join('\n'):''}`);
}
export function failure(id:string,message:string):string {
 return truncate(`ジョブ ${id} の処理に失敗しました。\n\n原因：\n${mask(message)}\n\n再実行する場合：\n/retry ${id}`);
}

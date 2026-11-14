import { z } from 'zod';
import { redactHandle } from '../logging/redact-handle.js';
import type { Job } from '../store/types.js';

const statusText = { queued: '受付済み', claimed: '実行中', done: '完了', failed: '失敗', cancelled: 'キャンセル済み' };
export function statusLabel(job: Pick<Job, 'status' | 'policy_decision'>): string {
  if (job.status === 'queued' && job.policy_decision === 'hold') return '承認待ち';
  if (job.status === 'cancelled' && job.policy_decision === 'deny') return 'お断り';
  return statusText[job.status];
}
export function statusReply(job: Job, showUrls: boolean, page = 1): string {
  const redact = (text: string) => redactHandle(text, job.sender_handle);
  const heading = redact(`ジョブID：${job.job_id}\n状態：${statusLabel(job)}\n`);
  const details = redact(`試行回数：${job.attempts}\nキャンセル要求：${job.cancel_requested ? 'あり' : 'なし'}`);
  const urls = showUrls && job.status === 'done' ? z.array(z.string()).parse(JSON.parse(job.artifact_urls)).map(redact) : [];
  const next = (n: number) => redact(`\n\n次のページ：/status ${job.job_id} ${n}`);
  const pages: string[][] = [[]];
  for (const url of urls) {
    if ([...heading + '成果物：\n' + url + '\n' + details + next(urls.length)].length > 1500) {
      return heading + details + '\n保存済みの成果物 URL が表示上限を超えています。短い URL での再登録が必要です。';
    }
    const current = pages.at(-1);
    if (!current) throw new Error('STATUS_PAGE_MISSING');
    const body = heading + '成果物：\n' + [...current, url].join('\n') + '\n' + details;
    if ([...body + next(urls.length)].length > 1500) {
      pages.push([url]);
    } else current.push(url);
  }
  const selected = pages[page - 1];
  if (!selected) return redact(`ページがありません。1〜${pages.length} のページ番号を指定してください。\n/status ${job.job_id} 1`);
  return heading + (selected.length ? '成果物：\n' + selected.join('\n') + '\n' : '') + details + (page < pages.length ? next(page + 1) : '');
}

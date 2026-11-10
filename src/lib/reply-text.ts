export class ArtifactNotificationTooLong extends Error {
  readonly code = 'ARTIFACT_NOTIFICATION_TOO_LONG';
  constructor() { super('ARTIFACT_NOTIFICATION_TOO_LONG'); }
}
export const truncate = (text: string, max = 1500) => [...text].slice(0, max).join('');
export function completion(id: string, summary: string, urls: string[] = []): string {
  const prefix = `ジョブ ${id} が完了しました。\n\n結果：\n`;
  const artifacts = urls.length ? '\n\n成果物：\n' + urls.join('\n') : '';
  const available = 1500 - [...prefix + artifacts].length;
  if (available < 0) throw new ArtifactNotificationTooLong();
  return prefix + truncate(summary, available) + artifacts;
}
export const failureReasons = {
  TIMEOUT: '処理が時間切れになりました',
  SOURCE_UNAVAILABLE: '参照先を利用できません',
  INVALID_REQUEST: '依頼の内容を確認してください',
  PERMISSION_REQUIRED: '処理に必要な権限がありません',
  PROCESSING_ERROR: '処理中にエラーが起きました',
  LEASE_EXPIRED_MAX_ATTEMPTS: '実行期限切れが再試行の上限に達しました',
};
export type FailureCode = keyof typeof failureReasons;
export function failure(id: string, code: string): string {
  const reason = Object.entries(failureReasons).find(([key]) => key === code)?.[1] ?? failureReasons.PROCESSING_ERROR;
  return `ジョブ ${id} の処理に失敗しました。\n\n原因：\n${reason}\n\n再実行する場合：\n/retry ${id}`;
}

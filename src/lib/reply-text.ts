export const truncate = (text: string, max = 1500) => [...text].slice(0, max).join('');
export function completion(id: string, summary: string, urls: string[] = []): string {
  const prefix = `ジョブ ${id} が完了しました。\n\n結果：\n`;
  const reservedSummary = Math.min(200, [...summary].length);
  const selected: string[] = [];
  const omittedLine = (count: number) => count > 0 ? `\n\nほか ${count} 件の成果物 URL は /status ${id} で確認できます。` : '';
  const artifacts = () => selected.length ? '\n\n成果物：\n' + selected.join('\n') : '';
  for (const url of urls) {
    selected.push(url);
    const omitted = urls.length - selected.length;
    if ([...prefix + artifacts() + omittedLine(omitted)].length + reservedSummary > 1500) selected.pop();
  }
  const suffix = artifacts() + omittedLine(urls.length - selected.length);
  return prefix + truncate(summary, 1500 - [...prefix + suffix].length) + suffix;
}
export const failureReasons = {
  TIMEOUT: '処理が時間切れになりました',
  SOURCE_UNAVAILABLE: '参照先を利用できません',
  INVALID_REQUEST: '依頼の内容を確認してください',
  INVALID_ARTIFACT: '処理結果の成果物 URL が規則に合いませんでした',
  PERMISSION_REQUIRED: '処理に必要な権限がありません',
  PROCESSING_ERROR: '処理中にエラーが起きました',
  LEASE_EXPIRED_MAX_ATTEMPTS: '試行の上限に達し、実行期限が切れました',
};
export type FailureCode = keyof typeof failureReasons;
export function failure(id: string, code: string, retry: { canRetry: boolean; maxAttempts: number }): string {
  const reason = Object.entries(failureReasons).find(([key]) => key === code)?.[1] ?? failureReasons.PROCESSING_ERROR;
  const action = code === 'INVALID_ARTIFACT' ? '同じ処理を再実行しても成果物 URL の規則違反は直らないため、処理側の修正が必要です。' : retry.canRetry ? `再実行する場合：\n/retry ${id}` : `試行の上限（${retry.maxAttempts} 回）に達したため、/retry はできません。`;
  return `ジョブ ${id} の処理に失敗しました。\n\n原因：\n${reason}\n\n${action}`;
}

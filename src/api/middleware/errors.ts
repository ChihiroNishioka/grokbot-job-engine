import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { StoreError } from '../../store/errors.js';
import type { Logger } from '../../logging/logger.js';

const messages: Record<string,[ContentfulStatusCode,string]> = {
  VALIDATION_ERROR:[400,'入力が正しくありません'], INVALID_JSON:[400,'JSON を読めません'], UNAUTHORIZED:[401,'認証が必要です'],
  CHAT_NOT_ALLOWED:[403,'このトークからは受け付けません'], NOT_FOUND:[404,'見つかりません'], JOB_NOT_FOUND:[404,'見つかりません'],OUTBOX_NOT_FOUND:[404,'見つかりません'],
  IDEMPOTENCY_CONFLICT:[409,'同じメッセージ ID で内容が違います'],JOB_NOT_CLAIMABLE:[409,'claim できる状態ではありません'],OUTBOX_NOT_CLAIMABLE:[409,'claim できる状態ではありません'],
  INVALID_TRANSITION:[409,'この状態では実行できません'],CLAIM_TOKEN_MISMATCH:[409,'claim_token が一致しません'],LEASE_EXPIRED:[409,'lease の期限が切れています'],MAX_ATTEMPTS_REACHED:[409,'試行の上限に達しています'],
  POLICY_DENIED:[400,'権限ポリシーで許可されていません'],POLICY_NOT_PENDING:[409,'承認待ちではありません'],
  PAYLOAD_TOO_LARGE:[413,'本文が大きすぎます'],RATE_LIMITED:[429,'リクエストが多すぎます'],INTERNAL:[500,'内部エラーです'],
};
export function errorResponse(c: Context, code: string) {
  const [status,message]=messages[code]??[500,'内部エラーです'];
  return c.json({error:{code:messages[code]?code:'INTERNAL',message}},status);
}
export function handleError(error: Error, c: Context, logger: Logger) {
  if(error instanceof StoreError) return errorResponse(c,error.code);
  logger.error({event:'request.error',message:error.message});
  return errorResponse(c,'INTERNAL');
}

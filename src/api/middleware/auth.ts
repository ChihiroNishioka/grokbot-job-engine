import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { errorResponse } from './errors.js';

export function auth(expected: string): MiddlewareHandler {
  const digest = createHash('sha256').update(expected).digest();
  return async (c,next)=> {
    if(c.req.path==='/healthz') return next();
    const match=/^Bearer ([^\s]+)$/.exec(c.req.header('Authorization')??'');
    const supplied=createHash('sha256').update(match?.[1]??'').digest();
    const equal=timingSafeEqual(digest,supplied);
    if(!match || !equal) return errorResponse(c,'UNAUTHORIZED');
    await next();
  };
}

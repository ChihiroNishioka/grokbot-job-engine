import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { Clock } from '../../lib/clock.js';
import type { Logger } from '../../logging/logger.js';

export function requestLog(clock: Clock, logger: Logger, uuid: ()=>string = randomUUID): MiddlewareHandler {
  return async (c,next)=> {
    const start=clock.now(); const request_id=uuid();
    await next();
    const route=matchedRoutes(c).filter(route=>!route.path.includes('*') && (route.method===c.req.method || route.method==='ALL')).at(-1);
    logger.info({method:c.req.method,path:route?.path??'unmatched',status:c.res.status,ms:clock.now()-start,request_id});
  };
}

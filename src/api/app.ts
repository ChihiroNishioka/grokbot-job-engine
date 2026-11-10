import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Deps } from '../store/types.js';
import type { Logger } from '../logging/logger.js';
import { JobStore } from '../store/jobs.js';
import { OutboxStore } from '../store/outbox.js';
import { schemas } from './schemas.js';
import { auth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requestLog } from './middleware/requestLog.js';
import { errorResponse, handleError } from './middleware/errors.js';
import { jobsRoutes } from './routes/jobs.js';
import { outboxRoutes } from './routes/outbox.js';

export interface AppDeps extends Deps {logger:Logger;rateLimitKey?:(c:Context)=>string}
export function createApp(deps:AppDeps):Hono {
  const app=new Hono();
  app.onError((error,c)=>handleError(error,c,deps.logger));
  app.notFound(c=>errorResponse(c,'NOT_FOUND'));
  app.use('*',requestLog(deps.clock,deps.logger,deps.ids?.uuid));
  app.use('*',rateLimit(deps.clock,deps.config.RATE_LIMIT_PER_MINUTE,deps.rateLimitKey));
  app.use('*',auth(deps.config.JOB_API_TOKEN));
  app.use('*',bodyLimit({maxSize:deps.config.BODY_MAX_BYTES,onError:c=>errorResponse(c,'PAYLOAD_TOO_LARGE')}));
  app.get('/healthz',c=>c.json({ok:true}));
  const s=schemas(deps.config);
  jobsRoutes(app,new JobStore(deps),s);
  outboxRoutes(app,new OutboxStore(deps),s);
  return app;
}

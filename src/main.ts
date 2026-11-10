import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { loadConfig } from './config/index.js';
import { openDb } from './db/open.js';
import { createIngressApp } from './ingress/app.js';
import { createApp } from './api/app.js';
import { systemClock } from './lib/clock.js';
import { createLogger } from './logging/logger.js';
import { reconcile } from './reconciler/index.js';

const logger=createLogger(line=>process.stdout.write(line+'\n'));
try {
  const config=loadConfig(process.env);
  if(config.DATABASE_PATH!==':memory:')mkdirSync(dirname(config.DATABASE_PATH),{recursive:true});
  const db=openDb(config.DATABASE_PATH);
  const deps={db,clock:systemClock,config,logger};
  const app=createApp(deps);
  const server=serve({fetch:app.fetch,hostname:config.HOST,port:config.PORT});
  const ingressServer=serve({fetch:createIngressApp(deps).fetch,hostname:config.GENIE_HOST,port:config.GENIE_PORT});
  const timer=config.RECONCILE_INTERVAL_SECONDS===0 ? undefined : setInterval(()=>{
    try {logger.info({event:'reconcile',report:reconcile(deps,{queuedStaleMs:config.QUEUED_STALE_SECONDS*1000,outboxStaleMs:config.OUTBOX_STALE_SECONDS*1000})});}
    catch {logger.error({event:'reconcile.failed'});}
  },config.RECONCILE_INTERVAL_SECONDS*1000);
  const shutdown=()=>{
    if(timer)clearInterval(timer);
    server.close(()=>{ingressServer.close(()=>{db.close();});});
  };
  process.once('SIGINT',shutdown);
  process.once('SIGTERM',shutdown);
} catch {
  logger.error({event:'startup.failed'});
  process.exitCode=1;
}

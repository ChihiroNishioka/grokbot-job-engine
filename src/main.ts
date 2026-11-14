import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { ConfigError, loadConfig } from './config/index.js';
import { openDb, openReadonlyDb } from './db/open.js';
import { createIngressApp } from './ingress/app.js';
import { createApp } from './api/app.js';
import { systemClock } from './lib/clock.js';
import { createLogger, type Logger } from './logging/logger.js';
import { reconcile } from './reconciler/index.js';
import { createDashboardApp } from './dashboard/app.js';

interface StartupOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  listen?: (server: ServerType, port: number, host: string) => void;
  setExitCode?: (code: number) => void;
}

export function startMain({
  env = process.env,
  logger = createLogger(line => process.stdout.write(line + '\n')),
  listen = (server, port, host) => { server.listen(port, host); },
  setExitCode = code => { process.exitCode = code; },
}: StartupOptions = {}): () => void {
  const servers: ServerType[] = [];
  let db: ReturnType<typeof openDb> | undefined;
  let readDb: ReturnType<typeof openReadonlyDb> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    let pending = servers.length;
    if (pending === 0) closeDatabases();
    for (const server of servers) {
      server.close(() => { if (--pending === 0) closeDatabases(); });
    }
  };
  const closeDatabases = () => {
    if (readDb?.open) readDb.close();
    if (db?.open) db.close();
  };
  const listenFailed = (listener: 'job_api' | 'genie' | 'dashboard', error: unknown) => {
    if (stopped) return;
    const code = error !== null && typeof error === 'object' && 'code' in error &&
      (error.code === 'EADDRINUSE' || error.code === 'EADDRNOTAVAIL' || error.code === 'EACCES' || error.code === 'EPERM')
      ? error.code : 'LISTEN_ERROR';
    logger.error({ event: 'listen.failed', listener, code });
    setExitCode(1);
    shutdown();
  };
  try {
    const config = loadConfig(env);
    if (config.DATABASE_PATH !== ':memory:') mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
    db = openDb(config.DATABASE_PATH);
    readDb = openReadonlyDb(config.DATABASE_PATH);
    const deps = { db, clock: systemClock, config, logger };
    const listeners = [
      { name: 'job_api', fetch: createApp(deps).fetch, host: config.HOST, port: config.PORT },
      { name: 'genie', fetch: createIngressApp(deps).fetch, host: config.GENIE_HOST, port: config.GENIE_PORT },
      { name: 'dashboard', fetch: createDashboardApp({ ...deps, readDb }).fetch, host: config.DASHBOARD_HOST, port: config.DASHBOARD_PORT },
    ] satisfies { name: 'job_api' | 'genie' | 'dashboard'; fetch: Parameters<typeof createAdaptorServer>[0]['fetch']; host: string; port: number }[];
    for (const listener of listeners) {
      const server = createAdaptorServer({ fetch: listener.fetch });
      server.on('error', error => listenFailed(listener.name, error));
      servers.push(server);
    }
    for (const [index, listener] of listeners.entries()) {
      const server = servers[index];
      if (!server || stopped) break;
      try { listen(server, listener.port, listener.host); }
      catch (error) { listenFailed(listener.name, error); }
    }
    if (stopped) return shutdown;
    timer = config.RECONCILE_INTERVAL_SECONDS === 0 ? undefined : setInterval(() => {
      try { logger.info({ event: 'reconcile', report: reconcile(deps, { queuedStaleMs: config.QUEUED_STALE_SECONDS * 1000, outboxStaleMs: config.OUTBOX_STALE_SECONDS * 1000 }) }); }
      catch { logger.error({ event: 'reconcile.failed' }); }
    }, config.RECONCILE_INTERVAL_SECONDS * 1000);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    logger.error({ event: 'startup.failed', ...(error instanceof ConfigError ? { fields: error.fields } : {}) });
    setExitCode(1);
    shutdown();
  }
  return shutdown;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startMain();

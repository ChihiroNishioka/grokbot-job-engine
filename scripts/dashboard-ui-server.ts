import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMain } from '../src/main.js';

const databaseDir = mkdtempSync(join(tmpdir(), 'job-dashboard-ui-'));
Object.assign(process.env, {
  JOB_API_TOKEN: 'dummy-job-api-token-00000000000000000000000000000000',
  GENIE_TOKEN: 'dummy-genie-token-00000000000000000000000000000000',
  DASHBOARD_TOKEN: 'dummy-dashboard-token-00000000000000000000000000000000',
  DASHBOARD_ALIAS_KEY: 'dummy-dashboard-alias-key-00000000000000000000000000000000',
  DASHBOARD_ALIASES: '{}',
  ALLOWED_SOURCE_CHAT_IDS: '21',
  GENIE_ALLOWED_CHAT_IDS: '21',
  PORT: '3320',
  GENIE_PORT: '3321',
  DASHBOARD_PORT: '3322',
  DATABASE_PATH: join(databaseDir, 'jobs.sqlite'),
  RECONCILE_INTERVAL_SECONDS: '0',
});
startMain();
process.once('beforeExit', () => rmSync(databaseDir, { recursive: true, force: true }));

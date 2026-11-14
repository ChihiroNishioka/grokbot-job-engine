import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardApp } from '../../src/dashboard/app.js';
import { loadConfig } from '../../src/config/index.js';
import { openDb, openReadonlyDb } from '../../src/db/open.js';
import { FakeClock } from '../helpers/context.js';
import type { CreateInput } from '../../src/store/types.js';
import { JobStore } from '../../src/store/jobs.js';
import { dashboardEnv } from './env.js';
import { z } from 'zod';

const sessionSchema = z.object({ csrfNonce: z.string() });

export function dashboardContext() {
  const dir = mkdtempSync(join(tmpdir(), 'job-dashboard-'));
  const path = join(dir, 'jobs.sqlite');
  const config = loadConfig(dashboardEnv);
  const db = openDb(path);
  const readDb = openReadonlyDb(path);
  const clock = new FakeClock(Date.parse('2026-11-14T12:34:56.000+09:00'));
  let tokenIndex = 0;
  const app = createDashboardApp({ db, readDb, clock, config, ids: { token: () => `dummy-session-${++tokenIndex}`, uuid: () => '00000000-0000-4000-8000-000000000001' } });
  const origin = `http://${config.DASHBOARD_HOST}:${config.DASHBOARD_PORT}`;
  const sameOrigin = { Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  async function json(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function login(token = config.DASHBOARD_TOKEN) {
    const response = await json('POST', '/login', { token }, sameOrigin);
    const setCookie = response.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';', 1)[0] ?? '';
    const session = await json('GET', '/api/session', undefined, { Cookie: cookie });
    const value = sessionSchema.parse(await session.json());
    return { response, cookie, csrfNonce: value.csrfNonce };
  }
  function authorize(cookie: string, csrfNonce: string) {
    return { ...sameOrigin, Cookie: cookie, 'X-CSRF-Token': csrfNonce };
  }
  function seedJob(overrides: Partial<CreateInput> = {}) {
    return new JobStore({ db, clock, config }).create({
      source: 'imessage', source_message_id: 'dummy-message-1', source_chat_id: 'chat-a',
      requester_id: 'self', request_text: 'dummy request', ...overrides,
    }).job;
  }
  function close() {
    readDb.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { app, db, readDb, clock, config, origin, sameOrigin, json, login, authorize, seedJob, close };
}

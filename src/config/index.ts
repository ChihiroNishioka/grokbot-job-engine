import { z } from 'zod';
import { isIP } from 'node:net';

function specifiedIp(host: string): boolean {
  switch (isIP(host)) {
    case 4: return host !== '0.0.0.0';
    case 6: {
      try {
        const normalized = new URL(`http://[${host}]`).hostname;
        return normalized !== '[::]' && normalized !== '[::ffff:0:0]';
      } catch { return false; }
    }
    default: return false;
  }
}

const integer = (fallback: number, min: number, max: number) => z.string().regex(/^\d+$/).default(String(fallback)).transform(Number).pipe(z.number().int().min(min).max(max));
const schema = z.object({
  JOB_API_TOKEN: z.string().min(32),
  ALLOWED_SOURCE_CHAT_IDS: z.string().transform(value => value.split(',').map(id => id.trim()).filter(Boolean)).refine(ids => ids.length > 0),
  HOST: z.string().default('127.0.0.1').refine(specifiedIp),
  GENIE_HOST: z.enum(['127.0.0.1', '::1', 'localhost']).default('127.0.0.1'),
  GENIE_PORT: integer(3321, 1, 65535),
  GENIE_TOKEN: z.string().min(32),
  GENIE_ALLOWED_CHAT_IDS: z.string().transform(value => value.split(',').map(id => id.trim())).refine(ids => ids.length > 0 && ids.every(id => /^-?\d+$/.test(id) && Number.isSafeInteger(Number(id)))).transform(ids => ids.map(Number)),
  GENIE_GROUP_CHAT_IDS: z.string().default('').transform(value => value.split(',').map(id => id.trim()).filter(Boolean)).refine(ids => ids.every(id => /^-?\d+$/.test(id) && Number.isSafeInteger(Number(id)))).transform(ids => ids.map(Number)),
  OWNER_NOTIFY_CHAT_ID: z.string().default('').transform(value => value.trim()).refine(value => value === '' || (/^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)))).transform(value => value === '' ? null : Number(value)),
  GENIE_REPLY_PAGE_LIMIT: integer(50, 1, 100),
  PORT: integer(3320, 1, 65535),
  DATABASE_PATH: z.string().min(1).default('./data/jobs.sqlite'),
  LEASE_SECONDS_DEFAULT: integer(300, 10, 86400),
  LEASE_SECONDS_MAX: integer(3600, 10, 86400),
  JOB_MAX_ATTEMPTS_DEFAULT: integer(3, 1, 10),
  REQUEST_TEXT_MAX_CHARS: integer(4000, 1, 100000),
  RESULT_MAX_CHARS: integer(16000, 1, 1000000),
  BODY_MAX_BYTES: integer(65536, 1024, 10485760),
  RATE_LIMIT_PER_MINUTE: integer(120, 1, 100000),
  OUTBOX_LEASE_SECONDS: integer(120, 10, 3600),
  OUTBOX_MAX_ATTEMPTS: integer(5, 1, 20),
  QUEUED_STALE_SECONDS: integer(900, 1, 604800),
  OUTBOX_STALE_SECONDS: integer(900, 1, 604800),
  RECONCILE_INTERVAL_SECONDS: integer(60, 0, 86400),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}).refine(config => config.LEASE_SECONDS_DEFAULT <= config.LEASE_SECONDS_MAX, { path: ['LEASE_SECONDS_DEFAULT'] })
  .refine(config => config.GENIE_TOKEN !== config.JOB_API_TOKEN, { path: ['GENIE_TOKEN'] })
  .refine(config => config.GENIE_ALLOWED_CHAT_IDS.every(id => config.ALLOWED_SOURCE_CHAT_IDS.includes(String(id))), { path: ['GENIE_ALLOWED_CHAT_IDS'] })
  .refine(config => config.GENIE_GROUP_CHAT_IDS.every(id => config.GENIE_ALLOWED_CHAT_IDS.includes(id)), { path: ['GENIE_GROUP_CHAT_IDS'] })
  .refine(config => config.GENIE_GROUP_CHAT_IDS.length === 0 || config.OWNER_NOTIFY_CHAT_ID !== null, { path: ['OWNER_NOTIFY_CHAT_ID'] })
  .refine(config => config.OWNER_NOTIFY_CHAT_ID === null || config.GENIE_ALLOWED_CHAT_IDS.includes(config.OWNER_NOTIFY_CHAT_ID), { path: ['OWNER_NOTIFY_CHAT_ID'] })
  .refine(config => config.OWNER_NOTIFY_CHAT_ID === null || !config.GENIE_GROUP_CHAT_IDS.includes(config.OWNER_NOTIFY_CHAT_ID), { path: ['OWNER_NOTIFY_CHAT_ID'] });

export type Config = z.infer<typeof schema>;
export class ConfigError extends Error {
  constructor(readonly fields: string[]) { super('設定が正しくありません'); }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new ConfigError([...new Set(parsed.error.issues.flatMap(issue => {
    const field = issue.path[0];
    return typeof field === 'string' && field in schema.shape ? [field] : [];
  }))].sort());
  return parsed.data;
}

import { z } from 'zod';

const integer = (fallback: number, min: number, max: number) => z.string().regex(/^\d+$/).default(String(fallback)).transform(Number).pipe(z.number().int().min(min).max(max));
const schema = z.object({
  JOB_API_TOKEN: z.string().min(32),
  ALLOWED_SOURCE_CHAT_IDS: z.string().transform(value => value.split(',').map(id => id.trim()).filter(Boolean)).refine(ids => ids.length > 0),
  HOST: z.string().min(1).default('127.0.0.1').refine(host => host !== '0.0.0.0' && host !== '::'),
  GENIE_HOST: z.enum(['127.0.0.1', '::1', 'localhost']).default('127.0.0.1'),
  GENIE_PORT: integer(3321, 1, 65535),
  GENIE_TOKEN: z.string().min(32),
  GENIE_ALLOWED_CHAT_IDS: z.string().transform(value => value.split(',').map(id => id.trim())).refine(ids => ids.length > 0 && ids.every(id => /^-?\d+$/.test(id) && Number.isSafeInteger(Number(id)))).transform(ids => ids.map(Number)),
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
}).refine(config => config.LEASE_SECONDS_DEFAULT <= config.LEASE_SECONDS_MAX)
  .refine(config => config.GENIE_TOKEN !== config.JOB_API_TOKEN)
  .refine(config => config.GENIE_ALLOWED_CHAT_IDS.every(id => config.ALLOWED_SOURCE_CHAT_IDS.includes(String(id))));

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error('設定が正しくありません');
  return parsed.data;
}

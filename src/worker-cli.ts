import { artifactUrls, artifactOmissionFlags } from './lib/artifact-urls.js';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { JobApiClient } from './worker/client.js';
import { createTailscaleNcTransport } from './worker/tailscale-nc.js';
import type { Transport } from './worker/transport.js';
import { completion } from './lib/reply-text.js';
import { prepareNotification, type NotificationFlags } from './worker/notification.js';
import { capabilitySchema } from './policy/family-policy.js';

const integer = (fallback: number, max: number) => z.string().regex(/^\d+$/).default(String(fallback)).transform(Number).pipe(z.number().int().positive().max(max));
const configSchema = z.object({
  JOB_API_TAILNET_HOST: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:-]*$/),
  JOB_API_PORT: integer(3320, 65535),
  JOB_API_TOKEN_FILE: z.string().min(1),
  TAILSCALE_BIN: z.string().min(1).default('tailscale'),
  JOB_API_TIMEOUT_MS: integer(15000, 2 ** 31 - 1),
});
const id = z.string().regex(/^J-\d{6,}$/);
const worker = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const lease = z.number().int().min(10).max(86400).optional();
const claim = z.strictObject({ worker_id: worker, lease_seconds: lease, job_types: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/)).optional() });
const tokenFields = { job_id: id, claim_token: z.string().min(1) };
const notify = z.object({ body: z.string().min(1) }).optional();
const commands = z.discriminatedUnion('command', [
  z.object({ command: z.literal('claim'), input: claim }),
  z.object({ command: z.literal('get'), input: z.strictObject({ job_id: id }) }),
  z.object({ command: z.literal('heartbeat'), input: z.strictObject({ ...tokenFields, lease_seconds: lease }) }),
  z.object({ command: z.literal('complete'), input: z.strictObject({ ...tokenFields, result: z.record(z.string(), z.unknown()), artifact_urls: artifactUrls.optional(), used_capabilities: z.array(capabilitySchema).optional(), notify }) }),
  z.object({ command: z.literal('fail'), input: z.strictObject({ ...tokenFields, error: z.strictObject({ code: z.string().regex(/^[A-Z0-9_]{1,64}$/), message: z.string().refine(value => [...value].length <= 1000) }), notify }) }),
  z.object({ command: z.literal('outbox'), input: z.strictObject({ worker_id: worker, lease_seconds: lease, outbox_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }) }),
]);
type UsageReason = 'INVALID_ARGUMENTS' | 'BAD_JSON' | 'STDIN_TOO_LARGE' | 'UNKNOWN_COMMAND' | 'MISSING_CONFIG' | 'INVALID_CONFIG' | 'TOKEN_FILE_MISSING' | 'TOKEN_FILE_UNREADABLE' | 'TOKEN_FILE_MODE' | 'TOKEN_TOO_SHORT' | 'TOKEN_HAS_WHITESPACE';
export async function runWorkerCli(argv: string[], env: NodeJS.ProcessEnv, deps: { transport?: Transport; stdin?: AsyncIterable<Uint8Array> } = {}): Promise<{ exitCode: number; output: string }> {
  const usage = (reason: UsageReason, detail: { fields?: string[]; missing?: string[] } = {}) => ({ exitCode: 2, output: JSON.stringify({ ok: false, error: 'USAGE_ERROR', reason, ...detail }) + '\n' });
  const noNotify = argv.includes('--no-notify');
  const args = argv.filter(arg => arg !== '--no-notify');
  if (args.length < 1 || args.length > 2 || argv.length - args.length > 1) return usage('INVALID_ARGUMENTS');
  if (!['claim', 'get', 'heartbeat', 'complete', 'fail', 'outbox'].includes(args[0] ?? '')) return usage('UNKNOWN_COMMAND');
  if (noNotify && args[0] !== 'complete' && args[0] !== 'fail') return usage('INVALID_ARGUMENTS');
  let input: unknown;
  try {
    let json = args[1];
    if (json === '-') {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of deps.stdin ?? process.stdin) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > 1024 * 1024) return usage('STDIN_TOO_LARGE');
        chunks.push(buffer);
      }
      json = Buffer.concat(chunks).toString('utf8');
    }
    input = json === undefined ? {} : JSON.parse(json);
  }
  catch { return usage('BAD_JSON'); }
  const parsedCommand = commands.safeParse({ command: args[0], input });
  if (!parsedCommand.success) return usage('INVALID_ARGUMENTS', { fields: [...new Set(parsedCommand.error.issues.map(issue => issue.path.join('.')))] });
  const command = parsedCommand.data;
  const parsedConfig = configSchema.safeParse(env);
  if (!parsedConfig.success) {
    const fields = [...new Set(parsedConfig.error.issues.map(issue => issue.path.join('.')))];
    const missing = fields.filter(field => env[field] === undefined || env[field] === '');
    return missing.length > 0 ? usage('MISSING_CONFIG', { missing }) : usage('INVALID_CONFIG', { fields });
  }
  const config = parsedConfig.data;
  let secret: string;
  try {
    const stat = statSync(config.JOB_API_TOKEN_FILE);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) return usage('TOKEN_FILE_MODE');
    secret = readFileSync(config.JOB_API_TOKEN_FILE, 'utf8').replace(/\n$/, '');
  } catch (error) {
    return usage(error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'TOKEN_FILE_MISSING' : 'TOKEN_FILE_UNREADABLE');
  }
  if (/\s/.test(secret)) return usage('TOKEN_HAS_WHITESPACE');
  if (secret.length < 32) return usage('TOKEN_TOO_SHORT');
  const client = new JobApiClient(deps.transport ?? createTailscaleNcTransport({ host: config.JOB_API_TAILNET_HOST, port: config.JOB_API_PORT, binary: config.TAILSCALE_BIN, timeoutMs: config.JOB_API_TIMEOUT_MS }), secret);
  try {
    let result;
    let flags: NotificationFlags & { artifact_urls_omitted?: number } = {};
    switch (command.command) {
      case 'claim': result = await client.claim(command.input); break;
      case 'get': result = await client.get(command.input.job_id); break;
      case 'heartbeat': { const { job_id, ...input } = command.input; result = await client.heartbeat(job_id, input); break; }
      case 'complete': {
        const { job_id, notify: providedNotify, ...input } = command.input;
        const summary = typeof input.result.summary === 'string' ? input.result.summary : '結果を保存しました。';
        const prepared = noNotify ? undefined : prepareNotification(providedNotify?.body, () => completion(job_id, summary, input.artifact_urls));
        const notification = prepared ? { notify: { body: prepared.body } } : {};
        flags = { ...prepared?.flags, ...artifactOmissionFlags(input.artifact_urls, prepared?.body) };
        result = await client.complete(job_id, { ...input, ...notification });
        break;
      }
      case 'fail': {
        const { job_id, notify: providedNotify, ...input } = command.input;
        const prepared = noNotify ? undefined : prepareNotification(providedNotify?.body, () => '');
        const notification = prepared ? { notify: prepared.body ? { body: prepared.body } : {} } : {};
        flags = prepared?.flags ?? {};
        result = await client.fail(job_id, { ...input, ...notification });
        break;
      }
      case 'outbox': result = await client.outbox(command.input); break;
    }
    const exitCode = result.ok ? 0 : result.unreachable ? 3 : 4;
    const output = JSON.stringify({ ...result, ...(result.ok ? flags : {}) }, (_key, value: unknown) => typeof value === 'string' ? value.replaceAll(secret, '[REDACTED]') : value);
    return { exitCode, output: output + '\n' };
  } catch {
    return { exitCode: 4, output: JSON.stringify({ ok: false, error: 'CLIENT_ERROR' }) + '\n' };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runWorkerCli(process.argv.slice(2), process.env);
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}

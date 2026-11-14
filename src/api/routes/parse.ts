import type { Context } from 'hono';
import type { z } from 'zod';
import { StoreError } from '../../store/errors.js';

export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result=schema.safeParse(value);
  if(!result.success) throw new StoreError('VALIDATION_ERROR');
  return result.data;
}
export async function body<T>(c:Context,schema:z.ZodType<T>):Promise<T> {
  let value:unknown;
  try {value=await c.req.json();} catch {throw new StoreError('INVALID_JSON');}
  return validate(schema,value);
}
export function jobId(c:Context):string { const id=c.req.param('id')??'';if(!/^J-\d{6,}$/.test(id))throw new StoreError('JOB_NOT_FOUND');return id; }
export function outboxId(c:Context):number { const id=c.req.param('id')??'';if(!/^[1-9]\d{0,15}$/.test(id)||!Number.isSafeInteger(Number(id)))throw new StoreError('OUTBOX_NOT_FOUND');return Number(id); }

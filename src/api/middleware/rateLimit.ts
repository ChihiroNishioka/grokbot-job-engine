import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Clock } from '../../lib/clock.js';
import { errorResponse } from './errors.js';

function connectionKey(c: Context): string {
  try { return getConnInfo(c).remote.address ?? 'local'; } catch { return 'local'; }
}
export function rateLimit(clock: Clock, limit: number, key: (c:Context)=>string = connectionKey): MiddlewareHandler {
  const windows = new Map<string,{start:number;count:number}>();
  return async (c,next)=> {
    const now=clock.now();
    const id=key(c);
    let window=windows.get(id);
    if(!window || now>=window.start+60000) {window={start:now,count:0};windows.set(id,window);}
    window.count+=1;
    if(window.count>limit) { c.header('Retry-After',String(Math.max(1,Math.ceil((window.start+60000-now)/1000))));return errorResponse(c,'RATE_LIMITED'); }
    await next();
  };
}

import {it,expect} from 'vitest';
import {token} from '../helpers/context.js';
import {setup,payload,genieToken} from './helpers.js';
it('G62 isolates app routes and credentials',async()=>{const c=setup();try{
 expect((await c.request('/jobs')).status).toBe(404);
 expect((await c.req('POST','/ingress/genie',payload())).status).toBe(404);
 expect((await c.req('GET','/genie/replies')).status).toBe(404);
 expect((await c.request('/ingress/genie',payload(),token)).status).toBe(401);
 expect((await c.req('GET','/jobs',undefined,{Authorization:`Bearer ${genieToken}`})).status).toBe(401);
 expect((await c.ingress.request('/healthz')).status).toBe(200);
}finally{c.close();}});
it('G62 ingress enforces authentication, rate limit and body bounds',async()=>{const c=setup({RATE_LIMIT_PER_MINUTE:'1'});try{expect((await c.ingress.request('/genie/replies')).status).toBe(401);const second=await c.request('/genie/replies');expect(second.status).toBe(429);c.clock.advance(60000);expect((await c.request('/genie/replies')).status).toBe(200);}finally{c.close();}const limited=setup({BODY_MAX_BYTES:'1024'});try{expect((await limited.request('/ingress/genie',payload({text:'x'.repeat(2000)}))).status).toBe(413);expect(limited.table('jobs')).toHaveLength(0);}finally{limited.close();}});

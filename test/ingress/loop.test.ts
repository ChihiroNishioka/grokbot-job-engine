import {it,expect} from 'vitest';
import {setup,payload} from './helpers.js';
it.each(['🧞‍♂️ 完了しました','🪔 🧞‍♂️ …','🧞 …','  🧞‍♂️…','\u200b🪔️ \u200b🧞…'])('G66 ignores bot reply %s',async(text)=>{const c=setup();try{expect((await c.request('/ingress/genie',payload({text}))).body).toEqual({status:'ignored',reason:'bot_reply'});expect(c.table('jobs')).toHaveLength(0);expect(c.table('delivery_outbox')).toHaveLength(0);}finally{c.close();}});
it.each(['','🪔',' \u200b🪔️  '])('G66 ignores empty %s',async(text)=>{const c=setup();try{expect((await c.request('/ingress/genie',payload({text}))).body).toEqual({status:'ignored',reason:'empty'});expect(c.table('jobs')).toHaveLength(0);}finally{c.close();}});

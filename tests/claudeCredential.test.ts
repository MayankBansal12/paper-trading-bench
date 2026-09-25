import {test,expect} from 'bun:test';
import {claudeCredential} from '../src/claude/credential.ts';
test('host subscription credential refuses expired or nearly expired access before inference',async()=>{
 for(const expiresAt of [0,1000,301000,NaN]) {
  const c=claudeCredential(()=>1000,async()=>({token:'host-only-fixture',expiresAt}));
  await expect(c.authorize(new AbortController().signal)).rejects.toThrow('BENCH_AUTH_PAUSE');
 }
 const c=claudeCredential(()=>1000,async()=>({token:'host-only-fixture',expiresAt:601000}));
 expect((await c.authorize(new AbortController().signal)).get('authorization')).toBe('Bearer host-only-fixture');
 const controller=new AbortController();controller.abort();
 await expect(c.authorize(controller.signal)).rejects.toThrow();
});

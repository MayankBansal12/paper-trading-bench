import {test,expect,beforeAll} from 'bun:test';
import {readFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dir,'..'),dir=resolve(root,'dist');
let summary:any;
beforeAll(async()=>{
 const p=Bun.spawn([process.execPath,'scripts/build-viewer.ts'],{cwd:root,stdout:'ignore',stderr:'pipe'});
 const [err,code]=await Promise.all([new Response(p.stderr).text(),p.exited]);
 if(code)throw Error(err);summary=await Bun.file(dir+'/data/summary.json').json();
},30_000);
test('published selection has all ten models and preserves invalid and uncommitted attempts',async()=>{
 expect(summary.models).toHaveLength(10);
 expect(summary.models[0].model).toBe('Opus 5');
 expect(summary.models[0].net_profit).toBe(32582.58);
 expect(summary.models[0].average_profit).toBe(8145.65);
 expect(summary.manifest).toMatchObject({accounted_days:2510,valid_days:2506,attempts:2578,fills:3191});
 for(const m of summary.models){
  expect(m.quarters).toHaveLength(4);
  const slug=m.model.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const a=await Bun.file(`${dir}/data/${slug}/attempts.json`).json();
  expect(a).toHaveLength(m.attempts);
  for(const q of m.quarters){const ds=await Bun.file(`${dir}/data/${slug}/${q.quarter}.json`).json();expect(ds).toHaveLength(q.days);expect(ds.at(-1).closing_portfolio.netWorth-150000).toBeCloseTo(q.net_profit,5);}
 }
 expect(summary.models.some((m:any)=>m.model==='Luna 5.6'||m.model.includes('Terra'))).toBe(false);
});
test('every built local page link resolves, including study and session anchors',async()=>{
 let count=0;
 for(const page of ['index.html','study.html','methodology.html']){
  const html=await readFile(`${dir}/${page}`,'utf8');
  expect(html).not.toContain('/home/');expect(html).not.toContain('{{PNL_TABLE}}');
  for(const match of html.matchAll(/href="([^"]+)"/g)){
   const href=match[1]!;if(/^(https?:|mailto:)/.test(href))continue;
   const [path,anchor]=href.split('#'),target=path||page;await access(resolve(dir,target));
   if(anchor?.startsWith('sessions/')){const [,model,date]=anchor.split('/');expect(summary.models.some((m:any)=>m.model.toLowerCase().replace(/[^a-z0-9]+/g,'-')===model&&m.quarters.some((q:any)=>date!>=q.start&&date!<=q.end))).toBe(true);}
   else if(anchor&&anchor!=='sessions'){const other=await readFile(resolve(dir,target),'utf8');expect(other).toContain(`id="${anchor}"`);}
   count++;
  }
 }
 expect(count).toBeGreaterThan(50);
});
test('build keeps journals escaped and labels accounting and sample limits',async()=>{
 const html=await readFile(dir+'/study.html','utf8');
 expect(html).toContain('not a compliance rate');
 expect(html).toContain('not forced to sell');
 expect(html).not.toMatch(/<script[^>]*>[^<]+/);
 const method=await readFile(dir+'/methodology.html','utf8');
 expect(method).toContain('post-result selection');expect(method).toContain('fresh attempts');
});

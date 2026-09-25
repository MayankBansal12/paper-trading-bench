// Build a portable static site from the same evidence used by scripts/analyze.py.
import {mkdir,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dir,'..'),out=join(root,'dist'),src=join(root,'results/current');
const read=async(name:string)=>JSON.parse(await readFile(join(src,name),'utf8'));
const manifest=await read('manifest.json'),metrics=await read('metrics.json');
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const money=(v:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v);
const style:Record<string,string>={
 'Astra 6':'Cautious confirmation entries, substantial cash, selective reductions.',
 'Sol 5.6':'Broad relative-strength screening and whole-position replacement.',
 'Sol 6':'Broad screening, more additions, and greater concentration in retained winners.',
 'Opus 5':'Staged purchases and discretionary risk rules, with more exits in later quarters.',
 'Opus 5.5':'A broadly invested core, many HOLDs, and occasional risk reductions.',
 'Luna 6':'A retained core with frequent additions and partial trims.',
 'GLM 5.3 Flash':'Persistent baskets, selective additions, and changing deployment conditions.',
 'Sonnet 5':'Selected core holdings, small additions on weakness, and more cash later.',
 'Muse Spark 1.3':'Long waits followed by larger, concentrated purchases.',
 'DeepSeek 4.1 Flash':'Frequent history queries, active rotation and flexible price thresholds.'};
await rm(out,{recursive:true,force:true});await mkdir(join(out,'data'),{recursive:true});
const days:any[]=[];
for(const f of manifest.files){
 const path=join(src,f.path),bytes=await readFile(path);
 if(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')!==f.sha256)throw Error('Evidence checksum mismatch: '+f.path);
 const rows=bytes.toString().trim().split('\n').map(l=>JSON.parse(l));
 if(rows.length!==f.records)throw Error('Evidence count mismatch: '+f.path);
 if(f.kind==='sessions')days.push(...rows);
 const target=join(out,'data',f.path.replace(/\.jsonl$/,'.json'));await mkdir(resolve(target,'..'),{recursive:true});await writeFile(target,JSON.stringify(rows));
}
const models=metrics.models.map((m:any)=>{
 const qs=metrics.quarters.filter((q:any)=>q.model===m.model).map((q:any)=>{const ds=days.filter(d=>d.model===m.model&&d.quarter===q.quarter);return {...q,start:ds[0].date,end:ds.at(-1).date};});
 const sum=(key:string)=>qs.reduce((s:number,q:any)=>s+q[key],0);
 const net=Math.round(sum('net_profit')*100)/100;
 return {...m,quarters:qs,net_profit:net,average_profit:Math.round(net*25+1e-7)/100,mean_twr:sum('twr_pct')/4,realized:sum('realized'),unrealized:sum('unrealized'),dividend_income:sum('dividend_income'),winning_sales:sum('winning_sales'),losing_sales:sum('losing_sales'),worst_drawdown:Math.max(...qs.map((q:any)=>q.max_drawdown_pct)),average_calls:m.calls_per_valid_day.mean,common_first:Object.entries(m.first_tool).sort((a:any,b:any)=>b[1]-a[1])[0]?.[0],style:style[m.model]};
}).sort((a:any,b:any)=>b.net_profit-a.net_profit);
await writeFile(join(out,'data/summary.json'),JSON.stringify({models,quarters:['2025-Q2','2025-Q3','2025-Q4','2026-Q1'],manifest}));
for(const file of ['manifest.json','provenance.json','metrics.json','rule-review.json','memory-audit.json','price-opportunities.json'])await cp(join(src,file),join(out,'data',file));
// Public JSON paths differ from the Git JSONL paths; retain both in the download index.
await writeFile(join(out,'data/manifest.json'),JSON.stringify({...manifest,files:manifest.files.map((f:any)=>({...f,repository_path:'results/current/'+f.path,download:f.path.replace(/\.jsonl$/,'.json'),sha256_applies_to:'repository JSONL bytes; JSON download is a derived array'}))},null,2));
for(const f of ['index.html','style.css'])await cp(join(root,'web',f),join(out,f));
const bundle=await Bun.build({entrypoints:[join(root,'web/app.ts')],target:'browser',outdir:out,minify:true});if(!bundle.success)throw new AggregateError(bundle.logs,'Viewer build failed');
const template=await readFile(join(out,'index.html'),'utf8');
const page=async(name:string,title:string,body:string)=>{
 let html=template.replace('<title>Paper Trading Bench</title>',`<title>${esc(title)} · Paper Trading Bench</title>`).replace(/<main id="main">[\s\S]*?<\/main>/,`<main id="main" class="study">${body}</main>`).replace('<script type="module" src="app.js"></script>','').replace(' aria-current="page"','');
 html=html.replace(`href="${name}.html"`,`href="${name}.html" aria-current="page"`);await writeFile(join(out,name+'.html'),html);
};
const table=`<div class="table-wrap pnl"><table><thead><tr><th>Model</th><th>Realized</th><th>Unrealized</th><th>Dividends</th><th>Net profit</th></tr></thead><tbody>${models.map((m:any)=>`<tr><td>${esc(m.model)}</td>${['realized','unrealized','dividend_income','net_profit'].map(k=>`<td>${money(m[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const pairs:[string,string,string][]=[['astra','Astra 6','2025-05-08'],['opus','Opus 5','2025-04-09'],['sol','Sol 5.6','2025-09-26'],['deepseek','DeepSeek 4.1 Flash','2025-12-24'],['astra-hold','Astra 6','2025-04-10'],['opus-hold','Opus 5','2025-04-10'],['luna','Luna 6','2025-04-10'],['sonnet','Sonnet 5','2025-09-04'],['sol-workflow','Sol 5.6','2025-09-30'],['deepseek-workflow','DeepSeek 4.1 Flash','2025-09-10'],['sol6-style','Sol 6','2025-09-26'],['muse-style','Muse Spark 1.3','2025-12-30'],['glm-style','GLM 5.3 Flash','2025-11-26'],['opus55-style','Opus 5.5','2025-07-21']];
const cards=pairs.map(([id,m,date])=>{const d=days.find(d=>d.model===m&&d.date===date);if(!d?.journal?.text)throw Error('Missing study evidence '+id);return `<details id="case-${id}" class="case"><summary>${esc(m)} · ${date}</summary><p>${esc(d.tool_calls.map((t:any)=>t.name).join(' → '))}</p><div class="journal">${esc(d.journal.text)}</div><p>${d.fills.map((f:any)=>`${esc(f.side)} ${money(f.notional)} ${esc(f.ticker)}`).join(' · ')||'No executed trades.'}</p><a href="index.html#sessions/${slug(m)}/${date}">Open portfolio, receipts and all attempts →</a><pre>Original day hash: ${esc(d.day_hash)}</pre></details>`;}).join('');
const md=await readFile(join(root,'docs/STUDY.md'),'utf8');
await page('study','Investment behavior',Bun.markdown.html(md.replace(/<!-- pnl-table -->[\s\S]*?<!-- \/pnl-table -->/,table).replaceAll('https://mayankbansal12.github.io/paper-trading-bench/study.html#','#'))+`<h2 id="evidence">Selected original sessions</h2><p>Examples explain the findings; they are not an unbiased estimate of rule compliance.</p>${cards}<details><summary>Evidence coverage and accounting</summary><p>The comparison uses 2,510 days, 2,506 valid decisions, 3,191 fills and 2,578 selected attempts. All 40 quarter accounts reconcile in independent float and Decimal calculations. Original event-chain verification was performed during extraction; this site checks compact file hashes and recalculates accounting, not a new pinned-runtime replay.</p><p>Automatic context was directly checked for 1,293 attempts across five models. For the others, the matching pinned protocol and committed sequence establish the preload policy; this does not prove the model used its journals. Query coverage differs by model and is displayed with denominators.</p><p><a href="data/rule-review.json">30 purposive rule cases</a> · <a href="data/price-opportunities.json">Price-response denominators</a> · <a href="data/memory-audit.json">Memory coverage</a> · <a href="methodology.html#selection">Selection history</a></p></details>`);
const method=await readFile(join(root,'docs/METHODOLOGY.md'),'utf8');
await page('methodology','Methodology',Bun.markdown.html(method)+`<h2 id="selection">Selected runs</h2><p>Snapshot: September 25, 2026. Luna 6 replaces Luna 5.6; incomplete Terra and earlier failed cohorts are excluded from the leaderboard. Historical evidence is preserved separately.</p>${manifest.exceptions.map((x:any)=>`<h3>${esc(x.model)}</h3><p>${esc(x.note)}</p>`).join('')}<p><a href="data/manifest.json">Compact evidence manifest</a> · <a href="data/provenance.json">Exact run identities</a> · <a href="https://github.com/MayankBansal12/paper-trading-bench/blob/main/docs/SETUP.md">Setup and replication</a></p>`);
await writeFile(join(out,'.nojekyll'),'');console.log(`Built ${models.length} models / ${days.length} sessions in dist/`);

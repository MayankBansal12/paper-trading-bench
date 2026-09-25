"""Recompute the published metrics from compact evidence. Use --check to verify without writes.
No inference, source edits, benchmark replay, or original-artifact writes.
"""
from pathlib import Path
from collections import defaultdict, Counter
from decimal import Decimal as Dec, ROUND_HALF_UP
import json, math, statistics as st, hashlib
import sys
ROOT=Path(__file__).resolve().parents[1]
O=ROOT/'results/current'
MANIFEST=json.loads((O/'manifest.json').read_text())
CHECK='--check' in sys.argv
def jl(p):return [json.loads(l) for l in p.open()]
def dump(n,x):
 target=O/n
 if CHECK:
  assert json.loads(target.read_text())==x, 'Stale derived result: '+n
 else:target.write_text(json.dumps(x,indent=2,ensure_ascii=False,allow_nan=False)+'\n')
def rq(v,n=6):return float(Dec(str(v)).quantize(Dec(10)**-n,rounding=ROUND_HALF_UP))
def stat(v):
 v=sorted(v)
 return {'n':len(v),'mean':st.mean(v) if v else None,'median':st.median(v) if v else None,'p90':v[max(0,math.ceil(.9*len(v))-1)] if v else None,'max':max(v) if v else None}
def issuer(t):return 'Alphabet' if t in ['GOOG','GOOGL'] else t
D=[d for f in MANIFEST['files'] if f['kind']=='sessions' for d in jl(O/f['path'])]
A=[a for f in MANIFEST['files'] if f['kind']=='attempts' for a in jl(O/f['path'])]
for f in MANIFEST['files']:
 assert hashlib.sha256((O/f['path']).read_bytes()).hexdigest()==f['sha256'], 'Input checksum: '+f['path']
D.sort(key=lambda d:(d['model'],d['date']));models=sorted({d['model'] for d in D});checks=[]
def check(label,v):
 if not v:raise AssertionError(label)
 checks.append(label)
F=[];Q=[];MD=[];S=[];flow=[];cash_events=[];all_daily=[]
for m in models:
 ds=[d for d in D if d['model']==m];ats=[a for a in A if a['model']==m];vd=[d for d in ds if d['session_class']!='invalid'];check(m+'251days',len(ds)==251)
 for q in sorted({d['quarter'] for d in ds}):
  qs=[d for d in ds if d['quarter']==q];book={};cash=50000.;realized=0.;income=0.;cash_residual=0.;cashround=0.;divmodel=0.;observed_runtime_basis=[];retd=[];prev_eq=50000;index=peak=1.;dd=0.;qf=[];netdeposit=0.;cn=Counter();weights=[];hhi=[];maxi=0.;held=defaultdict(list);historyseen=set();qcash=[];qunreal=[];corps=[]
  for i,d in enumerate(qs):
   netdeposit+=d['contribution'];cash+=d['contribution'];dayincome=0;deltasp=[]
   for ca in sorted(d['corporate_actions'],key=lambda a:a['type']=='dividend'):
    t=ca['ticker'];h=book.get(t)
    if not h:continue
    if ca['type']=='split':
     oldunits=h['units'];h['units']=rq(oldunits*ca['ratio']);deltasp.append({'ticker':t,'oldunits':oldunits,'newunits':h['units'],'ratio':ca['ratio'],'cost_preserved':h['cost']})
    elif ca['type']=='dividend':
     amt=rq(h['units']*ca['amount'],2);income+=amt;dayincome+=amt;cash+=amt
     corps.append({'date':d['date'],'ticker':t,'type':'dividend','units':h['units'],'per_share':ca['amount'],'cash':amt})
   # Check independently reconstructed units, without using rounded avgCost as the economic basis.
   op=d['opening_portfolio'];cp=d['closing_portfolio']
   for t,h in op['holdings'].items():check(m+q+d['date']+t+' opening units',t in book and abs(book[t]['units']-h['units'])<1.01e-6)
   check(m+q+d['date']+' opening ticker set',set(book)==set(op['holdings']))
   opening_cash_residual=op['cash']-cash;cash_residual+=opening_cash_residual;cash=op['cash']
   if abs(opening_cash_residual)>.005:cash_events.append({'model':m,'quarter':q,'date':d['date'],'stage':'opening','residual':opening_cash_residual})
   current_unreal=sum(h['value']-book[t]['cost'] for t,h in op['holdings'].items())
   for fi,f in enumerate(d['fills']):
    t=f['ticker'];n=f['notional'];u=f['units'];h=book.get(t);before=h['units'] if h else 0;oldcost=h['cost'] if h else 0
    if f['side']=='BUY':
     typ='add' if before>0 else 'initial' if i==0 else 'reentry' if t in historyseen else 'later'
     book[t]={'units':rq(before+u),'cost':oldcost+n};cash-=n;gain=None;allocated=None
    else:
     check(m+q+d['date']+t+' sell holdings',h is not None and u<=before+1e-6)
     remaining=rq(before-u);typ='exit' if remaining<=0 else 'trim';allocated=oldcost if typ=='exit' else oldcost*u/before;gain=n-allocated;realized+=gain;cash+=n
     if typ=='exit':del book[t]
     else:book[t]={'units':remaining,'cost':oldcost-allocated}
    historyseen.add(t);cn[typ]+=1
    # Observed price-vs-rounded-average-cost classification is a DIFFERENT measure.
    observed_gain=f.get('observed_cost_gain_pct');runtime_gain=f.get('realized_mark_vs_avg_cost')
    fr={'model':m,'quarter':q,'date':d['date'],'fill_index':fi,'ticker':t,'issuer':issuer(t),'side':f['side'],'type':typ,'units':u,'fill_price':f['price'],'actual_cash_notional':n,'unrounded_units_times_price':u*f['price'],'cash_rounding_delta':n-u*f['price'],'allocated_historical_cost':allocated,'realized_pnl':gain,'pretrade_vs_rounded_avg_cost_pct':observed_gain,'units_before':before,'units_after':book.get(t,{}).get('units',0),'day_hash':d['day_hash'],'day_path':d['day_path']}
    qf.append(fr);F.append(fr)
   endres=cp['cash']-cash;cash_residual+=endres;cash=cp['cash']
   if abs(endres)>.005:cash_events.append({'model':m,'quarter':q,'date':d['date'],'stage':'closing','residual':endres})
   check(m+q+d['date']+' closing tickers',set(book)==set(cp['holdings']))
   for t,h in cp['holdings'].items():check(m+q+d['date']+t+' closing units',abs(book[t]['units']-h['units'])<1.01e-6)
   unrl=sum(h['value']-book[t]['cost'] for t,h in cp['holdings'].items());profit=cp['netWorth']-50000-netdeposit
   check(m+q+d['date']+' pnl reconciliation',abs(realized+unrl+income+cash_residual-profit)<.001)
   cashpct=cp['cash']/cp['netWorth']*100;qcash.append(cashpct)
   r=cp['netWorth']/(prev_eq+d['contribution'])-1;prev_eq=cp['netWorth'];index*=1+r;peak=max(peak,index);dd=min(dd,(index/peak-1)*100);retd.append(r)
   iv=defaultdict(float)
   for t,h in cp['holdings'].items():iv[issuer(t)]+=h['value']
   hhi.append(sum((v/cp['holdingsValue'])**2 for v in iv.values()) if cp['holdingsValue'] else None)
   largest=max(iv.values(),default=0)/cp['netWorth']*100;maxi=max(maxi,largest)
   for t,v in iv.items():held[t].append(v/cp['netWorth']*100)
   cn[d['session_class']]+=1
   rec={'model':m,'quarter':q,'date':d['date'],'cash_pct':cashpct,'largest_issuer_pct':largest,'hhi':hhi[-1],'issuer_weights':{t:v/cp['netWorth']*100 for t,v in iv.items()},'cumulative_realized':realized,'unrealized':unrl,'cumulative_income':income,'cash_residual':cash_residual,'profit':profit}
   all_daily.append(rec)
  sells=[f for f in qf if f['side']=='SELL'];wins=[f for f in sells if f['realized_pnl']>.005];loss=[f for f in sells if f['realized_pnl']<-.005]
  qr={'model':m,'quarter':q,'days':len(qs),'valid':sum(d['session_class']!='invalid' for d in qs),'counts':dict(cn),'mean_cash_pct':st.mean(qcash),'mean_hhi':st.mean([h for h in hhi if h is not None]),'max_issuer_pct':maxi,'max_drawdown_pct':-dd,'daily_volatility_pct':st.stdev(retd)*100,'twr_pct':(index-1)*100,'realized':realized,'realized_positive':sum(f['realized_pnl'] for f in wins),'realized_negative':sum(f['realized_pnl'] for f in loss),'unrealized':unrl,'dividend_income':income,'unexplained_cash_effect':cash_residual,'net_profit':profit,'pnl_residual':profit-realized-unrl-income-cash_residual,'sell_proceeds':sum(f['actual_cash_notional'] for f in sells),'sale_cost_allocated':sum(f['allocated_historical_cost'] for f in sells),'winning_sales':len(wins),'losing_sales':len(loss),'flat_sales':len(sells)-len(wins)-len(loss),'median_fill_pct':st.median(f['notional_pct_opening_equity'] for d in qs for f in d['fills']),'gross_turnover_pct':st.mean(d['turnover_pct'] for d in qs),'favorites':sorted([{'issuer':t,'mean_weight':sum(v)/len(qs),'held_days':len(v)} for t,v in held.items()],key=lambda f:-f['mean_weight'])[:5],'corporate_income_events':corps,'ending_cost_basis':book}
  Q.append(qr)
 # Tool stats: all attempts and valid committed decision attempts shown separately.
 calls=Counter(t['name'] for d in vd for t in d['tool_calls']);atcalls=Counter()
 for a in ats:atcalls.update(a['query_tools'])
 jc=[sum(t['name']=='journal' for t in d['tool_calls']) for d in vd]
 ja=[a['query_tools'].get('journal',0) for a in ats]
 duplicates=[];breadth=[];lookbacks=[]
 for d in vd:
  seen=Counter();secs=set();seq=[]
  for t in d['tool_calls']:
   tn=t['name'];arg=t['arguments'];seq.append(tn)
   if tn in ('price_history','market_snapshot','journal'):
    k=json.dumps([tn,arg],sort_keys=True);seen[k]+=1
   if tn=='price_history':lookbacks.append(arg.get('lookback'))
  for r in d['tool_receipts']:
   if not r['is_error']:secs.update(r.get('securities',{}))
  breadth.append(len(secs));dup=sum(max(0,n-1) for n in seen.values());duplicates.append(dup)
  if dup:flow.append({'model':m,'date':d['date'],'exact_repeated_query_calls':dup,'sequence':seq})
 bdm=[x for x in all_daily if x['model']==m];fav=defaultdict(float);heldc=Counter()
 for d in bdm:
  for t,w in d['issuer_weights'].items():fav[t]+=w/251;heldc[t]+=1
 metrics={'model':m,'valid_days':len(vd),'attempts':len(ats),'uncommitted_attempts':sum(not a['committed'] for a in ats),'retried_dates':len({a['date'] for a in ats if a['attempt']>1}),'journal_calls_valid':sum(jc),'journal_days':sum(n>0 for n in jc),'journal_calls_per_valid_day':sum(jc)/len(vd),'journal_calls_all_attempts':sum(ja),'journal_attempts':sum(n>0 for n in ja),'journal_calls_per_attempt':sum(ja)/len(ats),'calls_valid':dict(calls),'calls_all_attempts':dict(atcalls),'calls_per_valid_day':stat([len(d['tool_calls']) for d in vd]),'calls_per_attempt':stat([a['tool_calls'] for a in ats]),'model_turns_per_valid_day':stat([d['usage']['turns'] for d in vd if d['usage'].get('turns') is not None]),'inference_requests_per_attempt':stat([a['inference_requests'] for a in ats]),'first_tool':dict(Counter(d['tool_calls'][0]['name'] for d in vd if d['tool_calls'])),'only_submit_days':sum([t['name'] for t in d['tool_calls']]==['submit_day'] for d in vd),'valid_tool_errors':sum(r['is_error'] for d in vd for r in d['tool_receipts']),'all_attempt_tool_errors':sum(a['tool_errors'] for a in ats),'execution_rejections':sum(len(d['failed_orders']) for d in ds),'duplicate_query_calls':sum(duplicates),'duplicate_query_days':sum(n>0 for n in duplicates),'received_query_breadth':stat(breadth),'lookback_arguments':dict(Counter(str(v) for v in lookbacks)),'favorites':sorted([{'issuer':t,'weight':w,'held_days':heldc[t]} for t,w in fav.items()],key=lambda x:-x['weight'])[:5],'mean_cash_pct':st.mean(x['cash_pct'] for x in bdm),'max_issuer_pct':max(x['largest_issuer_pct'] for x in bdm),'mean_hhi':st.mean(x['hhi'] for x in bdm if x['hhi'] is not None),'gross_turnover':st.mean(d['turnover_pct'] for d in ds),'traded_days':sum(d['session_class']=='traded' for d in ds),'hold_days':sum(d['session_class']=='explicit_hold' for d in ds),'fills':sum(len(d['fills']) for d in ds),'attempt_outcomes':dict(Counter(a['outcome'] for a in ats)),'strategy_quarter_coverage':len([q for q in Q if q['model']==m])}
 MD.append(metrics)
 # Fixed definitions, all execution observations strictly at/before the decision cutoff.
 for kind in ['initial','later','reentry','add','trim','exit']:
  fs=[f for f in F if f['model']==m and f['type']==kind];cover=[]
  dm={d['date']:d for d in ds}
  for f in fs:
   d=dm[f['date']];raw=d['fills'][f['fill_index']];ob=raw.get('observed') or {}
   if ob.get('last_date'):check(m+f['date']+' signal cutoff',ob['last_date']<=d['observation_date'])
   cover.append(ob)
  cov20=[o for o in cover if o.get('return_20d_pct') is not None];cov1=[o for o in cover if o.get('return_1d_pct') is not None];covhigh=[o for o in cover if o.get('high_close_20') is not None and o.get('close') is not None]
  # Definition: >= highest of supplied latest 20 closes (ties allowed), not an all-time or intraday high.
  S.append({'model':m,'type':kind,'fills':len(fs),'covered_1day':len(cov1),'down_1day':sum(o['return_1d_pct']<0 for o in cov1),'up_1day':sum(o['return_1d_pct']>0 for o in cov1),'covered_20day_return':len(cov20),'negative_20day_return':sum(o['return_20d_pct']<0 for o in cov20),'positive_20day_return':sum(o['return_20d_pct']>0 for o in cov20),'covered_20close_high':len(covhigh),'at_20close_high':sum(o['close']>=o['high_close_20']-1e-8 for o in covhigh),'covered_observed_basis':sum(f['pretrade_vs_rounded_avg_cost_pct'] is not None for f in fs),'observed_loss_count':sum(f['pretrade_vs_rounded_avg_cost_pct'] is not None and f['pretrade_vs_rounded_avg_cost_pct']<0 for f in fs),'realized_gain_count':sum(f['realized_pnl'] is not None and f['realized_pnl']>.005 for f in fs),'realized_loss_count':sum(f['realized_pnl'] is not None and f['realized_pnl']<-.005 for f in fs),'realized_gain_dollars':sum(f['realized_pnl'] for f in fs if f['realized_pnl'] is not None and f['realized_pnl']>.005),'realized_loss_dollars':sum(f['realized_pnl'] for f in fs if f['realized_pnl'] is not None and f['realized_pnl']<-.005),'realized_total':sum(f['realized_pnl'] or 0 for f in fs),'sell_proceeds':sum(f['actual_cash_notional'] for f in fs if f['side']=='SELL')})
dump('metrics.json',{'models':MD,'quarters':Q,'signals':S,'definition':'Perpetual weighted-average historical CASH cost; buy cash debits capitalize cost, partial sales allocate proportional cost, splits preserve total cost, dividends are separate income. Runtime rounded avgCost is used only for pretrade classification. Quarter-end remaining basis stays unrealized.','checks':len(checks),'all_passed':True,'cash_reconciliation_events':cash_events,'source_inputs':{f['path']:f['sha256'] for f in MANIFEST['files']}})

print('models',len(models),'days',len(D),'fills',len(F),'quarters',len(Q),'checks',len(checks),'cash anomalies',len(cash_events))
for m in MD:
 q=[q for q in Q if q['model']==m['model']];print(m['model'],'journal',m['journal_calls_valid'],'days',m['journal_days'],'calls',m['calls_per_valid_day'],'P&L',{k:round(sum(x[k] for x in q),2) for k in ['realized','unrealized','dividend_income','unexplained_cash_effect','net_profit']})

# Covered ticker-day price responses; coverage is not a causal attribution.
P=[]
for m in sorted({d['model'] for d in D}):
 ds=sorted([d for d in D if d['model']==m],key=lambda d:d['date']);v=[d for d in ds if d['session_class']!='invalid'];c=Counter();dayscovered=Counter();sample=[];expected=Counter();qs=[]
 for q in sorted({d['quarter'] for d in ds}):
  n=0
  for d in [d for d in ds if d['quarter']==q]:
   if d['session_class']!='invalid':expected[min(n,3)]+=1;n+=1
 for d in v:
  obs={}
  for r in d['tool_receipts']:
   if r['is_error']:continue
   for t,o in r.get('securities',{}).items():
    if o.get('n_bars',0)>=obs.get(t,{}).get('n_bars',0):obs[t]={**o,'receipt_id':r.get('receipt',{}).get('id'),'receipt_hash':r.get('receipt',{}).get('resultHash')}
  dayflags=set()
  for t,o in obs.items():
   if o.get('last_date'):assert o['last_date']<=d['observation_date']
   side={f['side'] for f in d['fills'] if f['ticker']==t};action='BOTH' if len(side)==2 else next(iter(side)) if side else 'FAILED' if any(f['ticker']==t for f in d['failed_orders']) else 'NO FILL'
   flags=[]
   if o.get('return_1d_pct') is not None:
    flags.append('1d_covered')
    if o['return_1d_pct']<=-3:flags.append('down_at_least_3pct_1d')
    if o['return_1d_pct']>=3:flags.append('up_at_least_3pct_1d')
   if o.get('return_20d_pct') is not None:
    flags.append('20d_covered')
    if o['return_20d_pct']<0:flags.append('negative_20d')
   if o.get('high_close_20') is not None and o.get('close') is not None:
    flags.append('20close_high_covered')
    if o['close']>=o['high_close_20']-1e-8:flags.append('at_20close_high')
   for flag in flags:c[flag+'|'+action]+=1;dayflags.add(flag)
  for f in dayflags:dayscovered[f]+=1
 rows=[]
 for flag in sorted(dayscovered):
  counts={action:c[flag+'|'+action] for action in ['BUY','SELL','BOTH','NO FILL','FAILED']};rows.append({'condition':flag,'covered_model_days':dayscovered[flag],'queried_ticker_days':sum(counts.values()),'response':counts})
 P.append({'model':m,'rows':rows})

dump('price-opportunities.json',P)

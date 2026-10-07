"""Independent Decimal accounting checks against the published float ledger."""
from pathlib import Path
from decimal import Decimal as N, ROUND_HALF_UP
from collections import defaultdict,Counter
import json,hashlib,csv
O=Path(__file__).resolve().parents[1]/'results/current'
def jl(p):return [json.loads(l) for l in p.open()]
def num(x):return N(str(x))
def quant(x,n):return x.quantize(N(10)**-n,rounding=ROUND_HALF_UP)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
manifest=json.loads((O/'manifest.json').read_text())
days=[d for f in manifest['files'] if f['kind']=='sessions' for d in jl(O/f['path'])]
metrics=json.loads((O/'metrics.json').read_text());qref={(q['model'],q['quarter']):q for q in metrics['quarters']};groups=defaultdict(list)
for d in days:groups[d['model'],d['quarter']].append(d)
results=[];classification=defaultdict(Counter);signal_checks=0;closechecks=0
for (m,q),ds in sorted(groups.items()):
 units={};basis={};cash=N(50000);funding=N(50000);realized=N(0);income=N(0)
 for d in sorted(ds,key=lambda d:d['date']):
  cash+=num(d['contribution']);funding+=num(d['contribution'])
  for c in sorted(d['corporate_actions'],key=lambda c:c['type']=='dividend'):
   t=c['ticker']
   if t not in units:continue
   if c['type']=='split':units[t]=quant(units[t]*num(c['ratio']),6)
   if c['type']=='dividend':v=quant(units[t]*num(c['amount']),2);income+=v;cash+=v
  assert abs(cash-num(d['opening_portfolio']['cash']))<N('.0001')
  for f in d['fills']:
   t=f['ticker'];u=num(f['units']);n=num(f['notional']);ob=f.get('observed') or {}
   if ob.get('last_bar') and ob.get('previous_bar') and ob.get('return_1d_pct') is not None:
    assert abs((ob['last_bar']['close']/ob['previous_bar']['close']-1)*100-ob['return_1d_pct'])<1e-7;signal_checks+=1
   if f['side']=='BUY':units[t]=quant(units.get(t,N(0))+u,6);basis[t]=basis.get(t,N(0))+n;cash-=n
   else:
    cost=basis[t]*u/units[t] if u<units[t] else basis[t];gain=n-cost;realized+=gain;cash+=n;units[t]=quant(units[t]-u,6);basis[t]-=cost
    if units[t]==0:del units[t];del basis[t]
    og=f.get('observed_cost_gain_pct');classification[m]['sells']+=1
    if og is not None:
     classification[m]['pretrade_covered']+=1
     avg=d['opening_portfolio']['holdings'].get(t,{}).get('avgCost')
     if avg and ob.get('close') is not None:
      assert abs((ob['close']/avg-1)*100-og)<1e-6;classification[m]['pretrade_formula_checked']+=1
     sign='loss' if gain<N('-.005') else 'profit' if gain>N('.005') else 'flat';psign='loss' if og<0 else 'profit' if og>0 else 'flat'
     classification[m]['pretrade_'+psign+'_execution_'+sign]+=1
  cp=d['closing_portfolio'];assert set(cp['holdings'])==set(units)
  for t,h in cp['holdings'].items():assert abs(num(h['units'])-units[t])<N('.0000011')
  assert abs(cash-num(cp['cash']))<N('.0001')
  unreal=sum((num(h['value'])-basis[t] for t,h in cp['holdings'].items()),N(0));profit=num(cp['netWorth'])-funding
  assert abs(realized+unreal+income-profit)<N('.000001');closechecks+=1
 row={'model':m,'quarter':q,'realized':float(realized),'unrealized':float(unreal),'dividend_income':float(income),'net_profit':float(profit),'cash_residual':float(cash-num(cp['cash']))}
 for k in ['realized','unrealized','dividend_income','net_profit']:assert abs(row[k]-qref[m,q][k])<.000001
 results.append(row)

assert closechecks==manifest['accounted_days']
print(f'Independent Decimal ledger: {closechecks} days / {len(results)} quarters reconcile')

ix={(d['model'],d['date']):d for d in days}
rules=json.loads((O/'rule-review.json').read_text())
for case in rules['cases']:
 a=ix[case['model'],case['declared']];b=ix[case['model'],case['response']]
 assert case['exact_prior_quote'] in a['journal']['text']
 assert a['day_hash']==case['prior_day_hash'] and b['day_hash']==case['response_day_hash']
print(f"All {len(rules['cases'])} editorial rule cases match their source journals")

# Full recorded opening contexts are present for both October imports. Recheck
# the actual notes, including failed attempts, rather than merely their counts.
context_checks=0
for model in ['Sol 6.1','Sonnet 5.5']:
 files=[f for f in manifest['files'] if f['model']==model and f['kind']=='attempts']
 attempts=[a for f in files for a in jl(O/f['path'])]
 for a in attempts:
  prior=sorted([d for d in days if d['model']==model and d['quarter']==a['quarter'] and d['date']<a['date'] and d['status']=='completed'],key=lambda d:d['date'])
  ctx=a['opening_journal_context']
  assert ctx['recent_journals']==[d['journal'] for d in prior[-3:][::-1]]
  assert ctx['committed_journal_entries']==len(prior)
  context_checks+=1
assert context_checks==510
print(f'{context_checks} imported opening contexts match prior committed journals')

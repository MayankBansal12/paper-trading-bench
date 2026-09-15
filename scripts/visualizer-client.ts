// Embedded verbatim in the viewer; no framework or build step is required.
export const CLIENT = String.raw`
var state = { runs: [], cohorts: [], model: null, quarter: null, detail: null, refreshing: false };
function fmt(n, d) { return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d === undefined ? 0 : d }); }
function pct(n) { return n == null || !Number.isFinite(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function dollars(n) { return n == null ? '—' : (n >= 0 ? '+$' : '−$') + fmt(Math.abs(n), 2); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
async function api(path) { var r = await fetch(path); if (!r.ok) throw new Error(await r.text()); return r.json(); }
function kpi(k, v, note, cls) {
  return '<div class="kpi"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + esc(v) + '</div><div class="d">' + esc(note) + '</div></div>';
}
function quarterStats(r) {
  var last = r.days[r.days.length - 1];
  return { principal: r.funding.totalPrincipal, netWorth: last ? last.netWorth : null,
    profit: r.funding.netProfit, profitPct: r.funding.returnOnPrincipalPct, twr: r.funding.timeWeightedReturnPct,
    cashPct: last && last.netWorth ? last.cash / last.netWorth * 100 : null };
}
function pickModel(id) { closeModal(); state.model = id; state.quarter = null; render(); }
function pickQuarter(id, runId) { closeModal(); state.model = id; state.quarter = runId; render(); }
function renderSidebar() {
  var el = document.getElementById('sidebar');
  if (!state.cohorts.length) { el.innerHTML = '<div class="loading">No runs yet</div>'; return; }
  el.innerHTML = state.cohorts.map(function(g) {
    var runs = state.runs.filter(function(r) { return r.cohortId === g.id; });
    return '<div class="model"><button class="model-btn' + (state.model === g.id ? ' active' : '') + '" data-model="' + g.id + '">' +
      '<div class="nm">' + esc(g.name) + '</div><div class="pv">' + esc(g.provider) + '</div><div class="cohort">' + esc(g.cohort) + '</div>' +
      '<div class="ms">' + g.committed + ' / ' + g.expected + ' sessions</div><div class="bar"><i style="width:' +
      (g.expected ? Math.min(100, g.committed / g.expected * 100) : 0) + '%"></i></div></button>' +
      runs.map(function(r) {
        return '<button class="model-btn ms' + (state.quarter === r.runId ? ' active' : '') + '" data-model="' + g.id + '" data-run="' + esc(r.runId) + '">' +
          esc(r.label) + ' · ' + r.committed + '/' + r.totalDays + '<div class="cohort">' + esc(r.state) + '</div></button>';
      }).join('') + '</div>';
  }).join('');
}
function render() {
  if (!state.cohorts.some(function(g) { return g.id === state.model; })) {
    state.model = state.cohorts.length ? state.cohorts[0].id : null;
    state.quarter = null;
  }
  renderSidebar();
  var el = document.getElementById('main');
  var group = state.cohorts.find(function(g) { return g.id === state.model; });
  if (!group) { el.innerHTML = '<div class="loading">No runs found yet</div>'; return; }
  var runs = state.runs.filter(function(r) { return r.cohortId === group.id; });
  if (state.quarter) renderQuarter(el, runs);
  else renderModelPage(el, runs, group);
}
function quarterCard(r) {
  var s = quarterStats(r);
  return '<button class="qcard" data-model="' + r.cohortId + '" data-run="' + esc(r.runId) + '">' +
    '<div class="qh"><span>' + esc(r.label) + '</span><span class="qs">' + r.committed + '/' + r.totalDays + '</span></div>' +
    '<div class="qs">' + esc(r.state) + '</div><div class="bar"><i style="width:' + (r.totalDays ? Math.min(100, r.committed / r.totalDays * 100) : 0) + '%"></i></div>' +
    '<div class="row"><span>Net worth</span><b>' + (s.netWorth == null ? '—' : '$' + fmt(s.netWorth, 2)) + '</b></div>' +
    '<div class="row"><span>Profit</span><b>' + dollars(s.profit) + '</b></div>' +
    '<div class="row"><span>Return on principal</span><b>' + pct(s.profitPct) + '</b></div>' +
    '<div class="row"><span>Time-weighted return</span><b>' + pct(s.twr) + '</b></div>' +
    '<div class="row"><span>Cash</span><b>' + (s.cashPct == null ? '—' : fmt(s.cashPct, 1) + '%') + '</b></div>' +
    '<div class="row"><span>Valid / invalid</span><b>' + r.valid + ' / ' + r.invalid + '</b></div></button>';
}
function renderModelPage(el, runs, g) {
  var y = g.year;
  el.innerHTML = '<div class="crumbs"><span class="cur">' + esc(g.name) + '</span><span>' + esc(g.provider) + '</span></div>' +
    '<div class="kpis">' + kpi(y ? 'Year profit' : 'Profit to date', dollars(y ? y.netProfit : g.observedProfit), y ? 'sum of independent quarters' : 'partial results', g.observedProfit >= 0 ? 'pos' : 'neg') +
    (g.annual ? kpi('Mean quarterly TWR', pct(y && y.meanQuarterTimeWeightedReturnPct), g.completedQuarters + '/4 quarters complete') : '') +
    kpi('Sessions', g.committed + ' / ' + g.expected, g.valid + ' valid · ' + g.invalid + ' invalid') +
    kpi('Fills', g.fills, g.rejectedOrders + ' rejected orders') + kpi('Tool calls', g.tools, 'all attempts on committed days') + '</div>' +
    (g.annual && !g.complete ? '<div class="mini status-line">Full-year score is unavailable until all four unique quarters complete.</div>' : '') +
    '<div class="card"><h2>' + (g.annual ? 'Quarters' : 'Runs') + ' — click to open</h2><div class="quarters">' +
    (g.annual ? g.quarters.map(function(q) {
      return q.runIds.length ? q.runIds.map(function(id) { return quarterCard(runs.find(function(r) { return r.runId === id; })); }).join('') :
        '<button class="qcard" disabled><div class="qh">' + esc(q.label) + '</div><div class="row">Not started · 0/' + q.expected + '</div></button>';
    }).join('') : runs.map(quarterCard).join('')) + '</div></div>';
}
function renderQuarter(el, runs) {
  var r = runs.find(function(r) { return r.runId === state.quarter; });
  if (!r) { state.quarter = null; render(); return; }
  var s = quarterStats(r), days = r.days;
  el.innerHTML = '<div class="crumbs"><button class="model-btn back" data-model="' + state.model + '">' + esc(r.modelName) + '</button>' +
    '<span>›</span><span class="cur">' + esc(r.label) + '</span><span>' + esc(r.start) + ' → ' + esc(r.end) + '</span></div>' +
    '<div class="kpis">' + kpi('Net worth', s.netWorth == null ? '—' : '$' + fmt(s.netWorth, 2), 'principal ' + (s.principal == null ? '—' : '$' + fmt(s.principal, 2))) +
    kpi('Profit', dollars(s.profit), pct(s.profitPct) + ' on principal', s.profit >= 0 ? 'pos' : 'neg') +
    kpi('Time-weighted return', pct(s.twr), 'adjusts for deposit timing') +
    kpi('Cash', s.cashPct == null ? '—' : fmt(s.cashPct, 1) + '%', 'of net worth') +
    kpi('Sessions', r.committed + ' / ' + r.totalDays, r.valid + ' valid · ' + r.invalid + ' invalid') + '</div>' +
    '<div class="mini status-line">' + esc(r.state) + ' · Last recorded activity: ' + esc(r.lastEventAt || 'none') + '</div>' +
    '<div class="card"><h2>Net worth &amp; cash allocation</h2><canvas id="chart"></canvas><div class="legend">' +
    '<span><i class="sw" style="background:var(--accent)"></i>net worth</span><span>Dashed: principal · shaded: cash % (right axis)</span></div></div>' +
    '<div class="card"><h2>Session timeline</h2><div class="timeline">' + r.timeline.map(function(t) {
      var d = days.find(function(d) { return d.date === t.date; }) || t;
      var cls = d.status === 'invalid' ? 'x' : d.status === 'uncommitted' ? 'pending' : d.status === 'unattempted' ? 'future' : d.fills > 0 ? 't' : '';
      return '<button class="tl ' + cls + '" data-date="' + d.date + '" aria-label="' + d.date + ' · ' + esc(d.status) + '" title="' + d.date + ' · ' + esc(d.status) + '"></button>';
    }).join('') + '</div><div class="legend">Blue: traded · gray: valid, no fills · red: invalid · dashed gray: uncommitted · outline: unattempted</div></div>' +
    '<div class="card"><h2>Sessions — click for the agent run</h2><div class="sessions"><table><thead><tr>' +
    '<th>Date</th><th>Status</th><th>Net worth</th><th>Deposit</th><th>Day P/L</th><th>Cash %</th><th>Fills</th><th>Attempts</th><th>Calls</th><th>Tags</th></tr></thead><tbody>' +
    days.map(function(d) {
      var calls = Object.values(d.tools).reduce(function(a, b) { return a + b; }, 0);
      return '<tr data-date="' + d.date + '" tabindex="0" role="button"><td>' + d.date + '</td><td><span class="pill ' + (d.status === 'completed' ? 'ok' : 'x') + '">' + esc(d.status) + '</span></td>' +
        '<td>' + fmt(d.netWorth, 2) + '</td><td>' + (d.contribution ? '+' + fmt(d.contribution, 2) : '—') + '</td><td class="' + (d.dailyProfit >= 0 ? 'pos' : 'neg') + '">' + dollars(d.dailyProfit) + '</td>' +
        '<td>' + (d.netWorth ? fmt(d.cash / d.netWorth * 100, 1) : '0') + '%</td><td>' + d.fills + '</td><td>' + d.attempts + '</td><td>' + calls +
        (d.toolErrors ? ' <span class="neg">' + d.toolErrors + ' errors</span>' : '') + '</td><td>' +
        (d.tags.length ? d.tags.slice(0, 2).map(function(t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') : '—') + '</td></tr>';
    }).join('') + '</tbody></table></div><div class="legend">Day P/L excludes deposits. Tool counts include failed attempts; invalid days are not deliberate holds.</div></div>';
  requestAnimationFrame(function() { drawChart(days); });
}
function drawChart(days) {
  var c = document.getElementById('chart');
  if (!c || !days.length) return;
  var dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr;
  var ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
  var left = 64, right = 52, top = 14, bottom = 24, iw = Math.max(1, W - left - right), ih = H - top - bottom;
  var funding = days.map(function(d) { return d.totalPrincipal; });
  var values = days.map(function(d) { return d.netWorth; }).concat(funding);
  var min = Math.min.apply(null, values), max = Math.max.apply(null, values), pad = (max - min) * .08 || 1000;
  min -= pad; max += pad;
  function x(i) { return left + (days.length === 1 ? iw / 2 : i / (days.length - 1) * iw); }
  function y(v) { return top + (1 - (v - min) / (max - min)) * ih; }
  function yc(d) { return top + (1 - (d.netWorth ? d.cash / d.netWorth : 0)) * ih; }
  ctx.clearRect(0, 0, W, H); ctx.font = '10px ui-monospace,monospace'; ctx.strokeStyle = '#22262d'; ctx.fillStyle = '#98a0ab';
  for (var g = 0; g <= 4; g++) {
    var v = min + (max - min) * g / 4;
    ctx.beginPath(); ctx.moveTo(left, y(v)); ctx.lineTo(W - right, y(v)); ctx.stroke();
    ctx.fillText(fmt(v), 8, y(v) + 3); ctx.fillText((g * 25) + '%', W - right + 6, top + (1 - g / 4) * ih + 3);
  }
  ctx.beginPath(); days.forEach(function(d, i) { i ? ctx.lineTo(x(i), yc(d)) : ctx.moveTo(x(i), yc(d)); });
  ctx.lineTo(x(days.length - 1), top + ih); ctx.lineTo(x(0), top + ih); ctx.closePath(); ctx.fillStyle = 'rgba(152,160,171,.12)'; ctx.fill();
  ctx.beginPath(); funding.forEach(function(v, i) { i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); });
  ctx.strokeStyle = '#667080'; ctx.setLineDash([2, 4]); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); days.forEach(function(d, i) { i ? ctx.lineTo(x(i), y(d.netWorth)) : ctx.moveTo(x(i), y(d.netWorth)); });
  ctx.strokeStyle = '#8ab4f8'; ctx.lineWidth = 1.8; ctx.stroke(); ctx.fillStyle = '#98a0ab';
  [0, Math.floor(days.length / 2), days.length - 1].forEach(function(i) { ctx.fillText(days[i].date, x(i) - 24, H - 6); });
}
function payload(value) {
  var readable = value && Array.isArray(value.content) ? value.content.map(function(b) {
    if (b.type !== 'text') return b;
    try { return JSON.parse(b.text); } catch (_) { return b.text; }
  }) : value;
  return '<pre class="payload">' + esc(JSON.stringify(readable, null, 2)) + '</pre>';
}
function renderCalls(calls) {
  if (!calls.length) return '<div class="empty">No calls recorded.</div>';
  return '<div class="sessions"><table><thead><tr><th>#</th><th>Tool / request</th><th>Arguments &amp; response</th><th>Status</th><th>Tool ms</th></tr></thead><tbody>' + calls.map(function(c) {
    var status = c.name === 'inference' ? c.httpStatus == null ? 'Awaiting headers' : 'HTTP ' + c.httpStatus : c.ok === null ? 'No result' : c.ok ? 'ok' : 'error';
    return '<tr><td>' + c.seq + '</td><td>' + esc(c.name) + '</td><td><details><summary>' + esc(c.args || 'Request details') + '</summary>' +
      '<div class="mini">Arguments</div>' + payload(c.raw) + (c.result === undefined ? '' : '<div class="mini">Result</div>' + payload(c.result)) + '</details></td>' +
      '<td class="' + (c.ok === false || c.httpStatus >= 400 ? 'neg' : '') + '">' + status + '</td><td>' + fmt(c.ms) + '</td></tr>';
  }).join('') + '</tbody></table></div>';
}
function renderAttempt(a) {
  var label = a.accepted ? 'Committed decision' : a.outcome === 'in_progress' ? 'Unfinished' : 'Not committed';
  return '<div class="attempt"><h4>Attempt ' + a.attempt + ' · ' + label + '</h4><div class="mini">' + esc(a.outcome) + (a.reason ? ' · ' + esc(a.reason) : '') + '</div>' +
    '<div class="mini">' + esc(a.startedAt || '') + (a.endedAt ? ' → ' + esc(a.endedAt) : '') + '</div>' +
    a.submissions.filter(function(s) { return !s.accepted; }).map(function(s) {
      return '<details><summary>Uncommitted submission — orders and journal</summary>' + payload(s.orders) + '<pre class="journal">' + esc(s.journal.text) + '</pre></details>';
    }).join('') + renderCalls(a.calls) + '</div>';
}
function holdingsTable(p) {
  if (!p || !p.holdings || !Object.keys(p.holdings).length) return '<div class="empty">All cash.</div>';
  return '<div class="sessions"><table><thead><tr><th>Ticker</th><th>Units</th><th>Avg cost</th><th>Last close</th><th>P/L</th><th>Value</th></tr></thead><tbody>' + Object.entries(p.holdings).map(function(e) {
    var h = e[1], pl = h.avgCost ? (h.lastClose / h.avgCost - 1) * 100 : null;
    return '<tr><td>' + esc(e[0]) + '</td><td>' + fmt(h.units, 6) + '</td><td>$' + fmt(h.avgCost, 2) + '</td><td>$' + fmt(h.lastClose, 2) + '</td><td>' + pct(pl) + '</td><td>$' + fmt(h.value, 2) + '</td></tr>';
  }).join('') + '</tbody></table></div>';
}
function sect(title, body) { return '<div class="sect"><h4>' + title + '</h4>' + body + '</div>'; }
function closeModal() { state.detail = null; document.getElementById('overlay').classList.remove('open'); }
async function showDetail(date, quiet) {
  var r = state.runs.find(function(r) { return r.runId === state.quarter; });
  if (!r) return;
  var selected = r.runId + '/' + date;
  state.detail = { runId: r.runId, date: date };
  document.getElementById('overlay').classList.add('open');
  var el = document.getElementById('modal');
  if (!quiet) el.innerHTML = '<h3>Loading ' + esc(date) + '<button class="close" onclick="closeModal()">esc</button></h3>';
  try {
    var d = await api('/api/run/' + encodeURIComponent(r.runId) + '/' + date);
    if (!state.detail || state.detail.runId + '/' + state.detail.date !== selected) return;
    var finance = d.after ? 'Net worth $' + fmt(d.after.netWorth, 2) + ' · principal $' + fmt(d.totalPrincipal, 2) + ' · day P/L ' + dollars(d.dailyProfit) + ' · deposit $' + fmt(d.contribution, 2) : 'No committed closing balance for this session.';
    el.innerHTML = '<h3>' + esc(d.date) + ' <span class="pill ' + (d.status === 'completed' ? 'ok' : 'x') + '">' + esc(d.status) + '</span><button class="close" onclick="closeModal()">esc</button></h3>' +
      (d.reason ? '<div class="mini neg">' + esc(d.reason) + '</div>' : '') + '<div class="mini">' + finance + '</div>' +
      (d.journal ? sect('Committed journal', (d.journal.tags || []).map(function(t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '<pre class="journal">' + esc(d.journal.text) + '</pre>') : '') +
      sect('Executed orders', d.fills.length ? '<div class="sessions"><table><thead><tr><th>Side</th><th>Ticker</th><th>Units</th><th>Price</th><th>Notional</th></tr></thead><tbody>' + d.fills.map(function(f) {
        return '<tr><td>' + esc(f.side) + '</td><td>' + esc(f.ticker) + '</td><td>' + fmt(f.units, 6) + '</td><td>$' + fmt(f.price, 2) + '</td><td>$' + fmt(f.notional, 2) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">' + (d.status === 'invalid' ? 'No valid decision. No orders executed; holdings carried forward.' : d.status === 'completed' ? 'No fills recorded.' : 'No execution committed for this session.') + '</div>') +
      (d.failedOrders.length ? sect('Rejected orders', payload(d.failedOrders)) : '') + (d.after ? sect('Holdings after', holdingsTable(d.after)) : '') +
      sect('Session attempts', d.attempts.length ? d.attempts.map(renderAttempt).join('') : '<div class="empty">This session has not been attempted.</div>');
  } catch (e) {
    if (state.detail && state.detail.runId + '/' + state.detail.date === selected) el.innerHTML = '<h3>Session unavailable<button class="close" onclick="closeModal()">esc</button></h3><p>' + esc(e.message) + '</p>';
  }
}
document.getElementById('overlay').addEventListener('click', function(e) { if (e.target === this) closeModal(); });
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-date]')) { e.preventDefault(); showDetail(e.target.getAttribute('data-date')); }
});
document.addEventListener('click', function(e) {
  var model = e.target.closest ? e.target.closest('[data-model]') : null;
  if (model) { var run = model.getAttribute('data-run'); run ? pickQuarter(model.getAttribute('data-model'), run) : pickModel(model.getAttribute('data-model')); return; }
  var date = e.target.closest ? e.target.closest('[data-date]') : null;
  if (date) showDetail(date.getAttribute('data-date'));
});
async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    var data = await api('/api/runs'); state.runs = data.runs; state.cohorts = data.cohorts;
    document.getElementById('liveText').textContent = 'auto-refresh';
    document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
    render();
    if (state.detail) await showDetail(state.detail.date, true);
  } catch (e) { document.getElementById('updated').textContent = 'Refresh failed: ' + e.message; }
  finally { state.refreshing = false; }
}
refresh();
setInterval(refresh, 5000);
`;

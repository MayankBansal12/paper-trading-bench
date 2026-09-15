import { CLIENT } from "./visualizer-client.ts";

export const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paper Trading Bench</title>
<style>
:root{--bg:#0b0d10;--panel:#131519;--panel2:#171a1f;--border:#22262d;--border2:#2c313a;--text:#e8eaed;--muted:#98a0ab;--dim:#88919e;--accent:#8ab4f8;--pos:#4ade80;--neg:#f87171;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}html{color-scheme:dark}
body{background:var(--bg);color:var(--text);font:13.5px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:10;display:flex;align-items:baseline;gap:14px;padding:12px 22px;background:var(--bg);border-bottom:1px solid var(--border)}
header h1{font-size:14px;font-weight:600}.live{font-size:11.5px;color:var(--muted)}#updated{margin-left:auto;color:var(--dim);font:11px var(--mono)}
.layout{display:grid;grid-template-columns:300px minmax(0,1fr);max-width:1500px;margin:0 auto;min-height:calc(100vh - 45px)}
aside{border-right:1px solid var(--border);padding:14px 10px;overflow-y:auto;position:sticky;top:45px;height:calc(100vh - 45px)}
.model{margin-bottom:6px}.model-btn{width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:8px;padding:9px 12px;cursor:pointer;color:var(--text);font:inherit}
.model-btn:hover{background:var(--panel)}.model-btn.active{background:var(--panel2);border-color:var(--border2)}.model-btn.back{width:auto;padding:0}
.nm{font-weight:600;font-size:13px}.pv,.cohort{color:var(--dim);font:10.5px/1.5 var(--mono);overflow-wrap:anywhere}.pv{text-transform:uppercase;letter-spacing:.04em}.ms{font:11px/1.5 var(--mono);color:var(--muted)}
.bar{height:4px;border-radius:2px;background:#1c2027;margin:6px 0 2px;overflow:hidden}.bar>i{display:block;height:100%;background:var(--accent);opacity:.75;border-radius:2px}
main{padding:18px 22px 40px;min-width:0}.crumbs{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:12.5px;color:var(--muted);flex-wrap:wrap}.cur{color:var(--text);font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}.kpi{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:11px 14px}
.k{color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em}.v{font:600 19px/1.5 var(--mono);margin-top:3px}.d{font:11px/1.5 var(--mono);color:var(--muted);margin-top:2px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:15px 17px;margin-bottom:14px}.card h2{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:11px}
.quarters{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}.qcard{background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:13px 15px;cursor:pointer;color:var(--text);font:inherit;text-align:left;width:100%}
.qcard:hover{border-color:var(--border2)}.qcard:disabled{cursor:default;opacity:.65}.qh{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;font-weight:600}.qs{color:var(--muted);font:11px/1.5 var(--mono)}
.row{display:flex;justify-content:space-between;font:12px/1.5 var(--mono);color:var(--muted);margin-top:5px;gap:10px}.row b{color:var(--text);font-weight:500}
canvas{width:100%;height:250px;display:block}.timeline{display:flex;flex-wrap:wrap;gap:3px}.tl{width:15px;height:15px;border:0;border-radius:4px;background:#343b46;cursor:pointer}.tl.t{background:var(--accent);opacity:.8}
.tl.x{background:transparent;border:1.5px dashed var(--neg)}.tl.pending{background:transparent;border:1.5px dashed var(--muted)}.tl.future{background:transparent;border:1px solid var(--border2)}.tl:hover{outline:2px solid var(--accent)}
.sessions{max-height:420px;overflow:auto}table{width:100%;border-collapse:collapse;font:12px/1.5 var(--mono)}th{color:var(--dim);text-align:left;font-weight:500;padding:6px 10px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--panel);font-size:10.5px;text-transform:uppercase}
td{padding:5.5px 10px;border-bottom:1px solid #20242b;white-space:nowrap}tr[data-date]{cursor:pointer}tr:hover td{background:var(--panel2)}
.pill{display:inline-block;padding:1px 8px;border-radius:9px;font:10.5px var(--sans)}.pill.ok{background:#12291a;color:var(--pos)}.pill.x{background:#2a1417;color:var(--neg)}
.tag{display:inline-block;background:#151d2e;color:var(--accent);border:1px solid #243050;border-radius:9px;padding:1px 8px;font:10.5px var(--mono);margin:2px 4px 2px 0}
.overlay{position:fixed;inset:0;background:rgba(5,6,8,.72);display:none;align-items:flex-start;justify-content:center;z-index:50;overflow-y:auto;padding:36px 16px}.overlay.open{display:flex}
.modal{background:var(--panel);border:1px solid var(--border2);border-radius:12px;max-width:1100px;width:100%;padding:20px 24px}.modal h3{font-size:15px;margin-bottom:4px;display:flex;align-items:center;gap:10px}
.close{margin-left:auto;cursor:pointer;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:2px 10px;background:none;font:12px var(--mono)}.close:hover{color:var(--text)}
.sect{margin-top:15px}.sect h4{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:7px}
pre.journal,pre.payload{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font:11.5px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;color:#d3d7dc}
.pos{color:var(--pos)}.neg{color:var(--neg)}.empty{color:var(--dim);font-style:italic}.loading{padding:50px;text-align:center;color:var(--dim)}footer{color:var(--dim);font:11px var(--mono);text-align:center;padding:8px 0 24px}
.mini{font-size:12px;color:var(--muted)}.status-line{margin-bottom:14px}.legend{display:flex;gap:14px;margin-top:8px;font-size:11px;color:var(--muted);flex-wrap:wrap}.legend span{display:inline-flex;align-items:center;gap:5px}.sw{width:10px;height:10px;border-radius:3px;display:inline-block}
.attempt{border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:12px}details{max-width:650px;white-space:normal}summary{cursor:pointer;color:var(--accent)}pre.payload{margin:6px 0}.cohort{font-size:10px}
button:focus-visible,a:focus-visible,[data-date]:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media(max-width:920px){.layout{grid-template-columns:1fr}aside{position:static;height:auto;max-height:300px;border-right:0;border-bottom:1px solid var(--border)}}
@media(max-width:480px){main{padding:14px 10px}.modal{padding:16px 12px}header{padding:10px;gap:8px;flex-wrap:wrap}.quarters{grid-template-columns:1fr}}
</style></head><body>
<header><h1>Paper Trading Bench</h1><span class="live" id="live"><span id="liveText">loading</span></span><span id="updated"></span></header>
<div class="layout"><aside id="sidebar"><div class="loading">Loading…</div></aside><main id="main"><div class="loading">Select a model</div></main></div>
<div class="overlay" id="overlay"><div class="modal" id="modal" role="dialog" aria-modal="true" aria-label="Session details"></div></div>
<footer>read-only · refreshes every 5s</footer><script>${CLIENT}</script></body></html>`;

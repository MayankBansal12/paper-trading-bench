import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { quotaPause, QUOTA_PAUSE_POLICY, ZEN_QUOTA_PAUSE_POLICY, availabilityPolicy } from "../src/study/availability.ts";

const event = {kind:"result",recordedAt:"2026-09-16T14:00:00Z",hash:"result-hash",scope:{attempt:1},payload:{outcome:"harness_error"}} as any;
function store(error:any,status=429){return {trace:()=>[{type:"inference_response",sequence:2,status},{type:"inference_chunk",sequence:2,base64:Buffer.from(JSON.stringify({error})).toString("base64")}]} as any;}
test("quota pause uses explicit provider reset with buffer and preserves the failed attempt",()=>{
 const reset=Date.parse("2026-09-16T18:00:00Z")/1000;
 expect(quotaPause(store({type:"usage_limit_reached",resets_at:reset}),event)).toEqual({reason:"provider-usage-limit",notBefore:"2026-09-16T18:05:00.000Z",failedAttempt:1,resultEventHash:"result-hash"});
 expect(quotaPause(store({type:"usage_limit_reached"}),event)?.notBefore).toBe("2026-09-16T20:05:00.000Z");
 expect(quotaPause(store({type:"rate_limit_exceeded"}),event)).toBeUndefined();
 expect(quotaPause(store({type:"usage_limit_reached"},200),event)).toBeUndefined();
 expect(quotaPause(store({type:"usage_limit_reached"}),{...event,payload:{outcome:"completed"}})).toBeUndefined();
});
for (const model of ["pi/openai-codex/gpt-6-astra", "opencode/muse-spark-1.3-contributor-free"]) test(`${model}: pause/resume makes no calls during cooldown and never grants a third attempt`,async()=>{
 const script=`import { mock } from "bun:test";
 import {rm} from "node:fs/promises";
 let calls=0; const clock=Date.now; let offset=0; Date.now=()=>clock()+offset;
 mock.module(${JSON.stringify(resolve("src/study/model.ts"))},()=>({
 prepareModelRuntime:async()=>({bundle:{evidence:{id:"offline-fixture"}},dispose:async()=>{}}),
 decideStudy:async(view,store,past,horizon,audit)=>{
 calls++;const trace=[{type:"inference_response",sequence:1,status:429},{type:"inference_chunk",sequence:1,base64:Buffer.from(JSON.stringify({error:{type:"usage_limit_reached",resets_at:Math.floor((Date.now()+3600000)/1000)}})).toString("base64")}];
 for(const e of trace)audit(e);
 const {initialStudyDecision}=await import(${JSON.stringify(resolve("src/study/agent.ts"))});
 const {contentHash}=await import(${JSON.stringify(resolve("src/core/hash.ts"))});
 const decision=initialStudyDecision(view);decision.trace=trace;
 return {outcome:"harness_error",reason:"synthetic quota",scope:view.scope,viewHash:contentHash(view),decision,journalEntries:[]};
 }}));
 const {config}=await import(${JSON.stringify(resolve("tests/studyTestSupport.ts"))});
 const {runStudy}=await import(${JSON.stringify(resolve("src/study/runner.ts"))});
 const {availabilityPolicy}=await import(${JSON.stringify(resolve("src/study/availability.ts"))});
 const c={...await config("2024-04-02","2024-04-02"),kind:"environment",model:${JSON.stringify(model)},availabilityPolicy:availabilityPolicy(${JSON.stringify(model)})};
 const root=${JSON.stringify(resolve("results/studies"))}+"/"+c.runId;
 try{
 const first=await runStudy(c);if(first.summary.status!=="paused"||calls!==1||first.summary.committedDays!==0)throw Error("first failure did not pause");
 const again=await runStudy(c);if(again.summary.status!=="paused"||calls!==1)throw Error("cooldown made a request");
 const replay=await runStudy(c,{readOnly:true});if(replay.summary.attempts!==1||calls!==1)throw Error("replay changed attempts");
 offset=2*3600000;const second=await runStudy(c);if(second.summary.status!=="paused"||calls!==2||second.summary.attempts!==2)throw Error("second quota attempt not retained");
 offset=4*3600000;const final=await runStudy(c);if(calls!==2||final.summary.invalidDays!==1||final.summary.attempts!==2)throw Error("attempt allowance was reset");
 console.log(JSON.stringify({passed:true,calls,invalidDays:final.summary.invalidDays}));
 }finally{Date.now=clock;await rm(root,{recursive:true,force:true});}`;
 const p=Bun.spawn([process.execPath,"-e",script],{stdout:"pipe",stderr:"pipe"});
 const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 expect(err).toBe("");expect(code).toBe(0);expect(JSON.parse(out).calls).toBe(2);
});

test("Zen pauses every 429 and honors explicit reset evidence without changing Pi policy", () => {
 const trace = [{type:"inference_response", sequence:1, status:429, retryAfter:"7200"},
  {type:"inference_chunk", sequence:1, base64:Buffer.from(JSON.stringify({error:{type:"FreeUsageLimitError"}})).toString("base64")}];
 const s = {trace:()=>trace} as any;
 expect(quotaPause(s,event,ZEN_QUOTA_PAUSE_POLICY)?.notBefore).toBe("2026-09-16T16:05:00.000Z");
 trace[0]!.retryAfter="Wed, 16 Sep 2026 18:00:00 GMT";
 expect(quotaPause(s,event,ZEN_QUOTA_PAUSE_POLICY)?.notBefore).toBe("2026-09-16T18:05:00.000Z");
 trace[0]!.retryAfter="unknown";
 expect(quotaPause(s,event,ZEN_QUOTA_PAUSE_POLICY)?.notBefore).toBe("2026-09-16T20:05:00.000Z");
 expect(quotaPause(s,event,QUOTA_PAUSE_POLICY)).toBeUndefined();
 expect(quotaPause(store({resets_at:Date.parse("2026-09-17T00:00:00Z")/1000}),event,ZEN_QUOTA_PAUSE_POLICY)?.notBefore).toBe("2026-09-17T00:05:00.000Z");
 expect(()=>availabilityPolicy("opencode/muse-spark-1.2-contributor-free")).toThrow();
 expect(()=>availabilityPolicy("opencode-go/glm-5.3-flash")).toThrow();
});

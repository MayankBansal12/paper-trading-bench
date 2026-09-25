import { test, expect } from "bun:test";
import { piRoute, PI_MUSE_MODEL_ID, PI_MUSE_CATALOG_COST } from "../src/pi/route.ts";
import { validatePiCatalog } from "../src/pi/runtime.ts";
import { makePiConfig } from "../src/pi/config.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const model = { id: "muse-spark-1.3-contributor", provider: "opencode-go", api: "openai-responses",
  baseUrl: "https://opencode.ai/zen/go/v1", reasoning: true, cost: PI_MUSE_CATALOG_COST,
  thinkingLevelMap: { medium: "medium" }, compat: { sessionAffinityFormat: "openai-nosession" } };

test("exact Muse Pi/Go catalog pins API, endpoint, cost, medium reasoning, and provider", () => {
  expect(() => validatePiCatalog(PI_MUSE_MODEL_ID, model)).not.toThrow();
  for (const change of [{ id: "muse-spark-1.3" }, { provider: "opencode" },
    { api: "openai-completions" }, { baseUrl: "https://opencode.ai/zen/v1" },
    { cost: { ...model.cost, input: 0 } }, { headers: { authorization: "untrusted" } },
    { reasoning: false }, { thinkingLevelMap: { medium: "high" } }])
    expect(() => validatePiCatalog(PI_MUSE_MODEL_ID, { ...model, ...change })).toThrow();
  expect(piRoute(PI_MUSE_MODEL_ID).cost).toBeNull();
  expect(() => piRoute("pi/opencode/muse-spark-1.3-contributor-free")).toThrow();
});

test("Muse sandbox config selects only Pi Go and contains only attempt capability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-config-"));
  try {
    await makePiConfig(dir, "attempt-capability", model, [], "system", "daily");
    const launch = JSON.parse(await readFile(join(dir, "launch.json"), "utf8"));
    expect(launch.settings.defaultProvider).toBe("opencode-go");
    expect(Object.keys(launch.models.providers)).toEqual(["opencode-go"]);
    expect(launch.models.providers["opencode-go"].apiKey).toBe("attempt-capability");
    expect(launch.models.providers["opencode-go"].models[0].api).toBe("openai-responses");
    expect(launch.settings.retry.provider.maxRetries).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Muse accepted-response integrity failure is persisted once and stops before another attempt", async () => {
  const { resolve } = await import("node:path");
  const script = `import {mock} from 'bun:test';
  import {readFileSync} from 'node:fs'; import {rm} from 'node:fs/promises';
  let calls=0;
  mock.module(${JSON.stringify(resolve('src/study/model.ts'))},()=>({
    prepareModelRuntime:async()=>({credential:{authorize:async()=>new Headers()},bundle:{evidence:{id:'fixture'}},dispose:async()=>{}}),
    decideStudy:async(view)=>{
      calls++; const {initialStudyDecision}=await import(${JSON.stringify(resolve('src/study/agent.ts'))});
      const decision=initialStudyDecision(view); decision.outcome='completed';
      return {outcome:'completed',scope:view.scope,decision,journalEntries:[]};
    }
  }));
  mock.module(${JSON.stringify(resolve('src/study/accept.ts'))},()=>({validateAccepted:()=>{throw Error('synthetic audit mismatch')},validateOpeningContext:()=>{}}));
  const {config}=await import(${JSON.stringify(resolve('tests/studyTestSupport.ts'))});
  const {runStudy}=await import(${JSON.stringify(resolve('src/study/runner.ts'))});
  const c={...await config('2024-04-02','2024-04-03'),kind:'environment',model:'pi/opencode-go/muse-spark-1.3-contributor'};
  const dir=${JSON.stringify(resolve('results/studies'))}+'/'+c.runId;
  try{
    let stopped=false;try{await runStudy(c)}catch(e){stopped=String(e).includes('TERMINAL_VERIFICATION_ERROR')}
    const events=readFileSync(dir+'/events.jsonl','utf8').trim().split('\\n').map(JSON.parse);
    if(!stopped||calls!==1||events.filter(e=>e.kind==='begin').length!==1||events.filter(e=>e.kind==='result'&&e.payload.outcome==='harness_error').length!==1)throw Error('integrity failure was retried or lost');
  } finally {await rm(dir,{recursive:true,force:true})}`;
  const p=Bun.spawn([process.execPath,'-e',script],{stdout:'pipe',stderr:'pipe'});
  const [err,code]=await Promise.all([new Response(p.stderr).text(),p.exited]);
  expect(err).toBe(''); expect(code).toBe(0);
});

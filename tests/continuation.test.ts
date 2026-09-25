import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { contentHash } from "../src/core/hash.ts";
import { implementationMatches, quotaWasReset } from "../src/study/continuation.ts";
const identity = (hashes: Record<string,string>) => ({ hashes, hash: contentHash(hashes) });
test("explicit continuation permits only pinned scheduling changes and unchanged config", () => {
 const dir=mkdtempSync(join(tmpdir(),"quota-continuation-"));
 try {
  const saved=identity({"src/study/runner.ts":"old","src/study/tools.ts":"same"});
  const current=identity({"src/study/runner.ts":"new","src/study/tools.ts":"same","src/study/continuation.ts":"receipt"});
  const config={model:"pi/openai-codex/gpt-5.6-sol"};
  const receipt={runId:basename(dir),version:"manual-quota-reset-v1",authorization:"user-confirmed-external-quota-reset",authorizedAt:"2026-09-18T00:00:00Z",failureHashes:[],configHash:contentHash(config),previousImplementationHash:saved.hash,continuedImplementationHash:current.hash};
  expect(implementationMatches(saved,current,dir,config)).toBe(false);
  writeFileSync(join(dir,"manual-quota-reset.json"),JSON.stringify(receipt));
  expect(implementationMatches(saved,current,dir,config)).toBe(true);
  writeFileSync(join(dir,"manual-quota-reset.json"),JSON.stringify({...receipt,runId:"other-cohort"}));
  expect(implementationMatches(saved,current,dir,config)).toBe(false);
  writeFileSync(join(dir,"manual-quota-reset.json"),JSON.stringify(receipt));
  expect(implementationMatches(saved,current,dir,{...config,model:"different"})).toBe(false);
  const changedTrading=identity({...current.hashes,"src/study/tools.ts":"changed"});
  writeFileSync(join(dir,"manual-quota-reset.json"),JSON.stringify({...receipt,continuedImplementationHash:changedTrading.hash}));
  expect(implementationMatches(saved,changedTrading,dir,config)).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("reset is scoped to exact pre-authorization failures and run, never future quota failures",()=>{
 const dir=mkdtempSync(join(tmpdir(),"quota-receipt-"));
 try {
  const hash="a".repeat(64);
  writeFileSync(join(dir,"manual-quota-reset.json"),JSON.stringify({version:"manual-quota-reset-v1",authorization:"user-confirmed-external-quota-reset",authorizedAt:"2026-09-18T00:00:00Z",failureHashes:[hash],runId:"fixture"}));
  const e={hash,scope:{runId:"fixture"},recordedAt:"2026-09-17T00:00:00Z"} as any;
  expect(quotaWasReset(dir,e)).toBe(true);
  expect(quotaWasReset(dir,{...e,hash:"b".repeat(64)})).toBe(false);
  expect(quotaWasReset(dir,{...e,scope:{...e.scope,runId:"other"}})).toBe(false);
  expect(quotaWasReset(dir,{...e,recordedAt:"2026-09-19T00:00:00Z"})).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("runtime continuation allows only launch-path change with identical actual executables and catalog",async()=>{
 const {runtimeMatches}=await import("../src/study/continuation.ts");
 const dir=mkdtempSync(join(tmpdir(),"runtime-continuation-"));
 try{
  const evidence=(launch:string,binary="same")=>{const data={policy:"same",hashes:{"scripts/sandbox/launch.sh":launch,"worker":"same"},bwrapHash:binary,pi:{catalogHash:"same"}};return {...data,id:contentHash(data)};};
  const before=evidence("old"),after=evidence("new");
  const r={runId:basename(dir),version:"manual-quota-reset-v1",authorization:"user-confirmed-external-quota-reset",authorizedAt:"2026-09-18T00:00:00Z",failureHashes:[],previousRuntimeHash:contentHash(before),continuedRuntimeHash:contentHash(after)};
  writeFileSync(join(dir,"manual-quota-reset.json"),JSON.stringify(r));
  expect(runtimeMatches(before,after,dir)).toBe(true);
  writeFileSync(join(dir,"manual-quota-reset.json"),JSON.stringify({...r,runId:"other-cohort"}));
  expect(runtimeMatches(before,after,dir)).toBe(false);
  const changed=evidence("new","changed");
  writeFileSync(join(dir,"manual-quota-reset.json"),JSON.stringify({...r,continuedRuntimeHash:contentHash(changed)}));
  expect(runtimeMatches(before,changed,dir)).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

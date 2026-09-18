import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "../src/core/hash.ts";
import { implementationMatches, quotaWasReset } from "../src/study/continuation.ts";
const identity = (hashes: Record<string,string>) => ({ hashes, hash: contentHash(hashes) });
test("explicit continuation permits only pinned scheduling changes and unchanged config", () => {
 const dir=mkdtempSync(join(tmpdir(),"quota-continuation-"));
 try {
  const saved=identity({"src/study/runner.ts":"old","src/study/tools.ts":"same"});
  const current=identity({"src/study/runner.ts":"new","src/study/tools.ts":"same","src/study/continuation.ts":"receipt"});
  const config={model:"pi/openai-codex/gpt-5.6-sol"};
  const receipt={version:"manual-quota-reset-v1",authorization:"user-confirmed-external-quota-reset",authorizedAt:"2026-09-18T00:00:00Z",failureHashes:[],configHash:contentHash(config),previousImplementationHash:saved.hash,continuedImplementationHash:current.hash};
  expect(implementationMatches(saved,current,dir,config)).toBe(false);
  writeFileSync(join(dir,"manual-quota-reset.json"),JSON.stringify(receipt));
  expect(implementationMatches(saved,current,dir,config)).toBe(true);
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

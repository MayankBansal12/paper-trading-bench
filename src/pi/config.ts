import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { piRoute, PI_THINKING } from "./route.ts";
export async function makePiConfig(
  dir: string,
  capability: string,
  catalog: any,
  definitions: any[],
  system: string,
  prompt: string,
  forbiddenPaths: string[] = [],
) {
  const route = piRoute(`pi/${catalog.provider}/${catalog.id}`);
  // No credentials: the synthetic JWT is a per-attempt gateway capability.
  const settings = {
    defaultProvider: route.provider,
    defaultModel: route.model,
    defaultThinkingLevel: PI_THINKING,
    transport: "sse",
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    packages: [],
    extensions: [],
    skills: [],
    promptTemplates: [],
    themes: [],
  };
  const model = { ...catalog, baseUrl: "http://127.0.0.1:8765/inference" };
  await writeFile(
    join(dir, "launch.json"),
    JSON.stringify({
      pi: true,
      forbiddenPaths,
      capability,
      prompt,
      system,
      definitions,
      settings,
      models: {
        providers: {
          [route.provider]: {
            baseUrl: model.baseUrl,
            apiKey: capability,
            models: [model],
          },
        },
      },
      catalog: { [route.provider]: { models: [model] } },
    }),
  );
  await writeFile(
    join(dir, "benchmark-plugin.mjs"),
    `
import {readFileSync} from "node:fs";
const setup=JSON.parse(readFileSync("/runtime/launch.json","utf8"));
const request=async(path,body)=>{
 const r=await fetch("http://127.0.0.1:8765"+path,{method:"POST",headers:{authorization:"Bearer "+setup.capability,"content-type":"application/json"},body:JSON.stringify(body)});
 if(!r.ok)throw new Error("Benchmark gateway returned "+r.status);
 return r.json();
};
export default function(pi){
 pi.on("before_agent_start",()=>({systemPrompt:setup.system}));
 for(const d of setup.definitions)pi.registerTool({name:"trading_"+d.name,label:d.name,description:d.description,parameters:d.inputSchema,
 async execute(id,args){
  await request("/bind-call",{callID:id,tool:"trading_"+d.name,args});
  const reply=await request("/mcp",{jsonrpc:"2.0",id,method:"tools/call",params:{name:d.name,arguments:args}});
  if(reply.result.isError)throw new Error(JSON.stringify(reply.result.content));
  return {content:reply.result.content,details:{benchmarkResult:reply.result}};
 }});
}
`,
  );
}

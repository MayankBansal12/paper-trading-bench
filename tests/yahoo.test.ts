import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertYahooChart } from "../src/data/yahoo.ts";
import { importYahoo } from "../scripts/import-yahoo.ts";
import { exchangeDates } from "../src/data/calendar.ts";
import { loadDataset } from "../src/data/dataset.ts";
const timestamp=(d:string)=>Date.parse(`${d}T17:00:00Z`)/1000;
function chart(dates:string[]) {
  return { chart: { error:null,result:[{
    meta:{symbol:"AAPL",currency:"USD",exchangeTimezoneName:"America/New_York",instrumentType:"EQUITY"},
    timestamp:dates.map(timestamp),
    indicators:{quote:[{open:dates.map(()=>100),high:dates.map(()=>101),low:dates.map(()=>99),close:dates.map(()=>100),volume:dates.map(()=>400)}],adjclose:[{adjclose:dates.map(()=>-999)}]},
    events:{splits:{one:{date:timestamp("2024-08-01"),numerator:4,denominator:1}},dividends:{one:{date:timestamp("2024-01-03"),amount:0.205}}},
  }] } };
}
describe("Yahoo raw conversion",()=>{
  test("reverses splits beyond evaluation end on OHLC, volume AND cash dividend; ignores adjclose",()=>{
    const x=convertYahooChart(chart(["2024-01-02","2024-01-03"]),"AAPL","2024-01-02","2024-01-03");
    expect(x.bars[0]).toEqual({date:"2024-01-02",open:400,high:404,low:396,close:400,volume:100});
    expect(x.actions).toEqual([{type:"dividend",date:"2024-01-03",ticker:"AAPL",amount:0.82}]);
    expect(x.allSplits).toHaveLength(1);
  });
  test("spin-off factors masquerading as Yahoo splits are rejected",()=>{
    const source=chart(["2024-01-02"]);
    source.chart.result[0]!.events.splits.one={date:timestamp("2024-08-01"),numerator:1061,denominator:1000};
    expect(()=>convertYahooChart(source,"AAPL","2024-01-01","2024-01-03")).toThrow("possible spin-off");
  });
  test("pre-coverage exotic factors are ignored because they cannot affect retained raw bars",()=>{
    const source=chart(["2024-01-02"]);
    source.chart.result[0]!.events.splits.one={date:timestamp("2023-12-01"),numerator:1061,denominator:1000};
    const converted=convertYahooChart(source,"AAPL","2024-01-01","2024-01-03");
    expect(converted.allSplits).toEqual([]);
    expect(converted.bars[0]!.close).toBe(100);
  });
  test("multiple forward and reverse splits apply strictly after each bar",()=>{
    const source=chart(["2024-01-02","2024-08-01","2024-09-02"]);
    (source.chart.result[0]!.events.splits as any).two={date:timestamp("2024-09-02"),numerator:1,denominator:2};
    const x=convertYahooChart(source,"AAPL","2024-01-01","2024-09-02");
    expect(x.bars.map(b=>b.close)).toEqual([200,50,100]);
    expect(x.bars.map(b=>b.volume)).toEqual([200,800,400]);
    expect(x.actions.filter(a=>a.type==="split")).toHaveLength(2);
  });
  test("Yahoo symbol alias, null rows, duplicate dates and unsupported distributions fail loudly",()=>{
    const nullSource=chart(["2024-01-02"]);(nullSource.chart.result[0]!.indicators.quote[0]!.open as any)[0]=null;
    expect(()=>convertYahooChart(nullSource,"AAPL","2024-01-02","2024-01-03")).toThrow("Missing");
    expect(()=>convertYahooChart(chart(["2024-01-02","2024-01-02"]),"AAPL","2024-01-02","2024-01-03")).toThrow("Duplicate");
    const gains=chart(["2024-01-02"]);(gains.chart.result[0]!.events as any).capitalGains={one:{date:timestamp("2024-01-02"),amount:3}};
    expect(()=>convertYahooChart(gains,"AAPL","2024-01-02","2024-01-03")).toThrow("capital-gain");
    const alias=chart(["2024-01-02"]);alias.chart.result[0]!.meta.symbol="BRK-B";
    expect(convertYahooChart(alias,"BRK.B","2024-01-02","2024-01-03").bars).toHaveLength(1);
  });
});
const dirs:string[]=[];
const originalFetch=globalThis.fetch;
afterEach(async()=>{globalThis.fetch=originalFetch;for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
describe("immutable Yahoo import and replay",()=>{
  test("frozen snapshots reproduce byte-identical manifests and version with network forbidden",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"yahoo-import-"));dirs.push(dir);
    const expected=chart(exchangeDates("2023-01-01","2024-03-31"));
    let calls=0;
    globalThis.fetch=(async(input:Parameters<typeof fetch>[0])=>{
      calls++;const url=new URL(String(input));
      expect(Number(url.searchParams.get("period2"))).toBeGreaterThan(timestamp("2024-08-01"));
      return new Response(JSON.stringify(expected));
    }) as unknown as typeof fetch;
    await importYahoo(["--start","2024-01-01","--end","2024-03-31","--history-start","2023-01-01","--out",join(dir,"one"),"--tickers","AAPL"]);
    expect(calls).toBe(1);
    globalThis.fetch=(async()=>{throw new Error("network forbidden");}) as unknown as typeof fetch;
    await importYahoo(["--from-snapshot",join(dir,"one"),"--out",join(dir,"two")]);
    const first=await loadDataset(join(dir,"one")),second=await loadDataset(join(dir,"two"));
    expect(first.version).toBe(second.version);
    expect(await readFile(join(dir,"one/manifest.json"),"utf8")).toBe(await readFile(join(dir,"two/manifest.json"),"utf8"));
    expect(first.asOfBefore("AAPL","2024-01-03")[0]!.close).toBe(400);
    await expect(importYahoo(["--from-snapshot",join(dir,"one"),"--out",join(dir,"two")])).rejects.toThrow("overwrite");
  });
  test("stale provider bars fail instead of silently shortening the requested benchmark",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"yahoo-stale-"));dirs.push(dir);
    globalThis.fetch=(async()=>new Response(JSON.stringify(chart(exchangeDates("2023-01-01","2024-03-28").slice(0,-1))))) as unknown as typeof fetch;
    await expect(importYahoo(["--start","2024-01-01","--end","2024-03-31","--history-start","2023-01-01","--out",join(dir,"missing"),"--tickers","AAPL"])).rejects.toThrow("Incomplete Yahoo coverage");
  });
});

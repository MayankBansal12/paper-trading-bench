import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADJUSTMENT_CONVENTION, loadDataset, sha256, validateBars, validateDatasetWindow, type DatasetManifest } from "../src/data/dataset.ts";
import { exchangeDates, CALENDAR_VERSION } from "../src/data/calendar.ts";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const bar = (date: string, close = 100) => ({ date, open: close, high: close+1, low: close-1, close, volume: 200 });
async function fixture(): Promise<{dir:string; manifest:DatasetManifest}> {
  const dir = await mkdtemp(join(tmpdir(), "market-dataset-")); dirs.push(dir);
  const bars = [bar("2024-01-02",100),bar("2024-01-03",50),bar("2024-01-04",49),bar("2024-01-05",49)];
  const bytes = JSON.stringify(bars);
  await writeFile(join(dir,"AAPL.json"),bytes);
  await writeFile(join(dir,"source.json"),"{}");
  const manifest:DatasetManifest = {
    schemaVersion:1,kind:"historical",source:"controlled historical test",fetchedAt:"2024-01-06T00:00:00Z",adjustmentConvention:ADJUSTMENT_CONVENTION,
    calendarVersion:CALENDAR_VERSION,coverage:{start:"2024-01-01",end:"2024-01-07"},evaluation:{start:"2024-01-01",end:"2024-01-07"},
    calendar:bars.map(b=>b.date),universe:["AAPL"],
    actions:[{type:"split",date:"2024-01-03",ticker:"AAPL",ratio:2},{type:"dividend",date:"2024-01-04",ticker:"AAPL",amount:1}],
    files:{AAPL:{path:"AAPL.json",sha256:sha256(bytes)}}, snapshots:[{path:"source.json",sha256:sha256("{}") }],
  };
  await save(dir,manifest);return {dir,manifest};
}
const save = (dir:string, manifest:DatasetManifest) => writeFile(join(dir,"manifest.json"),JSON.stringify(manifest));
describe("dataset validation and causal corporate actions",()=>{
  test("raw execution bars and date-effective adjusted history",async()=>{
    const {dir}=await fixture(), d=await loadDataset(dir);
    expect(d.version).toMatch(/^[a-f0-9]{64}$/);
    expect(d.openOn("AAPL","2024-01-02")).toBe(100);
    expect(d.asOfBefore("AAPL","2024-01-03")).toEqual([{date:"2024-01-02",open:50,high:50.5,low:49.5,close:50,volume:400}]);
    expect(d.asOfBefore("AAPL","2024-01-02")).toEqual([]);
    expect(d.asOfBefore("AAPL","2024-01-04").map(b=>b.close)).toEqual([50,50]);
    expect(d.closeOn("AAPL","2024-01-04")).toBe(49);
    expect(d.asOfBefore("AAPL","2024-01-05").map(b=>b.close)).toEqual([50,50,49]); // dividends do not rewrite history
    const rows=d.asOfBefore("AAPL","2024-01-05");rows[0]!.close=999;
    const actions=d.actionsOn("2024-01-03");(actions[0] as any).ratio=999;
    expect(d.asOfBefore("AAPL","2024-01-03")[0]!.close).toBe(50);
    expect(d.asOfBefore("AAPL","2024-01-05",0)).toEqual([]);
    expect(()=>d.asOfBefore("AAPL","2024-01-05",-1)).toThrow();
  });
  test("future action changes cannot leak into earlier decision",async()=>{
    const {dir,manifest}=await fixture(); const early=await loadDataset(dir);
    manifest.actions[0]={type:"split",date:"2024-01-05",ticker:"AAPL",ratio:10};await save(dir,manifest);
    const future=await loadDataset(dir);
    expect(early.asOfBefore("AAPL","2024-01-02")).toEqual(future.asOfBefore("AAPL","2024-01-02"));
    expect(future.asOfBefore("AAPL","2024-01-03")[0]!.close).toBe(100);
    const observed=future.asOfBefore("AAPL","2024-01-04");
    expect(observed).toHaveLength(2);
    manifest.actions[0]={type:"split",date:"2024-01-05",ticker:"AAPL",ratio:20};await save(dir,manifest);
    const changedFuture=await loadDataset(dir);
    expect(changedFuture.asOfBefore("AAPL","2024-01-04")).toEqual(observed);
  });
  test("coverage includes nontrading boundary days and rejects truncation/warmup",async()=>{
    const {dir}=await fixture(),d=await loadDataset(dir);
    expect(validateDatasetWindow(d,"2024-01-01","2024-01-07",0)).toHaveLength(4);
    expect(()=>validateDatasetWindow(d,"2023-12-31","2024-01-07",0)).toThrow("outside");
    expect(()=>validateDatasetWindow(d,"2024-01-01","2024-01-07",60)).toThrow("warmup");
    expect(()=>validateDatasetWindow(d,"2024-01-01","2024-01-07",0,["BAD"])).toThrow("missing");
  });
  test("content and source tampering fail SHA verification",async()=>{
    const {dir}=await fixture();await writeFile(join(dir,"source.json"),"tampered");
    await expect(loadDataset(dir)).rejects.toThrow("SHA-256");
    await writeFile(join(dir,"source.json"),"{}");await writeFile(join(dir,"AAPL.json"),"[]");
    await expect(loadDataset(dir)).rejects.toThrow("SHA-256");
  });
  test("missing exchange sessions and duplicate calendar fail before use",async()=>{
    const {dir,manifest}=await fixture();manifest.calendar.splice(1,1);await save(dir,manifest);
    await expect(loadDataset(dir)).rejects.toThrow("calendar");
    manifest.calendar.splice(1,0,manifest.calendar[0]!);await save(dir,manifest);
    await expect(loadDataset(dir)).rejects.toThrow("unique");
  });
  test("file gaps fail even when newly hashed; invalid actions fail",async()=>{
    const {dir,manifest}=await fixture();const rows=JSON.parse(await readFile(join(dir,"AAPL.json"),"utf8"));rows.pop();
    const bytes=JSON.stringify(rows);await writeFile(join(dir,"AAPL.json"),bytes);manifest.files.AAPL!.sha256=sha256(bytes);await save(dir,manifest);
    await expect(loadDataset(dir)).rejects.toThrow("missing bars");
    rows.push(bar("2024-01-05",49));const good=JSON.stringify(rows);await writeFile(join(dir,"AAPL.json"),good);manifest.files.AAPL!.sha256=sha256(good);
    manifest.actions.push({type:"split",date:"2024-01-03",ticker:"AAPL",ratio:2});await save(dir,manifest);
    await expect(loadDataset(dir)).rejects.toThrow("Duplicate corporate action");
  });
  test("legacy fixtures remain labeled synthetic and independently immutable",async()=>{
    const d=await loadDataset();expect(d.kind).toBe("synthetic");expect(d.universe).toHaveLength(50);expect(d.version).toMatch(/^[a-f0-9]{64}$/);
  });
  test("bar schema rejects invalid domains, ordering, dates and bounds",()=>{
    for(const row of [{...bar("2024-01-02"),close:-1},{...bar("2024-01-02"),volume:-1},{...bar("2024-01-02"),high:90},{...bar("2024-01-02"),open:NaN},bar("2024-02-30")])expect(()=>validateBars([row],"A")).toThrow();
    expect(()=>validateBars([bar("2024-01-02"),bar("2024-01-02")],"A")).toThrow("unique");
    expect(()=>validateBars([bar("2024-01-03"),bar("2024-01-02")],"A")).toThrow("increasing");
  });
});
describe("NYSE calendar",()=>{
  test("exchange holidays and exceptional closures are excluded; early closes retained",()=>{
    expect(exchangeDates("2024-03-28","2024-04-01")).toEqual(["2024-03-28","2024-04-01"]);
    expect(exchangeDates("2024-11-28","2024-11-29")).toEqual(["2024-11-29"]);
    expect(exchangeDates("2025-01-09","2025-01-10")).toEqual(["2025-01-10"]);
    expect(exchangeDates("2012-10-29","2012-10-31")).toEqual(["2012-10-31"]);
    expect(exchangeDates("2022-06-17","2022-06-21")).toEqual(["2022-06-17","2022-06-21"]);
    expect(exchangeDates("2021-12-31","2022-01-03")).toEqual(["2021-12-31","2022-01-03"]);
    expect(exchangeDates("2024-01-01","2024-03-31")).toHaveLength(61);
    expect(()=>exchangeDates("1999-01-01","2000-01-01")).toThrow("Unsupported");
  });
});

test("versioned historical universe excludes HON while preserving the legacy universe",async()=>{
  const {getUniverse,UNIVERSE_VERSION,UNIVERSE_EXCLUSIONS}=await import("../src/config/universe.ts");
  expect(UNIVERSE_VERSION).toBe("v3");expect(getUniverse("v1")).toHaveLength(50);expect(getUniverse("v2")).toHaveLength(49);expect(getUniverse("v3")).toHaveLength(99);
  expect(getUniverse("v2")).toEqual(getUniverse("v1").filter(t=>t!=="HON"));
  expect(UNIVERSE_EXCLUSIONS.v2?.[0]?.ticker).toBe("HON");
  expect(UNIVERSE_EXCLUSIONS.v3?.map(x=>x.ticker)).toEqual(["HON","EA"]);
  expect(getUniverse("v3")).toContain("GOOG");expect(getUniverse("v3")).toContain("GOOGL");
});

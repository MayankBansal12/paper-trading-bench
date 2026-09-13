import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "../core/hash.ts";
import type { MarketDataset } from "../data/dataset.ts";
import { loadNDX } from "./reference.ts";
import type { StudyConfig } from "./runner.ts";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
/** Optional comparison eligibility; never alters simulation inputs or strategy. */
export async function qualifyStudyProfile(
  c: StudyConfig,
  market: MarketDataset,
) {
  if (c.kind === "quarter") {
    const d = new Date(`${c.start}T00:00:00Z`);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 0))
      .toISOString()
      .slice(0, 10);
    if (
      !c.start.endsWith("-01") ||
      ![0, 3, 6, 9].includes(d.getUTCMonth()) ||
      end !== c.end
    )
      throw new Error("Quarter requires a complete calendar quarter");
  }
  if (c.kind === "quarter" && market.kind !== "historical")
    throw new Error("Scored quarters require historical data");
  let reference: MarketDataset | undefined;
  if (c.reference)
    reference = await loadNDX(
      c.reference.dataDir,
      c.reference.datasetHash,
      c.start,
      c.end,
    );
  if (c.kind === "quarter") {
    if (!reference)
      throw new Error(
        "Scored quarter requires a frozen NDX reference with session opens and closes",
      );
    const manifest = read(join(c.dataDir, "manifest.json"));
    const firstSession = market.calendar.find((date) => date >= c.start);
    if (
      manifest.universeDefinition?.effectiveDate !== firstSession ||
      manifest.universeDefinition?.frozenThrough !== c.end ||
      manifest.universeDefinition?.indexSymbol !== "NDX" ||
      !manifest.universeRecord ||
      !manifest.snapshots?.some(
        (f: any) => contentHash(f) === contentHash(manifest.universeRecord),
      )
    )
      throw new Error(
        "Quarter requires its own frozen start-of-quarter membership evidence",
      );
    if (
      !manifest.universeDefinition.sources?.length ||
      manifest.universeDefinition.sources.some(
        (source: any) =>
          typeof source.asOf !== "string" ||
          source.asOf >= c.start ||
          typeof source.availableAt !== "string" ||
          !Number.isFinite(Date.parse(source.availableAt)) ||
          Date.parse(source.availableAt) >= Date.parse(c.start + "T00:00:00Z"),
      )
    )
      throw new Error("Membership evidence must predate the quarter");
    if (manifest.exclusions?.length)
      throw new Error(
        "Scored quarter refuses retrospectively excluded securities; qualify complete membership and corporate actions",
      );
  }
  return reference;
}

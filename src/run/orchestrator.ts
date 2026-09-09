// Ties data + engine + agent + persistence into one configurable batch run.
//
// Crash-safety / idempotency contract:
//   - Only ONE process may write a given run directory at a time (lock.ts).
//   - Each day's commit is: (1) write daily/<date>.json atomically, then
//     (2) append the date to state.completedDates and save state.json
//     atomically. state.json is the single source of truth for "is this day
//     done" — a crash between (1) and (2) leaves an "orphan" daily record
//     that resume must adopt (not re-simulate, which would re-invoke a real,
//     possibly non-deterministic, paid agent call for an already-decided
//     day) and then commit into state.completedDates itself.
//   - transactions.jsonl is derived, not appended — see persist.ts — so it
//     can never accumulate duplicate fills across a crash/resume.
//   - A no-op rerun of an already-"completed" run touches no files.

import { readFile } from "node:fs/promises";
import { calendarDates } from "../data/ohlcv.ts";
import { getUniverse } from "../config/universe.ts";
import { resolveDateRange } from "../engine/calendar.ts";
import { createInitialPortfolio } from "../engine/portfolio.ts";
import { computeMetrics } from "../engine/metrics.ts";
import { cashBaseline, buyAndHoldBaseline } from "../engine/baselines.ts";
import { runOneDay } from "./day.ts";
import { ensureConfig, loadRunState, resolveRunDir, saveRunState } from "./state.ts";
import { acquireRunLock } from "./lock.ts";
import { loadDailyRecord, writeDailyRecord, writeTransactions } from "./persist.ts";
import { writeFileAtomic } from "../utils/fs.ts";
import { runSummaryFile } from "../utils/paths.ts";
import type { AgentPort, DailyRecord, RunConfig, RunState, RunSummary, UsageStats } from "../domain/types.ts";

const RECENT_DAYS_WINDOW = 5;

const nowIso = () => new Date().toISOString();

async function readExistingSummary(dir: string): Promise<RunSummary | null> {
  try {
    return JSON.parse(await readFile(runSummaryFile(dir), "utf8")) as RunSummary;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** True only when `existing` is EXACTLY what re-deriving from the currently
 * committed daily records/config would produce — config, status, and the
 * complete equity curve (dates + net worths). Anything less (e.g. a crash
 * between `state.status = "completed"` and the transactions/summary rewrite
 * that follows it, leaving a shorter/stale summary.json beside a newer
 * completed state) must fall through to the normal rebuild path below rather
 * than being returned as if it were the true, already-derived answer. */
function summaryIsCurrent(existing: RunSummary | null, resolvedConfig: RunConfig, status: RunState["status"], equityCurve: readonly { date: string; netWorth: number }[]): existing is RunSummary {
  if (!existing) return false;
  if (existing.status !== status) return false;
  if (JSON.stringify(existing.config) !== JSON.stringify(resolvedConfig)) return false;
  if (existing.equityCurve.length !== equityCurve.length) return false;
  return existing.equityCurve.every((p, i) => p.date === equityCurve[i]!.date && p.netWorth === equityCurve[i]!.netWorth);
}

function sumUsage(records: readonly DailyRecord[]): UsageStats {
  return records.reduce<UsageStats>(
    (acc, r) => ({
      turns: acc.turns + r.usage.turns,
      toolCalls: acc.toolCalls + r.usage.toolCalls,
      failedToolCalls: acc.failedToolCalls + r.usage.failedToolCalls,
      promptTokens: acc.promptTokens + r.usage.promptTokens,
      completionTokens: acc.completionTokens + r.usage.completionTokens,
    }),
    { turns: 0, toolCalls: 0, failedToolCalls: 0, promptTokens: 0, completionTokens: 0 },
  );
}

/** Commit a day that's already fully decided (either just-simulated, or an
 * orphan daily record adopted as-is on resume) into state.completedDates. */
async function commitDay(dir: string, state: RunState, record: DailyRecord): Promise<void> {
  state.completedDates.push(record.date);
  state.lastNetWorth = record.portfolioAfter.netWorth;
  state.updatedAt = nowIso();
  if (record.terminated) state.status = "terminated";
  await saveRunState(dir, state); // checkpoint after every day — resumable at any interruption point
}

export async function runBatch(configInput: RunConfig, agent: AgentPort): Promise<{ runId: string; dir: string; summary: RunSummary }> {
  const { runId, dir } = resolveRunDir(configInput);
  const config: RunConfig = { ...configInput, runId };

  // Validate the resolved calendar range BEFORE touching disk at all — not
  // just before writing config.json, but before acquireRunLock's ensureDir
  // creates the run directory in the first place. A wholly invalid range
  // (e.g. --start/--end outside the fixture calendar) must leave zero
  // artifacts behind, so a corrected retry with the same --run-id never gets
  // rejected as "incompatible" against a directory the failed attempt itself
  // created. `config`'s own startDate/endDate/universeVersion are exactly
  // what ensureConfig below will persist (they're rigid fields, or — for
  // endDate — the monotonic extension ensureConfig applies verbatim), so
  // resolving against them here is equivalent to resolving against
  // resolvedConfig afterward.
  const universe = getUniverse(config.universeVersion);
  const fullCalendar = await calendarDates(universe);
  const dates = resolveDateRange(fullCalendar, config.startDate, config.endDate);

  const release = await acquireRunLock(dir);
  try {
    const resolvedConfig = await ensureConfig(dir, config);

    let state: RunState | null = await loadRunState(dir);
    if (!state) {
      state = {
        config: resolvedConfig,
        status: "active",
        completedDates: [],
        lastNetWorth: resolvedConfig.startingCapital,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await saveRunState(dir, state);
    } else if (JSON.stringify(state.config) !== JSON.stringify(resolvedConfig)) {
      // Keep state.json's embedded config in sync with config.json (e.g. an
      // endDate extension ensureConfig just applied) instead of leaving it stale.
      state.config = resolvedConfig;
      state.updatedAt = nowIso();
      await saveRunState(dir, state);
    }

    // Reconstruct in-memory history for already-completed dates (resume path)
    // BEFORE any no-op decision — the no-op fast path must be verified
    // against what's actually committed on disk, not assumed from state.json
    // alone (see summaryIsCurrent's doc comment).
    const allRecords: DailyRecord[] = [];
    let portfolio = createInitialPortfolio(resolvedConfig.startingCapital);
    for (const date of state.completedDates) {
      const record = await loadDailyRecord(dir, date);
      if (!record) throw new Error(`Run state lists ${date} as completed but daily/${date}.json is missing in ${dir}`);
      allRecords.push(record);
      portfolio = record.portfolioAfter;
    }

    // TRUE no-op fast path: everything requested is already completed and
    // persisted, AND the existing summary.json is byte-for-byte what
    // re-deriving from the committed daily records would produce right now —
    // so return it as-is instead of rewriting transactions.jsonl/summary.json
    // (a no-op rerun of a completed run must touch NO artifact's mtime). If
    // the stored summary is stale (e.g. a crash after `state.status` flipped
    // to "completed" but before transactions.jsonl/summary.json were
    // rewritten for an endDate extension), fall through and rebuild both.
    if (state.status === "completed" && dates.every((d) => state!.completedDates.includes(d))) {
      const existingSummary = await readExistingSummary(dir);
      const reconstructedCurve = allRecords.map((r) => ({ date: r.date, netWorth: r.portfolioAfter.netWorth }));
      if (summaryIsCurrent(existingSummary, resolvedConfig, state.status, reconstructedCurve)) {
        return { runId, dir, summary: existingSummary };
      }
    }

    let orderedRemaining = dates.filter((d) => !state!.completedDates.includes(d));

    // Adopt any orphan daily record(s): written to disk by a prior process
    // that crashed before committing them to state.completedDates. Adopting
    // instead of re-simulating avoids a duplicate real agent call and
    // guarantees the persisted decision for that day never silently changes.
    if (state.status !== "terminated") {
      while (orderedRemaining.length > 0) {
        const date = orderedRemaining[0]!;
        const orphan = await loadDailyRecord(dir, date);
        if (!orphan) break;
        allRecords.push(orphan);
        portfolio = orphan.portfolioAfter;
        await commitDay(dir, state, orphan);
        orderedRemaining = orderedRemaining.slice(1);
        if (orphan.terminated) break;
      }
    }

    // "terminated" is the only hard stop — a "completed" run can still pick up
    // MORE days if the caller extends --end and reuses the same --run-id.
    if (state.status !== "terminated") {
      for (const date of orderedRemaining) {
        const recentDays = allRecords.slice(-RECENT_DAYS_WINDOW);
        const record = await runOneDay(agent, resolvedConfig, date, universe, portfolio, recentDays);
        await writeDailyRecord(dir, record);
        portfolio = record.portfolioAfter;
        allRecords.push(record);
        await commitDay(dir, state, record);
        if (record.terminated) break;
      }
      if (state.status === "active" && state.completedDates.length >= dates.length) {
        state.status = "completed";
        state.updatedAt = nowIso();
        await saveRunState(dir, state);
      }
    }

    // Rebuilt every invocation (cheap at v0 scale) so it's always consistent
    // with whatever is actually committed, regardless of when a crash happened.
    await writeTransactions(dir, allRecords);

    const equityCurve = allRecords.map((r) => ({ date: r.date, netWorth: r.portfolioAfter.netWorth }));
    const tradeCount = allRecords.reduce((n, r) => n + r.fills.length, 0);
    const failedOrderCount = allRecords.reduce((n, r) => n + r.failedOrders.length, 0);
    const boundedStopCount = allRecords.filter((r) => r.boundedStop).length;
    const turnoverSeries = allRecords.map((r) => r.turnoverPct);
    const metrics = computeMetrics(equityCurve, resolvedConfig.startingCapital, tradeCount, failedOrderCount, boundedStopCount, turnoverSeries);

    // Baselines cover the FULL requested batch (not just days the agent
    // survived) so an early termination is visible against what a passive
    // strategy would have done over the same window.
    const cashCurve = cashBaseline(resolvedConfig.startingCapital, dates);
    const cashMetrics = computeMetrics(cashCurve, resolvedConfig.startingCapital, 0, 0, 0, dates.map(() => 0));
    const bh = await buyAndHoldBaseline(resolvedConfig.startingCapital, universe, dates);
    const bhMetrics = computeMetrics(bh.equityCurve, resolvedConfig.startingCapital, bh.tradeCount, 0, 0, bh.turnoverPct);

    const summary: RunSummary = {
      config: resolvedConfig,
      status: state.status,
      equityCurve,
      metrics,
      usageTotals: sumUsage(allRecords),
      baselines: {
        cash: { equityCurve: cashCurve, metrics: cashMetrics },
        buyAndHold: { equityCurve: bh.equityCurve, metrics: bhMetrics },
      },
    };
    await writeFileAtomic(runSummaryFile(dir), JSON.stringify(summary, null, 2) + "\n");

    return { runId, dir, summary };
  } finally {
    await release();
  }
}

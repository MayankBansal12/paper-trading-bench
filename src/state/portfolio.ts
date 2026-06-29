// Portfolio state read/write. All persistence is atomic via writeFileAtomic.
// Per the spec, the file is only rewritten after a fully successful session —
// callers MUST treat the in-memory state as the source of truth mid-session
// and call savePortfolio() exactly once at the end.

import { readFile } from "node:fs/promises";
import { PORTFOLIO_FILE } from "../utils/paths.ts";
import { writeFileAtomic, ensureDir } from "../utils/fs.ts";
import { formatDate, nowIso } from "../utils/dates.ts";
import type { PortfolioState } from "../types.ts";

const OPENING_BALANCE = 1000;
const TERMINATION_THRESHOLD = 10; // spec: net_worth < $10 = terminated

export function createInitialPortfolio(model?: string): PortfolioState {
  const now = nowIso();
  return {
    start_date: formatDate(new Date()),
    created_at: now,
    updated_at: now,
    opening_balance: OPENING_BALANCE,
    current_balance: OPENING_BALANCE,
    holdings_value: 0,
    holdings: {},
    net_worth: OPENING_BALANCE,
    net_pnl: 0,
    status: "active",
    ...(model ? { model } : {}),
  };
}

export async function loadPortfolio(): Promise<PortfolioState | null> {
  try {
    const raw = await readFile(PORTFOLIO_FILE, "utf8");
    return JSON.parse(raw) as PortfolioState;
  } catch (err: unknown) {
    // ENOENT is expected on first run — return null, caller initializes.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function portfolioExists(): Promise<boolean> {
  try {
    await readFile(PORTFOLIO_FILE, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function savePortfolio(state: PortfolioState): Promise<void> {
  await ensureDir(PORTFOLIO_FILE.replace(/\/[^/]+$/, ""));
  const stamped: PortfolioState = { ...state, updated_at: nowIso() };
  await writeFileAtomic(PORTFOLIO_FILE, JSON.stringify(stamped, null, 2) + "\n");
}

export function markTerminated(state: PortfolioState): PortfolioState {
  return { ...state, status: "terminated", updated_at: nowIso() };
}

export function isTerminated(state: PortfolioState): boolean {
  return state.status === "terminated" || state.net_worth < TERMINATION_THRESHOLD;
}

export { OPENING_BALANCE, TERMINATION_THRESHOLD };

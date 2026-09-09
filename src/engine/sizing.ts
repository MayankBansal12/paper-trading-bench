// Fill sizing: how many ticks a notional-sized order affords, and the exact
// cash a fill of a given size moves. Split out of execution.ts (round 9) to
// keep that file under the 300-line source-file limit — this module has no
// knowledge of OrderRequest/PortfolioState; it's pure tick/price arithmetic.

import { centsToDollars, MAX_UNITS, positionValueCents, UNIT_DECIMALS } from "./money.ts";
import { roundUnits } from "./portfolio.ts";

/** Smallest tradable increment: 1 unit at UNIT_DECIMALS precision. */
export const TICK = 10 ** -UNIT_DECIMALS;

/** The cash a fill moves: the change in the position's OWN value at the
 * fill price, computed EXACTLY (see `positionValueCents` in
 * engine/portfolio.ts) — the two position values are subtracted in BigInt
 * cents BEFORE ever becoming a `number`, so this can never suffer the
 * catastrophic-cancellation error that subtracting two independently
 * `round2`-ed dollar values would (round 9 fix: for a large position —
 * e.g. 50,000,000 units at $20 — `round2(newUnits*price) -
 * round2(existingUnits*price)` in plain doubles could return a
 * non-cent-quantized result like $0.019999980926513672 for a true $0.02
 * move). The final DELTA is converted via `centsToDollars`, exact for a
 * genuinely small delta (an ordinary partial fill) regardless of how large
 * the underlying position values being subtracted are — but round 10
 * correction: an earlier version of this comment claimed the delta is
 * ALWAYS bounded by portfolio cash (<= MAX_MONEY_USD), which is only true
 * for a BUY's transfer. A SELL's delta is the CHANGE in position value, and
 * for a full (or near-full) exit that change equals the position's entire
 * marked value, which is bounded by cash on neither side — see
 * MAX_MONEY_CENTS in engine/portfolio.ts. `executeOrder`
 * (engine/execution.ts) is responsible for rejecting a fill whose resulting
 * cash would leave the supported money domain BEFORE trusting this return
 * value; this function only guarantees the delta itself converts exactly
 * (via `centsToDollars`) or throws rather than silently rounding it. Always
 * >= 0 for newUnits >= existingUnits (value is monotonic in units), so this
 * doubles as |transfer| for both BUY (newUnits > existingUnits) and SELL
 * (newUnits < existingUnits, caller negates). */
export function valueDelta(existingUnits: number, newUnits: number, price: number): number {
  const deltaCents = positionValueCents(newUnits, price) - positionValueCents(existingUnits, price);
  return centsToDollars(deltaCents);
}

/** Both binary searches below need `hi` (and every `mid` derived from it) to
 * be an EXACT integer for the search to provably terminate: once a bound
 * exceeds this, adjacent doubles are no longer 1 apart, so
 * `Math.floor((lo+hi)/2)` can equal an existing endpoint and the search
 * stalls forever instead of narrowing (round 7 postmortem — see
 * MIN_PRICE_USD/MAX_UNITS in engine/portfolio.ts, which bound
 * executeOrder's inputs specifically to keep this invariant). This is a
 * canary, not the primary defense: executeOrder validates price/cash/
 * notional/existingUnits BEFORE calling either function below, so it should
 * never actually throw — if it does, some input reached here unvalidated. */
const MAX_SAFE_TICKS = Number.MAX_SAFE_INTEGER;

function assertSafeSearchBound(hi: number, fn: string): void {
  if (hi > MAX_SAFE_TICKS) {
    throw new Error(`${fn}: binary-search bound ${hi} exceeds Number.MAX_SAFE_INTEGER — caller must validate its inputs before calling (see engine/portfolio.ts MIN_PRICE_USD/MAX_MONEY_USD/MAX_UNITS).`);
  }
}

/** Largest additional tick count (>= 0) a notional-sized BUY can afford:
 * the max `k` such that valueDelta(existingUnits, existingUnits + k*TICK,
 * price) <= capBudget, WITHOUT the resulting holding exceeding MAX_UNITS.
 * `capBudget` is already a whole-cent value. Binary search over integer
 * ticks — `lo=0` is always feasible (existingUnits <= MAX_UNITS is already
 * validated by the caller).
 *
 * `hi` is capped by TWO independent, individually-sufficient bounds: the
 * budget-derived bound (its true, unrounded value exceeds capBudget by more
 * than the max possible rounding slack — a fill's transfer can exceed the
 * true value it represents by at most $0.01, two round2 calls each off by
 * at most half a cent — so it's provably budget-infeasible) and
 * `unitsHeadroomTicks + 1` (one tick past crossing MAX_UNITS, provably
 * ceiling-infeasible). Round 8 postmortem: capping `hi` by budget alone let
 * that $0.01 rounding slack push the ACCEPTED result ~0.005 units past
 * MAX_UNITS (e.g. an empty position, capBudget=MAX_MONEY_USD,
 * price=MIN_PRICE_USD) — the budget bound proves the search converges, not
 * that its winner respects the units ceiling, so that's a SEPARATE bound on
 * `hi` and an explicit per-candidate condition in the loop below (capping
 * only `hi` would still let an earlier, budget-only `mid` above
 * `unitsHeadroomTicks` be accepted into `lo`). */
export function maxBuyTicks(existingUnits: number, price: number, capBudget: number): number {
  const unitsHeadroomTicks = Math.max(0, Math.round((MAX_UNITS - existingUnits) / TICK));
  let lo = 0;
  let hi = Math.min(Math.max(1, Math.ceil((capBudget + 0.02) / (price * TICK))), unitsHeadroomTicks + 1);
  assertSafeSearchBound(hi, "maxBuyTicks");
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = roundUnits(existingUnits + mid * TICK);
    if (mid <= unitsHeadroomTicks && valueDelta(existingUnits, candidate, price) <= capBudget) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Mirror of maxBuyTicks for a notional-sized SELL: largest tick count (>=
 * 0, capped at the held position) whose cash RECEIVED (-valueDelta) stays
 * within capBudget. `hi = heldTicks + 1` is always structurally infeasible
 * (selling more than held), which bounds the search without needing a
 * separate rounding-slack argument. */
export function maxSellTicks(existingUnits: number, price: number, capBudget: number): number {
  const heldTicks = Math.round(existingUnits / TICK);
  let lo = 0;
  let hi = heldTicks + 1;
  assertSafeSearchBound(hi, "maxSellTicks");
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = roundUnits(existingUnits - mid * TICK);
    const transfer = -valueDelta(existingUnits, candidate, price);
    if (mid <= heldTicks && transfer <= capBudget) lo = mid;
    else hi = mid;
  }
  return lo;
}

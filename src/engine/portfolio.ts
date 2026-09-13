// Portfolio state: creation, mark-to-market valuation, and applying a fill.
// All money rounds to 2dp; all share counts round to UNIT_DECIMALS (6dp) so
// fractional-share math is deterministic and never accumulates float drift
// in the persisted JSON. Exact-arithmetic/bounds primitives live in
// engine/money.ts (split out round 10 to keep this file under 300 lines).

import type { Fill, Holdings, PortfolioState } from "../domain/types.ts";
import { assertWithinMoneyDomain, centsToDollars, dollarsToCents, positionValueCents, UNIT_DECIMALS } from "./money.ts";

export const CASH_DECIMALS = 2;
export { UNIT_DECIMALS };

/** Floor the canonical decimal representation of a JS number. Multiplying
 * first (`Math.floor(n * scale)`) is unreliable at large magnitudes: the
 * product can land just below an exact tick. An epsilon/ULP snap is also not
 * a floor because a genuine value immediately below a tick is
 * indistinguishable from representation noise. `Number#toString` gives the
 * shortest decimal that round-trips to the caller's number, so parsing that
 * decimal into integer ticks preserves canonical grid values while never
 * rounding a raw request upward. */
function decimalFloor(n: number, decimals: number): number {
  if (!Number.isFinite(n)) throw new RangeError(`Cannot quantize non-finite value ${n}`);
  const rendered = n.toString().toLowerCase();
  const negative = rendered.startsWith("-");
  const unsigned = negative ? rendered.slice(1) : rendered;
  const [coefficient, exponentText] = unsigned.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = coefficient!.split(".");

  // Fast path for persisted grid values and ordinary raw inputs already on
  // the requested decimal grid.
  if (exponentText === undefined && fraction.length <= decimals) return n;

  const digits = BigInt(`${whole}${fraction}`);
  const shift = exponent - fraction.length + decimals;
  let magnitude: bigint;
  if (shift >= 0) {
    magnitude = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    magnitude = digits / divisor;
    if (negative && digits % divisor !== 0n) magnitude += 1n;
  }
  const ticks = negative ? -magnitude : magnitude;
  if (ticks > BigInt(Number.MAX_SAFE_INTEGER) || ticks < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`Quantized tick count for ${n} exceeds Number's safe-integer range`);
  }
  return Number(ticks) / 10 ** decimals;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
/** Round DOWN to 2dp — used for a fill's cash notional so it can never
 * exceed the true (pre-rounding) unit*price cost, unlike nearest-rounding
 * which can inflate a sub-cent notional above what was actually earned/spent
 * (e.g. a $0.015 true cost must never fill for $0.02). */
export const floorCents = (n: number) => decimalFloor(n, CASH_DECIMALS);
export const roundUnits = (n: number) => {
  const f = 10 ** UNIT_DECIMALS;
  return Math.round(n * f) / f;
};
/** Strict raw-order floor. Persisted/internal values use `roundUnits`, whose
 * provenance is known; raw caller input never gets an ULP-based upward snap. */
export const floorUnits = (n: number) => decimalFloor(n, UNIT_DECIMALS);

/** A run terminates once net worth falls below 1% of starting capital (legacy engine utility; the daily study does not terminate at this threshold). */
export const TERMINATION_FRACTION = 0.01;

export function isTerminated(portfolio: PortfolioState, startingCapital: number): boolean {
  return portfolio.netWorth < startingCapital * TERMINATION_FRACTION;
}

export function createInitialPortfolio(startingCapital: number): PortfolioState {
  if (!Number.isFinite(startingCapital) || startingCapital <= 0) throw new RangeError("Starting capital must be finite and positive");
  return {
    cash: round2(startingCapital),
    holdings: {},
    holdingsValue: 0,
    netWorth: round2(startingCapital),
  };
}

/** Recompute holdingsValue/netWorth from a price lookup. Pure — does not
 * touch cash. Round 10 fix: aggregates in BigInt cents (each holding's mark
 * gated against the closed per-position money domain via
 * `assertWithinMoneyDomain`, see MAX_MONEY_CENTS in engine/money.ts) and
 * converts to dollars ONCE at the end, rather than summing per-holding
 * `number`s that could each already be silently lossy — see
 * `positionValue`'s comment (engine/money.ts) for why the old "bounded by
 * net worth" assumption this replaced was wrong. The AGGREGATE
 * (holdingsValue/netWorth) is deliberately NOT re-gated against
 * MAX_MONEY_CENTS here: unlike a single position's mark (which can only
 * reach an unsafe magnitude via a precision-losing computation), a
 * multi-position portfolio's total can exceed MAX_MONEY_USD while every
 * contributing value stays cent-exact and small (e.g. several holdings each
 * legitimately worth hundreds of millions) — that's a real portfolio value,
 * not a corrupted one, so only the exact-precision floor in
 * `centsToDollars` applies to the sum. */
export function valuePortfolio(
  portfolio: PortfolioState,
  priceLookup: (ticker: string) => number,
): PortfolioState {
  let holdingsValueCents = 0n;
  const holdings: Holdings = {};
  for (const [ticker, h] of Object.entries(portfolio.holdings)) {
    const price = priceLookup(ticker);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(h.units) || h.units < 0) throw new RangeError(`Invalid valuation input for ${ticker}`);
    const cents = positionValueCents(h.units, price);
    assertWithinMoneyDomain(cents, `Marking ${ticker} at $${price}`);
    holdings[ticker] = { ...h, lastClose: price, value: centsToDollars(cents) };
    holdingsValueCents += cents;
  }
  const netWorthCents = dollarsToCents(portfolio.cash) + holdingsValueCents;
  return {
    ...portfolio,
    holdings,
    holdingsValue: centsToDollars(holdingsValueCents),
    netWorth: centsToDollars(netWorthCents),
  };
}

/** Apply an already-validated fill: move cash, update the position's
 * weighted avg cost. Round 10 fix: same BigInt-cents aggregation as
 * `valuePortfolio` above, for the same reason — a fill's own transfer
 * (engine/sizing.ts's `valueDelta`) is exact regardless of position scale,
 * but the RESULTING position's absolute marked value isn't automatically
 * bounded by that transfer (see `positionValue`'s comment in
 * engine/money.ts), so it must be gated here too, not just trusted. */
export function applyFill(portfolio: PortfolioState, fill: Fill): PortfolioState {
  const existing = portfolio.holdings[fill.ticker];
  const holdings = { ...portfolio.holdings };

  if (fill.side === "BUY") {
    const newUnits = roundUnits((existing?.units ?? 0) + fill.units);
    const newAvgCost = existing
      ? (existing.units * existing.avgCost + fill.units * fill.price) / newUnits
      : fill.price;
    const cents = positionValueCents(newUnits, fill.price);
    assertWithinMoneyDomain(cents, `${fill.ticker} position value after this BUY`);
    holdings[fill.ticker] = {
      units: newUnits,
      avgCost: round2(newAvgCost),
      lastClose: fill.price,
      value: centsToDollars(cents),
    };
  } else {
    const remaining = roundUnits((existing?.units ?? 0) - fill.units);
    if (remaining <= 0) {
      delete holdings[fill.ticker];
    } else {
      const cents = positionValueCents(remaining, fill.price);
      assertWithinMoneyDomain(cents, `${fill.ticker} position value after this SELL`);
      holdings[fill.ticker] = {
        ...existing!,
        units: remaining,
        lastClose: fill.price,
        value: centsToDollars(cents),
      };
    }
  }

  // Sum in BigInt cents, not `number`s: every `h.value` here is already
  // exact/cent-quantized (produced by `centsToDollars` above or by a prior
  // `valuePortfolio`/`applyFill` call), but summing several large `number`s
  // can itself lose precision the way the old
  // `positionValue`-then-`+`-then-`round2` chain did — `dollarsToCents`
  // recovers each holding's exact cents losslessly since it's already
  // cent-quantized (see its own comment). Not re-gated against
  // MAX_MONEY_CENTS — see `valuePortfolio`'s comment on why the aggregate is
  // allowed past that per-position ceiling.
  let holdingsValueCents = 0n;
  for (const h of Object.values(holdings)) holdingsValueCents += dollarsToCents(h.value);
  const netWorthCents = dollarsToCents(fill.cashAfter) + holdingsValueCents;
  return {
    cash: fill.cashAfter,
    holdings,
    holdingsValue: centsToDollars(holdingsValueCents),
    netWorth: centsToDollars(netWorthCents),
  };
}

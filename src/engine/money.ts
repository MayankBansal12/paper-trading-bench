// Exact-arithmetic money primitives: the safe input/output domain this
// engine accepts for price/cash/units, and BigInt-cents conversion helpers
// that keep position/portfolio values cent-exact at any reachable scale.
// Split out of engine/portfolio.ts (round 10) to keep that file under the
// 300-line source-file limit once it started enforcing MAX_MONEY_CENTS.

export const UNIT_DECIMALS = 6;

/** Safe range for any money value this engine accepts as INPUT — starting
 * capital (cli/run.ts, after normalization) and, defensively, portfolio
 * cash/order notional (engine/execution.ts) — chosen so cent-scale
 * (round2/floorCents) arithmetic never approaches float precision loss or
 * overflow. MIN_MONEY_USD also rejects a sub-cent starting capital that
 * would otherwise round to $0 and turn every downstream percentage metric
 * (metrics.ts totalReturnPct etc.) into NaN. Price uses the SEPARATE,
 * tighter MIN_PRICE_USD floor below — see its comment for why $0.01 is not
 * safe as a price bound even though it's fine as a cash/capital bound. */
export const MIN_MONEY_USD = 0.01;
export const MAX_MONEY_USD = 1e9;

/** Price floor for execution.ts (round 7 fix; distinct from MIN_MONEY_USD,
 * which continues to bound starting capital/cash/notional). The v1 defense
 * (round 6) bounded price to [MIN_MONEY_USD, MAX_MONEY_USD] = [$0.01, $1e9]
 * on the theory that this kept maxBuyTicks/maxSellTicks' budget/(price*TICK)
 * quotient far below double-overflow. It does — but overflow-to-Infinity
 * isn't the only failure mode: that quotient becomes the binary search's
 * `hi` tick count, and once `hi` exceeds Number.MAX_SAFE_INTEGER (2**53-1 ≈
 * 9.007e15), `hi`/`lo`/`mid` are no longer exact integers, so
 * `Math.floor((lo+hi)/2)` can equal an existing endpoint and the search
 * stalls without ever reaching `hi - lo <= 1` — a silent hang, not a thrown
 * overflow, caught by round 7's reviewer via a real 3s-timeout probe at the
 * accepted boundary (BUY: cash/notional=MAX_MONEY_USD, price=$0.01 ->
 * hi≈1.0000000002e17, ~11x over budget). Worst-case hi is
 * (MAX_MONEY_USD+0.02)/(MIN_PRICE_USD*TICK) (TICK=10**-UNIT_DECIMALS,
 * execution.ts) — MIN_PRICE_USD=$1.00 keeps that at ~1.0e15, comfortably
 * (~9x) under the safe-integer ceiling. No fixture price is anywhere near
 * $1 (fixtures/ohlcv/*.json minimum is $20.17), so this floor never affects
 * real universe data — it only narrows the defensive/adversarial-input
 * range. See also MAX_UNITS below for the symmetric SELL-side bound. */
export const MIN_PRICE_USD = 1.0;

/** Defensive ceiling on any single position's unit count. Two independent
 * enforcement points in engine/execution.ts:
 *  1. A PRECONDITION on `existingUnits` (round 7 fix, companion to
 *     MIN_PRICE_USD above), checked before either sizing path runs.
 *     maxSellTicks derives its own binary search bound as `heldTicks =
 *     existingUnits / TICK`, so an oversized `existingUnits` hangs it
 *     exactly like an oversized capBudget hangs maxBuyTicks — and unlike
 *     capBudget, `existingUnits` isn't bounded by any CLI-validated input:
 *     it comes from persisted/resumed portfolio state (or a
 *     directly-constructed PortfolioState in a test), so it must be
 *     validated at the point of use, defensively, regardless of provenance.
 *  2. An INVARIANT on the RESULTING holding of every accepted BUY (round 8
 *     fix): maxBuyTicks bounds its search by remaining MAX_UNITS headroom,
 *     and a units-sized BUY is rejected outright if it would cross the
 *     ceiling. This is NOT implied by (1) plus the input bounds above —
 *     round 7's reasoning that "a run can never legitimately accumulate
 *     more than MAX_MONEY_USD / MIN_PRICE_USD units in one ticker" treated
 *     that quotient as a hard ceiling on the fill math, but maxBuyTicks'
 *     cent-rounding slack (a fill's transfer can round up to $0.01 above
 *     its true cost) let the ACCEPTED result land up to ~0.005 units past
 *     it: a notional BUY of MAX_MONEY_USD at MIN_PRICE_USD into an empty
 *     position sized to 1,000,000,000.004999 units before the round 8 fix.
 *     Capital/price bounds alone bound the search's INPUT domain (keeping
 *     it representable/terminating); they do not by themselves bound its
 *     OUTPUT, which is why (2) has to be checked separately on every
 *     accepted transition rather than assumed from (1).
 * At MAX_UNITS, heldTicks = 1e9 / 1e-6 = 1e15 — the same ~9x safe-integer
 * margin as MIN_PRICE_USD gives the BUY path. */
export const MAX_UNITS = 1e9;

/** The closed domain a single persisted money SCALAR — cash, a single
 * position's marked value, a fill's own resulting cash or resulting
 * position value — must stay inside: the same $0-$MAX_MONEY_USD range
 * already enforced on cash/notional/price INPUTS (see MAX_MONEY_USD above),
 * now also enforced on values that only ever arise from a fill or a
 * mark-to-market, not from a caller-supplied input. Round 10 fix: earlier
 * rounds bounded price and MAX_UNITS INDEPENDENTLY for
 * binary-search-termination safety, but their PRODUCT (a position marked at
 * up to MAX_MONEY_USD/share while holding up to MAX_UNITS shares) reaches
 * $1e18 — 9 orders of magnitude past both this domain ceiling and the
 * ~$90.07 trillion point where a BigInt cents value stops converting
 * exactly to a `number` (see MAX_SAFE_CENTS below). Without this check,
 * `valuePortfolio`/`applyFill` (engine/portfolio.ts) and `executeOrder`
 * (engine/execution.ts) silently accepted a lossy or out-of-domain mark/fill
 * instead of rejecting it — see call sites of `assertWithinMoneyDomain`.
 * Round 12 correction: an earlier version of this comment also listed
 * "aggregate holdings value, net worth" as bound by this ceiling — wrong.
 * Only a single scalar is gated; a multi-position portfolio's
 * `holdingsValue`/`netWorth` is deliberately NOT re-gated against it and may
 * legitimately exceed it while every contributing position stays
 * cent-exact and individually in-domain (see `valuePortfolio`'s comment in
 * engine/portfolio.ts and PRODUCT.md's round 10 correction). */
export const MAX_MONEY_CENTS = BigInt(Math.round(MAX_MONEY_USD * 100));

/** BigInt cents beyond which `Number(cents)` is no longer an exact integer
 * (`Number.MAX_SAFE_INTEGER` = 2**53-1 ≈ 9.007e15, i.e. ≈$90.07 trillion).
 * This is ~90,000x looser than MAX_MONEY_CENTS above, so every real call
 * site gates on MAX_MONEY_CENTS (via `assertWithinMoneyDomain`) well before
 * reaching this — it exists purely as a last-resort canary in
 * `centsToDollars`, mirroring `assertSafeSearchBound` in engine/sizing.ts:
 * if this ever throws, some caller converted a value to dollars without
 * first gating it against MAX_MONEY_CENTS. */
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

/** Convert exact integer cents to dollars, exactly — see MAX_SAFE_CENTS. */
export function centsToDollars(cents: bigint): number {
  const abs = cents < 0n ? -cents : cents;
  if (abs > MAX_SAFE_CENTS) {
    throw new Error(
      `centsToDollars: ${cents} cents is beyond the safe exact-precision range (Number.MAX_SAFE_INTEGER cents) — caller must gate its price/units inputs against MAX_MONEY_CENTS before converting to dollars.`,
    );
  }
  return Number(cents) / 100;
}

/** Recover the exact integer cents a `round2`-quantized dollar amount
 * represents. Safe (no precision loss) for any `usd` this engine persists,
 * since every persisted dollar amount is itself produced by `centsToDollars`
 * above and is therefore already cent-quantized and within MAX_MONEY_CENTS. */
export function dollarsToCents(usd: number): bigint {
  return BigInt(Math.round(usd * 100));
}

/** Throws if `cents` falls outside the closed money domain
 * [-MAX_MONEY_CENTS, MAX_MONEY_CENTS] — see MAX_MONEY_CENTS above. `label`
 * identifies what was being computed (a ticker's marked value, aggregate
 * holdings value, net worth, ...) for the error message. Only ever expected
 * to fire for adversarial/corrupted inputs or an extreme price move on a
 * MAX_UNITS-scale position (never with this benchmark's fixed, realistic
 * universe fixtures and $1,000 starting capital) — see MAX_MONEY_CENTS. */
export function assertWithinMoneyDomain(cents: bigint, label: string): void {
  const abs = cents < 0n ? -cents : cents;
  if (abs > MAX_MONEY_CENTS) {
    const dollars = cents / 100n; // truncated, just for the error message
    throw new Error(
      `${label} is $${dollars} (${cents} cents), outside the supported $${-MAX_MONEY_USD}-$${MAX_MONEY_USD} money domain (MAX_MONEY_CENTS).`,
    );
  }
}

/** Decompose a finite, non-negative double into the EXACT rational number it
 * represents (`num / den`, `den` a power of two) by reading its IEEE754
 * bits directly — every finite double is exactly `mantissa * 2**exponent`,
 * so this loses no information regardless of how many decimal digits the
 * value "looks like" it has (33.333333 is just as exact here as 20.00).
 * This is what lets `positionValueCents` below avoid assuming `price` is
 * cent-quantized (execution.ts's own convention is price-agnostic — it
 * "fills at whatever price the caller passes") while still being exact. */
function exactRational(x: number): { num: bigint; den: bigint } {
  if (x === 0) return { num: 0n, den: 1n };
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = x;
  const bits = new BigUint64Array(buf)[0]!;
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn;
  let exponent: number;
  if (rawExponent === 0) {
    exponent = -1074; // subnormal: no implicit leading bit
  } else {
    mantissa |= 0x10000000000000n; // restore the implicit leading 1 bit
    exponent = rawExponent - 1075; // unbias (1023) and account for the 52 mantissa bits
  }
  let num = mantissa;
  let den = 1n;
  if (exponent >= 0) num <<= BigInt(exponent);
  else den <<= BigInt(-exponent);
  return { num, den };
}

/** Exact value (in integer cents) of `units` shares at `price`.
 *
 * `units` is snapped to its EXACT intended micro-unit tick count
 * (`Math.round(units * 10**UNIT_DECIMALS)`, an exact integer — safe up to
 * MAX_UNITS since units*1e6 <= 1e15 stays under 2**53) rather than read via
 * `exactRational`: `units` is only ever a value `roundUnits`/`floorUnits`
 * already snapped to the 6dp tick grid, so its intended value IS an
 * integer tick count, but the double `roundUnits` returns can carry a tiny
 * (~1e-7-scale near MAX_UNITS) representational error from the final
 * `.../10**UNIT_DECIMALS` division — reading that noisy double's exact bit
 * value would faithfully reproduce the noise instead of the intended tick
 * count. Re-rounding recovers the intended integer exactly (the noise is
 * always far below 0.5 ticks). `price`, by contrast, is NOT assumed to be
 * tick- or cent-quantized (execution.ts's convention is price-agnostic, and
 * callers — including tests — legitimately pass arbitrary-precision prices
 * like 33.333333), so it's read via `exactRational` instead of a rounded
 * scale, losing no information regardless of its decimal precision.
 *
 * Combining an exact tick count with `price`'s exact bit value and doing
 * the whole computation in BigInt means this can never suffer the
 * double-precision rounding error `round2(units * price)` accumulates once
 * `units * price * 100` exceeds 2**53 (~9.007e15) — e.g. a position near
 * MAX_UNITS priced near MAX_MONEY_USD needs ~20 significant decimal digits,
 * but a double only carries ~15-17. Only the final division back down to
 * cents needs rounding, done here as round-half-up to match `Math.round`'s
 * behavior on the non-negative values this ledger only ever deals in (no
 * shorting, no negative prices). */
export function positionValueCents(units: number, price: number): bigint {
  const unitsMicros = BigInt(Math.round(units * 10 ** UNIT_DECIMALS));
  const p = exactRational(price);
  const numerator = unitsMicros * p.num * 100n;
  const denom = p.den * BigInt(10 ** UNIT_DECIMALS);
  const quotient = numerator / denom;
  const remainder = numerator % denom;
  return remainder * 2n >= denom ? quotient + 1n : quotient;
}

/** `positionValueCents` converted to dollars (2dp). Round 10 correction: an
 * earlier version of this comment claimed every call site's value is
 * "bounded by the portfolio's own net worth (<= MAX_MONEY_USD)" and
 * therefore always safe to convert directly — that bound only actually
 * holds for a BUY's fill transfer (capped by pre-fill cash), not for a
 * position's MARKED value, which can grow past it via ordinary price
 * appreciation on a large enough holding (see MAX_MONEY_CENTS above for the
 * concrete repro: MAX_UNITS shares marked at a price near MAX_MONEY_USD
 * values the position at ~$1e18). Callers that persist this result
 * (engine/portfolio.ts's `valuePortfolio`/`applyFill`) MUST gate the input
 * `cents` with `assertWithinMoneyDomain` first; `centsToDollars` below only
 * catches the much looser precision-loss boundary (MAX_SAFE_CENTS), not the
 * $MAX_MONEY_USD domain one. Callers computing a DELTA between two position
 * values (engine/sizing.ts's `valueDelta`) must subtract in
 * `positionValueCents`' BigInt domain FIRST and convert only the
 * (always-small) result — never subtract two `positionValue()` outputs,
 * which reintroduces the same cancellation error this exists to avoid. */
export function positionValue(units: number, price: number): number {
  return centsToDollars(positionValueCents(units, price));
}

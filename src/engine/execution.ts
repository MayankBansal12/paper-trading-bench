// Order execution. Convention (documented in README/PRODUCT.md):
//   Decisions for day D are made using bars with date < D only (D's own
//   session hasn't happened yet from the agent's point of view — see
//   data/ohlcv.ts asOfBefore()). Orders for day D fill AT day D's OPEN — the
//   first price actually observable once D exists. End-of-day mark-to-market
//   (net worth, termination check, equity curve) uses D's CLOSE. No
//   slippage, no fees. This function is convention-agnostic: it just fills
//   at whatever `price` the caller passes, so it's reused unchanged for
//   open-price execution and close-price valuation, and for the
//   buy-and-hold baseline (see engine/baselines.ts).
//
// Cent-ledger rule (v4, round 9): a fill's cash transfer is defined as the
// CHANGE in the position's own value at the fill price, computed EXACTLY in
// integer cents (see `positionValueCents`/`valueDelta` — engine/portfolio.ts
// and engine/sizing.ts) rather than by subtracting two independently
// `round2`-ed dollar values: for large positions (e.g. 50,000,000 units at
// $20), subtracting two big rounded doubles suffers catastrophic
// cancellation and need not itself be a whole-cent amount. `applyFill`
// (engine/portfolio.ts) stores a position's `.value` with that same exact
// helper (`positionValue`), so a fill's cash movement and the resulting
// holdings-value movement are ALWAYS the same number: cash + holdings value
// at the fill price is conserved to the cent, every time, not just
// approximately. (v1 floored each fill's own notional to cents while the
// aggregate position value rounded to nearest — two different rounding
// boundaries that could each drift the ledger by a cent per fill. v2/v3
// fixed the rounding BOUNDARY but still did the arithmetic in
// double-precision `round2(units * price)`, which is only cent-exact up to
// ~2**53 cents (~$90 trillion) of raw units*price*100 headroom — a
// MAX_UNITS-scale position priced in the hundreds of thousands of dollars
// or more could already exceed that. v4 computes every position value in
// BigInt cents instead, which is exact at any magnitude this engine's
// documented MAX_UNITS/MAX_MONEY_USD bounds allow.)
//
// A notional-sized order's requested USD is first reduced to a whole-cent
// budget (floorCents) — the ledger only ever deals in whole cents — and
// units are sized as the MOST the position can move within that budget
// without the resulting transfer exceeding it AND without the resulting
// holding exceeding MAX_UNITS (see maxBuyTicks/maxSellTicks in
// engine/sizing.ts). A units-sized order's units are taken as given
// (floored to UNIT_DECIMALS) and the transfer is whatever the cent-ledger
// rule says that costs — there is no budget or ceiling to size down to, so
// it can instead be rejected for insufficient cash, a resulting holding
// above MAX_UNITS (BUY), or an oversized sell (SELL).
//
// MAX_UNITS (v3, round 8): a BUY's resulting holding must never exceed
// MAX_UNITS — enforced on the OUTCOME of every accepted BUY, not just as a
// precondition on pre-fill existingUnits, since maxBuyTicks' cent-rounding
// slack could otherwise size an accepted fill past the true ceiling (see its
// doc comment in engine/sizing.ts). Changes which BUYs are ACCEPTED at the
// extreme price/capital/held-units boundary, so EXECUTION_CONVENTION bumped
// to _v3 (and again to _v4 for round 9's exact-arithmetic fix above, which
// changes accepted fill quantities/values for large positions).
//
// Resulting-position money-domain gate (v6, round 11): round 10's post-fill
// CASH check for SELL missed two holes — the position a PARTIAL sell leaves
// behind, and a BUY's resulting position (never checked at all, since
// MAX_UNITS bounds unit COUNT, not marked VALUE). Both let executeOrder hand
// back a "fill" that applyFill's own assertWithinMoneyDomain then throws on,
// turning a per-order rejection into a batch-aborting exception (runOneDay).
// Both BUY and SELL now compute the exact resulting position in BigInt
// cents and reject as a FailedOrder if it would leave the domain.

import type { Fill, FailedOrder, OrderRequest, PortfolioState } from "../domain/types.ts";
import { dollarsToCents, MAX_MONEY_CENTS, MAX_MONEY_USD, MAX_UNITS, MIN_PRICE_USD, positionValueCents } from "./money.ts";
import { floorCents, floorUnits, round2, roundUnits } from "./portfolio.ts";
import { maxBuyTicks, maxSellTicks, TICK, valueDelta } from "./sizing.ts";

/** Canonical identifier for the causal convention this engine implements.
 * Stored in RunConfig and folded into a run's identity hash (run/state.ts)
 * so a future convention change can never be silently applied to — or
 * silently mixed into — an existing run directory. Bump the suffix any time
 * this file's causal semantics change. (v2: cent-ledger fill accounting;
 * v3: MAX_UNITS enforced on accepted-BUY outcomes; v4: cent-ledger
 * arithmetic redone in exact BigInt cents instead of double `round2`; v5,
 * round 10: a SELL whose exact post-fill cash would leave the money domain
 * is now rejected instead of accepted with a cash value a later
 * precondition would then reject as "corrupted"; v6, round 11: a BUY's/
 * SELL's exact RESULTING POSITION value is now also gated against that
 * domain; v7, round 12: scale-aware ULP snapping; v8, round 13: raw order
 * sizes use canonical-decimal flooring and full exits require an exact
 * quantized match, restoring the no-round-up/no-oversell invariant.) */
export const EXECUTION_CONVENTION = "asof-before-D_exec-open-D_eod-close-D_v8";

export type ExecutionResult = { fill: Fill } | { failed: FailedOrder };

/** A fill whose cash transfer would round to below this is rejected instead
 * of silently moving units for near-zero cash — an unconserved free-share
 * (or free-cash) bug. */
export const MIN_NOTIONAL_USD = 0.01;

function fail(date: string, ticker: string, side: OrderRequest["side"], reason: string): ExecutionResult {
  return { failed: { date, ticker, side, reason } };
}

export function executeOrder(
  order: OrderRequest,
  price: number,
  portfolio: PortfolioState,
  date: string,
): ExecutionResult {
  const ticker = order.ticker;
  const requestedRaw = order.sizing.kind === "notional" ? order.sizing.usd : order.sizing.units;
  if (!(requestedRaw > 0)) {
    return fail(date, ticker, order.side, `Order size must be positive, got ${requestedRaw}`);
  }
  if (!(price > 0) || !Number.isFinite(price)) {
    return fail(date, ticker, order.side, `No valid price for ${ticker} on ${date}`);
  }
  // Defensive safe-range checks independent of any caller-side validation
  // (e.g. cli/run.ts's --starting-capital bound): maxBuyTicks/maxSellTicks
  // (engine/sizing.ts) divide a budget (or heldTicks) by/into `price * TICK`
  // to size their binary-search upper bound, which silently overflows to
  // Infinity — or, once past Number.MAX_SAFE_INTEGER but before actual
  // overflow, silently loses the integer precision the search's progress
  // guarantee depends on, which also hangs it (round 7 postmortem:
  // MIN_PRICE_USD and MAX_UNITS below exist specifically to keep every
  // accepted combination — not just each bound individually — under that
  // safe-integer ceiling; see their comments in engine/portfolio.ts).
  // Bounding all four inputs here (price, cash, notional, held units) keeps
  // this function from ever hanging regardless of what constructed
  // `order`/`portfolio`.
  if (price < MIN_PRICE_USD || price > MAX_MONEY_USD) {
    return fail(date, ticker, order.side, `Price $${price} for ${ticker} on ${date} is outside the supported safe range ($${MIN_PRICE_USD}-$${MAX_MONEY_USD}).`);
  }
  if (!Number.isFinite(portfolio.cash) || portfolio.cash > MAX_MONEY_USD) {
    return fail(date, ticker, order.side, `Portfolio cash $${portfolio.cash} is outside the supported safe range (max $${MAX_MONEY_USD}).`);
  }
  if (order.sizing.kind === "notional" && (!Number.isFinite(order.sizing.usd) || order.sizing.usd > MAX_MONEY_USD)) {
    return fail(date, ticker, order.side, `Order notional ${order.sizing.usd} is outside the supported safe range (max ${MAX_MONEY_USD}).`);
  }
  if (order.sizing.kind === "units" && (!Number.isFinite(order.sizing.units) || order.sizing.units > MAX_UNITS)) {
    return fail(date, ticker, order.side, `Order units ${order.sizing.units} are outside the supported MAX_UNITS safe range (max ${MAX_UNITS}).`);
  }

  const existingUnits = portfolio.holdings[ticker]?.units ?? 0;
  // Defensive: `existingUnits` comes from persisted/resumed state (or a
  // directly-constructed PortfolioState in a test), not from any
  // CLI-validated input, so it can't be bounded upstream the way price/cash/
  // notional are above. maxSellTicks' `heldTicks = existingUnits / TICK`
  // hangs exactly like maxBuyTicks' capBudget-derived `hi` does once this
  // exceeds the safe-integer ceiling (see MAX_UNITS' comment).
  if (!Number.isFinite(existingUnits) || existingUnits < 0 || existingUnits > MAX_UNITS) {
    return fail(date, ticker, order.side, `Held units ${existingUnits} for ${ticker} are outside the supported safe range (0-${MAX_UNITS}); refusing to size against corrupted holdings state.`);
  }

  if (order.side === "BUY") {
    const sizing = order.sizing;
    // The whole-cent budget (floorCents) is what actually gets spent — see
    // the module comment's "Cent-ledger rule" — so it's also what must be
    // checked against cash. Comparing the RAW pre-floor usd here (v1 bug)
    // rejected e.g. a $10.009 request with exactly $10.00 cash even though
    // its floored budget is exactly $10.00 and would fill in full.
    let notionalBudget: number | null = null;
    if (sizing.kind === "notional") {
      notionalBudget = floorCents(sizing.usd);
      if (notionalBudget > portfolio.cash) {
        return fail(
          date,
          ticker,
          "BUY",
          `Insufficient cash: requested $${sizing.usd.toFixed(2)} (budget $${notionalBudget.toFixed(2)}) but only $${portfolio.cash.toFixed(2)} available.`,
        );
      }
    }

    const newUnits =
      notionalBudget !== null
        ? roundUnits(existingUnits + maxBuyTicks(existingUnits, price, notionalBudget) * TICK)
        : roundUnits(existingUnits + floorUnits((sizing as { units: number }).units));
    // MAX_UNITS is an invariant of the OUTCOME, not just a precondition on
    // existingUnits (checked above): maxBuyTicks already bounds the notional
    // path, so this is what actually rejects a units-sized request (no
    // search to bound) that would push the resulting holding past it.
    if (newUnits > MAX_UNITS) {
      return fail(
        date,
        ticker,
        "BUY",
        `Order would bring ${ticker} holdings to ${newUnits} units, above the ${MAX_UNITS} MAX_UNITS safe ceiling (currently holding ${existingUnits}).`,
      );
    }
    // Resulting-position money-domain gate (round 11 fix): MAX_UNITS above
    // bounds unit COUNT, but the resulting position's marked VALUE can leave
    // the domain at a far smaller unit count once price is large (e.g.
    // 500,000,000 units at $2/share is already $1e9).
    const resultingCents = positionValueCents(newUnits, price);
    if (resultingCents > MAX_MONEY_CENTS) {
      return fail(
        date,
        ticker,
        "BUY",
        `Order would bring ${ticker} position value to $${resultingCents / 100n}, above the $${MAX_MONEY_USD} supported money domain.`,
      );
    }
    // Units-sized fills carry the strict raw floor; never re-derive it by subtracting large holdings.
    const units = notionalBudget !== null
      ? roundUnits(newUnits - existingUnits)
      : floorUnits((sizing as { units: number }).units);
    if (units <= 0) {
      return fail(date, ticker, "BUY", `Order rounds down to 0 units at price $${price.toFixed(2)} (min tradable size is 1e-6 shares).`);
    }
    const transfer = valueDelta(existingUnits, newUnits, price);
    if (transfer < MIN_NOTIONAL_USD) {
      return fail(
        date,
        ticker,
        "BUY",
        `Order notional rounds to $${transfer.toFixed(2)}, below the $${MIN_NOTIONAL_USD.toFixed(2)} minimum tradable fill size at price $${price.toFixed(2)}.`,
      );
    }
    if (transfer > portfolio.cash) {
      return fail(
        date,
        ticker,
        "BUY",
        `Insufficient cash: need $${transfer.toFixed(2)} but only $${portfolio.cash.toFixed(2)} available. Current holdings: ${JSON.stringify(portfolio.holdings)}`,
      );
    }
    return {
      fill: { date, ticker, side: "BUY", units, price, notional: transfer, cashAfter: round2(portfolio.cash - transfer) },
    };
  }

  // SELL — no short selling: units sold must not exceed the current position.
  if (existingUnits <= 0) {
    return fail(date, ticker, "SELL", `No position in ${ticker} to sell.`);
  }
  const rawUnits = order.sizing.kind === "notional" ? order.sizing.usd / price : order.sizing.units;
  const requestedUnits = floorUnits(rawUnits);
  // A tolerance cannot distinguish floating-point noise from a genuine raw
  // oversell. Persisted holdings are canonical grid values, so only an exact
  // raw match is a full exit; any raw value above the holding is rejected.
  const isFullExit = rawUnits === existingUnits;
  if (rawUnits > existingUnits) {
    return fail(date, ticker, "SELL", `Cannot sell ${requestedUnits} units of ${ticker}: only ${existingUnits} held.`);
  }

  const newUnits = isFullExit
    ? 0
    : order.sizing.kind === "notional"
      ? roundUnits(existingUnits - maxSellTicks(existingUnits, price, floorCents(order.sizing.usd)) * TICK)
      : roundUnits(existingUnits - requestedUnits);
  const units = isFullExit
    ? existingUnits
    : order.sizing.kind === "units"
      ? requestedUnits
      : roundUnits(existingUnits - newUnits);
  if (units <= 0) {
    return fail(date, ticker, "SELL", `Order rounds down to 0 units at price $${price.toFixed(2)} (min tradable size is 1e-6 shares).`);
  }
  // Resulting-position money-domain gate (round 11 fix): a PARTIAL sell
  // leaves a remaining position that must itself stay marked inside the
  // domain — the cash-domain check below only covers the SELL's own
  // proceeds, not what's left held. newUnits is exactly 0 for a full exit,
  // so this can never reject a full-position exit.
  const remainingCents = positionValueCents(newUnits, price);
  if (remainingCents > MAX_MONEY_CENTS) {
    return fail(
      date,
      ticker,
      "SELL",
      `Selling ${units} units of ${ticker} at $${price} would leave a remaining ${ticker} position worth $${remainingCents / 100n}, above the $${MAX_MONEY_USD} supported money domain.`,
    );
  }
  // Post-fill cash-domain check (round 10 fix), done in BigInt cents BEFORE
  // ever converting the transfer to a `number`: a SELL's proceeds are the
  // CHANGE in the position's own marked value (see valueDelta's comment in
  // engine/sizing.ts), which — unlike a BUY's transfer — is NOT bounded by
  // pre-fill cash. A near-full exit of a large, appreciated position can
  // legitimately move more cash than MAX_MONEY_USD even though the
  // arithmetic itself is exact; accepting that fill would leave `cashAfter`
  // outside the domain every OTHER precondition in this function assumes
  // (see the `portfolio.cash > MAX_MONEY_USD` check above), silently
  // corrupting the ledger until some later order gets rejected as
  // "corrupted" for a state THIS fill created. Rejecting it here instead
  // keeps every accepted state inside the supported domain.
  const transferCents = positionValueCents(existingUnits, price) - positionValueCents(newUnits, price);
  const cashAfterCents = dollarsToCents(portfolio.cash) + transferCents;
  if (cashAfterCents > MAX_MONEY_CENTS) {
    return fail(
      date,
      ticker,
      "SELL",
      `Selling ${units} units of ${ticker} at $${price} would bring cash to $${cashAfterCents / 100n}, above the $${MAX_MONEY_USD} supported money domain.`,
    );
  }
  const transfer = -valueDelta(existingUnits, newUnits, price);
  if (transfer < MIN_NOTIONAL_USD) {
    return fail(
      date,
      ticker,
      "SELL",
      `Order notional rounds to $${transfer.toFixed(2)}, below the $${MIN_NOTIONAL_USD.toFixed(2)} minimum tradable fill size at price $${price.toFixed(2)}.`,
    );
  }
  return {
    fill: { date, ticker, side: "SELL", units, price, notional: transfer, cashAfter: round2(portfolio.cash + transfer) },
  };
}

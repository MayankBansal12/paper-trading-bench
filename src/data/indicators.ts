// Technical indicators computed purely from an as-of bar window. These take
// already-sliced bars (see data/ohlcv.ts asOf()) and never reach outside the
// array — so look-ahead safety is entirely the caller's responsibility of
// slicing correctly, and these functions are trivially unit-testable.

import type { Indicators, OhlcvBar } from "../domain/types.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Simple moving average of closes over the last `period` bars. Null if not enough history. */
export function sma(bars: readonly OhlcvBar[], period: number): number | null {
  if (bars.length < period) return null;
  const window = bars.slice(bars.length - period);
  const sum = window.reduce((acc, b) => acc + b.close, 0);
  return round2(sum / period);
}

/** Wilder's RSI over `period` bars of daily close-to-close change. Null if not enough history. */
export function rsi(bars: readonly OhlcvBar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const window = bars.slice(bars.length - (period + 1));
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i < window.length; i++) {
    const change = window[i]!.close - window[i - 1]!.close;
    if (change >= 0) gainSum += change;
    else lossSum += -change;
  }
  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return round2(100 - 100 / (1 + rs));
}

export function computeIndicators(bars: readonly OhlcvBar[]): Indicators {
  return {
    sma20: sma(bars, 20),
    sma50: sma(bars, 50),
    rsi14: rsi(bars, 14),
  };
}

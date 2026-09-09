// Indicators consume the full causal history prefix; callers may truncate bars
// for display only AFTER computing indicators. No rounding at computation time.
import type { Indicators, OhlcvBar } from "../domain/types.ts";
function validatePeriod(period: number): void {
  if (!Number.isSafeInteger(period) || period < 1) throw new Error("Indicator period must be a positive integer");
}
/** Simple moving average over the trailing period, at full precision. */
export function sma(bars: readonly OhlcvBar[], period: number): number | null {
  validatePeriod(period);
  if (bars.length < period) return null;
  return bars.slice(-period).reduce((sum, b) => sum + b.close, 0) / period;
}
/** Wilder RSI: mean seed over first period changes, then recursive smoothing.
 * A flat history (zero gain AND loss) is neutral 50. Needs period + 1 bars.
 * Initialization is anchored at the frozen dataset history start, not a rolling
 * window. This finite-history seed convention is part of the signal protocol. */
export function rsi(bars: readonly OhlcvBar[], period: number): number | null {
  validatePeriod(period);
  if (bars.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = bars[i]!.close - bars[i - 1]!.close;
    gain += Math.max(change, 0); loss += Math.max(-change, 0);
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < bars.length; i++) {
    const change = bars[i]!.close - bars[i - 1]!.close;
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
export function computeIndicators(bars: readonly OhlcvBar[]): Indicators {
  return { sma20: sma(bars, 20), sma50: sma(bars, 50), rsi14: rsi(bars, 14) };
}

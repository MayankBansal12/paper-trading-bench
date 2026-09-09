// Shared CLI flag validation: reject unknown flags and non-finite/invalid
// values instead of silently coercing `Number("garbage")` into NaN and
// letting it corrupt a run's identity/config downstream.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertKnownFlags(flags: ReadonlyMap<string, string>, allowed: readonly string[], subcommand: string): void {
  const unknown = [...flags.keys()].filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown flag(s) for \`${subcommand}\`: ${unknown.map((k) => `--${k}`).join(", ")}. Known: ${allowed.map((a) => `--${a}`).join(", ")}`);
  }
}

/** This CLI only ever accepts `--flag=value` options — reject stray
 * positional arguments (e.g. a typo'd `--` flag, or leftover shell garbage)
 * instead of silently ignoring them. */
export function assertNoPositionals(positionals: readonly string[], subcommand: string): void {
  if (positionals.length > 0) {
    throw new Error(`Unexpected positional argument(s) for \`${subcommand}\`: ${positionals.join(", ")}. This command only accepts --flag=value options.`);
  }
}

export function parsePositiveFinite(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive finite number, got "${raw}"`);
  return n;
}

/** Rejects a NORMALIZED value (e.g. already round2'd) outside [min, max] or
 * non-finite — used after rounding, not instead of it, since a value that's
 * merely positive/finite pre-rounding can still normalize to something out
 * of range (a sub-cent capital rounds to $0; 1e307 rounds to Infinity). */
export function assertInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${name} must be between ${min} and ${max} once normalized, got ${value}`);
  }
}

export function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  const n = parsePositiveFinite(name, raw, fallback);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be a positive integer, got "${raw}"`);
  return n;
}

export function parseIntFlag(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`--${name} must be an integer, got "${raw}"`);
  return n;
}

/** Validates YYYY-MM-DD is a REAL calendar date (correct days-per-month,
 * leap years), not just the right shape — "2024-99-98" matches the regex
 * but isn't a date. Round-trips through UTC Date components: any out-of-range
 * month/day rolls over to a different date whose formatted string won't
 * match the input. */
export function parseDateFlag(name: string, raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (!DATE_PATTERN.test(raw)) throw new Error(`--${name} must be YYYY-MM-DD, got "${raw}"`);
  const [year, month, day] = raw.split("-").map(Number) as [number, number, number];
  const asDate = new Date(Date.UTC(year, month - 1, day));
  const roundTrip = `${asDate.getUTCFullYear().toString().padStart(4, "0")}-${(asDate.getUTCMonth() + 1).toString().padStart(2, "0")}-${asDate.getUTCDate().toString().padStart(2, "0")}`;
  if (roundTrip !== raw) {
    throw new Error(`--${name} must be a real calendar date, got "${raw}"`);
  }
  return raw;
}

// Minimal flag parsing — no arg-parser dependency. Supports both
// `--flag=value` and `--flag value` forms.

export interface ParsedArgs {
  flags: Map<string, string>;
  /** Any argument that isn't a `--flag` and wasn't consumed as a `--flag value`
   * pair's value. This command surface never accepts positional arguments —
   * callers should reject a non-empty list (see validate.ts assertNoPositionals)
   * instead of silently ignoring stray input like a typo'd flag. */
  positionals: string[];
}

export function parseFlags(args: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  // pnpm forwards the conventional `--` end-of-options separator as a
  // literal leading argument (unlike npm, which strips it), so
  // `pnpm run run -- --agent=fake` would otherwise parse as an empty
  // `--`-named flag. Drop exactly one leading separator so the documented
  // pnpm invocation parses identically to passing the flags directly.
  const rest = args[0] === "--" ? args.slice(1) : args;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, "true");
      }
    }
  }
  return { flags, positionals };
}

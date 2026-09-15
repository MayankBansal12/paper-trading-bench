import type { JournalEntry } from "./journal.ts";
import { POLICY } from "./protocol.ts";

/** Symbols are whole tokens: MU must not match momentum; BRK.B stays distinct. */
function mentionedTickers(entry: JournalEntry, universe: readonly string[]) {
  const symbols = new Set(entry.text.toUpperCase().match(/[A-Z0-9]+(?:[.-][A-Z0-9]+)*/g) ?? []);
  return universe.filter((ticker) => entry.tickers.includes(ticker) || symbols.has(ticker));
}

/** Input is the session's validated, immutable committed prefix, oldest first. */
export function readJournal(
  past: readonly JournalEntry[],
  universe: readonly string[],
  filters: { date?: string; tickers?: string[]; query?: string; cursor?: number },
) {
  const query = filters.query?.trim().toLowerCase();
  if (query === "") throw new Error("Journal query must contain a keyword; omit query to browse recent notes.");
  const terms = query?.split(/\s+/) ?? [];
  const recent = [...past].reverse();
  const rows = recent.filter((entry) => {
    if (filters.date && entry.date !== filters.date) return false;
    if (filters.tickers && !mentionedTickers(entry, universe).some((ticker) => filters.tickers!.includes(ticker))) return false;
    const fields = [entry.text, ...(entry.tags ?? [])].map((text) => text.toLowerCase());
    return terms.every((term) => fields.some((text) => text.includes(term)));
  });
  const start = filters.cursor ?? 0;
  const entries: JournalEntry[] = [];
  let chars = 0;
  let serializedChars = 0;
  for (const entry of rows.slice(start)) {
    const size = JSON.stringify(entry).length;
    // Keep complete notes and bound metadata too. At most six UTF-8 bytes per
    // serialized character after the outer tool-result encoding, with headroom.
    if (chars + entry.text.length > POLICY.maxReadChars ||
        serializedChars + size > POLICY.maxResponseBytes / 8) break;
    entries.push(entry);
    chars += entry.text.length;
    serializedChars += size;
  }
  const page = {
    entries,
    nextCursor: start + entries.length < rows.length ? start + entries.length : null,
  };
  if (rows.length) {
    return entries.length ? page : {
      ...page,
      matchingEntries: rows.length,
      hint: "Cursor is past the matching notes. Retry with cursor 0; use nextCursor only with the same filters.",
    };
  }

  // Ignore unsuccessful filters so the model can discover what actually exists.
  // Include prose mentions in the index for notes with incomplete ticker metadata.
  const index: { date: string; tickers: string[] }[] = [];
  let indexChars = 2; // Array brackets.
  for (const entry of recent.slice(0, POLICY.maxJournalIndexEntries)) {
    const row = {
      date: entry.date,
      tickers: mentionedTickers(entry, universe),
      tags: [...(entry.tags ?? [])],
    };
    const size = JSON.stringify(row).length + (index.length ? 1 : 0);
    if (indexChars + size > POLICY.maxReadChars) break;
    index.push(row);
    indexChars += size;
  }
  return {
    ...page,
    availableIndex: {
      entries: index,
      totalEntries: past.length,
      truncated: index.length < past.length,
    },
    hint: past.length
      ? "No matching committed notes. Try fewer keywords, a date or ticker from availableIndex, or omit filters to browse newest first using nextCursor. The index ignores your filters and may omit older dates."
      : "No committed notes exist yet. A journal becomes available after its trading day commits successfully.",
  };
}

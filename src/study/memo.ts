import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
export const journalSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 2000 }),
    tickers: Type.Array(Type.String({ pattern: "^[A-Z][A-Z0-9.-]{0,15}$" }), {
      maxItems: 128,
      uniqueItems: true,
    }),
    evidence_refs: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
        maxItems: 16,
        uniqueItems: true,
      }),
    ),
  },
  { additionalProperties: false },
);
export type JournalNote = Static<typeof journalSchema>;
export function assertJournalNote(
  value: unknown,
): asserts value is JournalNote {
  if (!Check(journalSchema, value) || !(value as JournalNote).text.trim())
    throw new Error("Invalid journal note");
}

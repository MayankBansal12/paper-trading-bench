import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { contentHash } from "../run/persist.ts";

const text = (maxLength: number, minLength = 10) => Type.String({ minLength, maxLength });
export const MAX_MEMO_CHARS = 5000;
export const decisionMemoSchema = Type.Object({
  thesis: text(600),
  evidence: Type.Array(Type.Object({
    claim: text(500),
    receiptIds: Type.Array(text(100, 1), { minItems: 1, maxItems: 2 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }),
  allocation: text(600),
  alternatives: text(500),
  risks: text(600),
  invalidation: text(500),
  continuity: text(600),
}, { additionalProperties: false });
export type DecisionMemo = Static<typeof decisionMemoSchema>;
export function assertDecisionMemo(value: unknown): asserts value is DecisionMemo {
  const nonblank = (v: unknown): boolean => typeof v === "string" ? !!v.trim()
    : Array.isArray(v) ? v.every(nonblank)
    : v !== null && typeof v === "object" ? Object.values(v).every(nonblank) : false;
  if (!Check(decisionMemoSchema, value) || !nonblank(value) ||
    JSON.stringify(value).length > MAX_MEMO_CHARS)
    throw new Error("Invalid decision memo: include thesis, receipt-linked evidence, allocation, alternatives, risks, invalidation and continuity within 5000 characters");
}
export function memoEvidenceIds(memo: DecisionMemo): string[] {
  return [...new Set(memo.evidence.flatMap(e => e.receiptIds))];
}
export function assertFinalJournal(entries: { ordersHash: string; decision?: DecisionMemo }[], orders: unknown) {
  const final = entries.at(-1);
  if (!final || final.ordersHash !== contentHash(orders))
    throw new Error("Final journal entry differs from order batch; append it after the final order");
  if (!final.decision) throw new Error("Final journal entry requires a structured decision memo, including for a hold");
  assertDecisionMemo(final.decision);
}
export function renderDecisionMemo(memo: DecisionMemo): string {
  return [
    `Thesis: ${memo.thesis}`,
    "Evidence:", ...memo.evidence.map(e => `- ${e.claim} [${e.receiptIds.join(", ")}]`),
    `Allocation / cash: ${memo.allocation}`, `Alternatives: ${memo.alternatives}`,
    `Risks / uncertainty: ${memo.risks}`, `Invalidation / next review: ${memo.invalidation}`,
    `Continuity / thesis changes: ${memo.continuity}`,
  ].join("\n");
}

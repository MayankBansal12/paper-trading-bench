import { createHash } from "node:crypto";
export const textHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const contentHash = (value: unknown) => textHash(JSON.stringify(value));
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

import { canonical } from "../core/hash.ts";
/** Attest the actual provider payload in addition to client hook reports. */
export function assertProviderContext(
  body: any,
  system: string,
  daily: string,
  names: readonly string[],
) {
  const messages = body.messages ?? body.input;
  if (!Array.isArray(messages))
    throw new Error("Missing provider message context");
  const texts = (m: any): string[] =>
    typeof m.content === "string"
      ? [m.content]
      : Array.isArray(m.content)
        ? m.content
            .map((p: any) => p.text)
            .filter((s: unknown) => typeof s === "string")
        : [];
  const actualSystem =
    typeof body.instructions === "string"
      ? [body.instructions]
      : messages
          .filter((m: any) => ["system", "developer"].includes(m.role))
          .flatMap(texts);
  const users = messages.filter((m: any) => m.role === "user").flatMap(texts);
  if (
    canonical(actualSystem) !== canonical([system]) ||
    !users.some((s: string) => s.trim() === daily.trim())
  )
    throw new Error("Provider system/preloaded context differs");
  const tools = (body.tools ?? [])
    .map((t: any) => t.function?.name ?? t.name)
    .sort();
  if (canonical(tools) !== canonical(names.map((n) => `trading_${n}`).sort()))
    throw new Error("Provider effective tool set differs");
}

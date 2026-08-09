// Session-trace recorder. Captures the live event stream from a pi
// AgentSession into a structured `Trace` (thinking + text deltas + tool
// calls + durations), then flushes it to disk as JSON (machine) + Markdown (human).
//
// Design notes:
// - The recorder must NEVER throw: a buggy listener would kill the whole
//   trading run, so handlers/finalize() swallow + log to stderr.
// - Per-turn thinking/text buffers come from `message_update` deltas; tool
//   calls attach as they complete. turn_start/turn_end frame a turn; tool
//   events are guaranteed to arrive before turn_end.
// - Tool result previews come from `result.content[].text` (pi-ai ToolResult
//   shape). The SDK types `result` as `any`, so we probe defensively.

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { writeFileAtomic } from "../utils/fs.ts";
import { TRACES_DIR } from "../utils/paths.ts";
import { join } from "node:path";

export interface ToolCallRecord {
  name: string;
  args: unknown;
  result_preview: string;
  is_error: boolean;
  duration_ms: number;
}
export interface TurnRecord { index: number; thinking: string | null; text: string | null; tool_calls: ToolCallRecord[]; }
export interface TraceTotals { turns: number; tool_calls: number; thinking_chars: number; text_chars: number; }
export interface Trace {
  date: string;
  model: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  turns: TurnRecord[];
  totals: TraceTotals;
}

interface PendingTool { name: string; args: unknown; started_at: number; }
interface CurrentTurn {
  thinking: string;
  text: string;
  tool_calls: ToolCallRecord[];
  pending: Map<string, PendingTool>;
}

const PREVIEW_MAX = 1024;
const TRUNC_SUFFIX = "…(truncated)";

/** Build a short text preview from a pi-ai ToolResult-shaped value. */
function previewResult(result: unknown, isError: boolean): string {
  const parts: string[] = [];
  if (typeof result === "string") {
    parts.push(result);
  } else if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
          parts.push((block as { text: string }).text);
        }
      }
    }
  }
  let preview = parts.join("\n").trim();
  if (!preview) preview = isError ? "(error, no text content)" : "(no text content)";
  if (preview.length > PREVIEW_MAX) preview = preview.slice(0, PREVIEW_MAX) + TRUNC_SUFFIX;
  return preview;
}

export class SessionRecorder {
  private readonly date: string;
  private readonly model: string;
  private readonly startedAt: Date;
  private readonly turns: TurnRecord[] = [];
  private current: CurrentTurn | null = null;
  private unsub: (() => void) | null = null;

  constructor(date: string, model: string) {
    this.date = date;
    this.model = model;
    this.startedAt = new Date();
  }

  /** Subscribe to the session's event stream. Re-attaching unsubscribes the previous listener. */
  attach(session: AgentSession): void {
    try {
      this.unsub?.();
      this.unsub = session.subscribe((ev) => this.handle(ev));
    } catch (err) {
      console.error("[trace] attach failed:", err instanceof Error ? err.message : err);
    }
  }

  private turn(): CurrentTurn {
    if (!this.current) this.current = { thinking: "", text: "", tool_calls: [], pending: new Map() };
    return this.current;
  }

  /** Central event handler. All recorder exceptions are swallowed + logged. */
  private handle(ev: AgentSessionEvent): void {
    try {
      switch (ev.type) {
        case "turn_start":
          // Defensively flush an un-framed previous turn (a missed turn_end
          // would otherwise lose accumulated data).
          if (this.current) this.flushTurn();
          this.current = { thinking: "", text: "", tool_calls: [], pending: new Map() };
          break;
        case "message_update": {
          const ame = ev.assistantMessageEvent;
          if (ame.type === "thinking_delta") this.turn().thinking += ame.delta ?? "";
          else if (ame.type === "text_delta") this.turn().text += ame.delta ?? "";
          break;
        }
        case "tool_execution_start":
          this.turn().pending.set(ev.toolCallId, { name: ev.toolName, args: ev.args, started_at: Date.now() });
          break;
        case "tool_execution_end": {
          const t = this.turn();
          const pend = t.pending.get(ev.toolCallId);
          const started_at = pend?.started_at ?? Date.now();
          t.pending.delete(ev.toolCallId);
          t.tool_calls.push({
            name: pend?.name ?? ev.toolName,
            args: pend?.args,
            result_preview: previewResult(ev.result, ev.isError),
            is_error: !!ev.isError,
            duration_ms: Date.now() - started_at,
          });
          break;
        }
        case "turn_end":
          // Still-pending tools (no matching end event) get a placeholder so a
          // dropped tool event doesn't silently vanish from the trace.
          this.flushTurn();
          break;
        // tool_execution_update / agent_start / agent_end / etc. not needed — ignored.
      }
    } catch (err) {
      console.error("[trace] handler error:", err instanceof Error ? err.message : err);
    }
  }

  private flushTurn(): void {
    if (!this.current) return;
    const t = this.current;
    this.current = null;
    for (const [id, pend] of t.pending) {
      t.tool_calls.push({
        name: pend.name,
        args: pend.args,
        result_preview: "(pending — no tool_execution_end received)",
        is_error: false,
        duration_ms: Date.now() - pend.started_at,
      });
      console.error(`[trace] dropping unresolved tool ${pend.name} (id=${id})`);
    }
    const thinking = t.thinking.trim();
    const text = t.text.trim();
    this.turns.push({
      index: this.turns.length,
      thinking: thinking.length > 0 ? thinking : null,
      text: text.length > 0 ? text : null,
      tool_calls: t.tool_calls,
    });
  }

  /** Stop recording and return the assembled trace. Safe to call once at end. */
  finalize(): Trace {
    try {
      this.flushTurn();
      this.unsub?.();
      this.unsub = null;
    } catch (err) {
      console.error("[trace] finalize error:", err instanceof Error ? err.message : err);
    }
    const endedAt = new Date();
    const tool_calls = this.turns.reduce((n, t) => n + t.tool_calls.length, 0);
    const thinking_chars = this.turns.reduce((n, t) => n + (t.thinking?.length ?? 0), 0);
    const text_chars = this.turns.reduce((n, t) => n + (t.text?.length ?? 0), 0);
    return {
      date: this.date,
      model: this.model,
      started_at: this.startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: endedAt.getTime() - this.startedAt.getTime(),
      turns: this.turns,
      totals: { turns: this.turns.length, tool_calls, thinking_chars, text_chars },
    };
  }
}

function renderMarkdown(trace: Trace): string {
  const lines: string[] = [];
  lines.push(`# ${trace.date} — ${trace.model}`);
  lines.push(`Duration: ${(trace.duration_ms / 1000).toFixed(1)}s | Turns: ${trace.totals.turns} | Tool calls: ${trace.totals.tool_calls}`);
  lines.push("");
  for (const turn of trace.turns) {
    lines.push(`## Turn ${turn.index + 1}`);
    lines.push("### Thinking");
    lines.push(turn.thinking ?? "_(none)_");
    lines.push("### Assistant");
    lines.push(turn.text ?? "_(none)_");
    lines.push("### Tool calls");
    if (turn.tool_calls.length === 0) {
      lines.push("_(none)_");
    } else {
      for (const c of turn.tool_calls) {
        const args = JSON.stringify(c.args ?? {});
        lines.push(`- **${c.name}** (\`${args}\`) in ${c.duration_ms}ms${c.is_error ? " — error" : ""} — result: \`${c.result_preview.replace(/`/g, "\\`")}\``);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

/** Write both the JSON and Markdown trace files atomically into results/traces/. */
export async function saveTrace(trace: Trace): Promise<void> {
  const base = `${trace.date}.${trace.model}`;
  await Promise.all([
    writeFileAtomic(join(TRACES_DIR, `${base}.json`), JSON.stringify(trace, null, 2) + "\n"),
    writeFileAtomic(join(TRACES_DIR, `${base}.md`), renderMarkdown(trace)),
  ]);
}
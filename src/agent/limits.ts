// Bounded resource tracking shared by both agent implementations. A single
// TurnBudget instance is created per day and threaded through the tool
// registry (piAgent) or checked directly (fakeAgent) so no agent can spin
// forever, hammer tools indefinitely, or run past the wall-clock budget.

import type { RunLimits } from "../domain/types.ts";

export class TurnBudget {
  private turns = 0;
  private toolCalls = 0;
  private failedToolCalls = 0;
  private readonly startedAt: number;
  private refusalReason: string | null = null;
  readonly limits: RunLimits;

  constructor(limits: RunLimits, nowMs: number) {
    this.limits = limits;
    this.startedAt = nowMs;
  }

  recordTurn(): void {
    this.turns += 1;
  }

  /** Gate-then-record for turns, mirroring agent/tools.ts's budgetGate
   * pattern for tool calls: returns false (and does NOT increment `turns`)
   * for a refused (N+1)th turn, so a non-cooperative session that keeps
   * starting turns after being told to stop can never push usage.turns past
   * `maxTurns` — recording unconditionally and checking afterward (the v2
   * bug) let the refused turn itself inflate the reported count. */
  admitTurn(): boolean {
    if (this.turns >= this.limits.maxTurns) return false;
    this.turns += 1;
    return true;
  }

  recordToolCall(failed: boolean): void {
    this.toolCalls += 1;
    if (failed) this.failedToolCalls += 1;
  }

  /** Reason string if any bound has been exceeded, else null. `maxTurns`
   * and `maxToolCalls` are inclusive caps (advertised as "at most N"): the
   * Nth turn/call is still allowed, only the (N+1)th is refused. Used by
   * agent/tools.ts's budgetGate to refuse an actual (N+1)th tool call. */
  exceeded(nowMs: number): string | null {
    if (this.turns > this.limits.maxTurns) return `max turns (${this.limits.maxTurns}) reached`;
    if (this.toolCalls >= this.limits.maxToolCalls) return `max tool calls (${this.limits.maxToolCalls}) reached`;
    if (nowMs - this.startedAt >= this.limits.timeoutMs) return `time budget (${this.limits.timeoutMs}ms) exceeded`;
    return null;
  }

  /** Like `exceeded()` but deliberately excludes `maxToolCalls`: used to
   * decide whether to abort the whole session at a turn boundary. Reaching
   * the tool-call cap must NOT abort the session — the model is still
   * entitled to finish that turn with its final rationale (only the next
   * actual tool call attempt is refused, via `exceeded()`/budgetGate). Only
   * maxTurns and the wall-clock timeout justify cutting the session off
   * outright. */
  exceededExcludingToolCalls(nowMs: number): string | null {
    if (this.turns > this.limits.maxTurns) return `max turns (${this.limits.maxTurns}) reached`;
    if (nowMs - this.startedAt >= this.limits.timeoutMs) return `time budget (${this.limits.timeoutMs}ms) exceeded`;
    return null;
  }

  /** Wall-clock deadline (ms since epoch) this budget was constructed against. */
  deadlineAt(): number {
    return this.startedAt + this.limits.timeoutMs;
  }

  /** Durably marks the day as bounded because budgetGate (agent/tools.ts)
   * refused an actual (N+1)th tool-call attempt — distinct from `exceeded()`
   * itself, which is re-checked (and can already be true) without the
   * session ever aborting: hitting maxToolCalls alone lets the model finish
   * its turn normally. Without this flag that refusal would vanish, and a
   * session that finishes with a rationale after being refused would be
   * reported as an un-bounded day. Only the first refusal's reason sticks. */
  recordRefusal(reason: string): void {
    this.refusalReason ??= reason;
  }

  /** Non-null once any tool call has ever been refused this day. */
  wasRefused(): string | null {
    return this.refusalReason;
  }

  usage() {
    return {
      turns: this.turns,
      toolCalls: this.toolCalls,
      failedToolCalls: this.failedToolCalls,
      promptTokens: 0,
      completionTokens: 0,
    };
  }
}

/** Rejects with `reason` if `promise` doesn't settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Like `withTimeout`, but for a `setup` promise that constructs a resource
 * needing explicit disposal (e.g. a Pi session): `setup` itself is never
 * cancelled by a timeout — the underlying work keeps running — so a setup
 * that times out and THEN resolves would otherwise hand back a resource the
 * caller already gave up on and will never reach its own disposal path for.
 * `onLateResolve` runs against that value in exactly that case, so it's
 * still cleaned up. Ordinary (on-time) resolution is untouched: the caller
 * gets the value back exactly as `withTimeout` would and owns its disposal
 * as normal. */
export function withTimeoutAndLateCleanup<T>(setup: Promise<T>, ms: number, reason: string, onLateResolve: (value: T) => void): Promise<T> {
  let timedOut = false;
  setup.then((value) => {
    if (timedOut) onLateResolve(value);
  }, () => {});
  return withTimeout(setup, ms, reason).catch((e: unknown) => {
    if (e instanceof Error && e.message.startsWith(reason)) timedOut = true;
    throw e;
  });
}

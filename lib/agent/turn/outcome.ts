import type { ChatTurnTerminal } from "@/lib/agent/chat-turn-lifecycle";

/**
 * The ONE terminal vocabulary for a turn (PLAN-cowork-unification Phase 1,
 * step 6 OUTCOME). Every turn ends in exactly one of these; telemetry,
 * persistence, and streaming all derive from it.
 */
export type TurnOutcome =
  | "delivered"
  | "clarified"
  | "cancelled"
  | "recoverable_error"
  | "hard_failure";

/**
 * Resolve the final TurnOutcome from the transport-level terminal state, the
 * outcome staged by the stream observer, and persistence health.
 *
 * Extracted verbatim from the finishStaged call site in chat-turn.ts:
 * - a failed turn is a hard_failure unless the staged outcome was already a
 *   recoverable_error AND persistence itself did not fail (a persistence
 *   failure is always hard — the user cannot see what was produced);
 * - a cancelled turn is cancelled;
 * - a deadline turn is a recoverable_error (the client offers Retry);
 * - a done/ask turn keeps the outcome staged by the observer (delivered or
 *   clarified); with nothing staged there is no evidence of delivery, so the
 *   honest outcome is hard_failure.
 */
export function resolveTurnOutcome(input: {
  terminal: ChatTurnTerminal;
  staged: TurnOutcome | null;
  persistenceFailed: boolean;
  cancelled: boolean;
}): TurnOutcome {
  if (input.terminal === "failure") {
    return input.persistenceFailed || input.staged !== "recoverable_error"
      ? "hard_failure"
      : "recoverable_error";
  }
  if (input.cancelled || input.terminal === "cancelled") return "cancelled";
  if (input.terminal === "deadline") return "recoverable_error";
  return input.staged ?? "hard_failure";
}

/**
 * Map a TurnOutcome onto the persisted chat_messages.terminal_reason
 * vocabulary ('done' | 'ask' | 'cancelled' | 'deadline' | 'error' — see
 * db/migration-095-chat-action-checkpoints.sql). This is the inverse of the
 * lifecycle mapping: deadline terminals resolve to recoverable_error, and
 * failure terminals (persisted as "error") resolve to hard_failure.
 */
export function terminalReasonForOutcome(
  outcome: TurnOutcome,
): "done" | "ask" | "cancelled" | "deadline" | "error" {
  switch (outcome) {
    case "delivered":
      return "done";
    case "clarified":
      return "ask";
    case "cancelled":
      return "cancelled";
    case "recoverable_error":
      return "deadline";
    case "hard_failure":
      return "error";
  }
}

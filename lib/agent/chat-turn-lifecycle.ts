import { AgentEventSchema, type AgentEvent } from "@/lib/agent/contracts";

export type ChatTurnTerminal =
  "done" | "ask" | "cancelled" | "deadline" | "failure";

export type ChatTurnOutcome = {
  terminal: ChatTurnTerminal;
  error?: Error;
};

export type ChatTurnPersistenceResult =
  | { ok: true }
  | { ok: false; error: Error };

export type AcceptedChatTurnAdapters = {
  signal?: AbortSignal;
  run: () => AsyncIterable<AgentEvent> | Promise<AsyncIterable<AgentEvent>>;
  persist: (
    event: AgentEvent,
  ) => Promise<void | ChatTurnPersistenceResult>;
  persistFailure?: (error: Error) => Promise<void>;
  release: () => Promise<void>;
};

function terminalForEvent(
  current: ChatTurnTerminal | null,
  event: AgentEvent,
): ChatTurnTerminal | null {
  if (current === "ask" || current === "deadline") return current;
  if (event.type === "ask") return "ask";
  if (event.type === "done" && event.terminalReason === "deadline") {
    return "deadline";
  }
  if (event.type === "done" && event.terminalReason === "cancelled") {
    return "cancelled";
  }
  if (event.type === "done" && event.terminalReason === "error") {
    return "failure";
  }
  if (
    event.type === "error" &&
    (event.code === "turn_deadline" || event.code === "turn_deadline_exceeded")
  ) {
    return "deadline";
  }
  if (event.type === "done") return "done";
  if (event.type === "error" && !event.recovery) return "failure";
  return current;
}

function isCancellation(error: Error, signal?: AbortSignal): boolean {
  return signal?.aborted === true || error.name === "AbortError";
}

/**
 * Owns the sequencing of one accepted chat turn. Transport-specific rendering
 * stays in the adapter, while claim lifetime and persistence ordering remain
 * invariant across HTTP, tests, and future workers.
 */
export async function executeAcceptedChatTurn(
  adapters: AcceptedChatTurnAdapters,
): Promise<ChatTurnOutcome> {
  let terminal: ChatTurnTerminal | null = null;

  try {
    const stream = await adapters.run();
    for await (const candidate of stream) {
      const parsed = AgentEventSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new Error(`Agent emitted an invalid ${candidate.type} event.`);
      }
      const persistence = await adapters.persist(candidate);
      if (persistence?.ok === false) {
        return { terminal: "failure", error: persistence.error };
      }
      terminal = terminalForEvent(terminal, candidate);
    }

    if (adapters.signal?.aborted) terminal = "cancelled";
    return { terminal: terminal ?? "failure" };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    terminal = isCancellation(error, adapters.signal) ? "cancelled" : "failure";
    await adapters.persistFailure?.(error);
    return { terminal, error };
  } finally {
    await adapters.release();
  }
}

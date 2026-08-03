export type ChatTerminalReason =
  | "done"
  | "ask"
  | "cancelled"
  | "deadline"
  | "error";

export type PersistedAskLifecycle = {
  persisted_terminal_reason?: ChatTerminalReason;
};

export function markPersistedTerminalReason<T extends object>(
  value: T,
  terminalReason: ChatTerminalReason | null | undefined,
): T & PersistedAskLifecycle {
  if (terminalReason) {
    Object.defineProperty(value, "persisted_terminal_reason", {
      value: terminalReason,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return value;
}

/**
 * Legacy ask rows predate terminal reasons, so a missing reason remains
 * resumable. Once a terminal reason exists, only the explicit ask outcome can
 * keep the question active.
 */
export function persistedAskRemainsPending(
  terminalReason: ChatTerminalReason | null | undefined,
): boolean {
  return terminalReason == null || terminalReason === "ask";
}

export function isInterviewAskArgs(
  args: Record<string, unknown> | null | undefined,
): boolean {
  return args?.variant === "interview";
}

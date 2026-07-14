export type ChatPreStreamWork = {
  hasImageAttachment: boolean;
  createsLeadMagnet: boolean;
};

export type ChatSetupDeadlines = {
  serverMs: number;
  clientMs: number;
};

/**
 * Bound only the work before SSE response headers exist. Expensive, explicit
 * setup gets enough room for its own bounded model work; normal chat should
 * never hold an invisible turn claim for minutes.
 */
export function chatSetupDeadlines(work: ChatPreStreamWork): ChatSetupDeadlines {
  if (work.createsLeadMagnet) return { serverMs: 260_000, clientMs: 285_000 };
  if (work.hasImageAttachment) return { serverMs: 70_000, clientMs: 90_000 };
  return { serverMs: 45_000, clientMs: 60_000 };
}

export type ChatSetupDeadline = {
  signal: AbortSignal;
  didExpire: () => boolean;
  stop: () => void;
};

type AbortableThenable<T> = PromiseLike<T> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>;
};

function abortError(): DOMException {
  return new DOMException("Chat setup was cancelled.", "AbortError");
}

/**
 * Make every pre-stream await obey the setup deadline. Supabase builders get
 * the signal at the fetch layer; test doubles and other thenables still race
 * the same signal so the chat claim can be released before the client offers
 * Retry.
 */
export function waitForChatSetup<T>(
  operation: AbortableThenable<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());

  const pending =
    typeof operation.abortSignal === "function"
      ? operation.abortSignal(signal)
      : operation;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(pending).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * A setup-only abort deadline. Every pre-stream await must be passed through
 * waitForChatSetup so a timed-out handler settles before the client deadline.
 */
export function createChatSetupDeadline(
  timeoutMs: number,
): ChatSetupDeadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didExpire: () => expired,
    stop: () => clearTimeout(timer),
  };
}

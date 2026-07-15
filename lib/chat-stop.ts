export type ChatTurnStopIdentity = {
  clientTurnId?: string;
  turnStartedAt?: string;
};

type StopRequestDependencies = {
  attemptTimeoutMs?: number;
  fetcher?: typeof fetch;
  retryDelaysMs?: number[];
  wait?: (delayMs: number) => Promise<void>;
};

export async function requestServerTurnStop(
  input: {
    chatId: string;
    identity: ChatTurnStopIdentity;
    recoverable?: boolean;
  },
  dependencies: StopRequestDependencies = {},
): Promise<void> {
  if (!input.identity.clientTurnId && !input.identity.turnStartedAt) {
    throw new Error("The active Cowork turn could not be identified.");
  }
  const fetcher = dependencies.fetcher ?? fetch;
  const attemptTimeoutMs = Math.max(1, dependencies.attemptTimeoutMs ?? 2_000);
  const retryDelaysMs = dependencies.retryDelaysMs ?? [0, 100, 250, 500, 1_000];
  const wait =
    dependencies.wait ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let lastError: unknown;

  for (const [attempt, delayMs] of retryDelaysMs.entries()) {
    if (attempt > 0 && delayMs > 0) await wait(delayMs);
    try {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const response = await Promise.race([
        fetcher(`/api/chats/${encodeURIComponent(input.chatId)}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...input.identity,
            ...(input.recoverable ? { recoverable: true } : {}),
          }),
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Stop confirmation timed out."));
          }, attemptTimeoutMs);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (response.ok) return;
      lastError = new Error(`Stop was not confirmed (${response.status}).`);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error("Cowork could not confirm that this turn stopped.", {
    cause: lastError,
  });
}

export type SseHeartbeatOptions = {
  write: () => void;
  intervalMs: number;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/** Keep configuration safely ahead of the client watchdog without hot loops. */
export function configuredSseHeartbeatInterval(value: number): number {
  return Number.isInteger(value) && value >= 1_000 && value <= 30_000
    ? value
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
}

export function startSseHeartbeat(
  options: SseHeartbeatOptions,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
  const write = () => {
    if (stopped) return;
    try {
      options.write();
    } catch {
      stop();
    }
  };

  // Flush response bytes immediately, then stay comfortably ahead of the
  // client's idle watchdog while a provider reasons without visible tokens.
  write();
  if (!stopped) timer = setInterval(write, options.intervalMs);
  return stop;
}

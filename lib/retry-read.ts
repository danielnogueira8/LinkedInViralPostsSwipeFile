// Retry wrapper for transient PostgREST read failures.
//
// Supabase/PostgREST returns `{ data: null, error }` (it does NOT throw) on a
// transient blip — connection-pool exhaustion, a brief network drop, a
// statement timeout under load. Our read paths deliberately `throw` on such an
// error rather than silently render a degraded/empty page, which is correct —
// but it means one blip on a fresh load surfaces the error boundary, and the
// user has to manually refresh to "fix" it. Re-running the same query a beat
// later almost always succeeds, so we self-heal here instead.
//
// Takes a *factory* (not a promise): PostgREST builders are single-shot
// thenables, so each attempt must build a fresh query.

type ReadResult<T> = {
  data: T | null;
  error: { message?: string; code?: string } | null;
  count?: number | null;
};

// PostgREST error codes worth retrying: connection/timeout-class failures.
// We do NOT retry on syntactic/permission errors (those won't fix themselves).
const RETRYABLE_CODES = new Set([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "57014", // query_canceled (statement timeout)
  "53300", // too_many_connections
  "54001", // statement_too_complex (rare, but transient under load)
]);

function isRetryable(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  if (error.code && RETRYABLE_CODES.has(error.code)) return true;
  // Code is often absent on network-layer failures (fetch failed, ECONNRESET,
  // timeout) — fall back to a message sniff for those.
  const msg = error.message?.toLowerCase() ?? "";
  return (
    msg.includes("fetch failed") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("network") ||
    msg.includes("connection")
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a Supabase read with a couple of fast retries on transient failure.
 * Returns the final `{ data, error, count }` — callers keep their existing
 * `if (error) throw` so a genuine (non-transient) failure still surfaces.
 *
 * Defaults: 2 retries (3 attempts total), 120ms then 240ms backoff. Kept
 * short so a real outage still fails fast rather than hanging the SSR render.
 */
export async function retryRead<T>(
  factory: () => PromiseLike<ReadResult<T>>,
  { retries = 2, baseDelayMs = 120 }: { retries?: number; baseDelayMs?: number } = {},
): Promise<ReadResult<T>> {
  let result = await factory();
  for (let attempt = 1; attempt <= retries && isRetryable(result.error); attempt++) {
    await sleep(baseDelayMs * attempt);
    result = await factory();
  }
  return result;
}

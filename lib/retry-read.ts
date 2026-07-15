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
  // PostgREST JWT-validation failures. With Supabase's new API keys the
  // gateway mints a short-lived JWT (iat = now) for PostgREST, which only
  // tolerates 30s of clock skew on iat/exp/nbf. When PostgREST's clock is
  // briefly behind the gateway's, a freshly-minted token reads as "issued in
  // the future" (or "expired") and the request is rejected — intermittently,
  // depending which backend instance/clock you hit. A retry usually lands on a
  // healthy clock and succeeds, so we treat these as transient. (Supabase
  // infra bug supabase/supabase#41294 — not something our code can prevent.)
  "PGRST301", // JWT validation failed (generic)
  "PGRST302", // anonymous/JWT auth required
  "PGRST303", // JWT expired / clock skew
]);

function isRetryable(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  if (error.code && RETRYABLE_CODES.has(error.code)) return true;
  // Code is often absent on network-layer failures (fetch failed, ECONNRESET,
  // timeout) and on the gateway's JWT-skew rejections — fall back to a message
  // sniff for those.
  const msg = error.message?.toLowerCase() ?? "";
  return (
    msg.includes("fetch failed") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("network") ||
    msg.includes("connection") ||
    // Clock-skew JWT rejections from the Supabase gateway (see codes above).
    // "JWT issued at future" / "...in the future" / "JWT expired".
    (msg.includes("jwt") &&
      (msg.includes("future") || msg.includes("expired") || msg.includes("issued at")))
  );
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  signal.throwIfAborted();
}

// Coerce a thrown value into our `{ message, code }` error shape so the same
// isRetryable() / surfacing logic covers both failure styles (see below).
function toError(e: unknown): { message?: string; code?: string } {
  if (e instanceof Error) {
    // supabase-js / undici attach a `code` on some network errors (ECONNRESET,
    // ETIMEDOUT, …); pass it through when present so code-based matching works.
    const code = (e as { code?: unknown }).code;
    return { message: e.message, code: typeof code === "string" ? code : undefined };
  }
  return { message: String(e) };
}

/**
 * Run a Supabase read with a couple of fast retries on transient failure.
 * Returns the final `{ data, error, count }` — callers keep their existing
 * `if (error) throw` so a genuine (non-transient) failure still surfaces.
 *
 * Handles BOTH failure styles PostgREST/supabase-js can produce:
 *   • Returned `{ data: null, error }` — PostgREST's normal soft failure.
 *   • A THROWN exception — the network layer (undici `fetch failed`,
 *     ECONNRESET, a DNS blip) rejects the promise rather than resolving with
 *     an error object. The earlier version only inspected the returned error,
 *     so a thrown transient blip bypassed retry entirely and tripped the
 *     error boundary — and when it happened inside a React cache()-wrapped
 *     reader (e.g. trackedAccountIds), the throw got memoized for the whole
 *     request, so the error boundary's "Try again" re-threw the cached error
 *     and only a full page refresh recovered. We now catch the throw, retry it
 *     on the same transient-classification rules, and on a retryable throw
 *     that exhausts its retries we RETURN it as `{ data: null, error }` so the
 *     caller's existing `if (error) throw` still surfaces a genuine outage.
 *     A non-retryable throw (a real bug) is re-thrown immediately, unchanged.
 *
 * Defaults: 3 retries (4 attempts total), 150ms · 300ms · 450ms backoff. The
 * extra attempt (was 2) gives the gateway's intermittent JWT clock-skew
 * rejection more chances to route to a healthy PostgREST instance, while the
 * ~0.9s worst-case total is still short enough that a real outage fails fast
 * rather than hanging the SSR render. Only incurred on actual failures.
 */
export async function retryRead<T>(
  factory: () => PromiseLike<ReadResult<T>>,
  {
    retries = 3,
    baseDelayMs = 150,
    signal,
  }: {
    retries?: number;
    baseDelayMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ReadResult<T>> {
  const attempt = async (): Promise<ReadResult<T>> => {
    signal?.throwIfAborted();
    try {
      return await factory();
    } catch (e) {
      const error = toError(e);
      // A retryable throw is normalized into the returned shape so the retry
      // loop below treats it identically to a returned error. A non-retryable
      // throw is a genuine fault — re-throw it untouched.
      if (isRetryable(error)) return { data: null, error };
      throw e;
    }
  };

  let result = await attempt();
  for (let i = 1; i <= retries && isRetryable(result.error); i++) {
    await sleep(baseDelayMs * i, signal);
    result = await attempt();
  }
  return result;
}

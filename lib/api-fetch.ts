import type { z } from "zod";

// Client-side fetch helper for the app's JSON API routes.
//
// Every call site used to do `const data = await res.json()` WITHOUT checking
// `res.ok` first. When a route 500s (or a proxy/edge returns an HTML error
// page), `res.json()` throws "Unexpected token <", and that opaque parser
// message became the user-facing toast — masking the real failure. Worse, an
// auth redirect or gateway error could return non-JSON with a 200-ish status.
//
// `fetchJson` centralizes the correct order of checks:
//   1. await the response
//   2. read the body as text once
//   3. parse JSON defensively (a non-JSON body becomes a clean error, not a
//      raw SyntaxError)
//   4. if !res.ok, throw using the server's { error } message when present,
//      else a status-based fallback
//
// It returns the parsed JSON typed as T. Routes in this app return a
// discriminated `{ ok: true, ... } | { ok: false, error }` envelope, so call
// sites still branch on `data.ok` as before — they just no longer crash on a
// non-JSON error response.

// Message shown when we detect the session has expired (see AuthExpiredError).
// Kept as a constant so call sites can match on it if they want bespoke UI.
export const AUTH_EXPIRED_MESSAGE =
  "Your session expired. Please refresh the page or sign in again.";

// Thrown when a request is rejected because the caller is no longer
// authenticated. Clerk's middleware (`auth.protect()`) returns a bare HTML
// error page — typically 401/403, or a 404 for non-navigational requests like
// our fetch POSTs — instead of a JSON `{ error }` envelope. Without this, the
// user just saw "Request failed (404)" and had no idea they'd been logged out
// (e.g. after signing in on another device). Call sites can `instanceof`-check
// this to offer a "reload / sign in" affordance.
export class AuthExpiredError extends Error {
  constructor(message: string = AUTH_EXPIRED_MESSAGE) {
    super(message);
    this.name = "AuthExpiredError";
  }
}

// Statuses Clerk's middleware uses to reject an unauthenticated request to a
// protected route. 401/403 are the obvious ones; 404 is what `auth.protect()`
// returns for non-navigational requests (it 404s rather than redirecting a
// fetch to an HTML sign-in page). When any of these come back with a NON-JSON
// body, it's an auth bounce — not a missing endpoint or a real "forbidden".
const AUTH_REJECT_STATUSES = new Set([401, 403, 404]);

// A forgiving sibling of `fetchJson` for polling/status reads where a transient
// failure should be ignored (the next tick retries) rather than thrown. Returns
// the parsed JSON on a 2xx JSON response, or `null` for ANY other outcome — a
// non-2xx status, an empty body, or a non-JSON body (HTML error page, gateway
// text). This is what status-poll loops want: a bad tick becomes "no update"
// instead of an "Unexpected token <" crash or a spurious AuthExpired toast on
// every interval. Use `fetchJson` (which throws) for user-initiated actions
// where the user must see why something failed.
export async function safeJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T | null> {
  try {
    const res = await fetch(input, init);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function parseJsonResponse<T>(
  res: Response,
  fallbackError?: string,
): Promise<T> {
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body (HTML error page, plain-text gateway message, etc.).
      // A 401/403/404 with an HTML body is the signature of Clerk's
      // middleware bouncing a logged-out request — surface an actionable
      // "your session expired" message instead of an opaque status code.
      if (AUTH_REJECT_STATUSES.has(res.status)) {
        throw new AuthExpiredError();
      }
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`);
      }
      throw new Error("Unexpected non-JSON response from server");
    }
  } else if (AUTH_REJECT_STATUSES.has(res.status)) {
    // Empty body on an auth-reject status (some edge configs return no body
    // at all) — still an auth bounce.
    throw new AuthExpiredError();
  }

  if (!res.ok) {
    const serverMsg =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : fallbackError ?? `Request failed (${res.status})`;
    throw new Error(serverMsg);
  }

  return parsed as T;
}

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  return parseJsonResponse<T>(await fetch(input, init));
}

export async function fetchJsonSchema<T extends z.ZodTypeAny>(
  schema: T,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<z.infer<T>> {
  const value = await fetchJson<unknown>(input, init);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid response from server");
  return parsed.data;
}

/** Parse a shared success/error envelope even when the HTTP status is non-2xx. */
export async function fetchApiContract<T extends z.ZodTypeAny>(
  schema: T,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<z.infer<T>> {
  const response = await fetch(input, init);
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : undefined;
  } catch {
    if (AUTH_REJECT_STATUSES.has(response.status)) throw new AuthExpiredError();
    throw new Error(response.ok ? "Invalid response from server" : `Request failed (${response.status})`);
  }
  if (response.status === 401) throw new AuthExpiredError();
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (AUTH_REJECT_STATUSES.has(response.status)) throw new AuthExpiredError();
  throw new Error("Invalid response from server");
}

export async function safeJsonSchema<T extends z.ZodTypeAny>(
  schema: T,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<z.infer<T> | null> {
  const value = await safeJson<unknown>(input, init);
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

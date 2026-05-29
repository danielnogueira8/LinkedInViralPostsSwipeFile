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
export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, init);

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body (HTML error page, plain-text gateway message, etc.).
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`);
      }
      throw new Error("Unexpected non-JSON response from server");
    }
  }

  if (!res.ok) {
    const serverMsg =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `Request failed (${res.status})`;
    throw new Error(serverMsg);
  }

  return parsed as T;
}

// LeadShark API client — comment-triggered auto-DM automations on LinkedIn.
//
// Unlike Zernio (ONE platform key SwipeIn pays for), the LeadShark key is
// USER-supplied and per-workspace: the user pastes their own LeadShark API key,
// we encrypt it (lib/crypto.ts) and store it (lib/leadshark-credentials.ts).
// A leaked key sends DMs / connection requests from the user's real LinkedIn
// account, so this module is careful never to let the key reach logs or Sentry.
//
// This is a thin, typed seam over the HTTP API. Several response shapes are
// still [PROBE]-unconfirmed (see the LeadShark build plan §8); when a probe
// resolves one, the change lives HERE — callers only see the typed result.
//
// Auth:  x-api-key: <key>
// Base:  https://apex.leadshark.io
// Docs:  LeadShark API reference (Pre-Automation Object / /api/automations).

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Overridable via env so a probe/staging base can be pointed at without a code
// change; defaults to production.
const BASE_URL = (
  process.env.LEADSHARK_API_BASE_URL ?? "https://apex.leadshark.io"
).replace(/\/+$/, "");

const RETRY_MAX_ATTEMPTS = 3; // total tries for transient failures (429 / 5xx / network)
const RETRY_BASE_MS = 500;
const RETRY_MAX_DELAY_MS = 15_000;

// LeadShark's documented limits (see build plan §2).
export const DM_TEMPLATE_MAX_CHARS = 2000;
export const MAX_KEYWORDS = 20;

// LeadShark's matcher compares against the LinkedIn ACTIVITY URN, exact string.
// A `share` URN silently never binds — validate before we ever send one.
const ACTIVITY_URN_RE = /^urn:li:activity:\d+$/;

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export type LeadSharkErrorKind =
  | "unauthorized" // 401 — key rejected/regenerated. Mark credential invalid.
  | "forbidden" // 403 — plan lacks API access, or a Pro+ feature on a Pro key.
  | "rate_limited" // 429 — back off; retry later.
  | "not_found" // 404 — automation/post id doesn't exist.
  | "bad_request" // 400 — validation error (surface the message).
  | "linkedin_not_connected" // 400 subset — LeadShark has no LinkedIn account. Key is FINE.
  | "transient" // 5xx / network / retry-exhausted — safe to retry.
  | "other";

export type LeadSharkError = {
  kind: LeadSharkErrorKind;
  message: string;
  status: number;
};

// Map an HTTP failure to a typed kind + user-facing message. `bodyText` is the
// (already-drained) response body; we sniff it for LeadShark's specific error
// strings without ever echoing the request (which carries the key).
export function mapLeadSharkError(status: number, bodyText: string): LeadSharkError {
  const b = (bodyText || "").toLowerCase();

  if (status === 401) {
    return {
      kind: "unauthorized",
      status,
      message: "LeadShark rejected your API key. It may have been regenerated.",
    };
  }
  // "LinkedIn not connected" comes back as a 400 but is NOT a key problem — the
  // key is valid, LeadShark just has no LinkedIn account attached. Distinguish
  // it so we don't wrongly mark the credential invalid.
  if (
    (status === 400 || status === 409) &&
    (b.includes("linkedin") &&
      (b.includes("not connected") ||
        b.includes("no account") ||
        b.includes("connect")))
  ) {
    return {
      kind: "linkedin_not_connected",
      status,
      message:
        "LeadShark isn't connected to a LinkedIn account. Connect it in LeadShark, then retry.",
    };
  }
  if (status === 403) {
    return {
      kind: "forbidden",
      status,
      message:
        "Your LeadShark plan doesn't include this. It requires a paid plan (Pro or above).",
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limited",
      status,
      message: "LeadShark is rate-limiting right now. Try again in a minute.",
    };
  }
  if (status === 404) {
    return { kind: "not_found", status, message: "Not found on LeadShark." };
  }
  if (status === 400 || status === 422) {
    return {
      kind: "bad_request",
      status,
      // Surface LeadShark's own validation text when present; it's the most
      // actionable thing we can show. Never includes the key (it's the response).
      message: bodyText?.trim()
        ? `LeadShark rejected the request: ${truncate(bodyText.trim(), 300)}`
        : "LeadShark rejected the request.",
    };
  }
  if (status >= 500 || status === 0) {
    return {
      kind: "transient",
      status,
      message: "Couldn't reach LeadShark. This is usually temporary — try again shortly.",
    };
  }
  return {
    kind: "other",
    status,
    message: `LeadShark request failed (${status}).`,
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ---------------------------------------------------------------------------
// URN validation — the single most important guard in the whole integration.
// ---------------------------------------------------------------------------

/** True only for a well-formed LinkedIn ACTIVITY URN (what LeadShark binds on). */
export function isActivityUrn(value: string | null | undefined): value is string {
  return typeof value === "string" && ACTIVITY_URN_RE.test(value);
}

/**
 * Throw unless `value` is an activity URN. Use immediately before sending a
 * post_id to LeadShark — a `share`/`ugcPost` URN would create a row that reports
 * healthy and silently never fires.
 */
export function assertActivityUrn(value: string | null | undefined): string {
  if (!isActivityUrn(value)) {
    throw new Error(
      `Refusing to send a non-activity URN to LeadShark: ${JSON.stringify(value)}. ` +
        "LeadShark's matcher only binds on urn:li:activity:<id>.",
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Request executor — bounded retry on transient failures, never on 4xx.
// The API key is passed in per call and NEVER stored on `this` or logged. On
// any thrown fetch error we rebuild a clean Error so a leaked key can't ride
// inside error.config/error.request into Sentry.
// ---------------------------------------------------------------------------

type RawResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; error: LeadSharkError };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const headerMs = retryAfter ? Number(retryAfter) * 1000 : NaN;
  if (Number.isFinite(headerMs) && headerMs > 0) {
    return Math.min(headerMs, RETRY_MAX_DELAY_MS);
  }
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
}

async function request(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; label: string },
): Promise<RawResult> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { "x-api-key": apiKey };
  let bodyStr: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(init.body);
  }

  let lastTransient: LeadSharkError | null = null;

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        headers,
        body: bodyStr,
        signal: init.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      // Rebuild a bare error — do NOT propagate the original, which may carry
      // request config (and thus the x-api-key header) into Sentry.
      lastTransient = {
        kind: "transient",
        status: 0,
        message: "Couldn't reach LeadShark (network error).",
      };
      const delay = retryDelayMs(attempt, null);
      if (attempt < RETRY_MAX_ATTEMPTS - 1) {
        await sleep(delay, init.signal);
        continue;
      }
      break;
    }

    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      return { ok: true, status: res.status, json };
    }

    // Drain the body so we can map the error AND free the socket.
    const text = await res.text().catch(() => "");
    const mapped = mapLeadSharkError(res.status, text);

    // Retry only transient/rate-limit; 4xx are surfaced immediately (never a
    // duplicate create, never a wasted retry on a permanent rejection).
    if ((mapped.kind === "transient" || mapped.kind === "rate_limited") &&
      attempt < RETRY_MAX_ATTEMPTS - 1) {
      lastTransient = mapped;
      const delay = retryDelayMs(attempt, res.headers.get("retry-after"));
      logRetry(init.label, attempt + 1, res.status, delay);
      await sleep(delay, init.signal);
      continue;
    }

    return { ok: false, error: mapped };
  }

  return {
    ok: false,
    error:
      lastTransient ?? {
        kind: "transient",
        status: 0,
        message: "Couldn't reach LeadShark after several attempts.",
      },
  };
}

function logRetry(label: string, attempt: number, status: number, delayMs: number): void {
  // Structured, key-free log line (mirrors the openrouter_retry shape).
  console.log(JSON.stringify({ leadshark_retry: { label, attempt, status, delay_ms: delayMs } }));
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Cheapest authenticated read — used to VALIDATE a key at connect time. A 200
 * proves the key works and the plan includes API access. Returns a typed result
 * so the connect route can branch on the error kind (401 vs 403 vs 429 vs 5xx)
 * and store nothing on failure.
 */
export async function verifyKey(
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: LeadSharkError }> {
  const res = await request(apiKey, "/api/automations?limit=1", {
    label: "leadshark_verify_key",
    signal,
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: res.error };
}

// NOTE: automation create / read-back / list-posts / stats-fetch land in
// Phase 2 & 3 and will be added here as typed functions over `request()` so the
// [PROBE] response shapes stay quarantined to this module.

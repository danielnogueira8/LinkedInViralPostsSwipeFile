import { describe, test, expect } from "vitest";
import { retryDelayMs, isAbortError } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// Transport resilience — the pure retry-decision logic. retryDelayMs decides
// whether (and how long) to back off before retrying a failed connection-phase
// fetch; isAbortError gates out intentional cancels (Stop button / our own
// timeout) so we never retry those. The actual fetch/sleep wrapper is exercised
// indirectly (it's a thin loop around this); these pin the decisions.
// ---------------------------------------------------------------------------

describe("retryDelayMs — backoff decision", () => {
  test("a retryable status (429/5xx) returns a positive delay on the first failure", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const d = retryDelayMs(0, status, null, 0.5);
      expect(d, `status ${status}`).not.toBeNull();
      expect(d!).toBeGreaterThan(0);
    }
  });

  test("a non-retryable status (4xx other than 429) returns null", () => {
    expect(retryDelayMs(0, 400, null, 0.5)).toBeNull();
    expect(retryDelayMs(0, 401, null, 0.5)).toBeNull();
    expect(retryDelayMs(0, 404, null, 0.5)).toBeNull();
    expect(retryDelayMs(0, 422, null, 0.5)).toBeNull();
  });

  test("a thrown network error (status=null) is retryable", () => {
    expect(retryDelayMs(0, null, null, 0.5)).not.toBeNull();
  });

  test("returns null once attempts are exhausted (default 3 tries → no retry after attempt index 2)", () => {
    // attempt 0 and 1 can retry; attempt 2 is the last try → no further retry.
    expect(retryDelayMs(0, 503, null, 0.5)).not.toBeNull();
    expect(retryDelayMs(1, 503, null, 0.5)).not.toBeNull();
    expect(retryDelayMs(2, 503, null, 0.5)).toBeNull();
  });

  test("backoff grows with the attempt index (exponential)", () => {
    // Same jitter source → attempt 1 delay >= attempt 0 delay.
    const d0 = retryDelayMs(0, 503, null, 0.5)!;
    const d1 = retryDelayMs(1, 503, null, 0.5)!;
    expect(d1).toBeGreaterThanOrEqual(d0);
  });

  test("honors a numeric Retry-After header (seconds → ms), capped", () => {
    // 2s → 2000ms (under the cap).
    expect(retryDelayMs(0, 429, "2", 0.5)).toBe(2000);
    // A huge Retry-After is capped (never blocks forever).
    expect(retryDelayMs(0, 429, "9999", 0.5)).toBeLessThanOrEqual(4000);
  });

  test("jitter stays within the [base/2, base] band for a given exp", () => {
    // attempt 0, base 300 → exp=300 → delay in [150, 300).
    const low = retryDelayMs(0, 503, null, 0)!;
    const high = retryDelayMs(0, 503, null, 0.999)!;
    expect(low).toBeGreaterThanOrEqual(150);
    expect(high).toBeLessThanOrEqual(300);
    expect(high).toBeGreaterThan(low);
  });
});

describe("isAbortError — never retry an intentional cancel", () => {
  test("an AbortError (Stop button / disconnect) is an abort", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(isAbortError(e)).toBe(true);
  });

  test("a TimeoutError (our deadline) is treated as an abort (not retried)", () => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    expect(isAbortError(e)).toBe(true);
  });

  test("a generic network error is NOT an abort (so it's retryable)", () => {
    expect(isAbortError(new TypeError("fetch failed"))).toBe(false);
    expect(isAbortError(new Error("OpenRouter 503"))).toBe(false);
  });

  test("a non-Error value is not an abort", () => {
    expect(isAbortError("nope")).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchWithRetry — the connection-phase retry loop (mocked fetch, no network).
// The CRITICAL safety property: it retries a transient failure but NEVER an
// abort, and it only ever wraps the fetch (not a stream read), so streamed text
// can't be replayed. (Real backoff sleeps run here — small, base ~300ms.)
// ---------------------------------------------------------------------------

import { describe as d2, test as t2, expect as e2, vi } from "vitest";
import { fetchWithRetry } from "@/lib/openrouter";

function res(status: number, body = ""): Response {
  return new Response(body, { status });
}

d2("fetchWithRetry — retry behavior", () => {
  t2("a 429 then 200 → one transparent retry, returns the 200", async () => {
    const calls: number[] = [];
    const fetchMock = vi.fn(async () => {
      calls.push(1);
      return calls.length === 1 ? res(429) : res(200, "ok");
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("http://x", {}, "test");
    e2(r.status).toBe(200);
    e2(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  t2("a non-retryable 400 → returns immediately, no retry", async () => {
    const fetchMock = vi.fn(async () => res(400, "bad"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("http://x", {}, "test");
    e2(r.status).toBe(400);
    e2(fetchMock).toHaveBeenCalledTimes(1); // not retried
    vi.unstubAllGlobals();
  });

  t2("an AbortError → thrown immediately, NEVER retried", async () => {
    const fetchMock = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    vi.stubGlobal("fetch", fetchMock);
    await e2(fetchWithRetry("http://x", {}, "test")).rejects.toThrow("aborted");
    e2(fetchMock).toHaveBeenCalledTimes(1); // the whole point: no retry on abort
    vi.unstubAllGlobals();
  });

  t2("a persistent network error → retries up to the cap, then throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    await e2(fetchWithRetry("http://x", {}, "test")).rejects.toThrow("network down");
    e2(fetchMock).toHaveBeenCalledTimes(3); // default max attempts
    vi.unstubAllGlobals();
  });

  t2("a persistent 503 → exhausts retries and returns the last 503 (caller handles !ok)", async () => {
    const fetchMock = vi.fn(async () => res(503));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("http://x", {}, "test");
    e2(r.status).toBe(503);
    e2(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// streamChat tool_choice portability fallback. Some providers reject a FORCED
// tool_choice (Alibaba/Qwen: 400 "tool_choice … does not support being set to
// required … in thinking mode"). The round-0 forcing is a GLM flake guard, not
// a correctness requirement, so streamChat degrades to "auto" ONCE and replays
// the request — connection phase only, no stream bytes consumed. Without it,
// EVERY content-task turn on such a provider hard-fails (live-observed:
// qwen/qwen3.7-max, 4/4 turns errored).
// ---------------------------------------------------------------------------

import { describe as d3, test as t3, expect as e3, vi as vi3 } from "vitest";
import { streamChat } from "@/lib/openrouter";

const SSE_OK = [
  'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const QWEN_400 =
  '{"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"<400> InternalError.Algo.InvalidParameter: The tool_choice parameter does not support being set to required or object in thinking mode"}}}';

d3("streamChat — forced tool_choice 400 fallback", () => {
  t3("a tool_choice 400 on a forced request → one replay with auto, stream succeeds", async () => {
    process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key";
    const bodies: string[] = [];
    const fetchMock = vi3.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return bodies.length === 1
        ? new Response(QWEN_400, { status: 400 })
        : new Response(SSE_OK, { status: 200 });
    });
    vi3.stubGlobal("fetch", fetchMock);

    let text = "";
    for await (const d of streamChat({
      messages: [{ role: "user", content: "draft a post" }],
      tools: [{ type: "function", function: { name: "t", description: "x", parameters: { type: "object", properties: {} } } }],
      toolChoice: "required",
    })) {
      if (d.text) text += d.text;
    }

    e3(fetchMock).toHaveBeenCalledTimes(2);
    e3(JSON.parse(bodies[0]).tool_choice).toBe("required");
    e3(JSON.parse(bodies[1]).tool_choice).toBe("auto"); // degraded, not dropped
    e3(text).toBe("hi");
    vi3.unstubAllGlobals();
  });

  t3("a NON-tool_choice 400 on a forced request → throws, no blind replay", async () => {
    process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key";
    const fetchMock = vi3.fn(async () =>
      new Response('{"error":{"message":"context length exceeded"}}', { status: 400 }),
    );
    vi3.stubGlobal("fetch", fetchMock);
    const run = async () => {
      for await (const d of streamChat({
        messages: [{ role: "user", content: "x" }],
        toolChoice: "required",
      })) void d;
    };
    await e3(run()).rejects.toThrow(/400/);
    e3(fetchMock).toHaveBeenCalledTimes(1);
    vi3.unstubAllGlobals();
  });

  t3("a tool_choice 400 on an UNFORCED request → throws (fallback only arms when we forced)", async () => {
    process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key";
    const fetchMock = vi3.fn(async () => new Response(QWEN_400, { status: 400 }));
    vi3.stubGlobal("fetch", fetchMock);
    const run = async () => {
      for await (const d of streamChat({
        messages: [{ role: "user", content: "x" }],
        toolChoice: "auto",
      })) void d;
    };
    await e3(run()).rejects.toThrow(/400/);
    e3(fetchMock).toHaveBeenCalledTimes(1);
    vi3.unstubAllGlobals();
  });
});

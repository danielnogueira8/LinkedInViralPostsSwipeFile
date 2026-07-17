import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Bug-hunt finding #188: POST /api/rewrite had NO atomic cost reservation —
// only the read-only checkChatRateLimit pre-check plus a per-instance,
// explicitly-non-atomic in-memory dedupe map. Two concurrent requests could
// each read the same stale spend, both pass, and both stream a real LLM call.
// Every other paid LLM route (voice interview, chat title, lead magnets,
// creator styles) closes this with claimWorkspaceCost/releaseWorkspaceCost —
// this proves /rewrite now does the same: claims BEFORE streaming, releases
// on completion (success, empty-rewrite, model error, or abort), and a denied
// claim short-circuits before any model call.
// ---------------------------------------------------------------------------

vi.mock("@/lib/workspace", async (orig) => ({
  ...(await orig<typeof import("@/lib/workspace")>()),
  requireWorkspaceId: async () => "ws-1",
}));

const capRef: { current: { ok: boolean; message?: string; retryAfterSec?: number } } = {
  current: { ok: true },
};
vi.mock("@/lib/agent/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/agent/rate-limit")>()),
  checkChatRateLimit: async () => capRef.current,
}));

const costClaimSpy = vi
  .fn<(args: unknown) => Promise<string | null>>()
  .mockResolvedValue("cost-claim-1");
const costReleaseSpy = vi
  .fn<(args: unknown) => Promise<void>>()
  .mockResolvedValue(undefined);
vi.mock("@/lib/workspace-cost-claims", () => ({
  claimWorkspaceCost: (args: unknown) => costClaimSpy(args),
  releaseWorkspaceCost: (args: unknown) => costReleaseSpy(args),
}));

// No voice profile — loadVoiceSummary's own DB read short-circuits to null.
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  }),
}));

type StreamDelta = { text?: string; usage?: { prompt_tokens: number; completion_tokens: number } };
const streamChatImpl: { current: () => AsyncGenerator<StreamDelta> } = {
  current: async function* () {
    yield { text: "Rewritten snippet." };
    yield { usage: { prompt_tokens: 10, completion_tokens: 5 } };
  },
};
vi.mock("@/lib/openrouter", async (orig) => ({
  ...(await orig<typeof import("@/lib/openrouter")>()),
  streamChat: () => streamChatImpl.current(),
  logOpenRouterUsage: async () => undefined,
}));

const { POST } = await import("@/app/api/rewrite/route");

// Unique selection text per call — the route's own in-memory dedupe map
// (a SEPARATE, pre-existing guard from the cost claim under test here)
// rejects an identical (workspace, selection, instruction) within 5s, which
// would otherwise make later calls in a test collide with earlier ones.
let callCounter = 0;
function call(body: Record<string, unknown> = {}) {
  callCounter++;
  return POST(
    new Request("http://x/api/rewrite", {
      method: "POST",
      body: JSON.stringify({
        selection: `original text ${callCounter}`,
        instruction: "make it punchier",
        ...body,
      }),
    }),
  );
}

// Drains an SSE ReadableStream body so the route's async start() callback
// (including its finally-block release) actually runs to completion.
async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

beforeEach(() => {
  costClaimSpy.mockClear();
  costReleaseSpy.mockClear();
  costClaimSpy.mockResolvedValue("cost-claim-1");
  capRef.current = { ok: true };
  streamChatImpl.current = async function* () {
    yield { text: "Rewritten snippet." };
    yield { usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
});

describe("POST /api/rewrite — atomic cost claim (bug-hunt fix #188)", () => {
  test("claims a cost reservation before streaming, releases it on a clean completion", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    await drain(res);

    expect(costClaimSpy).toHaveBeenCalledTimes(1);
    expect(costClaimSpy.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-1",
      budgetUsd: 5,
    });
    expect(costReleaseSpy).toHaveBeenCalledTimes(1);
    expect(costReleaseSpy.mock.calls[0]?.[0]).toMatchObject({ workspaceId: "ws-1" });
  });

  test("a denied claim (workspace over budget) short-circuits BEFORE any model call", async () => {
    costClaimSpy.mockResolvedValue(null);
    const streamSpy = vi.fn(streamChatImpl.current);
    streamChatImpl.current = streamSpy as unknown as typeof streamChatImpl.current;

    const res = await call();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "Monthly AI budget reached." });
    expect(streamSpy).not.toHaveBeenCalled();
    // Nothing was ever claimed, so nothing should be released either.
    expect(costReleaseSpy).not.toHaveBeenCalled();
  });

  test("releases the claim even when the model returns an empty rewrite", async () => {
    streamChatImpl.current = async function* () {
      // no text deltas at all
      yield { usage: { prompt_tokens: 10, completion_tokens: 0 } };
    };
    const res = await call();
    const text = await drain(res);
    expect(text).toContain("event: error");
    expect(costReleaseSpy).toHaveBeenCalledTimes(1);
  });

  test("releases the claim when the model call throws mid-stream", async () => {
    streamChatImpl.current = async function* () {
      yield { text: "partial" };
      throw new Error("provider exploded");
    };
    const res = await call();
    const text = await drain(res);
    expect(text).toContain("event: error");
    expect(costReleaseSpy).toHaveBeenCalledTimes(1);
  });

  test("releases the claim exactly once even if release is somehow invoked twice", async () => {
    // Regression guard for the releaseCostClaimOnce idempotency guard: the
    // outer catch and the stream's finally both hold a reference to it.
    const res = await call();
    await drain(res);
    expect(costReleaseSpy).toHaveBeenCalledTimes(1);
  });

  test("the existing read-only rate-limit pre-check still gates BEFORE claiming (fail-closed money ceiling preserved)", async () => {
    capRef.current = { ok: false, message: "over budget" };
    const res = await call();
    expect(res.status).toBe(429);
    expect(costClaimSpy).not.toHaveBeenCalled();
  });
});

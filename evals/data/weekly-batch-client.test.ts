import { describe, test, expect, vi, afterEach } from "vitest";
import { startWeeklyBatch, BATCH_DRAFT_COUNT } from "@/lib/batch/client";

// ---------------------------------------------------------------------------
// startWeeklyBatch — the shared client trigger used by BOTH the Posts-board
// button and the chat-home card, so the START behavior is identical on every
// surface. Pin: ok path returns the runId, a friendly 429 (cooldown/cost-cap)
// surfaces its server message, and a network throw degrades gracefully (never
// throws). We stub global fetch.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(res: {
  ok: boolean;
  json: () => Promise<unknown>;
}) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify(await res.json()),
    { status: res.ok ? 200 : 429, headers: { "Content-Type": "application/json" } },
  )));
}

describe("startWeeklyBatch", () => {
  test("ok → returns the runId + chatId", async () => {
    stubFetch({
      ok: true,
      json: async () => ({
        ok: true,
        jobId: "job-1",
        batchId: "run-1",
        runId: "run-1",
        chatId: "chat-1",
        status: "queued",
      }),
    });
    const out = await startWeeklyBatch();
    expect(out).toEqual({ ok: true, runId: "run-1", chatId: "chat-1" });
  });

  test("an incomplete success envelope fails softly", async () => {
    stubFetch({ ok: true, json: async () => ({ ok: true }) });
    const out = await startWeeklyBatch();
    expect(out.ok).toBe(false);
  });

  test("429 cooldown → surfaces the server message, reason, AND retryAt", async () => {
    stubFetch({
      ok: false,
      json: async () => ({
        ok: false,
        error: "You've already generated a batch this week.",
        reason: "cooldown",
        retryAt: "2026-07-09T00:00:00.000Z",
      }),
    });
    const out = await startWeeklyBatch();
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toMatch(/already generated/i);
      expect(out.reason).toBe("cooldown");
      // retryAt is threaded through so the card can flip to its cooldown panel
      // (with the unlock time) instead of a disappearing toast.
      expect(out.retryAt).toBe("2026-07-09T00:00:00.000Z");
    }
  });

  test("error body without a message → a safe default message", async () => {
    stubFetch({ ok: false, json: async () => ({ ok: false }) });
    const out = await startWeeklyBatch();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/couldn't start/i);
  });

  test("network throw → graceful failure, never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const out = await startWeeklyBatch();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/couldn't start/i);
  });

  test("JSON 401 → explicit expired-auth outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: "Sign in required" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    )));
    const out = await startWeeklyBatch();
    expect(out).toMatchObject({ ok: false, reason: "auth_expired" });
    if (!out.ok) expect(out.message).toMatch(/session expired/i);
  });
});

describe("BATCH_DRAFT_COUNT — single source of truth for count", () => {
  test("is 7 (5 regular + 2 lead-magnet) and shared client+server", async () => {
    expect(BATCH_DRAFT_COUNT).toBe(7);
    // The server module re-exports the SAME constant, so the pipeline and the
    // card can never disagree on how many drafts a batch makes.
    const server = await import("@/lib/batch/weekly");
    expect(server.BATCH_DRAFT_COUNT).toBe(BATCH_DRAFT_COUNT);
    // 2 of the 7 are lead-magnet-sourced.
    expect(server.BATCH_LEAD_MAGNET_COUNT).toBe(2);
  });
});

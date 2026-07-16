import { beforeEach, describe, expect, test, vi } from "vitest";
import { AdapterHealthRegistry } from "@/lib/agent/adapter-health";

const completeChat = vi.fn();
const logOpenRouterUsage = vi.fn();
const maybeSingle = vi.fn();
const upsert = vi.fn(async () => ({ error: null }));

vi.mock("@/lib/openrouter", async (original) => ({
  ...(await original<typeof import("@/lib/openrouter")>()),
  completeChat,
  logOpenRouterUsage,
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle,
        upsert,
      };
      return chain;
    },
  }),
}));

const {
  computeFreshnessConstraint,
  freshnessHistoryHash,
  FRESHNESS_MODEL,
  FRESHNESS_PROMPT_VERSION,
} = await import("@/lib/agent/specialists/freshness");
const { createCoworkTurnTelemetry } =
  await import("@/lib/agent/cowork-telemetry");

const priorDrafts = Array.from({ length: 5 }, (_, index) => ({
  id: `d${index}`,
  body: `Draft ${index} repeats the same identity anchor.`,
  createdAt: `2026-01-0${index + 1}`,
}));

beforeEach(() => {
  completeChat.mockReset();
  logOpenRouterUsage.mockReset();
  maybeSingle.mockReset();
  upsert.mockClear();
});

describe("freshness constraint cache", () => {
  test("an exact cache hit skips the paid model call, including empty results", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        history_hash: freshnessHistoryHash(priorDrafts),
        model: FRESHNESS_MODEL,
        prompt_version: FRESHNESS_PROMPT_VERSION,
        markers: [],
      },
      error: null,
    });

    await expect(
      computeFreshnessConstraint({ priorDrafts, workspaceId: "ws-1" }),
    ).resolves.toEqual({ block: "", markers: [] });
    expect(completeChat).not.toHaveBeenCalled();
  });

  test("a hash mismatch calls the model and replaces the workspace cache", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        history_hash: "old-hash",
        model: FRESHNESS_MODEL,
        prompt_version: FRESHNESS_PROMPT_VERSION,
        markers: ["old marker"],
      },
      error: null,
    });
    completeChat.mockResolvedValue({
      toolArgs: { overused_markers: ["current marker"] },
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "freshness-prepass",
        workspaceId: "ws-1",
        route: "legacy_agent",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      sink,
    );

    const result = await computeFreshnessConstraint({
      priorDrafts,
      workspaceId: "ws-1",
      telemetry,
      adapterHealth: new AdapterHealthRegistry(),
    });
    telemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 1 },
      provenanceStatus: "not_required",
      terminalOutcome: "delivered",
    });
    expect(result.markers).toEqual(["current marker"]);
    expect(completeChat).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "ws-1",
        history_hash: freshnessHistoryHash(priorDrafts),
        markers: ["current marker"],
      }),
      { onConflict: "workspace_id" },
    );
    expect(sink.mock.calls[0][0].stage_attempts).toContainEqual(
      expect.objectContaining({
        stage: "legacy_freshness_prepass",
        provider: "openrouter",
        outcome: "accepted",
        input_tokens: 100,
        output_tokens: 10,
      }),
    );
  });
});

import { beforeEach, describe, expect, test, vi } from "vitest";
import { AdapterHealthRegistry } from "@/lib/agent/adapter-health";
import { sanitizeVoiceProfile } from "@/lib/claude";

const mocks = vi.hoisted(() => ({
  completeChat: vi.fn(),
  logUsage: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("@/lib/openrouter", async (original) => ({
  ...(await original<typeof import("@/lib/openrouter")>()),
  completeChat: mocks.completeChat,
  logOpenRouterUsage: mocks.logUsage,
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      update: (value: unknown) => ({
        eq: async () => {
          mocks.updateProfile(value);
          return { error: null };
        },
      }),
    }),
  }),
}));

const {
  ensureBiographicalFacts,
  extractBiographicalFacts,
  NO_FACTS_SENTINEL,
} =
  await import("@/lib/agent/specialists/backstory");
const { createCoworkTurnTelemetry } =
  await import("@/lib/agent/cowork-telemetry");

const profile = sanitizeVoiceProfile({
  summary: "A founder based in Portugal who previously ran a content agency.",
});

beforeEach(() => {
  mocks.completeChat.mockReset();
  mocks.logUsage.mockReset();
  mocks.updateProfile.mockReset();
  mocks.completeChat.mockResolvedValue({
    text: "",
    toolArgs: { facts: ["Based in Portugal", "Previously ran an agency"] },
    finishReason: "tool_calls",
    usage: { prompt_tokens: 40, completion_tokens: 12, cost: 0.002 },
    citations: [],
  });
  mocks.logUsage.mockResolvedValue(undefined);
});

describe("backstory paid-attempt boundary", () => {
  test("records the default-on extractor in turn telemetry", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "backstory-prepass",
        workspaceId: "ws-1",
        route: "answer",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      sink,
    );

    await expect(
      extractBiographicalFacts({
        profile,
        workspaceId: "ws-1",
        telemetry,
        adapterHealth: new AdapterHealthRegistry(),
      }),
    ).resolves.toEqual(["Based in Portugal", "Previously ran an agency"]);
    telemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 1 },
      provenanceStatus: "not_required",
      terminalOutcome: "delivered",
    });

    expect(mocks.logUsage).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0][0].stage_attempts).toContainEqual(
      expect.objectContaining({
        stage: "legacy_backstory_prepass",
        provider: "openrouter",
        outcome: "accepted",
        charged_cost_usd: 0.002,
      }),
    );
  });

  test("never converts a failed authoritative usage write into a no-facts sentinel", async () => {
    const persistenceError = new Error("ledger unavailable");
    persistenceError.name = "UsagePersistenceError";
    mocks.logUsage.mockRejectedValue(persistenceError);

    await expect(
      extractBiographicalFacts({
        profile,
        workspaceId: "ws-1",
        adapterHealth: new AdapterHealthRegistry(),
      }),
    ).rejects.toBe(persistenceError);
  });

  test("does not cache a transient provider failure as a permanent no-facts result", async () => {
    mocks.completeChat.mockRejectedValue(new Error("provider timeout"));

    const result = await ensureBiographicalFacts({
      profile,
      workspaceId: "ws-1",
      adapterHealth: new AdapterHealthRegistry(),
    });

    expect(result).toBe(profile);
    expect(result.biographical_facts).toBeUndefined();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  test("caches the no-facts sentinel only after an accepted empty response", async () => {
    mocks.completeChat.mockResolvedValue({
      text: "",
      toolArgs: { facts: [] },
      finishReason: "tool_calls",
      usage: { prompt_tokens: 30, completion_tokens: 4 },
      citations: [],
    });

    const result = await ensureBiographicalFacts({
      profile,
      workspaceId: "ws-1",
      adapterHealth: new AdapterHealthRegistry(),
    });

    expect(result.biographical_facts).toEqual([NO_FACTS_SENTINEL]);
    expect(mocks.updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          biographical_facts: [NO_FACTS_SENTINEL],
        }),
      }),
    );
  });
});

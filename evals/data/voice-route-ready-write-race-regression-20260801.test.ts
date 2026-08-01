import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    concurrentPending: false,
    updateHadReadyGuard: false,
    updateResult: { id: "voice-1", status: "ready", generated_at: null },
  };

  const raw = {
    from: (table: string) => {
      if (table !== "voice_profiles") throw new Error(`unexpected table: ${table}`);
      let updating = false;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (column: string) => {
          if (updating && column === "status") state.updateHadReadyGuard = true;
          return chain;
        },
        update: () => {
          updating = true;
          return chain;
        },
        maybeSingle: async () => {
          if (updating) {
            return state.concurrentPending && !state.updateHadReadyGuard
              ? { data: state.updateResult, error: null }
              : { data: null, error: null };
          }
          // The read observes ready, then another request starts generation
          // before this route reaches its UPDATE statement.
          state.concurrentPending = true;
          return { data: { id: "voice-1", status: "ready" }, error: null };
        },
        single: async () => ({
          data: state.updateResult,
          error: null,
        }),
      });
      return chain;
    },
  };

  return {
    state,
    raw,
    errorResponse: vi.fn(() =>
      Response.json({ ok: false, error: "Unexpected error" }, { status: 500 }),
    ),
  };
});

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: vi.fn(async () => ({ workspaceId: "workspace-1", raw: mocks.raw })),
}));
vi.mock("@/lib/workspace", () => ({
  errorResponse: mocks.errorResponse,
}));
vi.mock("@/lib/voice-generation", () => ({
  sanitizeVoiceProfile: (profile: unknown) => profile,
}));
vi.mock("@/lib/voice-recovery", () => ({
  recoverStalePending: vi.fn(),
}));
vi.mock("@/lib/voice-profile-operations", () => ({
  startVoiceGeneration: vi.fn(),
  voiceRegenCooldown: vi.fn(() => ({
    canRegenerate: true,
    regenAvailableAt: null,
    daysUntilRegen: 0,
  })),
  VOICE_PROFILE_COLS: "id, status, generated_at",
}));

const { PATCH } = await import("@/app/api/voice/route");

function request(): Request {
  return new Request("https://app.test/api/voice", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: { summary: "Edited voice" } }),
  });
}

beforeEach(() => {
  mocks.state.concurrentPending = false;
  mocks.state.updateHadReadyGuard = false;
  mocks.errorResponse.mockClear();
});

describe("PATCH /api/voice ready-state write", () => {
  test("does not overwrite a generation that starts after the readiness read", async () => {
    const response = await PATCH(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(mocks.state.updateHadReadyGuard).toBe(true);
    expect(mocks.errorResponse).not.toHaveBeenCalled();
  });
});

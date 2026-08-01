import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    insertCalls: 0,
    rpcCalls: 0,
    rawCalls: 0,
  };

  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      neq: () => chain,
      order: () => chain,
      limit: () => chain,
      insert: () => {
        state.insertCalls += 1;
        return chain;
      },
      update: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({
        data: {
          id: "chat-created",
          title: "New chat",
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-01T00:00:00.000Z",
        },
        error: null,
      }),
    });
    return chain;
  };

  const raw = {
    from: () => {
      state.rawCalls += 1;
      return makeChain();
    },
    rpc: async () => {
      state.rpcCalls += 1;
      return { data: true, error: null };
    },
  };

  return {
    state,
    raw,
    scopedSupabase: vi.fn(async () => ({ workspaceId: "workspace-1", raw })),
    startVoiceGeneration: vi.fn(async () => ({
      ok: true,
      status: 202,
      voice: {},
      canRegenerate: true,
      regenAvailableAt: null,
      daysUntilRegen: 0,
    })),
    errorResponse: vi.fn(() =>
      Response.json({ ok: false, error: "Unexpected error" }, { status: 500 }),
    ),
  };
});

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: mocks.scopedSupabase,
}));
vi.mock("@/lib/workspace", () => ({
  errorResponse: mocks.errorResponse,
}));
vi.mock("@/lib/agent-loop/constants", () => ({
  AGENT_CHAT_TITLE: "__agent__",
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "user-1" })),
}));
vi.mock("@/lib/draft-lifecycle", () => ({
  DraftLifecycle: class DraftLifecycle {},
  draftRecordToApi: vi.fn(),
}));
vi.mock("@/lib/draft-lifecycle-supabase", () => ({
  createSupabaseDraftLifecycleRepository: vi.fn(),
}));
vi.mock("@/lib/artifact-rewrite", () => ({
  rewriteArtifactInPlace: vi.fn(),
}));
vi.mock("@/lib/draft-edit-events", () => ({
  recordDraftEditEvent: vi.fn(),
}));
vi.mock("@/lib/voice-generation", () => ({
  sanitizeVoiceProfile: (profile: unknown) => profile,
}));
vi.mock("@/lib/voice-recovery", () => ({
  recoverStalePending: vi.fn(),
}));
vi.mock("@/lib/voice-profile-operations", () => ({
  startVoiceGeneration: mocks.startVoiceGeneration,
  voiceRegenCooldown: vi.fn(() => ({
    canRegenerate: true,
    regenAvailableAt: null,
    daysUntilRegen: 0,
  })),
  VOICE_PROFILE_COLS: "id",
}));

const chatsRoute = await import("@/app/api/chats/route");
const stopRoute = await import("@/app/api/chats/[id]/stop/route");
const artifactsRoute = await import("@/app/api/chats/[id]/artifacts/route");
const voiceRoute = await import("@/app/api/voice/route");

const chatContext = { params: Promise.resolve({ id: "chat-1" }) };

function malformedRequest(url: string, method: string): Request {
  return new Request(`https://app.test${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: "{",
  });
}

beforeEach(() => {
  mocks.state.insertCalls = 0;
  mocks.state.rpcCalls = 0;
  mocks.state.rawCalls = 0;
  mocks.scopedSupabase.mockClear();
  mocks.startVoiceGeneration.mockClear();
  mocks.errorResponse.mockClear();
});

describe("support route malformed-body regressions", () => {
  test("POST /api/chats rejects malformed JSON without creating a chat", async () => {
    const response = await chatsRoute.POST(
      malformedRequest("/api/chats", "POST"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(mocks.state.insertCalls).toBe(0);
    expect(mocks.errorResponse).not.toHaveBeenCalled();
  });

  test("POST /api/chats/[id]/stop maps malformed JSON to 400", async () => {
    const response = await stopRoute.POST(
      malformedRequest("/api/chats/chat-1/stop", "POST"),
      chatContext,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(mocks.state.rpcCalls).toBe(0);
    expect(mocks.errorResponse).not.toHaveBeenCalled();
  });

  test("POST /api/voice rejects malformed JSON before starting generation", async () => {
    const response = await voiceRoute.POST(
      malformedRequest("/api/voice", "POST"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(mocks.startVoiceGeneration).not.toHaveBeenCalled();
    expect(mocks.errorResponse).not.toHaveBeenCalled();
  });

  test.each([
    ["POST", artifactsRoute.POST],
    ["DELETE", artifactsRoute.DELETE],
    ["PATCH", artifactsRoute.PATCH],
  ] as const)(
    "POST /api/chats/[id]/artifacts %s maps malformed JSON to 400",
    async (method, handler) => {
      const response = await handler(
        malformedRequest("/api/chats/chat-1/artifacts", method),
        chatContext,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false });
      expect(mocks.state.rawCalls).toBe(0);
      expect(mocks.errorResponse).not.toHaveBeenCalled();
    },
  );
});

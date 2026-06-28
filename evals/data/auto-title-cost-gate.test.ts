import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Auto-title cost gate (reliability finding #19). POST /api/chats/[id]/title
// spends a (small) GLM call to name a chat — and it was the ONE spend path not
// behind the monthly cost cap. A workspace over budget still incurred title
// cost. The gate must skip titling (no completeChat call) when over the cap.
// ---------------------------------------------------------------------------

// A fake chat row + first user message so the handler reaches the gate.
const fakeRaw = {
  from: (table: string) => {
    const chain: Record<string, unknown> = {};
    const ret = () => chain;
    Object.assign(chain, {
      select: ret,
      eq: ret,
      is: ret,
      in: ret,
      order: ret,
      limit: ret,
      update: ret,
      maybeSingle: async () =>
        table === "chats"
          ? { data: { id: "c1", title: "New chat" }, error: null }
          : { data: null, error: null },
      // the messages query awaits the builder directly (no maybeSingle)
      then: (resolve: (v: unknown) => void) =>
        resolve(
          table === "chat_messages"
            ? { data: [{ role: "user", content: "write me a hook about distribution" }], error: null }
            : { data: null, error: null },
        ),
    });
    return chain;
  },
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "ws_over", raw: fakeRaw }),
}));

const capRef: { current: { ok: boolean; reason?: string; message?: string } } = {
  current: { ok: true },
};
vi.mock("@/lib/agent/rate-limit", () => ({
  checkChatRateLimit: async () => capRef.current,
}));

const completeChatSpy = vi.fn(async () => ({
  text: "Distribution Tips",
  toolArgs: null,
  finishReason: "stop",
  usage: { prompt_tokens: 50, completion_tokens: 5 },
}));
vi.mock("@/lib/openrouter", async (orig) => ({
  ...(await orig<typeof import("@/lib/openrouter")>()),
  completeChat: (...a: unknown[]) => completeChatSpy(...(a as [])),
  logOpenRouterUsage: async () => undefined,
}));

const { POST } = await import("@/app/api/chats/[id]/title/route");

function call() {
  return POST(new Request("http://x/api/chats/c1/title", { method: "POST" }), {
    params: Promise.resolve({ id: "c1" }),
  });
}

beforeEach(() => {
  completeChatSpy.mockClear();
  capRef.current = { ok: true };
});

describe("auto-title cost gate", () => {
  test("over the monthly cap → skips titling, does NOT call completeChat", async () => {
    capRef.current = { ok: false, reason: "monthly", message: "over budget" };
    const res = await call();
    const body = await res.json();
    expect(completeChatSpy).not.toHaveBeenCalled();
    expect(body).toMatchObject({ ok: true, skipped: true });
  });

  test("under the cap → proceeds to title (completeChat IS called)", async () => {
    capRef.current = { ok: true };
    const res = await call();
    const body = await res.json();
    // The gate let it through to the spend. (The persisted title value depends
    // on the DB write, which the minimal fake doesn't round-trip — the contract
    // under test is "the cap gate doesn't block a healthy workspace".)
    expect(completeChatSpy).toHaveBeenCalledTimes(1);
    expect(body.ok).toBe(true);
    expect(body.skipped).not.toBe(true);
  });
});

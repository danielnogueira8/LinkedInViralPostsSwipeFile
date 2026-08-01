import { describe, expect, test, vi } from "vitest";

const costClaim = vi.fn(async () => "claim-1");
const costRelease = vi.fn(async () => undefined);

vi.mock("@/lib/workspace", () => ({
  errorResponse: (error: unknown) =>
    Response.json(
      { ok: false, error: (error as Error).message ?? "internal" },
      { status: 500 },
    ),
}));
vi.mock("@/lib/agent/rate-limit", () => ({
  checkChatRateLimit: vi.fn(async () => ({ ok: true })),
  REWRITE_COST_RESERVE_USD: 0.01,
  MONTHLY_BUDGET_USD: 5,
}));
vi.mock("@/lib/workspace-cost-claims", () => ({
  claimWorkspaceCost: costClaim,
  releaseWorkspaceCost: costRelease,
}));
vi.mock("@/lib/agent/skills", () => ({
  GLOBAL_WRITING_SKILL: "",
  OUTPUT_LANGUAGE_RULE: "",
}));
vi.mock("@/lib/agent/specialists/nets", () => ({
  stripEmDashes: (value: string) => value,
}));
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-1",
    raw: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    },
  }),
}));

vi.mock("@/lib/openrouter", () => ({
  CHAT_MODEL: "test-model",
  estimatedUsage: () => ({ prompt_tokens: 1, completion_tokens: 1 }),
  logOpenRouterUsage: vi.fn(async () => undefined),
  streamChat: async function* () {
    yield { text: "rewritten", usage: { prompt_tokens: 1, completion_tokens: 1 } };
  },
}));

const { POST } = await import("@/app/api/rewrite/route");

async function drain(response: Response) {
  const reader = response.body!.getReader();
  while (!(await reader.read()).done) {
    // Drain the SSE stream so its cleanup runs before the next request.
  }
}

function request(fullDraft: string) {
  return new Request("https://app.test/api/rewrite", {
    method: "POST",
    body: JSON.stringify({
      selection: "same selected sentence for distinct drafts",
      instruction: "make it clearer",
      fullDraft,
    }),
  });
}

describe("POST /api/rewrite dedupe identity", () => {
  test("allows the same edit in different full-draft contexts", async () => {
    const first = await POST(request("First draft context"));
    expect(first.status).toBe(200);
    await drain(first);

    const second = await POST(request("Second draft context"));
    expect(second.status).toBe(200);
    await drain(second);

    expect(costClaim).toHaveBeenCalledTimes(2);
  });
});

import { beforeEach, describe, expect, test, vi } from "vitest";

const completeChat = vi.fn();

vi.mock("@/lib/openrouter", async (original) => {
  const actual = await original<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    completeChat,
    logOpenRouterUsage: vi.fn(async () => undefined),
  };
});

const { repairAiTells, resolveAiTellModel } = await import(
  "@/lib/agent/specialists/ai-tell-repair"
);
const { CHAT_MODEL } = await import("@/lib/openrouter");

beforeEach(() => {
  completeChat.mockReset();
  delete process.env.AGENT_AI_TELL_REPAIR;
});

describe("conditional AI-tell repair", () => {
  test("falls back to the configured chat model when its override is absent or blank", () => {
    expect(resolveAiTellModel(undefined)).toBe(CHAT_MODEL);
    expect(resolveAiTellModel("   ")).toBe(CHAT_MODEL);
    expect(resolveAiTellModel("custom/model")).toBe("custom/model");
  });

  test("does not call a model for a clean post", async () => {
    const body = "I changed our pricing last week because the old plan confused buyers.";
    const result = await repairAiTells({ body });
    expect(result).toEqual({ body, repaired: false, detected: [] });
    expect(completeChat).not.toHaveBeenCalled();
  });

  test("repairs a detected pattern with one structured model call", async () => {
    completeChat.mockResolvedValue({
      text: "",
      toolArgs: {
        body: "It is fast and cheap.",
      },
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });
    const result = await repairAiTells({ body: "Fast, cheap, easy." });
    expect(result.repaired).toBe(true);
    expect(result.detected).toContain("rule-of-three");
    expect(completeChat).toHaveBeenCalledTimes(1);
    expect(completeChat.mock.calls[0][0].model).toBe(CHAT_MODEL);
  });

  test("fails open when the rewrite still contains an AI tell", async () => {
    const body = "Fast, cheap, easy.";
    completeChat.mockResolvedValue({ text: "", toolArgs: { body } });
    const result = await repairAiTells({ body });
    expect(result.body).toBe(body);
    expect(result.repaired).toBe(false);
  });

  test("rejects a rewrite that exceeds the caller's draft cap", async () => {
    const body = "Fast, cheap, easy.";
    completeChat.mockResolvedValue({
      text: "",
      toolArgs: { body: "It is fast and cheap." },
    });
    const result = await repairAiTells({ body, maxChars: 10 });
    expect(result.body).toBe(body);
    expect(result.repaired).toBe(false);
  });

  test("supports an environment kill switch", async () => {
    process.env.AGENT_AI_TELL_REPAIR = "0";
    const body = "Fast, cheap, easy.";
    const result = await repairAiTells({ body });
    expect(result.body).toBe(body);
    expect(completeChat).not.toHaveBeenCalled();
  });
});

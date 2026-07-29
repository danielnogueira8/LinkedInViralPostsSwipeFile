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
const { CHAT_MODEL, BACKGROUND_MODEL } = await import("@/lib/openrouter");

beforeEach(() => {
  completeChat.mockReset();
  delete process.env.AGENT_AI_TELL_REPAIR;
});

describe("conditional AI-tell repair", () => {
  test("falls back to the configured chat model when its override is absent or blank", () => {
    expect(resolveAiTellModel(undefined)).toBe(CHAT_MODEL);
    expect(resolveAiTellModel("   ")).toBe(CHAT_MODEL);
    expect(resolveAiTellModel("custom/model")).toBe(CHAT_MODEL);
    expect(resolveAiTellModel("openai/gpt-5.6-terra")).toBe(
      "openai/gpt-5.6-terra",
    );
  });

  test("repair runs on the cheap background tier, never the auto-router", () => {
    // Repair is a narrow forced-tool copy edit — it follows BACKGROUND_MODEL
    // (Haiku 4.5 under the Anthropic flag, CHAT_MODEL off it), never the
    // openrouter/auto meta-router that hung GLM past the 8s stage timeout.
    expect(resolveAiTellModel(undefined)).toBe(BACKGROUND_MODEL);
    expect(resolveAiTellModel(undefined)).not.toContain("openrouter/auto");
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

  test("repairs an isolated repeated opener before delivery", async () => {
    const body = [
      "Your offer becomes easier to copy when it is invisible. Your price becomes easier to undercut without public proof. Your product becomes easier to clone than your reputation.",
      "",
      "A visible body of work gives buyers proof before they compare alternatives.",
    ].join("\n");
    const repairedBody = [
      "An invisible offer is easier to copy. Without public proof, buyers compare the price alone.",
      "",
      "A reputation built in public remains harder to clone than the product.",
    ].join("\n");
    completeChat.mockResolvedValue({
      text: "",
      toolArgs: { body: repairedBody },
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    const result = await repairAiTells({ body });

    expect(result).toMatchObject({
      body: repairedBody,
      repaired: true,
      detected: ["repeated-opener"],
    });
    expect(completeChat).toHaveBeenCalledTimes(1);
    expect(
      String(completeChat.mock.calls[0][0].messages[1].content),
    ).toContain("repeated-opener");
  });

  test("explains the newly enforced tells to the repair model", async () => {
    completeChat.mockResolvedValue({
      text: "",
      toolArgs: {
        body: "A visible body of work protects your edge. Buyers trust the proof they have already seen.",
      },
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    await repairAiTells({
      body:
        "Your offer gets copied. Your price gets undercut. Your product gets cloned. Not likes, not impressions, not follower count.",
    });

    const systemPrompt = String(completeChat.mock.calls[0][0].messages[0].content);
    expect(systemPrompt).toContain("including You or Your");
    expect(systemPrompt).toContain("Not X, not Y, not Z");
    expect(systemPrompt).toContain("rule-of-three");
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

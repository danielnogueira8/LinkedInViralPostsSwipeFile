import { describe, expect, test, vi, beforeEach } from "vitest";

const completeChat = vi.fn();
const logOpenRouterUsage = vi.fn(async () => {});

vi.mock("@/lib/openrouter", async (original) => ({
  ...(await original<typeof import("@/lib/openrouter")>()),
  completeChat,
  logOpenRouterUsage,
}));

const {
  coerceIntentDecision,
  decideFallthroughIntent,
} = await import("@/lib/agent/turn/intent-decision");

function reply(json: unknown) {
  return {
    text: JSON.stringify(json),
    model: "openai/gpt-5.6-luna",
    usage: { prompt_tokens: 40, completion_tokens: 8 },
  };
}

const BASE = {
  userText: "remove the serious question sentence on the hook",
  workspaceId: "ws_1",
  hasCurrentDraft: true,
  hasModelSource: false,
};

// ---------------------------------------------------------------------------
// coerceIntentDecision — pure validation / normalization of the model output.
// ---------------------------------------------------------------------------
describe("coerceIntentDecision", () => {
  test("accepts each concrete intent", () => {
    for (const intent of [
      "edit_current_draft",
      "new_post",
      "board_action",
      "question",
    ]) {
      expect(coerceIntentDecision({ intent })).toEqual({ intent });
    }
  });

  test("an unknown intent → null (fall open)", () => {
    expect(coerceIntentDecision({ intent: "delete_everything" })).toBeNull();
    expect(coerceIntentDecision({})).toBeNull();
    expect(coerceIntentDecision("edit_current_draft")).toBeNull();
  });

  test("ambiguous keeps a usable clarify (question + ≥2 options, capped at 4)", () => {
    const out = coerceIntentDecision({
      intent: "ambiguous",
      clarify: {
        question: "Did you mean edit this post, or write a new one?",
        options: ["Edit this post", "Write a new post", "  ", "Something else", "Fifth"],
      },
    });
    expect(out?.intent).toBe("ambiguous");
    expect(out?.clarify?.question).toContain("Did you mean");
    // blank dropped, capped at 4
    expect(out?.clarify?.options).toEqual([
      "Edit this post",
      "Write a new post",
      "Something else",
      "Fifth",
    ]);
  });

  test("ambiguous WITHOUT a usable ask → null (never render a broken card)", () => {
    expect(
      coerceIntentDecision({ intent: "ambiguous" }),
    ).toBeNull();
    expect(
      coerceIntentDecision({
        intent: "ambiguous",
        clarify: { question: "Which?", options: ["only one"] },
      }),
    ).toBeNull();
    expect(
      coerceIntentDecision({
        intent: "ambiguous",
        clarify: { question: "", options: ["a", "b"] },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decideFallthroughIntent — the model call, always fail-open.
// ---------------------------------------------------------------------------
describe("decideFallthroughIntent", () => {
  beforeEach(() => {
    completeChat.mockReset();
    logOpenRouterUsage.mockClear();
  });

  test("returns the parsed verdict on a clean edit classification", async () => {
    completeChat.mockResolvedValue(reply({ intent: "edit_current_draft" }));
    const out = await decideFallthroughIntent(BASE);
    expect(out).toEqual({ intent: "edit_current_draft" });
    expect(completeChat).toHaveBeenCalledTimes(1);
    // usage is logged under the intent_decision kind
    expect(logOpenRouterUsage).toHaveBeenCalledWith(
      "intent_decision",
      expect.any(String),
      expect.anything(),
      "ws_1",
      expect.anything(),
    );
  });

  test("empty user text short-circuits without a model call", async () => {
    const out = await decideFallthroughIntent({ ...BASE, userText: "   " });
    expect(out).toBeNull();
    expect(completeChat).not.toHaveBeenCalled();
  });

  test("FAILS OPEN: a thrown model error → null", async () => {
    completeChat.mockRejectedValue(new Error("luna down"));
    expect(await decideFallthroughIntent(BASE)).toBeNull();
  });

  test("FAILS OPEN: malformed / non-JSON output → null", async () => {
    completeChat.mockResolvedValue({
      text: "sure! it looks like you want to edit it",
      model: "openai/gpt-5.6-luna",
      usage: {},
    });
    expect(await decideFallthroughIntent(BASE)).toBeNull();
  });

  test("FAILS OPEN: an ambiguous verdict with no usable options → null", async () => {
    completeChat.mockResolvedValue(reply({ intent: "ambiguous" }));
    expect(await decideFallthroughIntent(BASE)).toBeNull();
  });
});

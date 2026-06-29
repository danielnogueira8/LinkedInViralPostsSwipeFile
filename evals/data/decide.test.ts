import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  parseDecision,
  decisionLayerEnabled,
  decideTurn,
  decisionPromptTokens,
  DECISION_MODEL,
} from "@/lib/agent/decide";

// ---------------------------------------------------------------------------
// The decision pre-pass — a Sonnet-4.6 (via OpenRouter) judgment call that
// decides "ask a clarifying question, or proceed?". The CRITICAL property is
// FAIL OPEN: anything that isn't a clean, actionable "ask" must become "proceed"
// so a decision-layer hiccup degrades to today's GLM behavior, never a broken
// card or a thrown turn. parseDecision is where that safety lives.
// ---------------------------------------------------------------------------

describe("parseDecision — fail-open verdict validation", () => {
  test("a clean ask passes through", () => {
    const v = parseDecision({
      shouldAsk: true,
      question: "Did you mean idea #5, or all 5?",
      options: ["Just idea #5", "All 5 ideas", "Use your best judgment"],
      doneOption: "Use your best judgment",
      reasoning: "bare number against a list",
    });
    expect(v.shouldAsk).toBe(true);
    expect(v.question).toBe("Did you mean idea #5, or all 5?");
    expect(v.options).toHaveLength(3);
    expect(v.doneOption).toBe("Use your best judgment");
  });

  test("shouldAsk:false → proceed", () => {
    expect(parseDecision({ shouldAsk: false })).toEqual({ shouldAsk: false });
  });

  test("null/garbage tool args → proceed (never throws)", () => {
    expect(parseDecision(null)).toEqual({ shouldAsk: false });
    expect(parseDecision({} as Record<string, unknown>)).toEqual({ shouldAsk: false });
    expect(parseDecision({ foo: "bar" })).toEqual({ shouldAsk: false });
  });

  test("shouldAsk:true but NO question → proceed (not a broken card)", () => {
    expect(parseDecision({ shouldAsk: true, options: ["A", "B"] })).toEqual({
      shouldAsk: false,
    });
  });

  test("shouldAsk:true but fewer than 2 options → proceed", () => {
    expect(
      parseDecision({ shouldAsk: true, question: "Which?", options: ["only one"] }),
    ).toEqual({ shouldAsk: false });
    expect(
      parseDecision({ shouldAsk: true, question: "Which?", options: [] }),
    ).toEqual({ shouldAsk: false });
  });

  test("non-string options are filtered before the count check", () => {
    // Two junk + one real → 1 usable option → not actionable → proceed.
    const v = parseDecision({
      shouldAsk: true,
      question: "Q?",
      options: [1, true, "real"] as unknown[],
    });
    expect(v.shouldAsk).toBe(false);
  });

  test("doneOption/reasoning are optional and omitted when absent", () => {
    const v = parseDecision({
      shouldAsk: true,
      question: "Q?",
      options: ["A", "B"],
    });
    expect(v.shouldAsk).toBe(true);
    expect("doneOption" in v).toBe(false);
    expect("reasoning" in v).toBe(false);
  });

  test("shouldAsk must be the literal boolean true (a truthy string doesn't ask)", () => {
    expect(parseDecision({ shouldAsk: "yes" as unknown as boolean })).toEqual({
      shouldAsk: false,
    });
  });
});

describe("decisionLayerEnabled / model config", () => {
  const prev = process.env.AGENT_DECISION_LAYER;
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_DECISION_LAYER;
    else process.env.AGENT_DECISION_LAYER = prev;
  });

  test("disabled by default (no env) → off", () => {
    delete process.env.AGENT_DECISION_LAYER;
    expect(decisionLayerEnabled()).toBe(false);
  });

  test("only '1' enables it", () => {
    process.env.AGENT_DECISION_LAYER = "1";
    expect(decisionLayerEnabled()).toBe(true);
    process.env.AGENT_DECISION_LAYER = "true";
    expect(decisionLayerEnabled()).toBe(false);
  });

  test("defaults to Sonnet 4.6 on OpenRouter", () => {
    expect(DECISION_MODEL).toBe("anthropic/claude-sonnet-4.6");
  });
});

describe("decideTurn — fail-open gating (no network)", () => {
  const prevFlag = process.env.AGENT_DECISION_LAYER;
  const prevKey = process.env.OPENROUTER_API_KEY;
  beforeEach(() => {
    delete process.env.AGENT_DECISION_LAYER;
  });
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.AGENT_DECISION_LAYER;
    else process.env.AGENT_DECISION_LAYER = prevFlag;
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  test("flag off → proceed without any network call", async () => {
    const v = await decideTurn([{ role: "user", content: "draft 5" }], {
      workspaceId: "ws",
    });
    expect(v).toEqual({ shouldAsk: false });
  });

  test("flag on but no API key → proceed (fails open, no throw)", async () => {
    process.env.AGENT_DECISION_LAYER = "1";
    delete process.env.OPENROUTER_API_KEY;
    const v = await decideTurn([{ role: "user", content: "draft 5" }], {
      workspaceId: "ws",
    });
    expect(v).toEqual({ shouldAsk: false });
  });

  test("empty/whitespace history → proceed", async () => {
    process.env.AGENT_DECISION_LAYER = "1";
    process.env.OPENROUTER_API_KEY = "test-key";
    const v = await decideTurn([{ role: "user", content: "   " }], {
      workspaceId: "ws",
    });
    expect(v).toEqual({ shouldAsk: false });
  });
});

describe("decisionPromptTokens — cost footprint", () => {
  test("is bounded and small (thin context, not the 14K system prompt)", () => {
    const history = [
      { role: "user" as const, content: "Give me 5 hook ideas about cold outreach" },
    ];
    const t = decisionPromptTokens(history);
    expect(t).toBeGreaterThan(0);
    // The decision prompt + a short message should be well under a thousand
    // tokens — the whole point is a cheap, thin call.
    expect(t).toBeLessThan(1500);
  });
});

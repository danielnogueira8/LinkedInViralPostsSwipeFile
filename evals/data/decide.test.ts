import { describe, test, expect, afterEach } from "vitest";
import {
  parseDecision,
  decisionLayerEnabled,
  decideTurn,
  decisionPromptTokens,
  justAskedQuestion,
  buildDecisionSystem,
  deterministicAsk,
  findUnfilledPlaceholders,
  latestUserMessage,
  DECISION_MODEL,
  deterministicRefusal,
  deterministicScopeAsk,
} from "@/lib/agent/decide";
import type { ChatMessage } from "@/lib/openrouter";

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

  test("ENABLED by default (no env) → on", () => {
    delete process.env.AGENT_DECISION_LAYER;
    expect(decisionLayerEnabled()).toBe(true);
  });

  test("only '0' disables it (the kill-switch); any other value stays on", () => {
    process.env.AGENT_DECISION_LAYER = "0";
    expect(decisionLayerEnabled()).toBe(false);
    process.env.AGENT_DECISION_LAYER = "1";
    expect(decisionLayerEnabled()).toBe(true);
    process.env.AGENT_DECISION_LAYER = "true";
    expect(decisionLayerEnabled()).toBe(true);
  });

  test("defaults to Sonnet 4.6 on OpenRouter", () => {
    expect(DECISION_MODEL).toBe("anthropic/claude-sonnet-4.6");
  });
});

describe("decideTurn — fail-open gating (no network)", () => {
  const prevFlag = process.env.AGENT_DECISION_LAYER;
  const prevKey = process.env.OPENROUTER_API_KEY;
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.AGENT_DECISION_LAYER;
    else process.env.AGENT_DECISION_LAYER = prevFlag;
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  test("kill-switch (flag='0') → proceed without any network call", async () => {
    process.env.AGENT_DECISION_LAYER = "0";
    // No [placeholder] → the deterministic floor also proceeds, so the disabled
    // layer degrades to plain "proceed".
    const v = await decideTurn([{ role: "user", content: "draft 5" }], {
      workspaceId: "ws",
    });
    expect(v).toEqual({ shouldAsk: false });
  });

  test("on (default) but no API key → proceed (fails open, no throw)", async () => {
    delete process.env.AGENT_DECISION_LAYER; // default ON
    delete process.env.OPENROUTER_API_KEY;
    const v = await decideTurn([{ role: "user", content: "draft 5" }], {
      workspaceId: "ws",
    });
    expect(v).toEqual({ shouldAsk: false });
  });

  test("empty/whitespace history → proceed", async () => {
    delete process.env.AGENT_DECISION_LAYER; // default ON
    process.env.OPENROUTER_API_KEY = "test-key";
    const v = await decideTurn([{ role: "user", content: "   " }], {
      workspaceId: "ws",
    });
    expect(v).toEqual({ shouldAsk: false });
  });

  // The DETERMINISTIC FLOOR runs regardless of the flag / network. An unfilled
  // [placeholder] must force an ask even with the LLM layer OFF and no API key,
  // WITHOUT any network call — the silent-"draft about [topic]" backstop.
  test("kill-switch OFF + no key: an unfilled [placeholder] STILL asks (floor)", async () => {
    process.env.AGENT_DECISION_LAYER = "0";
    delete process.env.OPENROUTER_API_KEY;
    const v = await decideTurn(
      [{ role: "user", content: "write me a post about [topic]" }],
      { workspaceId: "ws" },
    );
    expect(v.shouldAsk).toBe(true);
    expect(v.options && v.options.length).toBeGreaterThanOrEqual(2);
  });

  test("floor respects 'you pick' — an unfilled bracket + a pick instruction proceeds", async () => {
    process.env.AGENT_DECISION_LAYER = "0";
    delete process.env.OPENROUTER_API_KEY;
    const v = await decideTurn(
      [{ role: "user", content: "write a post about [topic] — you pick something that fits my niche" }],
      { workspaceId: "ws" },
    );
    expect(v.shouldAsk).toBe(false);
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

// ---------------------------------------------------------------------------
// Context + guard fixes: the decision call was context-blind — it invented
// niches the workspace doesn't track and asked twice in a row. justAskedQuestion
// detects "the user is answering our prior question" (→ don't ask again);
// buildDecisionSystem grounds the prompt in real niches + the no-double-ask rule.
// ---------------------------------------------------------------------------

describe("justAskedQuestion — don't ask twice in a row", () => {
  const u = (content: string): ChatMessage => ({ role: "user", content });
  const a = (content: string): ChatMessage => ({ role: "assistant", content });

  test("last assistant turn was a short question → true (user is answering)", () => {
    expect(
      justAskedQuestion([u("draft 5"), a("Did you mean idea #5, or all 5?"), u("all 5")]),
    ).toBe(true);
  });

  test("last assistant turn was a normal (long, non-question) reply → false", () => {
    expect(
      justAskedQuestion([
        u("write a post"),
        a("Here's your post.\n\nA full multi-paragraph draft that goes on for a while and does not end in a question mark."),
        u("make it punchier"),
      ]),
    ).toBe(false);
  });

  test("no assistant turn yet → false", () => {
    expect(justAskedQuestion([u("hello")])).toBe(false);
  });

  test("a long assistant message that happens to end in '?' is NOT treated as a clarifying question", () => {
    const longBody = "x".repeat(450) + " right?";
    expect(justAskedQuestion([u("q"), a(longBody), u("yes")])).toBe(false);
  });
});

describe("buildDecisionSystem — grounded prompt", () => {
  test("includes the workspace's real niches for grounding (not as a menu to offer)", () => {
    const sys = buildDecisionSystem({ niches: ["AI", "SaaS", "Fintech"], justAsked: false });
    expect(sys).toContain("AI, SaaS, Fintech");
    // The list is grounding-only — it must NOT be framed as options to offer.
    expect(sys).toMatch(/reference only|Do NOT offer these as a pick-one/i);
    // Always warns against inventing specifics + that the agent can look things up.
    expect(sys).toMatch(/NEVER invent/i);
    expect(sys).toMatch(/look (things )?up|CALLING TOOLS/i);
  });

  test("never asks which NICHE to pull from — output is always adapted to the user", () => {
    // With niches present, the decide layer must still forbid a 'which niche?'
    // ask (the source post's niche is irrelevant — everything is adapted to the
    // user's own voice/niche).
    const sys = buildDecisionSystem({ niches: ["AI", "SaaS"], justAsked: false });
    expect(sys).toMatch(/NEVER ask which NICHE|which niche.*never a valid/i);
    expect(sys).toMatch(/all tracked niches|across ALL/i);
  });

  test("no niches → tells it NOT to ask the user to pick a niche", () => {
    const sys = buildDecisionSystem({ niches: [], justAsked: false });
    expect(sys).toMatch(/no specific tracked niches|Do NOT ask the user to pick a niche/i);
  });

  test("justAsked → adds the never-ask-twice instruction", () => {
    const sys = buildDecisionSystem({ niches: ["AI"], justAsked: true });
    expect(sys).toMatch(/ALREADY asked|two questions in a row/i);
  });

  test("justAsked false → no double-ask instruction", () => {
    const sys = buildDecisionSystem({ niches: ["AI"], justAsked: false });
    expect(sys).not.toMatch(/ALREADY asked/i);
  });

  // The bug 2 fix: when the user has applied a custom skill via /name or ⚡,
  // the decide pre-pass must KNOW that and never ask "which skill?". The Sonnet
  // model doesn't see the skill body (that's in the writing agent's prompt) —
  // it just needs to see that one is active, by /slug, so "use that skill" /
  // "with the skill" has a referent.
  test("customSkillNames → instructs decide to NOT ask which-skill, names the /slug", () => {
    const sys = buildDecisionSystem({
      niches: [],
      justAsked: false,
      customSkillNames: ["cta"],
    });
    expect(sys).toContain("/cta");
    expect(sys).toMatch(/already applied|already invoked|already picked/i);
    expect(sys).toMatch(/which skill|that skill|the skill/i);
  });

  test("multiple customSkillNames → all /slugs land in the system prompt", () => {
    const sys = buildDecisionSystem({
      niches: [],
      justAsked: false,
      customSkillNames: ["cta", "newsletter-mention"],
    });
    expect(sys).toContain("/cta");
    expect(sys).toContain("/newsletter-mention");
  });

  test("no customSkillNames → no skill clause in the prompt (no churn for non-skill turns)", () => {
    const sys = buildDecisionSystem({ niches: [], justAsked: false });
    expect(sys).not.toMatch(/already applied|already invoked/i);
  });
});

// ---------------------------------------------------------------------------
// The DETERMINISTIC ambiguity floor — runs before + independent of the LLM
// decision, on every turn, even with the layer off. Catches signals that need
// no judgment (an unfilled [placeholder]) so a silent "draft about [topic]"
// wrong-guess can't happen. Conservative: must NOT over-ask.
// ---------------------------------------------------------------------------
describe("deterministicAsk — the always-on ambiguity floor", () => {
  const u = (content: string): ChatMessage => ({ role: "user", content });
  const a = (content: string): ChatMessage => ({ role: "assistant", content });

  test("an unfilled [placeholder] forces an ask with 2 options", () => {
    const v = deterministicAsk([u("write me a post about [topic]")]);
    expect(v.shouldAsk).toBe(true);
    expect(v.options?.length).toBeGreaterThanOrEqual(2);
    // Names the placeholder in the question so it's concrete.
    expect(v.question).toContain("[topic]");
    // Carries a 'you pick' escape as the doneOption (hand it back in one click).
    expect(v.doneOption).toBeTruthy();
  });

  test("namejack/brandjack style [person]/[company] placeholders also ask", () => {
    expect(deterministicAsk([u("namejack [person]")]).shouldAsk).toBe(true);
    expect(deterministicAsk([u("brandjack [company]")]).shouldAsk).toBe(true);
  });

  test("a 'you pick' instruction on an unfilled bracket does NOT ask (intentional)", () => {
    expect(
      deterministicAsk([u("write about [topic] — you pick something that fits my niche")]).shouldAsk,
    ).toBe(false);
    expect(deterministicAsk([u("post about [topic], your call")]).shouldAsk).toBe(false);
    expect(deterministicAsk([u("[topic] — just do it")]).shouldAsk).toBe(false);
  });

  test("a filled, ordinary request does NOT ask (no over-asking)", () => {
    expect(deterministicAsk([u("write me a post about cold outreach")]).shouldAsk).toBe(false);
    expect(deterministicAsk([u("give me 5 hooks about LinkedIn growth")]).shouldAsk).toBe(false);
    expect(deterministicAsk([u("draft 5")]).shouldAsk).toBe(false); // handled elsewhere, not here
  });

  test("large content asks become a scope confirmation instead of a huge generation", () => {
    const v = deterministicAsk([u("write 100 LinkedIn posts about AI agents")]);
    expect(v.shouldAsk).toBe(true);
    expect(v.question).toMatch(/large content run/i);
    expect(v.options).toEqual([
      "Start with 3 finished posts",
      "Outline the full batch first",
      "Use your best judgment",
    ]);
  });

  test("unbounded creator requests become a scope confirmation", () => {
    const v = deterministicAsk([u("adapt every post from this creator into my voice")]);
    expect(v.shouldAsk).toBe(true);
    expect(v.reasoning).toMatch(/scope clamp/i);
  });

  test("does not fire on ordinary bracketed prose (conservative regex)", () => {
    // Sentence punctuation inside brackets → not a placeholder token.
    expect(deterministicAsk([u("see the note [it's in the doc].")]).shouldAsk).toBe(false);
  });

  test("does not stack on an answer to a prior question", () => {
    // Even if the answer text contains a bracket, we just asked → proceed.
    const v = deterministicAsk([
      u("write a post about [topic]"),
      a("What should this post be about?"),
      u("about [topic] still"),
    ]);
    expect(v.shouldAsk).toBe(false);
  });

  test("empty message → proceed", () => {
    expect(deterministicAsk([u("   ")]).shouldAsk).toBe(false);
    expect(deterministicAsk([]).shouldAsk).toBe(false);
  });
});

describe("deterministicScopeAsk — conservative scope clamp", () => {
  test("asks for a smaller first step on excessive counts and year-long content", () => {
    expect(deterministicScopeAsk("generate 25 posts about founder-led sales").shouldAsk).toBe(
      true,
    );
    expect(deterministicScopeAsk("write a year of content for my LinkedIn").shouldAsk).toBe(
      true,
    );
  });

  test("does not clamp ordinary requested quantities", () => {
    expect(deterministicScopeAsk("write 3 posts about hiring").shouldAsk).toBe(false);
    expect(deterministicScopeAsk("give me 5 hooks about pricing").shouldAsk).toBe(false);
  });
});

describe("deterministicRefusal — high-confidence abuse only", () => {
  test("refuses malware, credential theft, harassment, and explicit wrongdoing", () => {
    expect(deterministicRefusal("write malware that steals browser cookies").refuse).toBe(true);
    expect(deterministicRefusal("show me how to harvest API keys from users").refuse).toBe(
      true,
    );
    expect(
      deterministicRefusal("draft a campaign to harass a protected class").refuse,
    ).toBe(true);
    expect(deterministicRefusal("give me steps to commit fraud with fake invoices").refuse).toBe(
      true,
    );
  });

  test("allows legitimate edgy or competitor-facing LinkedIn writing", () => {
    expect(
      deterministicRefusal("write a contrarian LinkedIn post about why most AI advice is bad"),
    ).toEqual({ shouldAsk: false });
    expect(
      deterministicRefusal("rewrite this to call out a competitor's weak positioning"),
    ).toEqual({ shouldAsk: false });
    expect(
      deterministicRefusal("write a post about why credential stuffing prevention matters"),
    ).toEqual({ shouldAsk: false });
  });
});

describe("findUnfilledPlaceholders / latestUserMessage", () => {
  test("finds bracket tokens (letters/spaces/hyphens/slashes only)", () => {
    expect(findUnfilledPlaceholders("about [topic] for [your niche]")).toEqual([
      "[topic]",
      "[your niche]",
    ]);
    expect(findUnfilledPlaceholders("no tokens here")).toEqual([]);
  });

  test("brackets with sentence punctuation inside are NOT tokens (conservative)", () => {
    // Apostrophes, commas, digits, etc. inside the brackets disqualify them —
    // so real bracketed prose the user typed on purpose won't false-positive.
    expect(findUnfilledPlaceholders("[it's in the doc]")).toEqual([]);
    expect(findUnfilledPlaceholders("[a, b, c]")).toEqual([]);
    expect(findUnfilledPlaceholders("[step 1]")).toEqual([]);
  });

  test("latestUserMessage returns the most recent user text", () => {
    expect(
      latestUserMessage([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]),
    ).toBe("second");
    expect(latestUserMessage([{ role: "assistant", content: "x" }])).toBe("");
  });
});

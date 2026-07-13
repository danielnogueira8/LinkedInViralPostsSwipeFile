import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// End-to-end: runAgent threads customSkillBodies into the system messages the
// model actually receives, AND a turn with no custom skill sends the SAME system
// messages as before. We capture the `messages` streamChat is called with.
// ---------------------------------------------------------------------------

const captured: { messages: ChatMessage[] } = { messages: [] };

vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    streamChat: (opts: { messages: ChatMessage[] }) => {
      captured.messages = opts.messages;
      return (async function* () {
        yield { text: "ok.", finishReason: "stop" as const };
      })();
    },
  };
});

// Decision layer off by default (no env) so it doesn't intercept.
const { runAgent } = await import("@/lib/agent");

async function run(opts: {
  customSkillBodies?: string[];
  message?: string;
}): Promise<void> {
  for await (const _ of runAgent({
    // Default message triggers NO built-in skill, so a system-message count is a
    // clean baseline (a real message like "write a post" would fire VOICE_MATCH —
    // correct, but it muddies the count assertion).
    history: [{ role: "user", content: opts.message ?? "hello there friend" }],
    workspaceId: "ws",
    customSkillBodies: opts.customSkillBodies,
  })) {
    void _;
  }
}

// The text of every system message the model received this turn, joined.
function systemText(): string {
  return captured.messages
    .filter((m) => m.role === "system")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
          : "",
    )
    .join("\n\n");
}

beforeEach(() => {
  captured.messages = [];
});

describe("runAgent — custom skill bodies reach the model", () => {
  test("a custom skill body appears in the system messages", async () => {
    await run({ customSkillBodies: ["Always end with my newsletter CTA: comment GUIDE."] });
    expect(systemText()).toContain("Always end with my newsletter CTA: comment GUIDE.");
  });

  test("no custom skill → the system messages do NOT contain the skill block framing", async () => {
    await run({ customSkillBodies: [] });
    const txt = systemText();
    // The custom-skill framing line only appears when a custom skill is used.
    expect(txt).not.toMatch(/their own saved guidance/i);
  });

  test("the count of system messages is unchanged when no custom skill is used", async () => {
    // Baseline: a no-trigger message + no custom skill → the cached system
    // message PLUS the (uncached) current-date message. No separate skill
    // message. The date block is always present but never touches the cached
    // prefix, so cache behaviour is unchanged — see todayDateMessage().
    await run({ customSkillBodies: [] });
    const sysCount = captured.messages.filter((m) => m.role === "system").length;
    expect(sysCount).toBe(2); // SYSTEM_PROMPT+writing block + date block
  });

  test("a custom skill adds the separate (uncached) skill system message", async () => {
    await run({ customSkillBodies: ["My guidance."] });
    const sysCount = captured.messages.filter((m) => m.role === "system").length;
    expect(sysCount).toBe(3); // cached prefix + date block + the skill block
  });
});

// ---------------------------------------------------------------------------
// The always-on POST_STRUCTURE_SKILL: it must reach EVERY turn (like the
// anti-slop writing skill) so from-scratch posts don't all use one skeleton —
// AND it must live in the CACHED prefix, not add a per-turn uncached message.
// ---------------------------------------------------------------------------
describe("runAgent — structure-variety skill is always on + cache-safe", () => {
  test("the structure-variety guidance reaches the model every turn", async () => {
    await run({ customSkillBodies: [] });
    const txt = systemText();
    expect(txt).toContain("Vary the STRUCTURE of every from-scratch post");
    // It offers a MENU of architectures (the whole point — not one shape).
    expect(txt).toMatch(/single-insight/i);
    expect(txt).toMatch(/contrarian/i);
    expect(txt).toMatch(/story|narrative/i);
  });

  test("it scopes to from-scratch posts and defers to a modeled source", async () => {
    await run({ customSkillBodies: [] });
    const txt = systemText();
    // Must NOT override a modeled/adapted post's structure.
    expect(txt).toMatch(/adapting one, follow ITS shape/i);
  });

  test("it rides the cached prefix — no EXTRA system message is added for it", async () => {
    // Still exactly 2 system messages with no custom skill: the cached prefix
    // (SYSTEM_PROMPT + writing skill + structure skill, one block) + the date
    // block. If the structure skill had been added as its own message, this
    // would be 3.
    await run({ customSkillBodies: [] });
    const sysCount = captured.messages.filter((m) => m.role === "system").length;
    expect(sysCount).toBe(2);
    // And it's in the FIRST (cached) block, joined with the writing skill.
    const first = captured.messages.find((m) => m.role === "system");
    const firstText =
      typeof first?.content === "string"
        ? first.content
        : Array.isArray(first?.content)
          ? first!.content.map((b) => (b.type === "text" ? b.text : "")).join("")
          : "";
    expect(firstText).toContain("Vary the STRUCTURE of every from-scratch post");
    expect(firstText).toContain("Write like a human, not like AI"); // the writing skill too
  });
});

// ---------------------------------------------------------------------------
// Current-date injection. The model has no built-in clock, so relative-date
// phrasing ("yesterday", "last week") was unanchored. We inject the date as a
// SEPARATE, uncached system message so relative dates resolve WITHOUT touching
// the cached ~14K prefix. Two things must hold: (1) the date reaches the model
// with the recency guardrail intact, and (2) the cached prefix content-block is
// byte-identical to before — otherwise every turn pays full price.
// ---------------------------------------------------------------------------
describe("runAgent — injects the current date (cache-safe)", () => {
  test("a date system message reaches the model with an ISO date", async () => {
    await run({ customSkillBodies: [] });
    const joined = systemText();
    expect(joined).toMatch(/Today's date is \d{4}-\d{2}-\d{2}/);
  });

  test("the date block carries the recency guardrail (not data recency)", async () => {
    await run({ customSkillBodies: [] });
    const joined = systemText();
    // It must tell the model this is ONLY for relative dates...
    expect(joined).toMatch(/resolve relative dates/i);
    // ...and that data freshness still comes from the tool's scrape date.
    expect(joined).toContain("scrape.scraped_at");
    expect(joined).toContain("posted_at");
  });

  test("the date block is a plain-string system message right AFTER the cached prefix", async () => {
    await run({ customSkillBodies: [] });
    // Index 0 is the cached prefix (a content-block array with cache_control).
    // Index 1 is the date block — a plain string, so it's NOT cached.
    const first = captured.messages[0];
    const second = captured.messages[1];
    expect(Array.isArray(first.content)).toBe(true); // cached content-block prefix
    expect(second.role).toBe("system");
    expect(typeof second.content).toBe("string"); // uncached plain string
    expect(second.content).toMatch(/Today's date is/);
  });

  test("the cached prefix content-block is untouched by the date injection", async () => {
    await run({ customSkillBodies: [] });
    const prefix = captured.messages[0];
    // The prefix is still exactly one text block carrying the cache breakpoint.
    // If the date had leaked into it, this block would differ / lose its marker.
    expect(Array.isArray(prefix.content)).toBe(true);
    const block = (prefix.content as { type: string; text: string; cache_control?: unknown }[])[0];
    expect(block.type).toBe("text");
    expect(block.cache_control).toEqual({ type: "ephemeral" });
    // The volatile date must NOT be inside the cached block.
    expect(block.text).not.toMatch(/Today's date is/);
  });
});

// ---------------------------------------------------------------------------
// Template-fill guidance must NOT push the model to fabricate. The template
// body is user-typed freeform with {tokens}; some need facts the app doesn't
// store ({offer}, {proof_point}, {client}). The prompt used to say "FILL every
// placeholder ... never leave a literal {token}", which drove invention. It
// must now split derivable vs fact placeholders and ask for the unknown facts.
// ---------------------------------------------------------------------------
describe("runAgent — template-fill guidance doesn't invent facts", () => {
  test("the system prompt covers the TEMPLATE TO FILL envelope", async () => {
    await run({ customSkillBodies: [] });
    expect(systemText()).toContain("--- TEMPLATE TO FILL ---");
  });

  test("it distinguishes derivable placeholders from user-fact placeholders", async () => {
    await run({ customSkillBodies: [] });
    const txt = systemText();
    expect(txt).toMatch(/DERIVABLE placeholders/);
    expect(txt).toMatch(/FACT placeholders/);
    // The concrete fact tokens that have no source in this app are named.
    expect(txt).toMatch(/\{offer\}/);
    expect(txt).toMatch(/\{proof_point\}/);
  });

  test("it tells the model to ASK for unknown facts, not invent them", async () => {
    await run({ customSkillBodies: [] });
    const txt = systemText();
    expect(txt).toMatch(/DO NOT invent/);
    expect(txt).toMatch(/ask_user/);
    // A clearly-marked bracketed fallback, never a fabricated value.
    expect(txt).toMatch(/\[YOUR OFFER\]/);
  });

  test("it dropped the blanket 'never leave a literal {token}' fill-everything rule", async () => {
    await run({ customSkillBodies: [] });
    const txt = systemText();
    // The old wording that pushed fabrication must be gone.
    expect(txt).not.toMatch(/never leave a literal \{token\} in the output/);
    expect(txt).not.toMatch(/FILL every placeholder with real, specific content/);
  });
});

// ---------------------------------------------------------------------------
// todayDateMessage — the pure builder, tested with an injected date so it's
// deterministic (production uses the real `new Date()`).
// ---------------------------------------------------------------------------
describe("todayDateMessage — pure date-block builder", () => {
  test("formats the injected date as YYYY-MM-DD (UTC)", async () => {
    const { todayDateMessage } = await import("@/lib/agent/date-context");
    const msg = todayDateMessage(new Date("2026-07-01T09:30:00Z"));
    expect(msg.role).toBe("system");
    expect(msg.content).toContain("Today's date is 2026-07-01 (UTC)");
  });

  test("takes the UTC calendar date, not local — late-UTC times don't roll back", async () => {
    const { todayDateMessage } = await import("@/lib/agent/date-context");
    // 23:30 UTC on the 1st is still the 1st in UTC (guards against a local-tz
    // slice that could report the 30th).
    const msg = todayDateMessage(new Date("2026-07-01T23:30:00Z"));
    expect(msg.content).toContain("2026-07-01");
  });

  test("includes the relative-date-only guardrail + scrape-date pointer", async () => {
    const { todayDateMessage } = await import("@/lib/agent/date-context");
    const msg = todayDateMessage(new Date("2026-07-01T00:00:00Z"));
    const text = msg.content as string;
    expect(text).toMatch(/ONLY to resolve relative dates/i);
    expect(text).toContain("scrape.scraped_at");
    expect(text).toContain("posted_at");
    // Explicitly warns against using today as data recency.
    expect(text).toMatch(/NOT the recency/i);
  });
});

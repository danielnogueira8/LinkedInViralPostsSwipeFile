import { describe, test, expect, vi, beforeEach } from "vitest";
import { runLiveAgent, visibleDeliverable, type ToolFixtures } from "./harness";

// ---------------------------------------------------------------------------
// PROMPT-QUALITY AUDIT (live, OpenRouter-only).
//
// Targeted live probes for the two reported quality complaints plus core
// deliverable contracts:
//   A. RECENCY: "show me the most recent posts" — does the model reach for
//      search_viral_posts with sort:"posted", or does it fall back to the
//      engagement-ranked get_top_from_batch?
//   B. IDEA SOURCING: given a realistic get_top_from_batch result (big
//      creators ranked first by reactions, small creators recent but lower),
//      do generated ideas draw from the RECENT posts (per the tool
//      description's "most RECENT first" ranking rule) or from the big names?
//   C. COUNT CONTRACT: "exactly 3 ideas" → exactly 3.
//   D. REPETITION: two independent ideation runs over the SAME source data —
//      how much do the idea lists overlap? (Measurement, logged.)
//
// Unlike prompt-evals.live.test.ts this file needs NO Anthropic key: the
// fuzzy checks use a small OpenRouter judge (Haiku — different family from
// the GLM model under test, so no self-grading). Gate: RUN_LIVE_EVALS=1 +
// OPENROUTER_API_KEY only.
// ---------------------------------------------------------------------------

const fixtures: { current: ToolFixtures } = { current: {} };
function setFixtures(f: ToolFixtures): void {
  fixtures.current = f;
}

vi.mock("@/lib/agent/tools", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/agent/tools")>();
  return {
    ...orig,
    runTool: async (name: string) => fixtures.current[name] ?? { ok: true },
  };
});
vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return { ...orig, logOpenRouterUsage: async () => undefined };
});

const gate =
  process.env.RUN_LIVE_EVALS === "1" && !!process.env.OPENROUTER_API_KEY;
const maybe = gate ? describe : describe.skip;
if (!gate) {
  console.log(
    "[prompt-quality audit] skipped — needs RUN_LIVE_EVALS=1 + OPENROUTER_API_KEY",
  );
}

// Small OpenRouter judge (Haiku): different model family from GLM under test.
async function orJudge(opts: {
  deliverable: string;
  rule: string;
}): Promise<{ pass: boolean; reason: string }> {
  const { completeChat } = await import("@/lib/openrouter");
  try {
    const res = await completeChat({
      model: "anthropic/claude-haiku-4.5",
      maxTokens: 250,
      messages: [
        {
          role: "system",
          content:
            "You are a strict QA grader. Given an ASSISTANT REPLY and one RULE, decide only whether the reply satisfies the rule. Reply with STRICT JSON only: {\"pass\": true|false, \"reason\": \"<one sentence>\"}.",
        },
        {
          role: "user",
          content: `ASSISTANT REPLY:\n${opts.deliverable}\n\nRULE:\n${opts.rule}`,
        },
      ],
    });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return { pass: false, reason: `no JSON: ${res.text.slice(0, 100)}` };
    const p = JSON.parse(m[0]) as { pass?: unknown; reason?: unknown };
    return {
      pass: p.pass === true,
      reason: typeof p.reason === "string" ? p.reason : "(none)",
    };
  } catch (e) {
    return { pass: false, reason: `judge error: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Fixture: a faithful get_top_from_batch result. Mirrors the REAL tool's
// behavior: selected + ordered by reactions DESC (unused-first is a no-op here,
// all unused). Big creators dominate the top; small creators are RECENT but
// rank last. The tool description tells the model to rank ideas by recency
// first — this fixture makes "did it?" measurable by author name.
// ---------------------------------------------------------------------------
const SCRAPE_AT = "2026-07-08T06:00:00.000Z";
function post(
  id: string,
  author: string,
  postedAt: string,
  reactions: number,
  text: string,
) {
  return {
    id: `00000000-0000-4000-8000-00000000000${id}`,
    text: `<post>${text}</post>`,
    post_url: `https://linkedin.com/feed/update/${id}`,
    posted_at: postedAt,
    reactions,
    comments: Math.round(reactions / 20),
    reposts: Math.round(reactions / 50),
    media_type: "none",
    post_type: "regular",
    accounts: { name: author, niche: "SaaS" },
    already_used: false,
  };
}
const TOP_BATCH_FIXTURE = {
  ok: true,
  scrape: { scraped_at: SCRAPE_AT, window_days: 7 },
  count: 8,
  sparse: false,
  posts: [
    // Big creators: huge reactions, posted EARLY in the window (older).
    post("1", "Justin Welsh", "2026-07-01T09:00:00.000Z", 6200, "I built a $5M one-person business. Here are 7 systems that run it while I sleep: 1. Content batching 2. Evergreen funnels 3..."),
    post("2", "Justin Welsh", "2026-07-02T09:00:00.000Z", 5400, "Most people don't have a content problem. They have a consistency problem. I posted daily for 4 years. Here's what happened:"),
    post("3", "Lara Acosta", "2026-07-01T14:00:00.000Z", 4800, "How I gained 100K followers in 12 months (without ads): The exact playbook I'd follow if I started from zero today:"),
    post("4", "Lara Acosta", "2026-07-02T16:00:00.000Z", 4100, "Personal branding isn't posting more. It's positioning. 5 positioning shifts that 10x'd my inbound:"),
    post("5", "Justin Welsh", "2026-07-03T08:00:00.000Z", 3900, "The riches are in the niches. I ignored this advice for 2 years and it cost me $400K. Here's the lesson:"),
    // Small creators: modest reactions, posted LATE in the window (most recent).
    post("6", "Maya Chen", "2026-07-07T18:00:00.000Z", 480, "Nobody talks about the QUIET part of B2B sales: the 6 months where nothing converts and you question everything. My pipeline diary from month 4:"),
    post("7", "Tom Okafor", "2026-07-07T11:00:00.000Z", 390, "We killed our free trial and revenue went UP 40%. The counterintuitive pricing experiment every SaaS founder should run once:"),
    post("8", "Priya Nair", "2026-07-06T20:00:00.000Z", 510, "Your onboarding email sequence is why churn is high. I rewrote ours using support tickets as source material. Results after 60 days:"),
  ],
};

const SEARCH_FIXTURE = {
  ok: true,
  count: 5,
  posts: TOP_BATCH_FIXTURE.posts.slice(3), // any content; selection is what matters
};

// Count "- " / "1." top-level list items in the final text (ideas contract).
function countListItems(text: string): number {
  return text
    .split("\n")
    .filter((l) => /^\s*(?:-|\d{1,2}\.)\s+\S/.test(l)).length;
}

const BIG_NAMES = ["Justin Welsh", "Lara Acosta"];
const SMALL_NAMES = ["Maya Chen", "Tom Okafor", "Priya Nair"];
function nameMentions(text: string, names: string[]): number {
  return names.filter((n) => text.includes(n)).length;
}

maybe("prompt-quality audit (live)", () => {
  beforeEach(() => setFixtures({}));

  // ------------------------------------------------------------------ A ----
  test("A. 'most recent posts' → the model uses a recency-sorted search (3 runs)", async () => {
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      setFixtures({
        search_viral_posts: SEARCH_FIXTURE,
        get_top_from_batch: TOP_BATCH_FIXTURE,
      });
      const r = await runLiveAgent(
        "Show me the 5 most recent viral posts from my swipe file.",
      );
      const calls = r.toolCalls.map((c) => `${c.name}(${c.args})`).join(" | ");
      const searchCall = r.toolCalls.find((c) => c.name === "search_viral_posts");
      const usedRecencySort = !!searchCall && /"sort"\s*:\s*"posted"/.test(searchCall.args);
      const usedTopBatch = r.toolCalls.some((c) => c.name === "get_top_from_batch");
      results.push(
        `run${i + 1}: recencySort=${usedRecencySort} usedTopBatch=${usedTopBatch} calls=[${calls}]`,
      );
    }
    console.log(`\n[A: recency tool selection]\n${results.join("\n")}\n`);
    expect(results.length).toBe(3); // measurement test — results in the log
  }, 240_000);

  // ------------------------------------------------------------------ B ----
  test("B. ideas draw from RECENT posts, not just big names (2 runs)", async () => {
    const summaries: string[] = [];
    for (let i = 0; i < 2; i++) {
      setFixtures({ get_top_from_batch: TOP_BATCH_FIXTURE });
      const r = await runLiveAgent("Give me 5 post ideas based on what's working right now.");
      const out = visibleDeliverable(r);
      const big = nameMentions(out, BIG_NAMES);
      const small = nameMentions(out, SMALL_NAMES);
      const verdict = await orJudge({
        deliverable: out,
        rule:
          "The reply contains post ideas. At least 2 of the ideas must be clearly derived from these RECENT source posts: quiet part of B2B sales / killing a free trial raising revenue / onboarding emails causing churn. Ideas derived only from one-person-business systems, consistency, followers growth, positioning, or niches do NOT count.",
      });
      summaries.push(
        `run${i + 1}: bigNames=${big}/2 smallNames=${small}/3 judgeRecentIdeas=${verdict.pass}`,
      );
    }
    console.log(`\n[B: idea sourcing]\n${summaries.join("\n")}\n`);
    expect(summaries.length).toBe(2);
  }, 300_000);

  // ------------------------------------------------------------------ C ----
  test("C. count contract: exactly 3 ideas (2 runs)", async () => {
    for (let i = 0; i < 2; i++) {
      setFixtures({ get_top_from_batch: TOP_BATCH_FIXTURE });
      const r = await runLiveAgent("Give me exactly 3 post ideas.");
      const n = countListItems(r.finalText);
      console.log(`[C run${i + 1}] listItems=${n}`);
      expect(r.errored).toBe(false);
      // The contract: exactly 3 (system prompt: "honor that count precisely").
      expect(n).toBe(3);
    }
  }, 300_000);

  // ------------------------------------------------------------------ D ----
  test("D. repetition: two independent ideation runs over the SAME data (measurement)", async () => {
    const outs: string[] = [];
    for (let i = 0; i < 2; i++) {
      setFixtures({ get_top_from_batch: TOP_BATCH_FIXTURE });
      const r = await runLiveAgent("Give me 5 post ideas.");
      outs.push(visibleDeliverable(r));
    }
    const verdict = await orJudge({
      deliverable: `LIST ONE:\n${outs[0]}\n\nLIST TWO:\n${outs[1]}`,
      rule:
        "These are two idea lists generated independently. PASS if 3 or more of the 5 ideas in LIST TWO cover substantially the same topic/angle as an idea in LIST ONE (i.e. the lists repeat themselves). FAIL if the lists are mostly distinct.",
    });
    console.log(`\n[D: repetition] samePool→overlap=${verdict.pass}\n`);
    expect(outs.length).toBe(2); // measurement — verdict in the log
  }, 300_000);
});

// ---------------------------------------------------------------------------
// E. FRESHNESS BLOCK COMPLIANCE (headless A/B). Validates that the
// anti-repetition constraint injected by the freshness tracker actually steers
// the writer away from named identity anchors. Uses the REAL batch prompt
// builder + REAL renderFreshnessBlock, one completeChat per arm.
// ---------------------------------------------------------------------------
maybe("freshness block compliance (live, headless)", () => {
  test("E. the injected avoid-list suppresses named identity anchors (A/B)", async () => {
    const { buildWeeklyDraftSystem } = await import(
      "@/lib/batch/weekly-draft-prompt"
    );
    const { renderFreshnessBlock } = await import(
      "@/lib/agent/specialists/freshness"
    );
    const { completeChat, CHAT_MODEL } = await import("@/lib/openrouter");

    // A voice profile whose exemplars BAIT the anchor: both name-drop the
    // user's esports past, so an unconstrained draft is likely to reuse it.
    const voice = {
      summary:
        "Former competitive esports player turned B2B SaaS founder. Writes blunt, practical posts about building products and teams.",
      audience: { primary: "SaaS founders", pain_points: ["churn"], outcomes: ["growth"] },
      topics: ["SaaS", "teams", "product"],
      positioning: "The ex-pro-gamer founder who applies competitive discipline to startups.",
      tone: ["blunt", "practical"],
      format_patterns: { hook_styles: ["bold claim"], structure: "hook, story, lesson", length: "short" },
      signature_moves: ["draws lessons from his esports career"],
      do: ["be specific"],
      dont: ["hedge"],
      exemplars: [
        "When I played esports professionally, we reviewed every loss frame by frame. Most founders never review anything. That's why they repeat mistakes.",
        "My esports coach taught me one thing: you don't rise to the occasion, you fall to your training. Same in SaaS.",
      ],
    };
    const source = {
      id: "src-1",
      text: "Your calendar is lying to you. I audited 30 founders' weeks: 60% of 'work' was meetings nobody needed. Here's the 3-question filter we now use before accepting any invite:",
      post_url: null,
      reactions: 900,
      post_type: "regular",
    };
    const user = `Here is a high-performing post from the user's niche. Adapt its structure and angle into a fresh post in the user's voice, about the user's own expertise:\n\n"""\n${source.text}\n"""\n\nWrite the user's version now.`;

    const freshnessBlock = renderFreshnessBlock([
      "his competitive esports/pro-gaming past",
      "lessons from his esports coach",
    ]);

    const arms: Array<{ name: string; block: string }> = [
      { name: "control(no block)", block: "" },
      { name: "freshness(block)", block: freshnessBlock },
    ];
    const results: string[] = [];
    for (const arm of arms) {
      const system = buildWeeklyDraftSystem({
        voice: voice as never,
        preferences: [],
        isLeadMagnet: false,
        freshnessBlock: arm.block,
      });
      const res = await completeChat({
        model: CHAT_MODEL,
        maxTokens: 2048,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      const body = res.text.trim();
      const mentionsAnchor = /esport|pro[- ]?gam|competitive gam|gaming career|my coach/i.test(body);
      results.push(`${arm.name}: mentionsEsportsAnchor=${mentionsAnchor} len=${body.length}`);
    }
    console.log(`\n[E: freshness A/B]\n${results.join("\n")}\n`);
    expect(results.length).toBe(2);
  }, 240_000);
});

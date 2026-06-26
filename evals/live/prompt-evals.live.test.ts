import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  shouldRunLiveEvals,
  runLiveAgent,
  visibleDeliverable,
  judge,
  type ToolFixtures,
} from "./harness";

// ---------------------------------------------------------------------------
// Tier 3: live-model PROMPT evals.
//
// These hit the real chat model and a real LLM judge, so they're OPT-IN:
// skipped unless RUN_LIVE_EVALS=1 and both API keys are set (see
// shouldRunLiveEvals). They are NOT part of `npm run test:evals` / CI by
// default — run them with `npm run test:evals:live` (nightly / pre-release).
//
// Each case asserts ONE system-prompt rule actually holds when the model runs
// against fixed tool data. The DATA is stubbed (deterministic); the MODEL is
// real (so prompt-following is genuinely exercised). Grading is by LLM judge
// because these properties are fuzzy — you can't string-match "implied the post
// was newer than it is".
// ---------------------------------------------------------------------------

// Per-test tool fixtures the mocked runTool reads at call time.
const fixtures: { current: ToolFixtures } = { current: {} };
function setFixtures(f: ToolFixtures): void {
  fixtures.current = f;
}

// Mock ONLY the tool dispatch + the usage logger. streamChat stays REAL so the
// model actually runs. logOpenRouterUsage is no-op'd so the loop's finally
// doesn't try to write to Supabase.
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

const gate = shouldRunLiveEvals();
const maybe = gate.run ? describe : describe.skip;
if (!gate.run) {
  // Surface WHY it's skipped so a nightly run that forgot a key is obvious.
  console.log(`[live evals] skipped — ${gate.reason}`);
}

// A month-old post, plus the scrape metadata get_top_from_batch now returns.
// The post's posted_at is ~35 days before the scrape; the scrape itself is
// "recent". This is the exact shape that produced the Klaus bug.
const SCRAPE_DATE = "2026-06-25T12:00:00.000Z";
const OLD_POST_DATE = "2026-05-21T09:00:00.000Z"; // ~5 weeks before the scrape

maybe("live prompt evals", () => {
  beforeEach(() => {
    setFixtures({});
  });

  // The headline regression: the model must anchor recency to the SCRAPE date
  // and must NOT present a 5-week-old post as brand new / "just posted".
  test(
    "date honesty: states the scrape date, doesn't imply an old post is new",
    async () => {
      setFixtures({
        get_top_from_batch: {
          ok: true,
          scrape: {
            scraped_at: SCRAPE_DATE,
            posts_published_since: OLD_POST_DATE,
            window_days: 30,
          },
          count: 1,
          posts: [
            {
              id: "11111111-1111-1111-1111-111111111111",
              text: "The 5 cold email mistakes killing your reply rate (and the fix).",
              posted_at: OLD_POST_DATE,
              reactions: 189,
              comments: 1712,
              post_type: "lead_magnet",
              accounts: { name: "Klaus Schlumpberger", niche: "Outreach" },
            },
          ],
        },
      });

      const userMessage =
        "Show me the top posts from the most recent scrape and tell me when this data is from.";
      const r = await runLiveAgent(userMessage);
      const deliverable = visibleDeliverable(r);

      const v = await judge({
        userMessage,
        deliverable,
        rule:
          "When stating when the data is from, the reply must reference the scrape date " +
          "(June 25, 2026) — NOT today's date and NOT a vague 'just now'. It must NOT " +
          "describe the Klaus post as new/fresh/'just posted'/'this week' — that post was " +
          "published about 5 weeks before the scrape. Saying it's an older post, or simply " +
          "not implying recency for it, passes; implying it is recent fails.",
      });
      expect(v.pass, v.reason).toBe(true);
    },
  );

  // Exact-count rule: "5 hooks" must yield exactly 5, not 3 or 10.
  test("exact count: asks for 5 hooks → returns exactly 5", async () => {
    setFixtures({
      get_voice: {
        ok: true,
        voice: {
          summary: "Punchy B2B SaaS founder voice; short lines, contrarian takes.",
          tone: ["direct", "contrarian"],
          format_patterns: { hook_styles: ["contrarian", "stat_shock"] },
          exemplars: ["Most SaaS demos fail in the first 30 seconds. Here's why."],
        },
      },
    });

    const userMessage = "Give me 5 hooks for a post about cold email deliverability.";
    const r = await runLiveAgent(userMessage);
    const deliverable = visibleDeliverable(r);

    const v = await judge({
      userMessage,
      deliverable,
      rule:
        "The reply must contain EXACTLY 5 distinct hooks (openers) — not 3, not 4, not 6, " +
        "not 10. Count the hooks the user would copy. Exactly 5 passes; any other count fails. " +
        "They must be hooks/openers, not full posts.",
    });
    expect(v.pass, v.reason).toBe(true);
  });

  // Voice rule: when NO voice profile exists, the model must say so and offer a
  // neutral draft — not silently produce a generic post as if it were on-voice.
  test("voice required: no profile → says so, doesn't pretend it's on-voice", async () => {
    setFixtures({
      get_voice: { ok: false, error: "No voice profile yet.", status: null },
    });

    const userMessage = "Write me a post about why most onboarding flows fail.";
    const r = await runLiveAgent(userMessage);
    const deliverable = visibleDeliverable(r);

    const v = await judge({
      userMessage,
      deliverable,
      rule:
        "Because no voice profile exists, the reply must acknowledge that (e.g. say there's " +
        "no voice profile yet / offer to draft in a neutral voice or point the user to set one " +
        "up). It must NOT silently claim the draft is 'in your voice' or 'matches your style'. " +
        "Acknowledging the missing profile passes; pretending it's on-voice fails.",
    });
    expect(v.pass, v.reason).toBe(true);
  });

  // Honesty about internals: the reply must not narrate tool mechanics
  // (batch sizes, table/column names, "I pulled the top 10 from the latest
  // batch"). This is a prompt rule that's easy to regress.
  test("no internal narration: doesn't expose tool mechanics", async () => {
    setFixtures({
      search_viral_posts: {
        ok: true,
        count: 10,
        posts: [
          { id: "a", text: "Contrarian take on MQLs.", reactions: 900, comments: 120, accounts: { name: "A", niche: "GTM" } },
          { id: "b", text: "Stat-shock opener about churn.", reactions: 700, comments: 90, accounts: { name: "B", niche: "GTM" } },
        ],
      },
    });

    const userMessage = "What hook styles are working in GTM right now?";
    const r = await runLiveAgent(userMessage);
    const deliverable = visibleDeliverable(r);

    const v = await judge({
      userMessage,
      deliverable,
      rule:
        "The reply must NOT narrate internal tool mechanics: no mention of batch size, " +
        "'the latest batch', default limits, how many candidates a search returned, or any " +
        "table/column/tool names. Talking about hook styles and what's working in plain terms " +
        "passes; exposing the machinery (e.g. 'I pulled the top 10 from the latest batch') fails.",
    });
    expect(v.pass, v.reason).toBe(true);
  });
});

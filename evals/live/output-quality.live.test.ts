import { describe, test, expect, vi, beforeEach } from "vitest";
import { runLiveAgent, visibleDeliverable, type ToolFixtures } from "./harness";
import {
  findBannedWords,
  countEmDashes,
  findRuleOfThree,
  findUniformLengthRun,
  findParataxisRun,
  findDismissiveNegation,
  headlineViolations,
  structuralViolations,
} from "../anti-slop-detectors";

// ---------------------------------------------------------------------------
// OUTPUT-QUALITY AUDIT (live, OpenRouter-only).
//
// Where prompt-quality-audit.live.test.ts tests CONTRACTS (right tool, right
// count, right sources), this tier grades the CONTENT of what the agent
// actually ships: are the drafts A-grade LinkedIn posts, or merely valid ones?
//
// Two graders per draft:
//   1. DETERMINISTIC — the anti-slop detectors that already run in evals
//      (banned words, em-dash cap, rule-of-three, uniform sentence runs,
//      parataxis runs, dismissive negation, headline patterns). Any hit here
//      is machine-checkable and therefore fixable with a server-side net.
//   2. LLM JUDGE (Haiku via OpenRouter — different family from GLM under
//      test) — fuzzy content quality: hook strength, specificity, ending.
//
// Gate: RUN_LIVE_EVALS=1 + OPENROUTER_API_KEY (no Anthropic key needed).
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
    "[output-quality audit] skipped — needs RUN_LIVE_EVALS=1 + OPENROUTER_API_KEY",
  );
}

async function orJudge(opts: {
  deliverable: string;
  rule: string;
}): Promise<{ pass: boolean; reason: string }> {
  const { completeChat } = await import("@/lib/openrouter");
  try {
    const res = await completeChat({
      model: "anthropic/claude-haiku-4.5",
      maxTokens: 300,
      messages: [
        {
          role: "system",
          content:
            'You are a demanding LinkedIn ghostwriting editor grading a draft. Given a DRAFT and one RULE, decide only whether the draft satisfies the rule. Be strict — "fine" is not "passes" if the rule demands excellent. Reply with STRICT JSON only: {"pass": true|false, "reason": "<one sentence>"}.',
        },
        {
          role: "user",
          content: `DRAFT:\n${opts.deliverable}\n\nRULE:\n${opts.rule}`,
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

// Run all deterministic detectors on one draft body and return a labeled
// report. This is the "is there a deterministic net gap" instrument: any
// non-empty finding here shipped to a (simulated) user and was machine-
// catchable.
function slopReport(body: string) {
  return {
    bannedWords: findBannedWords(body),
    emDashes: countEmDashes(body),
    ruleOfThree: findRuleOfThree(body).length,
    uniformRuns: findUniformLengthRun(body).length,
    parataxisRuns: findParataxisRun(body).length,
    dismissiveNegation: findDismissiveNegation(body),
    headline: headlineViolations(body).map((v) => v.rule),
    structural: structuralViolations(body).map((v) => v.rule),
  };
}

// A realistic, opinionated voice profile — close to what a real generated
// profile looks like, so voice-adherence grading is meaningful.
const VOICE_FIXTURE = {
  ok: true,
  voice: {
    display_name: "Dana Reyes",
    headline: "I help B2B SaaS founders turn onboarding into revenue",
    summary:
      "Direct, numbers-first onboarding consultant. Short paragraphs, concrete client stories, allergic to fluff.",
    profile: {
      tone: ["direct", "specific", "warm but no-nonsense"],
      audience: "B2B SaaS founders, $1-10M ARR",
      format_patterns: {
        hook_styles: ["counterintuitive result", "specific number"],
        structure: "hook → 1 concrete story → the lesson → 1-line CTA",
        length: "120-220 words",
      },
      dos: [
        "use real numbers (percentages, dollar figures, timeframes)",
        "one concrete client example per post",
        "short paragraphs, 1-2 sentences each",
      ],
      donts: [
        "no rhetorical questions as hooks",
        "no motivational platitudes",
        "no emoji",
      ],
      exemplars: [
        "Our client cut churn 22% by deleting half their onboarding emails.\n\nNot rewriting them. Deleting them.\n\nEvery email you send during onboarding competes with the one action that actually retains people: reaching the product's first win.\n\nAudit your sequence. If an email doesn't push toward first value, it's friction with a subject line.",
      ],
    },
  },
};

const TOP_BATCH_FIXTURE = {
  ok: true,
  scrape: { scraped_at: "2026-07-08T06:00:00.000Z", window_days: 7 },
  count: 3,
  posts: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      text: "<post>We killed our free trial and revenue went UP 40%. The counterintuitive pricing experiment every SaaS founder should run once:</post>",
      post_url: "https://linkedin.com/feed/update/1",
      posted_at: "2026-07-07T11:00:00.000Z",
      reactions: 390,
      comments: 20,
      reposts: 8,
      media_type: "none",
      post_type: "regular",
      accounts: { name: "Tom Okafor", niche: "SaaS" },
      already_used: false,
      recently_surfaced: false,
    },
  ],
};

// Pull the draft bodies (artifact cards) from a run; quality grading targets
// the post body, not the conversational wrapper.
function draftBodies(r: Awaited<ReturnType<typeof runLiveAgent>>): string[] {
  return r.artifacts
    .filter((a) => a.kind === "post" || a.kind === "hook")
    .map((a) => a.body);
}

maybe("output-quality audit (live)", () => {
  beforeEach(() => setFixtures({}));

  // ------------------------------------------------------------------ 1 ----
  test("full voice draft: content quality + zero deterministic slop (2 runs)", async () => {
    for (let i = 0; i < 2; i++) {
      setFixtures({
        get_voice: VOICE_FIXTURE,
        get_top_from_batch: TOP_BATCH_FIXTURE,
      });
      const r = await runLiveAgent(
        "Write me a post about why founders should stop adding onboarding steps, in my voice.",
      );
      const bodies = draftBodies(r);
      expect(bodies.length, "expected at least one draft card").toBeGreaterThan(0);
      const body = bodies[0];
      const slop = slopReport(body);
      console.log(
        `[Q1 run${i + 1}] len=${body.length} SLOP=${JSON.stringify(slop)}`,
      );

      // Deterministic: nothing the detectors can catch should ship.
      expect(slop.bannedWords, "banned AI-tell words in a shipped draft").toEqual([]);
      expect(slop.emDashes, "em-dashes must be stripped by the net").toBe(0);

      // Judge: content quality, graded strictly.
      const v = await orJudge({
        deliverable: body,
        rule:
          "Grade as an A-tier LinkedIn post for a B2B SaaS founder audience. To PASS it must have ALL of: (1) a first line that creates a curiosity gap or states a surprising/specific claim (not a generic statement or rhetorical question), (2) at least one CONCRETE specific — a number, timeframe, or named mechanism — not just abstract advice, (3) short scannable paragraphs, (4) an ending that lands (a takeaway or pointed CTA), and (5) no motivational filler ('the results speak for themselves', 'game changer', 'it's that simple'). Fail if it reads like generic AI advice.",
      });
      console.log(`[Q1 run${i + 1}] judge: pass=${v.pass}`);
      expect(v.pass, v.reason).toBe(true);
    }
  }, 240_000);

  // ------------------------------------------------------------------ 2 ----
  test("voice adherence: draft follows the profile's dos/donts, not just generic 'good'", async () => {
    setFixtures({
      get_voice: VOICE_FIXTURE,
      get_top_from_batch: TOP_BATCH_FIXTURE,
    });
    const r = await runLiveAgent(
      "Write me a post about onboarding emails, in my voice.",
    );
    const bodies = draftBodies(r);
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies[0];
    console.log(`[Q2] len=${body.length}`);

    // Deterministic slice of the voice contract: the profile bans emoji and
    // rhetorical-question hooks — both machine-checkable.
    expect(/\p{Extended_Pictographic}/u.test(body), "profile says no emoji").toBe(false);
    const firstLine = body.split("\n")[0]?.trim() ?? "";
    expect(firstLine.endsWith("?"), "profile bans rhetorical-question hooks").toBe(false);

    const v = await orJudge({
      deliverable: body,
      rule:
        "The author's voice profile demands: real numbers (a percentage, dollar figure, or timeframe) AND short 1-2 sentence paragraphs AND a direct no-nonsense tone with zero motivational platitudes. PASS only if the draft observably follows ALL of these. FAIL if it contains no concrete number, or has long dense paragraphs, or leans on platitudes.",
    });
    console.log(`[Q2] judge: pass=${v.pass}`);
    expect(v.pass, v.reason).toBe(true);
  }, 240_000);

  // ------------------------------------------------------------------ 3 ----
  test("refine: 'shorter + punchier' actually shortens and keeps the core", async () => {
    const original =
      "Most SaaS founders treat onboarding like a museum tour.\n\nHere is every feature. Here is every setting. Here is a 14-step checklist before you get any value.\n\nOne of our clients had a 40% drop-off on step 3 of their onboarding flow. We did not add better tooltips. We deleted steps 3 through 9 entirely.\n\nActivation went from 31% to 58% in six weeks. Revenue followed.\n\nYour user does not want a tour. They want the one thing they came for. Give it to them first, and explain the rest later.\n\nAudit your onboarding this week: for each step, ask 'does this block first value?' If yes, cut it.";
    setFixtures({ get_voice: VOICE_FIXTURE });
    // Drive the EXACT refine path the product uses: the composer's message
    // shape + isRefine/skipDecision, so the shorten-refine length net is armed
    // exactly as in production.
    const r = await runLiveAgent(
      `Refine this post: Make it shorter and punchier\n\nKeep it in my voice. Here's the current post:\n"""\n${original}\n"""`,
      [],
      { isRefine: true, skipDecision: true },
    );
    const bodies = draftBodies(r);
    const body = bodies[0] ?? visibleDeliverable(r);
    console.log(`[Q3] original=${original.length} chars → refined=${body.length} chars`);

    // Deterministic: shorter means SHORTER.
    expect(body.length, "refined draft must be materially shorter").toBeLessThan(
      original.length * 0.85,
    );
    const v = await orJudge({
      deliverable: body,
      rule:
        "This is a shortened rewrite of a post whose core message is: deleting onboarding steps (not improving them) drives activation — with a client example going from 31% to 58% activation. PASS only if the rewrite keeps the deletion-beats-improvement message AND keeps at least one concrete number from the original. FAIL if the numbers vanished or the core claim was diluted.",
    });
    console.log(`[Q3] judge: pass=${v.pass}`);
    expect(v.pass, v.reason).toBe(true);
  }, 240_000);

  // ------------------------------------------------------------------ 4 ----
  test("hooks: 3 hooks are mutually distinct and none is a limp generic opener", async () => {
    setFixtures({ get_voice: VOICE_FIXTURE });
    const r = await runLiveAgent(
      "Give me 3 hooks for a post about churn being an onboarding problem, in my voice.",
    );
    const hooks = r.artifacts.filter((a) => a.kind === "hook").map((a) => a.body);
    console.log(`[Q4] hooks=${hooks.length}`);
    expect(hooks.length).toBe(3);

    // Deterministic: distinctness floor — no two hooks share a first 30 chars.
    const prefixes = new Set(hooks.map((h) => h.slice(0, 30).toLowerCase()));
    expect(prefixes.size, "hooks must not share openings").toBe(hooks.length);

    const v = await orJudge({
      deliverable: hooks.map((h, i) => `HOOK ${i + 1}: ${h}`).join("\n\n"),
      rule:
        "These are 3 LinkedIn hooks about churn being an onboarding problem. PASS only if (1) the three take genuinely different ANGLES (not the same claim reworded), and (2) every hook creates curiosity or makes a specific/surprising claim — none is a flat generic statement like 'Churn is a big problem for SaaS companies.' FAIL if any hook is generic or two hooks are near-duplicates.",
    });
    console.log(`[Q4] judge: pass=${v.pass}`);
    expect(v.pass, v.reason).toBe(true);
  }, 240_000);
});

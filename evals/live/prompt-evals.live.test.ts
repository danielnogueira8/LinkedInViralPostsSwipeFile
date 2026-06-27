import { describe, test, expect, vi, beforeEach } from "vitest";
import { isValidElement } from "react";
import {
  shouldRunLiveEvals,
  runLiveAgent,
  visibleDeliverable,
  judge,
  type ToolFixtures,
} from "./harness";
import { renderRichText } from "@/app/(app)/dashboard/chat-workspace";

// True if the rendered chat tree (chat mode) contains a <ul> or <ol> — i.e. the
// model emitted parseable "- "/"1." list syntax the renderer turned into a list.
function rendersAList(text: string): boolean {
  let found = false;
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (isValidElement(n)) {
      const el = n as { type: unknown; props: { children?: unknown } };
      if (el.type === "ul" || el.type === "ol") found = true;
      walk(el.props.children);
    }
  };
  walk(renderRichText(text, "chat"));
  return found;
}

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

  // Tidy formatting: when asked for several parallel items, the model should
  // emit a list ("- " / "1. ") that the chat renderer turns into <ul>/<ol> —
  // NOT a run-on sentence. This is the check that the prompt's new list rule and
  // the renderer stay in lockstep.
  test("list formatting: multiple parallel items render as a list, not a wall of prose", async () => {
    setFixtures({
      get_voice: {
        ok: true,
        voice: { summary: "B2B SaaS founder voice.", tone: ["direct"], exemplars: ["Pipeline is a lagging indicator."] },
      },
    });

    const userMessage = "Give me 4 cold-email angles for selling to RevOps leaders. Just the angles.";
    const r = await runLiveAgent(userMessage);
    const deliverable = visibleDeliverable(r);

    // Deterministic structural check: the reply renders to a real list.
    const isList = rendersAList(deliverable);

    // Judge as a backstop on the substance (4 distinct angles, not full posts).
    const v = await judge({
      userMessage,
      deliverable,
      rule:
        "The reply must present the angles as a SCANNABLE LIST (each angle on its own line, " +
        "led by '- ' or '1. '/'2. '), not as a single run-on paragraph. Four distinct angles in " +
        "list form passes; the same content mashed into prose sentences fails.",
    });
    expect(
      isList && v.pass,
      `${v.reason} (renders as <ul>/<ol>: ${isList})`,
    ).toBe(true);
  });

  // Regression: when the user is iterating on an EXISTING post and asks to change
  // its hook, the agent must EDIT the post in place (re-render the full post),
  // not produce a detached standalone hook card. (Reported bug: asked for a
  // contrarian hook on a lead-magnet post, got a separate hook instead.)
  test("change-the-hook-of-a-post → re-renders the POST, not a standalone hook", async () => {
    setFixtures({
      get_voice: {
        ok: true,
        voice: {
          summary: "Punchy B2B founder voice; short blunt lines, contrarian takes.",
          tone: ["direct", "contrarian"],
          exemplars: ["Most cold outreach is dead. Here's what replaced it."],
        },
      },
    });

    const existingPost =
      "I spent 6 years and 4,000+ posts figuring out why some hooks go viral.\n\n" +
      "Here's the one thing that actually matters: specificity.\n\n" +
      "Vague hooks get scrolled. Specific ones get read.\n\n" +
      "Comment PLAYBOOK and I'll send you the full breakdown.";

    // Seed a prior turn where the agent already delivered this post.
    const history = [
      { role: "user" as const, content: "Write me a lead magnet post about viral hooks." },
      {
        role: "assistant" as const,
        content: `Here's a lead-magnet post in your voice:\n\n${existingPost}`,
      },
    ];

    const userMessage = "I feel like we need a more contrarian hook.";
    const r = await runLiveAgent(userMessage, history);

    const postArtifacts = r.artifacts.filter((a) => a.kind === "post");
    const hookArtifacts = r.artifacts.filter((a) => a.kind === "hook");

    // Structural guard: the deliverable should be a re-rendered POST, not a lone
    // hook card. (A post card present, and no standalone-hook-only outcome.)
    const editedThePost = postArtifacts.length >= 1;
    const onlyGaveAHook = hookArtifacts.length >= 1 && postArtifacts.length === 0;

    const v = await judge({
      userMessage,
      deliverable: visibleDeliverable(r),
      rule:
        "The user is iterating on an existing lead-magnet POST and asked for a more contrarian HOOK. " +
        "The correct behavior is to EDIT THE POST: return the full post again with a new, more " +
        "contrarian opening line and the rest preserved. Returning the full updated post passes. " +
        "Returning ONLY a standalone hook/opener (without the rest of the post) fails.",
    });

    expect(
      editedThePost && !onlyGaveAHook && v.pass,
      `${v.reason} (post cards: ${postArtifacts.length}, hook cards: ${hookArtifacts.length})`,
    ).toBe(true);
  });

  // The global anti-slop writing skill (always injected) must actually reach the
  // model and shape the draft: a neutral-voice post should avoid the most
  // flagrant AI tells. Two checks — a deterministic banned-token scan (cheap,
  // unambiguous) AND an LLM judge for the fuzzier structural slop. We use a
  // NEUTRAL voice (no profile) so the skill is what's driving style, not a
  // user voice that might legitimately override it.
  test("anti-slop skill: a drafted post avoids flagrant AI tells", async () => {
    // No get_voice fixture → neutral professional voice, so the anti-slop skill
    // (not a user's idiosyncratic voice) governs the prose.
    setFixtures({ get_voice: { ok: false, error: "No voice profile yet." } });

    const userMessage =
      "Write me a LinkedIn post about why most startup onboarding flows lose users in the first week.";
    const r = await runLiveAgent(userMessage);
    const deliverable = visibleDeliverable(r);
    const lower = deliverable.toLowerCase();

    // Deterministic scan for the worst, unambiguous banned tokens from the
    // skill's banned-words list. These are near-never correct in a human post
    // and are the skill's headline targets, so a hit is a real miss. (We keep
    // this list tight + unambiguous — e.g. not "landscape", which has literal
    // uses — to avoid false failures.)
    const FLAGRANT = [
      "delve",
      "tapestry",
      "let's dive in",
      "let's dive deeper",
      "it's worth noting",
      "in today's fast-paced",
      "in today's digital",
      "at the end of the day",
      "unlock the power",
      "supercharge your",
      "game-changer",
      "game-changing",
      "navigating the",
      "in the realm of",
    ];
    const hits = FLAGRANT.filter((w) => lower.includes(w));
    expect(hits, `banned tokens present: ${hits.join(", ")}`).toEqual([]);

    // Em-dash discipline: the skill caps em dashes hard. A short post should have
    // at most one. (Count real em dashes — the "—" char, not hyphens.)
    const emDashes = (deliverable.match(/—/g) ?? []).length;
    expect(emDashes, `too many em dashes: ${emDashes}`).toBeLessThanOrEqual(1);

    // Judge the fuzzier structural slop the token-scan can't catch.
    const v = await judge({
      userMessage,
      deliverable,
      rule:
        "This is a LinkedIn post that must NOT read as AI-generated. It passes if it avoids " +
        "obvious AI-writing patterns: it should NOT open with a banned filler opener " +
        "(Certainly/Moreover/Furthermore/Additionally/'In today's…'/'When it comes to…'), should " +
        "NOT use uniform short-sentence parataxis (many same-length one-line declaratives in a row), " +
        "and should NOT lean on banned buzzwords (leverage, seamless, robust, transformative, " +
        "elevate, streamline, supercharge, 'pain points', 'move the needle'). Specific, varied, " +
        "human-sounding prose passes; generic buzzword-y AI slop fails.",
    });
    expect(v.pass, v.reason).toBe(true);
  });

  // Unfilled placeholder: if a literal [topic] reaches the agent (e.g. a pasted
  // starter prompt, or any path that bypassed the composer nudge), it must ask
  // ONE short question rather than drafting about the literal bracket text or
  // inventing a subject.
  test("unfilled placeholder: asks instead of guessing", async () => {
    const userMessage =
      "Write an original post in my voice about [topic]. Ground it in what's resonating in my niche right now.";
    const r = await runLiveAgent(userMessage);
    const deliverable = visibleDeliverable(r);

    // Structural guard: it should NOT have produced a finished post draft.
    const posts = r.artifacts.filter((a) => a.kind === "post");
    const v = await judge({
      userMessage,
      deliverable,
      rule:
        "The user's message still contains a literal unfilled placeholder '[topic]'. The correct " +
        "behavior is to ASK a short question to find out the topic (e.g. 'What topic should this " +
        "post be about?') and NOT draft a finished post yet. It must NOT write a post about the " +
        "literal word 'topic'/'[topic]', and must NOT silently invent and commit to a subject. " +
        "Asking for the topic passes; drafting a full post anyway fails.",
    });
    expect(
      v.pass && posts.length === 0,
      `${v.reason} (post cards: ${posts.length})`,
    ).toBe(true);
  });

  // The deliberate "you pick" path (what the composer sends on a 2nd send): the
  // placeholder is gone and the message explicitly tells the agent to choose. It
  // must NOT ask again — it should pick a fitting subject and proceed.
  test("explicit 'you pick': chooses a subject and proceeds, doesn't re-ask", async () => {
    // Give the agent real signal to pick FROM — a voice profile + a populated
    // niche (a real user invoking this has both). With data to ground a choice,
    // "pick a fitting topic" is answerable, so re-asking is a genuine miss.
    setFixtures({
      get_voice: {
        ok: true,
        voice: {
          summary: "Punchy B2B founder voice; short blunt lines, contrarian takes.",
          tone: ["direct", "contrarian"],
          exemplars: ["Most cold outreach is dead. Here's what replaced it."],
        },
      },
      list_niches: { ok: true, niches: [{ niche: "Outreach", count: 12 }] },
      search_viral_posts: {
        ok: true,
        count: 1,
        posts: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            text: "The 5 cold email mistakes killing your reply rate (and the fix).",
            posted_at: "2026-06-20T09:00:00.000Z",
            reactions: 240,
            comments: 88,
            post_type: "regular",
            accounts: { name: "Outreach Pro", niche: "Outreach" },
          },
        ],
      },
    });

    const userMessage =
      "Write an original post in my voice. Ground it in what's resonating in my niche right now.\n\n" +
      "(I didn't fill in the details in brackets — pick something that fits my voice and niche, and mention what you chose.)";
    const r = await runLiveAgent(userMessage);
    const deliverable = visibleDeliverable(r);

    const v = await judge({
      userMessage,
      deliverable,
      rule:
        "The user explicitly asked the assistant to PICK a topic that fits their voice/niche and " +
        "proceed. The correct behavior is to choose a concrete subject and write the post (or at " +
        "minimum commit to a specific topic and start) — NOT to bounce it back with another " +
        "'what topic?' question. Choosing a topic and proceeding passes; asking the user to pick " +
        "a topic again fails.",
    });
    expect(v.pass, v.reason).toBe(true);
  });
});

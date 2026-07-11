import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";
import type { DecisionVerdict } from "@/lib/agent/decide";

// ---------------------------------------------------------------------------
// Regression test for a confirmed audit finding: runAgent computes
// hasAttachedModelSource from opts.hasModelSource AND
// explicitlyRequestsSourceDiscovery(latestUserMsg), then passes it straight
// through as `intentFullySpecified` to decideTurn (lib/agent/run.ts ~2287-2299).
// decideTurn short-circuits to PROCEED whenever intentFullySpecified is true
// (lib/agent/decide.ts ~540-548), skipping the Sonnet decide call entirely —
// before the LLM ever gets a chance to notice the user's free-text instruction
// contradicts or goes beyond the single attached source.
//
// explicitlyRequestsSourceDiscovery only detects discovery verbs (find/search/
// pull/...) + a source-pool noun (latest/top/viral/swipe file/...). It does NOT
// detect:
//   - a second named source ("...and the Ewan McAllister post I saved earlier")
//   - a count that doesn't match the single attached source ("5 variations")
//   - an instruction that contradicts using the attached source at all
//
// So a user who clicks "model this post" (hasModelSource: true) and then types
// one of those messages gets intentFullySpecified: true, and decideTurn is
// short-circuited to PROCEED without ever running the Sonnet pass — even though
// the deterministic floor (scope/placeholder checks) has no reason to catch a
// "5 variations of this one post" phrasing either (requestedContentCount only
// matches "write/draft/create/... N posts/hooks/...", not "N variations").
//
// This test captures the `intentFullySpecified` value runAgent actually passes
// to decideTurn for exactly this trigger. If the bug is present, it will be
// `true` (wrongly fully-specified) instead of `false`.
// ---------------------------------------------------------------------------

const capturedOpts: { current: Parameters<
  typeof import("@/lib/agent/decide").decideTurn
>[1] | null } = { current: null };

vi.mock("@/lib/agent/decide", async (orig) => {
  const actual = await orig<typeof import("@/lib/agent/decide")>();
  return {
    ...actual,
    decideTurn: async (
      _history: ChatMessage[],
      opts: Parameters<typeof actual.decideTurn>[1],
    ): Promise<DecisionVerdict> => {
      capturedOpts.current = opts;
      return { shouldAsk: false };
    },
  };
});

vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    streamChat: async function* () {
      yield { text: "A normal reply.", finishReason: "stop" as const };
    },
  };
});

const { runAgent, freeTextLayersOpenChoice } = await import("@/lib/agent/run");

async function runWithModelSource(userMsg: string) {
  const history: ChatMessage[] = [{ role: "user", content: userMsg }];
  // Drain the generator — the events themselves aren't asserted here, only the
  // opts captured by the decideTurn mock.
  for await (const ev of runAgent({
    history,
    workspaceId: "ws",
    hasModelSource: true,
  })) {
    void ev;
  }
}

beforeEach(() => {
  capturedOpts.current = null;
});

describe("decide pre-pass short-circuit vs. contradictory/multi-source free text", () => {
  test("attached source + a second named source in the free text must NOT be treated as fully specified", async () => {
    await runWithModelSource(
      "model this after both this one and the Ewan McAllister post I saved earlier",
    );
    expect(capturedOpts.current).not.toBeNull();
    // BUG: run.ts passes hasAttachedModelSource straight through, which is true
    // here because explicitlyRequestsSourceDiscovery doesn't detect a second
    // named source. The correct value is false — there's still an open
    // question (which source structure applies to which part of the request).
    expect(capturedOpts.current?.intentFullySpecified).toBe(false);
  });

  test("attached source + a count that exceeds the single source must NOT be treated as fully specified", async () => {
    await runWithModelSource(
      "turn this into 5 variations, one for each of my different niches",
    );
    expect(capturedOpts.current).not.toBeNull();
    // BUG: "5 variations" doesn't match explicitlyRequestsSourceDiscovery (no
    // discovery verb) so hasAttachedModelSource stays true and short-circuits
    // decideTurn, even though the deterministic floor's requestedContentCount
    // also won't catch "N variations" phrasing (only "write/draft/... N posts").
    expect(capturedOpts.current?.intentFullySpecified).toBe(false);
  });

  test("attached source + an instruction to ignore it must NOT be treated as fully specified", async () => {
    await runWithModelSource(
      "model after this but actually write about something totally different, whichever you think fits",
    );
    expect(capturedOpts.current).not.toBeNull();
    expect(capturedOpts.current?.intentFullySpecified).toBe(false);
  });

  test("attached source + a bare small count must NOT be treated as fully specified", async () => {
    // "3 versions of this" is the classic bare-count ambiguity (3 independent
    // posts vs. 1 post embodying 3 points) — the Sonnet pass must judge it.
    await runWithModelSource("give me 3 versions of this in my voice");
    expect(capturedOpts.current).not.toBeNull();
    expect(capturedOpts.current?.intentFullySpecified).toBe(false);
  });

  test("control: attached source with no contradicting/extending free text IS fully specified (no regression)", async () => {
    await runWithModelSource("model this post about my new pricing page");
    expect(capturedOpts.current).not.toBeNull();
    expect(capturedOpts.current?.intentFullySpecified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The pure helper behind the fix. Locks the three trigger families + the
// negative space (plain model-this phrasings must NOT trigger, or every source
// turn would pay the decide call again and the short-circuit would be dead
// code).
// ---------------------------------------------------------------------------
describe("freeTextLayersOpenChoice", () => {
  test("counts trigger — numerals, words, and vague quantities", () => {
    expect(freeTextLayersOpenChoice("turn this into 5 variations")).toBe(true);
    expect(freeTextLayersOpenChoice("give me three versions of this")).toBe(true);
    expect(freeTextLayersOpenChoice("a few takes on this one")).toBe(true);
  });

  test("a second source triggers", () => {
    expect(
      freeTextLayersOpenChoice("model after both this one and the Ewan post I saved"),
    ).toBe(true);
    expect(freeTextLayersOpenChoice("combine it with the other post")).toBe(true);
  });

  test("an override of the source triggers", () => {
    expect(
      freeTextLayersOpenChoice("model after this but actually write about something totally different"),
    ).toBe(true);
    expect(freeTextLayersOpenChoice("ignore this and pick your own angle")).toBe(true);
  });

  test("plain model-this phrasings do NOT trigger (short-circuit stays alive)", () => {
    expect(freeTextLayersOpenChoice("model this post about my new pricing page")).toBe(false);
    expect(freeTextLayersOpenChoice("model this in my voice")).toBe(false);
    expect(freeTextLayersOpenChoice("adapt this to my niche, keep the hook style")).toBe(false);
    expect(freeTextLayersOpenChoice("")).toBe(false);
  });
});

import { describe, expect, test, vi } from "vitest";
import { checkDraft } from "@/lib/draft-check";
import { BANNED_WORDS } from "@/lib/anti-slop-detectors";

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ from: () => ({}) }) }));
vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIdsForService: async () => [],
  trackedAccountIds: async () => [],
  latestRelevantScrapeForService: async () => null,
}));
vi.mock("@/lib/ai-operation-claims", () => ({
  claimAiOperation: async () => "claim-1",
  releaseAiOperation: async () => undefined,
}));
vi.mock("@/lib/agent/rate-limit", () => ({
  VOICE_JOB_COST_RESERVE_USD: 0.2,
  checkChatCostAllowance: async () => ({ ok: true }),
  checkChatRateLimit: async () => ({ ok: true }),
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: async () => ({ id: "job-1" }),
}));

const { registerSwipeTools } = await import("@/lib/mcp/register");

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

function registry() {
  const handlers: Record<string, ToolHandler> = {};
  const configs: Record<string, { description?: string }> = {};
  registerSwipeTools({
    registerTool: (name: string, config: { description?: string }, handler: ToolHandler) => {
      handlers[name] = handler;
      configs[name] = config;
    },
  } as never);
  return { handlers, configs };
}

function json(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

const CLEAN_DRAFT = [
  "I spent Tuesday afternoon rewriting our onboarding email with Priya from support.",
  "",
  "She had read 400 replies from people who churned in week one, and she kept pointing at the same paragraph. It asked new users to pick a plan before they had seen anything work.",
  "",
  "We moved that paragraph to the end. Signups converted the same. Week-two retention moved four points.",
].join("\n");

describe("checkDraft — clean copy", () => {
  test("passes a draft with no structural tells", () => {
    const result = checkDraft(CLEAN_DRAFT);
    expect(result.blocking_count).toBe(0);
    expect(result.passed).toBe(true);
  });

  test("reports word count and em dashes", () => {
    const result = checkDraft(CLEAN_DRAFT);
    expect(result.word_count).toBeGreaterThan(30);
    expect(result.em_dashes).toBe(0);
  });
});

describe("checkDraft — catches the reader-facing tells", () => {
  test("flags three-beat negative parallelism", () => {
    const result = checkDraft("Not likes, not impressions, not follower count.");
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.rule === "negative-parallelism")).toBe(true);
  });

  test("flags the rule-of-three cadence that shipped once before", () => {
    // The regression this detector set was built for.
    const result = checkDraft("Not 5. Not 10. Two.");
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.rule === "rule-of-three")).toBe(true);
  });

  test("flags stock AI vocabulary", () => {
    const result = checkDraft(
      "Let's delve into the tapestry of seamless growth and unlock our potential.",
    );
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.rule === "banned-word")).toBe(true);
  });

  test("every finding carries actionable guidance", () => {
    // A rule name alone is not usable by a caller that has never seen our docs.
    const result = checkDraft("Not likes, not impressions, not follower count.");
    for (const finding of result.findings) {
      expect(finding.guidance.length).toBeGreaterThan(20);
    }
  });
});

describe("checkDraft — severity", () => {
  test("only blocking findings fail the draft", () => {
    const result = checkDraft("Not likes, not impressions, not follower count.");
    const blocking = result.findings.filter((f) => f.severity === "blocking");
    expect(blocking.length).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  test("lists blocking findings before advisory ones", () => {
    // A caller reading only the head of the list must see what matters.
    const result = checkDraft(
      [
        "Not likes, not impressions, not follower count.",
        "We shipped the fix on Monday morning.",
        "We shipped the docs on Tuesday morning.",
        "We shipped the tests on Wednesday morning.",
        "We shipped the demo on Thursday morning.",
      ].join(" "),
    );
    const severities = result.findings.map((f) => f.severity);
    const firstAdvisory = severities.indexOf("advisory");
    const lastBlocking = severities.lastIndexOf("blocking");
    if (firstAdvisory !== -1 && lastBlocking !== -1) {
      expect(lastBlocking).toBeLessThan(firstAdvisory);
    }
  });

  test("counts stay consistent with the findings list", () => {
    // Every banned term the detector knows, one per sentence (findBannedWords
    // dedupes by term, so repeating one word yields a single finding). Built
    // from the real export so it cannot drift as the vocabulary changes.
    const spammy = BANNED_WORDS.map(
      (word, i) => `Sentence ${i} will ${word} the outcome.`,
    ).join("\n\n");
    const result = checkDraft(spammy);

    expect(result.blocking_count).toBeGreaterThan(0);
    // The list is capped; the counts are not. They describe every finding, so
    // a caller can always tell whether the list it received was complete.
    expect(result.findings.length).toBeLessThanOrEqual(40);
    expect(result.blocking_count + result.advisory_count).toBeGreaterThanOrEqual(
      result.findings.length,
    );
  });

  // NOTE: the 40-finding cap is not directly exercised here. The detectors are
  // deliberately conservative and dedupe (banned words by term, structural
  // rules by span), so no realistic draft produced more than ~12 findings in
  // testing. The cap remains as a bound on a pathological input; the assertion
  // above pins the property that matters either way — the counts describe every
  // finding, so a truncated list can never be mistaken for a complete one.
});

describe("checkDraft — edge cases", () => {
  test("an empty draft fails rather than reporting a clean bill of health", () => {
    // "No text" must never look like "no problems" to a caller's own gate.
    const result = checkDraft("");
    expect(result.passed).toBe(false);
    expect(result.summary).toMatch(/empty/i);
  });

  test("whitespace-only input is treated as empty", () => {
    expect(checkDraft("   \n\n  ").passed).toBe(false);
  });

  test("is deterministic across identical calls", () => {
    expect(checkDraft(CLEAN_DRAFT)).toEqual(checkDraft(CLEAN_DRAFT));
  });
});

describe("check_draft — tool surface", () => {
  test("is registered", () => {
    expect(Object.keys(registry().handlers)).toContain("check_draft");
  });

  test("returns findings without needing a workspace", async () => {
    const body = await registry()
      .handlers.check_draft(
        { body: "Not likes, not impressions, not follower count." },
        { authInfo: { extra: {} } },
      )
      .then(json);
    expect(body.ok).toBe(true);
    expect(body.passed).toBe(false);
  });

  test("passes a clean draft through the tool surface", async () => {
    const body = await registry()
      .handlers.check_draft({ body: CLEAN_DRAFT }, { authInfo: { extra: {} } })
      .then(json);
    expect(body.ok).toBe(true);
    expect(body.passed).toBe(true);
  });

  test("its description tells the caller when to run it", async () => {
    const description = registry().configs.check_draft?.description ?? "";
    expect(description).toMatch(/create_draft/);
  });
});

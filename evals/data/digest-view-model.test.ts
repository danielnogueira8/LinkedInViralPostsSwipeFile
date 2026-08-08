import { describe, expect, it } from "vitest";
import {
  cleanInline,
  extractHookQuote,
  formatDigestDate,
  hookCommentary,
  parseDigest,
  referencedPostIds,
  relativeDigestLabel,
  splitAngles,
  splitEvidence,
  splitSectionLead,
} from "@/lib/digest-view-model";

// The input here is MODEL OUTPUT, so it drifts. Every test is either a real
// production sample or a degradation case — the page must never go blank
// because the model reformatted a heading.

/** Verbatim from the first production digest. */
const REAL_DIGEST = `1. THEME — **Claude/AI agents turning revenue and content work into operating systems.** The cluster appears across "Complete Claude Revenue System" ([a5677d81-b17b-4b89-a73f-8517dae640c3] — 827 reactions, 2,957 comments), "Complete Client Acquisition System" ([b7a4937f-ae73-4237-9918-27a16af1b962] — 122 reactions, 534 comments).

2. BEST HOOK — **"I don't want to sound like I'm bragging"** — [7aab6930-af25-4c6a-9664-1843b0292b40], 1,840 reactions and 1,191 comments. It opens with a familiar audience hesitation, then immediately challenges the belief behind it.

3. FORMAT — **Numbered, utility-first lists paired with a free resource or access CTA** over-performed as a repeatable structure: the Claude Revenue System generated 827 reactions and 2,957 comments.

4. WRITE NEXT —
- **The agent system teardown:** walk through one revenue workflow from input to output.
- **The anti-automation list:** explain which parts of a workflow Claude should own.`;

describe("parseDigest — the four known sections", () => {
  it("finds every section in a real digest", () => {
    const { sections, unmatched } = parseDigest(REAL_DIGEST);
    expect(sections.map((s) => s.id)).toEqual([
      "theme",
      "hook",
      "format",
      "write_next",
    ]);
    expect(unmatched).toBe("");
  });

  it("uses our headings, not the model's casing", () => {
    // The model has written "BEST HOOK", "Best Hook", and "## 2. BEST HOOK"
    // across runs; the page must read consistently regardless.
    const { sections } = parseDigest(REAL_DIGEST);
    expect(sections.map((s) => s.title)).toEqual([
      "Theme",
      "Best hook",
      "Format that worked",
      "Write next",
    ]);
  });

  it("parses markdown-heading formatting too", () => {
    // A second observed shape from a different workspace.
    const { sections } = parseDigest(
      `## 1. THEME\n\nAI agents everywhere.\n\n## 2. BEST HOOK\n\n"A quoted hook line"\n\n1,840 reactions`,
    );
    expect(sections.map((s) => s.id)).toEqual(["theme", "hook"]);
  });

  it("keeps text that matched no section instead of dropping it", () => {
    // Silently losing model output is how you end up debugging a "blank"
    // digest that was actually fine.
    const { unmatched } = parseDigest(
      `Some preamble the prompt did not ask for.\n\n1. THEME — a theme.`,
    );
    expect(unmatched).toBe("Some preamble the prompt did not ask for.");
  });

  it("returns no sections for unstructured text, so the caller can fall back", () => {
    const { sections } = parseDigest("Just a paragraph with no headings.");
    expect(sections).toEqual([]);
  });

  it("survives empty and whitespace input", () => {
    expect(parseDigest("").sections).toEqual([]);
    expect(parseDigest("   \n\n ").sections).toEqual([]);
  });

  it("drops a heading with no body rather than rendering an empty card", () => {
    const { sections } = parseDigest(`1. THEME —\n\n2. BEST HOOK — a real hook.`);
    expect(sections.map((s) => s.id)).toEqual(["hook"]);
  });
});

describe("cleanInline — defects the rendered page revealed", () => {
  it("takes the parentheses with the post id", () => {
    // Removing the id alone left "( — 827 reactions, 2,957 comments)" on the
    // page: a dangling bracket that reads as a typo.
    const out = cleanInline(
      `"Revenue System" ([a5677d81-b17b-4b89-a73f-8517dae640c3] — 827 reactions, 2,957 comments)`,
    );
    expect(out).toBe(`"Revenue System" (827 reactions, 2,957 comments)`);
    expect(out).not.toContain("( —");
  });

  it("removes emphasis markers rather than rendering them literally", () => {
    // There is no markdown renderer, so ** would print as-is.
    expect(cleanInline("**Numbered lists** over-performed")).toBe(
      "Numbered lists over-performed",
    );
    expect(cleanInline("**** — , 1,840 reactions")).toBe("1,840 reactions");
  });

  it("keeps the engagement numbers, which are the evidence", () => {
    expect(cleanInline("827 reactions, 2,957 comments")).toContain("2,957");
  });

  it("does not leave space before punctuation", () => {
    expect(cleanInline("a post [a5677d81-b17b-4b89-a73f-8517dae640c3] , next")).toBe(
      "a post, next",
    );
  });
});

describe("hook extraction", () => {
  it("pulls the quoted line for pull-quote display", () => {
    const { sections } = parseDigest(REAL_DIGEST);
    expect(extractHookQuote(sections[1].body)).toBe(
      "I don't want to sound like I'm bragging",
    );
  });

  it("returns the commentary without the orphaned markers", () => {
    const { sections } = parseDigest(REAL_DIGEST);
    const rest = hookCommentary(sections[1].body)!;
    expect(rest.startsWith("1,840")).toBe(true);
    expect(rest).not.toContain("*");
  });

  it("returns null rather than guessing when nothing is quoted", () => {
    // A mis-extracted "hook" shown in large type is worse than plain prose.
    expect(extractHookQuote("No quotation marks here at all.")).toBeNull();
  });

  it("returns null commentary when only the quote remains", () => {
    expect(hookCommentary(`"just the hook"`)).toBeNull();
  });
});

describe("splitAngles", () => {
  it("splits the two angles the prompt asks for", () => {
    const { sections } = parseDigest(REAL_DIGEST);
    expect(splitAngles(sections[3].body)).toHaveLength(2);
  });

  it("handles numbered angles too", () => {
    expect(splitAngles("1. First angle here.\n2. Second angle here.")).toHaveLength(2);
  });

  it("returns one item rather than nothing when it cannot split", () => {
    expect(splitAngles("A single unbulleted paragraph.")).toEqual([
      "A single unbulleted paragraph.",
    ]);
  });

  it("returns nothing for an empty body", () => {
    expect(splitAngles("   ")).toEqual([]);
  });
});

describe("date labels", () => {
  it("reads as a date, not an ISO string", () => {
    expect(formatDigestDate("2026-08-06")).toBe("Thursday 6 August");
  });

  it("uses today and yesterday in the history rail", () => {
    const today = new Date("2026-08-06T09:00:00Z");
    expect(relativeDigestLabel("2026-08-06", today)).toBe("Today");
    expect(relativeDigestLabel("2026-08-05", today)).toBe("Yesterday");
    expect(relativeDigestLabel("2026-08-04", today)).toBe("Tuesday 4 August");
  });

  it("does not shift the date for a late-evening viewer", () => {
    // A local-time formatter would show the wrong day east of UTC.
    expect(formatDigestDate("2026-08-06")).toContain("6 August");
  });

  it("falls back to the raw value rather than showing Invalid Date", () => {
    expect(formatDigestDate("not-a-date")).toBe("not-a-date");
  });
});

describe("referencedPostIds — the evidence behind the brief", () => {
  it("finds every cited post id", () => {
    // The ids were ALREADY in the stored content; the prompt asks for them so
    // findings can be checked. Showing the cards needed no change to the cron.
    expect(referencedPostIds(REAL_DIGEST)).toEqual([
      "a5677d81-b17b-4b89-a73f-8517dae640c3",
      "b7a4937f-ae73-4237-9918-27a16af1b962",
      "7aab6930-af25-4c6a-9664-1843b0292b40",
    ]);
  });

  it("dedupes a post cited in more than one section", () => {
    // THEME and FORMAT routinely cite the same post; the reader does not want
    // the card twice.
    const twice = `1. THEME — [a5677d81-b17b-4b89-a73f-8517dae640c3] strong.
3. FORMAT — again [a5677d81-b17b-4b89-a73f-8517dae640c3] and 827 reactions.`;
    expect(referencedPostIds(twice)).toEqual([
      "a5677d81-b17b-4b89-a73f-8517dae640c3",
    ]);
  });

  it("preserves first-mention order so the lead post leads", () => {
    const ordered = `[b7a4937f-ae73-4237-9918-27a16af1b962] then [a5677d81-b17b-4b89-a73f-8517dae640c3]`;
    expect(referencedPostIds(ordered)[0]).toBe(
      "b7a4937f-ae73-4237-9918-27a16af1b962",
    );
  });

  it("matches ids with or without brackets", () => {
    expect(
      referencedPostIds("cited as a5677d81-b17b-4b89-a73f-8517dae640c3 bare"),
    ).toHaveLength(1);
  });

  it("returns nothing when the brief cites no ids", () => {
    expect(referencedPostIds("A brief with no citations at all.")).toEqual([]);
    expect(referencedPostIds("")).toEqual([]);
  });

  it("does not match a partial or malformed uuid", () => {
    // A loose matcher would send junk ids to the database on every page view.
    expect(referencedPostIds("[a5677d81-b17b] and [not-a-uuid-at-all]")).toEqual(
      [],
    );
  });
});

describe("splitSectionLead — claim first, evidence after", () => {
  it("promotes the bolded claim the model already writes", () => {
    // Every section arrives as ONE dense paragraph (theme is 429 chars), so
    // the claim and its numbers had equal weight. The model marks the claim in
    // bold; cleanInline used to strip that signal instead of using it.
    const { claim, evidence } = splitSectionLead(
      parseDigest(REAL_DIGEST).sections[0].body,
    );
    expect(claim).toBe(
      "Claude/AI agents turning revenue and content work into operating systems",
    );
    expect(evidence).toContain("Complete Claude Revenue System");
  });

  it("strips trailing punctuation from the claim", () => {
    expect(splitSectionLead("**A claim here.** And evidence follows.").claim).toBe(
      "A claim here",
    );
  });

  it("returns no claim when the model marked none", () => {
    // Guessing at a first sentence would put an arbitrary phrase in large type.
    const { claim, evidence } = splitSectionLead("Just prose, no emphasis at all.");
    expect(claim).toBeNull();
    expect(evidence).toBe("Just prose, no emphasis at all.");
  });

  it("ignores bold that appears mid-paragraph", () => {
    // Mid-paragraph bold is emphasis, not a heading.
    expect(splitSectionLead("Some lead-in **then bold** after.").claim).toBeNull();
  });

  it("keeps a claim with no evidence as plain prose", () => {
    // A lead with nothing under it is just the section's only sentence.
    const { claim } = splitSectionLead("**The whole section is this.**");
    expect(claim).toBeNull();
  });
});

describe("splitEvidence — scannable rows", () => {
  it("splits quoted post titles from their engagement", () => {
    const { evidence } = splitSectionLead(parseDigest(REAL_DIGEST).sections[0].body);
    const items = splitEvidence(evidence);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Complete Claude Revenue System");
    expect(items[0].detail).toBe("827 reactions, 2,957 comments");
  });

  it("leaves no unbalanced bracket on the detail", () => {
    // The model writes engagement inside "(...)"; splitting mid-wrapper left a
    // trailing ")" that reads as a typo.
    const { evidence } = splitSectionLead(parseDigest(REAL_DIGEST).sections[0].body);
    for (const item of splitEvidence(evidence)) {
      expect(item.detail).not.toMatch(/[()]/);
    }
  });

  it("splits semicolon-separated evidence into one item per clause", () => {
    // The production FORMAT section lists several posts separated by ";".
    const items = splitEvidence(
      "the Revenue System generated 827 reactions; the AEO list generated 659 reactions; the content list generated 79 reactions",
    );
    expect(items).toHaveLength(3);
    expect(items[0].title).toBeNull();
    expect(items[0].detail).toBe("Revenue System generated 827 reactions");
  });

  it("leaves a single-clause section as prose", () => {
    // The fixture's FORMAT section has no semicolons — one continuous thought,
    // so a list would be invented structure.
    const { evidence } = splitSectionLead(parseDigest(REAL_DIGEST).sections[2].body);
    expect(splitEvidence(evidence)).toEqual([]);
  });

  it("drops the lead-in that restates the claim", () => {
    // "over-performed as a repeatable structure: the Revenue System
    // generated..." — the preamble repeats the claim and made item one read
    // twice as long as the rest.
    const items = splitEvidence(
      "over-performed as a repeatable structure: the A list got 10 reactions; the B list got 20 reactions",
    );
    expect(items[0].detail).toBe("A list got 10 reactions");
  });

  it("returns nothing when the evidence is one continuous thought", () => {
    // The caller then renders a paragraph — a reformat must never invent
    // structure that is not there.
    expect(splitEvidence("A single explanatory sentence with no list.")).toEqual([]);
  });

  it("does not split on a single semicolon into one item", () => {
    expect(splitEvidence("Only one clause here; ok").length).toBe(0);
  });
});

describe("splitEvidence — the production THEME section", () => {
  // Verbatim from the rendered page. The earlier fixture used STRAIGHT quotes;
  // production emits CURLY ones, so the matcher silently found nothing and the
  // whole section fell back to prose — a six-post wall of text that looked
  // like the formatter simply had not been applied.
  const THEME_EVIDENCE =
    "The cluster appears across \u201CComplete Claude Revenue System\u201D (827 reactions, 2,957 comments), " +
    "\u201CComplete Client Acquisition System\u201D (122 reactions, 534 comments), " +
    "\u201CThe 10 Levels Of Claude For Content\u201D (79 reactions, 296 comments), " +
    "\u201C50 AI Agent setup guides\u201D (104 reactions, 243 comments), " +
    "\u201C7-step outbound workflow\u201D (136 reactions, 177 comments), and " +
    "\u201C20 Best Claude Agents For Your Entire Sales Operation\u201D (33 reactions, 43 comments).";

  it("splits all six cited posts", () => {
    expect(splitEvidence(THEME_EVIDENCE)).toHaveLength(6);
  });

  it("matches curly quotes, not just straight ones", () => {
    const items = splitEvidence(THEME_EVIDENCE);
    expect(items[0].title).toBe("Complete Claude Revenue System");
    expect(items[0].detail).toBe("827 reactions, 2,957 comments");
  });

  it("captures engagement wrapped in parentheses", () => {
    // The previous pattern forbade "(" in the detail, so a parenthesised
    // engagement figure could never be captured.
    for (const item of splitEvidence(THEME_EVIDENCE)) {
      expect(item.detail).toMatch(/reactions/);
      expect(item.detail).not.toMatch(/[()]/);
    }
  });

  it("drops the 'and' connecting the final item", () => {
    // Without this the second-to-last row ended "177 comments), and".
    const items = splitEvidence(THEME_EVIDENCE);
    expect(items[4].detail).toBe("136 reactions, 177 comments");
    expect(items.every((item) => !/\band\s*$/.test(item.detail))).toBe(true);
  });

  it("still handles straight quotes", () => {
    // Both styles appear across runs; neither may regress.
    const items = splitEvidence(
      '"First title" (10 reactions), "Second title" (20 reactions)',
    );
    expect(items).toHaveLength(2);
    expect(items[1].title).toBe("Second title");
  });

  it("does not build a list from a single quoted title", () => {
    // One quoted phrase mid-sentence is a quotation, not a list.
    expect(
      splitEvidence("The post \u201CSome title\u201D did well this week."),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The model moved to backtick-wrapped ids with no bold claim and no quoted
// titles. Every parser above missed that shape, so sections fell back to one
// prose paragraph with raw UUIDs printed on the page.
// ---------------------------------------------------------------------------

/** Verbatim from the 7 August brief, the shape that shipped the bug. */
const BACKTICK_THEME =
  "The clearest cluster was practical B2B sales systems: prospect research and " +
  "personalization, structured DMs, and pipeline foundations replacing vague " +
  "“post more” advice with repeatable process. The strongest evidence was " +
  "`84efa253-e31d-4dd0-ae36-e9d4e28dfaad` (208 reactions, 498 comments), " +
  "`60cb589b-c4e2-4fb8-89a1-1e9cc3de7604` (421 reactions, 241 comments), and " +
  "`1e174a9a-fcbc-4661-9b89-47d694e42181` (120 reactions, 99 comments).";

const BACKTICK_LABELS = new Map([
  ["84efa253-e31d-4dd0-ae36-e9d4e28dfaad", "Ada Lovelace"],
  ["60cb589b-c4e2-4fb8-89a1-1e9cc3de7604", "Grace Hopper"],
  ["1e174a9a-fcbc-4661-9b89-47d694e42181", "Alan Turing"],
]);

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("backtick-wrapped citations", () => {
  it("never leaves a raw UUID on the page", () => {
    expect(cleanInline(BACKTICK_THEME, BACKTICK_LABELS)).not.toMatch(UUID_ANYWHERE);
    // Also with no labels at all — an unresolved id must be removed, not shown.
    expect(cleanInline(BACKTICK_THEME)).not.toMatch(UUID_ANYWHERE);
  });

  it("substitutes the author so a citation reads as evidence", () => {
    const cleaned = cleanInline(BACKTICK_THEME, BACKTICK_LABELS);
    expect(cleaned).toContain("Ada Lovelace (208 reactions, 498 comments)");
    expect(cleaned).toContain("Grace Hopper (421 reactions, 241 comments)");
  });

  it("keeps the engagement numbers, which are the actual evidence", () => {
    const cleaned = cleanInline(BACKTICK_THEME, BACKTICK_LABELS);
    expect(cleaned).toContain("208 reactions, 498 comments");
    expect(cleaned).toContain("120 reactions, 99 comments");
  });

  it("splits a citation run into scannable rows instead of a paragraph", () => {
    const { evidence } = splitSectionLead(BACKTICK_THEME, BACKTICK_LABELS);
    const items = splitEvidence(evidence, BACKTICK_LABELS);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      title: "Ada Lovelace",
      detail: "208 reactions, 498 comments",
    });
    expect(items[2]).toEqual({
      title: "Alan Turing",
      detail: "120 reactions, 99 comments",
    });
  });

  it("shows numbers alone when a cited post cannot be resolved", () => {
    const items = splitEvidence(BACKTICK_THEME, new Map());
    expect(items).toHaveLength(3);
    expect(items[0].title).toBeNull();
    expect(items[0].detail).toBe("208 reactions, 498 comments");
  });

  it("leaves a single citation as prose rather than a one-row list", () => {
    const oneCitation =
      "The day's standout was `c244df87-c7a8-4b0d-9432-6773abba27b1` " +
      "(2,481 reactions, 303 comments).";
    expect(splitEvidence(oneCitation, BACKTICK_LABELS)).toEqual([]);
  });

  it("cleans the id out of the hook commentary too", () => {
    const hookBody =
      "“Woah, Bending Spoons is cooking.” — " +
      "`c244df87-c7a8-4b0d-9432-6773abba27b1` — 2,481 reactions, 303 comments.";
    const commentary = hookCommentary(
      hookBody,
      new Map([["c244df87-c7a8-4b0d-9432-6773abba27b1", "Ada Lovelace"]]),
    );
    expect(commentary).not.toMatch(UUID_ANYWHERE);
    expect(commentary).toContain("Ada Lovelace");
    expect(commentary).toContain("2,481 reactions");
  });

  it("still resolves cited ids for the post cards", () => {
    // The ids must survive in the RAW content — the card list depends on them.
    expect(referencedPostIds(BACKTICK_THEME)).toEqual([
      "84efa253-e31d-4dd0-ae36-e9d4e28dfaad",
      "60cb589b-c4e2-4fb8-89a1-1e9cc3de7604",
      "1e174a9a-fcbc-4661-9b89-47d694e42181",
    ]);
  });
});

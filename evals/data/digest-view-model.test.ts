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

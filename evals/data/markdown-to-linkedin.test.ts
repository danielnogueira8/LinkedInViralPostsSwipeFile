import { describe, test, expect } from "vitest";
import {
  markdownToLinkedIn,
  hasResidualMarkdown,
} from "@/lib/markdown/to-linkedin";
import { toUnicodeStyle } from "@/lib/markdown/unicode-styles";

// ---------------------------------------------------------------------------
// markdownToLinkedIn — converts a markdown post body to LinkedIn PLAIN TEXT
// with Unicode bold/italic. The load-bearing guarantee is the LAST describe
// block: the output never contains raw markdown metacharacters that would leak
// to LinkedIn as literal syntax.
// ---------------------------------------------------------------------------

const BOLD = (s: string) => toUnicodeStyle(s, "bold");
const ITALIC = (s: string) => toUnicodeStyle(s, "italic");

describe("markdownToLinkedIn — inline emphasis", () => {
  test("**bold** and __bold__ become Unicode bold", () => {
    expect(markdownToLinkedIn("this is **bold** text")).toBe(
      `this is ${BOLD("bold")} text`,
    );
    expect(markdownToLinkedIn("this is __bold__ text")).toBe(
      `this is ${BOLD("bold")} text`,
    );
  });

  test("*italic* and _italic_ become Unicode italic", () => {
    expect(markdownToLinkedIn("this is *italic* text")).toBe(
      `this is ${ITALIC("italic")} text`,
    );
    expect(markdownToLinkedIn("this is _italic_ text")).toBe(
      `this is ${ITALIC("italic")} text`,
    );
  });

  test("bold is matched before italic (** is not two single *)", () => {
    // If italic ran first it would eat the inner "*" and mangle the run.
    expect(markdownToLinkedIn("**Level 1: Random posting**")).toBe(
      BOLD("Level 1: Random posting"),
    );
  });

  test("snake_case and file names are NOT italicized", () => {
    // Word-boundaried underscore rule: these must survive verbatim.
    const s = "call send_draft and read file_name.ts here";
    expect(markdownToLinkedIn(s)).toBe(s);
  });

  test("digits inside bold are styled too", () => {
    // "the 10 rules" bolded → the digits also become the bold variant.
    expect(markdownToLinkedIn("**Rule 3**")).toBe(BOLD("Rule 3"));
    expect(markdownToLinkedIn("**Rule 3**")).not.toContain("3"); // ascii 3 gone
  });
});

describe("markdownToLinkedIn — blocks", () => {
  test("headings become a bold line", () => {
    expect(markdownToLinkedIn("## The 3 Levels")).toBe(BOLD("The 3 Levels"));
    expect(markdownToLinkedIn("#### Level 2: Intentional")).toBe(
      BOLD("Level 2: Intentional"),
    );
  });

  test("unordered lists use a real bullet, never a raw dash/star", () => {
    const out = markdownToLinkedIn("- one\n- two\n* three\n+ four");
    expect(out).toBe("• one\n• two\n• three\n• four");
    expect(out).not.toMatch(/^[-*+]/m);
  });

  test("ordered lists keep the number", () => {
    expect(markdownToLinkedIn("1. first\n2. second")).toBe(
      "1. first\n2. second",
    );
  });

  test("nested list indentation is preserved (2 spaces/level)", () => {
    const out = markdownToLinkedIn("- top\n  - nested\n    - deeper");
    expect(out).toBe("• top\n  • nested\n    • deeper");
  });

  test("inline emphasis inside list items is converted", () => {
    expect(markdownToLinkedIn("- **bold** point\n- plain point")).toBe(
      `• ${BOLD("bold")} point\n• plain point`,
    );
  });

  test("blockquotes drop the marker", () => {
    expect(markdownToLinkedIn("> a quoted line")).toBe("a quoted line");
  });

  test("horizontal rules become a blank line", () => {
    expect(markdownToLinkedIn("above\n\n---\n\nbelow")).toBe(
      "above\n\n\n\nbelow",
    );
  });
});

describe("markdownToLinkedIn — links and code", () => {
  test("[text](url) becomes 'text (url)'", () => {
    expect(markdownToLinkedIn("see [my guide](https://x.com/g) now")).toBe(
      "see my guide (https://x.com/g) now",
    );
  });

  test("inline code drops the backticks, keeps content", () => {
    expect(markdownToLinkedIn("run `npm test` first")).toBe(
      "run npm test first",
    );
  });

  test("fenced code blocks keep content, drop the fences", () => {
    const out = markdownToLinkedIn("before\n```js\nconst x = 1;\n```\nafter");
    expect(out).toBe("before\nconst x = 1;\nafter");
    expect(out).not.toContain("```");
  });

  test("code content is literal and is never interpreted as emphasis or a heading", () => {
    expect(markdownToLinkedIn("`price * quantity #forecast`")).toBe(
      "price * quantity #forecast",
    );
    expect(
      markdownToLinkedIn(
        "```ts\nconst total = price * quantity; // #forecast\n```",
      ),
    ).toBe("const total = price * quantity; // #forecast");
  });

  test("preserves URL fragments instead of treating their hash as markdown", () => {
    expect(markdownToLinkedIn("Read https://example.com/guide#section-2")).toBe(
      "Read https://example.com/guide#section-2",
    );
  });

  test("preserves text that resembles the converter's internal sentinels", () => {
    const sentinelLike = "\uE000code0\uE001 literal and `real * code`";
    expect(markdownToLinkedIn(sentinelLike)).toBe(
      "\uE000code0\uE001 literal and real * code",
    );
  });
});

describe("markdownToLinkedIn — safe on plain (Haiku-style) prose", () => {
  test("normal prose with no markdown is returned unchanged", () => {
    const post =
      "I watch founders hit two paths on LinkedIn.\n\nOne group grows. The other quits around month three.\n\nThe split isn't talent or luck.";
    expect(markdownToLinkedIn(post)).toBe(post);
  });

  test("a real LinkedIn post that already uses bullets/numbers is stable", () => {
    // Haiku writes clean "1." lines and "-" bullets already; converting must not
    // corrupt them (numbers kept; a leading "-" becomes the nicer "•").
    const post = "Here's the play:\n1. Post rough.\n2. Track what landed.";
    expect(markdownToLinkedIn(post)).toBe(post);
  });

  test("idempotent: converting twice equals converting once", () => {
    const md =
      "## Habits\n\n**1. Post before you're ready.**\n- ship *rough*\n- track `signals`";
    const once = markdownToLinkedIn(md);
    expect(markdownToLinkedIn(once)).toBe(once);
  });

  test("literal hashtags and multiplication operators survive", () => {
    const post = "Keep #AI and #FounderMode. Revenue = price * quantity.";
    expect(markdownToLinkedIn(post)).toBe(post);
    expect(hasResidualMarkdown(post)).toBe(false);
  });
});

describe("markdownToLinkedIn — a realistic Luna draft round-trips clean", () => {
  // Shape lifted from the live A/B (Luna leans on **bold** headers + lists).
  const LUNA = [
    "Most LinkedIn content falls into three maturity levels.",
    "",
    "**Level 1: Posting randomly**",
    "",
    "You post when you have time or feel inspired.",
    "",
    "**Level 2: Posting intentionally**",
    "",
    "You start choosing a few themes:",
    "",
    "- Clear content pillars",
    "- A repeatable rhythm",
    "- Formats that consistently perform",
    "",
    "**Level 3: Running a content system**",
    "",
    "The goal is not to post *more*. It is to move from random visibility to consistent credibility.",
  ].join("\n");

  test("produces LinkedIn plain text with Unicode bold + real bullets", () => {
    const out = markdownToLinkedIn(LUNA);
    expect(out).toContain(BOLD("Level 1: Posting randomly"));
    expect(out).toContain("• Clear content pillars");
    expect(out).toContain(ITALIC("more"));
    // The whole thing is safe to send to LinkedIn:
    expect(hasResidualMarkdown(out)).toBe(false);
  });
});

describe("markdownToLinkedIn — the LOAD-BEARING invariant: no markdown leaks", () => {
  const CASES = [
    "**bold** and *italic* and __b__ and _i_",
    "# H1\n## H2\n###### H6",
    "- a\n* b\n+ c\n1. d\n2) e",
    "> quote\n>nested",
    "a `code` span and\n```\nfenced\n```",
    "a [link](https://x.com) here",
    "***bold italic***",
    "mix: **bold [link](u)** with `code` in a ## heading",
  ];

  test.each(CASES)("output has no recognized markdown syntax: %s", (md) => {
    const out = markdownToLinkedIn(md);
    expect(hasResidualMarkdown(out)).toBe(false);
  });

  test("hasResidualMarkdown flags raw markdown but not converted output", () => {
    expect(hasResidualMarkdown("**still bold**")).toBe(true);
    expect(hasResidualMarkdown("## heading")).toBe(true);
    expect(hasResidualMarkdown("[t](u)")).toBe(true);
    expect(hasResidualMarkdown(`${BOLD("clean")} text • bullet`)).toBe(false);
    expect(hasResidualMarkdown("Keep #AI and 3 * 4")).toBe(false);
  });
});

import { describe, test, expect } from "vitest";
import {
  findPlaceholders,
  stripPlaceholders,
} from "@/app/(app)/dashboard/chat-workspace";

// ---------------------------------------------------------------------------
// Starter-prompt placeholder helpers (chat-workspace.tsx). A starter like
// "Write a post about [topic]" ships a [bracketed] span to fill. These detect
// the placeholders (so the composer can nudge) and strip them (for a deliberate
// "you pick" second send). The detector must catch the real starter placeholders
// WITHOUT false-positiving on natural bracketed prose.
// ---------------------------------------------------------------------------

describe("findPlaceholders — catches the real starter placeholders", () => {
  test("the three live starters", () => {
    expect(
      findPlaceholders("Write an original post in my voice about [topic]."),
    ).toEqual(["[topic]"]);
    expect(findPlaceholders("Namejack [person] — write a LinkedIn post.")).toEqual([
      "[person]",
    ]);
    expect(findPlaceholders("Brandjack [company] — write a post.")).toEqual([
      "[company]",
    ]);
  });

  test("multi-word and hyphen/slash placeholders", () => {
    expect(findPlaceholders("about [your topic]")).toEqual(["[your topic]"]);
    expect(findPlaceholders("for [company-name]")).toEqual(["[company-name]"]);
    expect(findPlaceholders("[A/B test idea]")).toEqual(["[A/B test idea]"]);
  });

  test("multiple placeholders in one message", () => {
    expect(
      findPlaceholders("Compare [company] to [competitor] for [audience]"),
    ).toEqual(["[company]", "[competitor]", "[audience]"]);
  });

  test("no placeholder → empty", () => {
    expect(findPlaceholders("Write a post about cold outreach.")).toEqual([]);
    expect(findPlaceholders("")).toEqual([]);
  });
});

describe("findPlaceholders — does NOT false-positive on natural brackets", () => {
  const natural = [
    // Sentence punctuation inside the brackets → not a placeholder token.
    "See the docs [here, please].",
    "I read [this article. it was great]",
    // A citation-like bracket with a number.
    "As shown in [1] and [2].",
    // Empty brackets.
    "An empty [] bracket pair.",
    // Brackets opening with a non-letter.
    "[123] is a number",
    "[ leading space]",
  ];
  for (const [i, text] of natural.entries()) {
    test(`natural #${i + 1}: ${JSON.stringify(text)}`, () => {
      expect(findPlaceholders(text)).toEqual([]);
    });
  }
});

describe("stripPlaceholders — removes tokens + tidies whitespace/punctuation", () => {
  test("strips the token and fixes the dangling space before a period", () => {
    expect(
      stripPlaceholders("Write an original post in my voice about [topic]."),
    ).toBe("Write an original post in my voice about.");
  });

  test("strips a mid-sentence placeholder without doubling spaces", () => {
    expect(stripPlaceholders("Namejack [person] — write a post.")).toBe(
      "Namejack — write a post.",
    );
  });

  test("strips multiple placeholders", () => {
    expect(stripPlaceholders("Compare [company] to [competitor].")).toBe(
      "Compare to.",
    );
  });

  test("a message with no placeholder is unchanged (trimmed)", () => {
    expect(stripPlaceholders("Write about cold outreach.")).toBe(
      "Write about cold outreach.",
    );
  });
});

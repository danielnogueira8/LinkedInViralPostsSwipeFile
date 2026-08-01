import { describe, test, expect } from "vitest";
import {
  truncateAtSentenceBoundary,
  truncateAtWordBoundary,
} from "@/lib/text-truncate";

describe("truncateAtWordBoundary", () => {
  test("returns the value untouched when it fits", () => {
    expect(truncateAtWordBoundary("short title", 60)).toBe("short title");
  });

  test("cuts on the last word boundary, never mid-word", () => {
    const line = "Your LinkedIn profile can kill a sale before your content gets a chance.";
    // The raw 60-char slice ends at "…content ge" — the fragment that leaked
    // into agent inbox prompts as a draft title.
    expect(line.slice(0, 60)).toBe("Your LinkedIn profile can kill a sale before your content ge");
    expect(truncateAtWordBoundary(line, 60)).toBe(
      "Your LinkedIn profile can kill a sale before your content",
    );
  });

  test("hard-cuts when one word exceeds the budget", () => {
    expect(truncateAtWordBoundary("x".repeat(100), 60)).toBe("x".repeat(60));
  });
});

describe("truncateAtSentenceBoundary", () => {
  test("returns the value untouched when it fits", () => {
    expect(truncateAtSentenceBoundary("One sentence.", 500)).toBe("One sentence.");
  });

  test("cuts at the last full sentence inside the budget", () => {
    const body = `${"Alpha claim. "}${"Beta detail that goes on and on. ".repeat(12)}Trailing thought that dangles`;
    const out = truncateAtSentenceBoundary(body, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith(".")).toBe(true);
    expect(out).not.toContain("Trailing");
  });

  test("never leaves a dangling opener like the 'Here's' that leaked into prompts", () => {
    const body =
      "Your profile only needs to do four things. That's how views turn into DMs instead of disappearing into analytics. Here's the part that never fits inside the evidence budget and must go.";
    const out = truncateAtSentenceBoundary(body, 140);
    expect(out).toBe(
      "Your profile only needs to do four things. That's how views turn into DMs instead of disappearing into analytics.",
    );
  });

  test("keeps a terminator that lands exactly on the cut edge", () => {
    const body = `${"word ".repeat(27).trim()} Done. Extra words that overflow the budget entirely.`;
    const out = truncateAtSentenceBoundary(body, 142);
    expect(out.endsWith(".")).toBe(true);
  });

  test("falls back to a word-boundary cut when no sentence ends in budget", () => {
    const body = "one long line without any terminators that keeps going and going and going past the cap";
    const out = truncateAtSentenceBoundary(body, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toBe("one long line without any terminators");
  });
});

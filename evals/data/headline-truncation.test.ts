import { describe, test, expect } from "vitest";
import {
  truncateHeadline,
  HEADLINE_PREVIEW_CHARS,
} from "@/lib/chat-ui-policy";

describe("truncateHeadline — consistent char-count cut for the card header", () => {
  test("a short headline is returned unchanged (no ellipsis)", () => {
    expect(truncateHeadline("Founder")).toBe("Founder");
    expect(truncateHeadline("Co-founder @ Scale Content Labs")).toBe(
      "Co-founder @ Scale Content Labs",
    );
  });

  test("a long headline cuts at a stable length with an ellipsis", () => {
    const long =
      "Co-founder @ Scale Content Labs | LinkedIn ghostwriting for SaaS and agency founders";
    const out = truncateHeadline(long);
    expect(out.endsWith("…")).toBe(true);
    // Cut at (or before) the budget — never longer than budget + the ellipsis.
    expect(out.length).toBeLessThanOrEqual(HEADLINE_PREVIEW_CHARS + 1);
  });

  test("never slices a word in half — cuts at a word boundary", () => {
    const long =
      "Helping ambitious founders build unstoppable personal brands everywhere";
    const out = truncateHeadline(long, 30);
    // The text before the ellipsis is a prefix ending on a whole word.
    const shown = out.replace(/…$/, "");
    expect(long.startsWith(shown)).toBe(true);
    expect(long[shown.length]).toBe(" "); // the next original char is a space
  });

  test("the cut is identical regardless of trailing content (consistency)", () => {
    const a = truncateHeadline("Growth marketer and community builder at Acme Corp Global");
    const b = truncateHeadline("Growth marketer and community builder at Acme Corp Worldwide");
    // Same prefix → same visible cut, so two cards never disagree on where it ends.
    expect(a).toBe(b);
  });

  test("a single very long token with no spaces hard-cuts (never returns empty)", () => {
    const out = truncateHeadline("x".repeat(200), 20);
    expect(out).toBe("x".repeat(20) + "…");
  });

  test("respects a custom max", () => {
    expect(truncateHeadline("one two three four five", 8)).toBe("one two…");
  });
});

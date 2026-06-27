import { describe, test, expect } from "vitest";
import { deriveDraftTitle, isAutoDerivedTitle } from "@/lib/draft-title";

// ---------------------------------------------------------------------------
// Title derivation for board posts. Backs the "Update post" fix: when a post's
// body changes and its title was auto-derived from the OLD first line, the card
// title should follow the NEW first line — but a manually-typed title is kept.
// ---------------------------------------------------------------------------

describe("deriveDraftTitle — first line, capped", () => {
  test("takes the first line", () => {
    expect(deriveDraftTitle("Hello world\n\nrest of body")).toBe("Hello world");
  });
  test("caps at 60 chars", () => {
    const long = "x".repeat(100);
    expect(deriveDraftTitle(long)).toHaveLength(60);
  });
  test("trims and falls back when empty", () => {
    expect(deriveDraftTitle("   \n more")).toBe("Untitled post");
    expect(deriveDraftTitle("")).toBe("Untitled post");
  });
});

describe("isAutoDerivedTitle — manual vs auto", () => {
  const body = "Your hooks are garbage.\n\nHere's the fix.";

  test("title equal to the body's first line is auto-derived", () => {
    expect(isAutoDerivedTitle("Your hooks are garbage.", body)).toBe(true);
  });
  test("empty / placeholder titles count as auto", () => {
    expect(isAutoDerivedTitle("", body)).toBe(true);
    expect(isAutoDerivedTitle(null, body)).toBe(true);
    expect(isAutoDerivedTitle("Untitled post", body)).toBe(true);
    expect(isAutoDerivedTitle("Untitled draft", body)).toBe(true);
  });
  test("a custom name the user typed is NOT auto (so it's preserved)", () => {
    expect(isAutoDerivedTitle("Q3 lead magnet", body)).toBe(false);
  });

  test("scenario: an auto-titled post whose body changes should re-derive", () => {
    // Old state: title was auto-derived from the old first line.
    const oldBody = "I wrote 400+ LinkedIn posts for founders last year.";
    const oldTitle = deriveDraftTitle(oldBody);
    expect(isAutoDerivedTitle(oldTitle, oldBody)).toBe(true);

    // New body (refined). Because the title was auto, it should follow the new
    // first line (this line is exactly 60 chars, so it's kept whole).
    const newBody = "Your LinkedIn posts aren't failing because of the algorithm.";
    const next = isAutoDerivedTitle(oldTitle, oldBody)
      ? deriveDraftTitle(newBody)
      : oldTitle;
    expect(next).toBe("Your LinkedIn posts aren't failing because of the algorithm.");
    expect(next).not.toBe(oldTitle); // the card title changed with the body
  });

  test("scenario: a manually-named post keeps its name on body change", () => {
    const oldBody = "First line A.";
    const manualTitle = "My favorite hook";
    const newBody = "Totally different first line.";
    const next = isAutoDerivedTitle(manualTitle, oldBody)
      ? deriveDraftTitle(newBody)
      : manualTitle;
    expect(next).toBe("My favorite hook");
  });
});

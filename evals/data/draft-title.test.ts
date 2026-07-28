import { describe, test, expect } from "vitest";
import {
  deriveDraftTitle,
  isAutoDerivedTitle,
  titleFromNewDraftPaste,
} from "@/lib/draft-title";

// ---------------------------------------------------------------------------
// Title derivation for board posts. Backs the "Update post" fix: when a post's
// body changes and its title was auto-derived from the OLD first line, the card
// title should follow the NEW first line — but a manually-typed title is kept.
// ---------------------------------------------------------------------------

describe("deriveDraftTitle — first line, capped", () => {
  test("takes the first line", () => {
    expect(deriveDraftTitle("Hello world\n\nrest of body")).toBe("Hello world");
  });
  test("a single word with no spaces past the cap hard-cuts, then adds an ellipsis", () => {
    const long = "x".repeat(100);
    expect(deriveDraftTitle(long)).toBe(`${"x".repeat(60)}…`);
  });
  test("cuts on the last word boundary within budget, not mid-word", () => {
    const body =
      "Stop waiting for the perfect post. (It is costing you clients)";
    const title = deriveDraftTitle(body);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(61); // 60-char budget + the ellipsis
    // The word right before the ellipsis is a COMPLETE word from the body,
    // never a fragment like "cost" (from "costing") cut mid-word.
    const bodyWords = body.split(" ");
    const kept = title.slice(0, -1).trim().split(" ");
    expect(bodyWords).toContain(kept[kept.length - 1]);
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

describe("titleFromNewDraftPaste — Posts new-draft flow", () => {
  test("uses the pasted post's first line when the new draft is blank", () => {
    expect(
      titleFromNewDraftPaste({
        isNew: true,
        currentTitle: "",
        currentBody: "",
        pastedText: "The hook becomes the title\n\nThe rest stays in the body.",
      }),
    ).toBe("The hook becomes the title");
  });

  test("preserves a title the user already entered", () => {
    expect(
      titleFromNewDraftPaste({
        isNew: true,
        currentTitle: "My custom title",
        currentBody: "",
        pastedText: "Pasted hook\n\nPasted body",
      }),
    ).toBeNull();
  });

  test("does not rename an existing post or a partially written draft", () => {
    expect(
      titleFromNewDraftPaste({
        isNew: false,
        currentTitle: "",
        currentBody: "",
        pastedText: "Pasted hook",
      }),
    ).toBeNull();
    expect(
      titleFromNewDraftPaste({
        isNew: true,
        currentTitle: "",
        currentBody: "Already writing",
        pastedText: "Pasted continuation",
      }),
    ).toBeNull();
  });

  test("ignores text-free clipboard content", () => {
    expect(
      titleFromNewDraftPaste({
        isNew: true,
        currentTitle: "",
        currentBody: "",
        pastedText: "   ",
      }),
    ).toBeNull();
  });
});

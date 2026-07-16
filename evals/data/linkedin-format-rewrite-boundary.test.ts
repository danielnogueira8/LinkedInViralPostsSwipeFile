import { describe, test, expect } from "vitest";
import { applyRewriteBoundary } from "@/lib/linkedin-format";

// ---------------------------------------------------------------------------
// applyRewriteBoundary — the fix for "Ask AI removes a line break".
//
// When the user selects a span in the draft editor and asks AI to rewrite it,
// the result used to be `rewritten.trim()`. That trims ALL edge whitespace,
// including a "\n\n" paragraph break that was PART OF the user's selection — so
// two paragraphs merged into one. This helper trims the model's OWN stray edge
// whitespace but re-applies exactly the leading/trailing whitespace the original
// selection carried, preserving the line breaks the user selected.
// ---------------------------------------------------------------------------

describe("applyRewriteBoundary", () => {
  test("selection with NO edge whitespace → plain trim (drops model's stray ws)", () => {
    expect(applyRewriteBoundary("  new text  ", "old text")).toBe("new text");
    expect(applyRewriteBoundary("\nnew text\n", "old text")).toBe("new text");
  });

  test("selection ending in a paragraph break → the break is PRESERVED", () => {
    // The bug: selection was "Old line.\n\n"; rewrite came back "New line.";
    // old code trimmed → "New line." (break lost, paragraphs merged). Now kept.
    expect(applyRewriteBoundary("New line.", "Old line.\n\n")).toBe(
      "New line.\n\n",
    );
  });

  test("selection with a leading break → leading break preserved", () => {
    expect(applyRewriteBoundary("New line.", "\n\nOld line.")).toBe(
      "\n\nNew line.",
    );
  });

  test("break preserved on BOTH edges", () => {
    expect(applyRewriteBoundary("New.", "\n\nOld.\n\n")).toBe("\n\nNew.\n\n");
  });

  test("model ALSO returned the break → no double-up (trim then re-apply once)", () => {
    // Model echoed a trailing "\n\n" of its own AND the selection had one — the
    // result must be a single "\n\n", not four newlines.
    expect(applyRewriteBoundary("New line.\n\n", "Old line.\n\n")).toBe(
      "New line.\n\n",
    );
  });

  test("single-space edges are preserved (mid-sentence selection)", () => {
    // Selecting " a phrase " inside a sentence keeps the surrounding spaces.
    expect(applyRewriteBoundary("rewritten", " a phrase ")).toBe(
      " rewritten ",
    );
  });

  test("multi-line body inside the rewrite is untouched (only edges matter)", () => {
    const body = "Line one.\n\nLine two.\n\nLine three.";
    expect(applyRewriteBoundary(body, "some selection\n\n")).toBe(body + "\n\n");
  });

  test("empty original selection → no edge whitespace applied", () => {
    expect(applyRewriteBoundary("  new  ", "")).toBe("new");
  });
});

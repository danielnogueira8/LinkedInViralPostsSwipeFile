import { describe, test, expect } from "vitest";
import { looksCorruptedDraft } from "@/lib/agent/run";

// ---------------------------------------------------------------------------
// Unit tests for the render-draft corruption gate (lib/agent/run.ts).
//
// A garbled render_post/render_hook body (observed: "...spec sheet.}}ermalink
// Long..." — JSON/fence control chars fused into prose) must be REJECTED so it
// never becomes a draft card; the model's self-correction then produces the
// clean draft as the only card. The detector is deliberately NARROW: it must
// catch the real corruption signatures WITHOUT false-positiving on legitimate
// posts (incl. ones that mention code, templating, or braces).
// ---------------------------------------------------------------------------

describe("looksCorruptedDraft — catches real corruption", () => {
  test("the exact observed symptom: }}ermalink fused into prose", () => {
    const body =
      "I used to write LinkedIn posts like a spec sheet.}}ermalink Long paragraphs. Every feature listed.";
    expect(looksCorruptedDraft(body)).toBe("JSON brace fragment fused into text");
  });

  test("a leaked ```post fence marker in the body", () => {
    expect(looksCorruptedDraft("Here's the draft:\n```post\nReal text")).toBe(
      "leaked code-fence marker",
    );
    expect(looksCorruptedDraft("text ```hook more")).toBe("leaked code-fence marker");
    expect(looksCorruptedDraft("```cite\n")).toBe("leaked code-fence marker");
  });

  test("a stray JSON key fragment from the tool-args envelope", () => {
    expect(looksCorruptedDraft('Great post here "permalink": "https://...')).toBe(
      "JSON key fragment in body",
    );
    expect(looksCorruptedDraft('...end of post","body": "next')).toBe(
      "JSON key fragment in body",
    );
    expect(looksCorruptedDraft('"title" : "Draft post"')).toBe(
      "JSON key fragment in body",
    );
  });

  test("multiple closing braces welded to letters (no space)", () => {
    expect(looksCorruptedDraft("the value is x}}}then text")).not.toBeNull();
    expect(looksCorruptedDraft("cut off here}}body more")).not.toBeNull();
  });
});

describe("looksCorruptedDraft — does NOT false-positive on real posts", () => {
  const clean = [
    // A normal, complete LinkedIn post.
    "I used to write LinkedIn posts like a spec sheet.\n\nLong paragraphs. Every feature listed.\n\nThen I studied Apple's copy. Here's what changed.",
    // A post that legitimately mentions code / templating with braces, but with
    // surrounding whitespace (not the fused-garbage signature).
    "Our config used to look like this:\n\n{\n  retries: 3\n}\n\nNow it's one line. Simpler wins.",
    // Double closing braces on their own, surrounded by whitespace (a code block
    // about templating) — NOT fused to letters, so it should pass.
    "Mustache templates use double braces: {{ name }} renders the value.\n\nNeat, right?",
    // A post that talks about JSON but doesn't contain a key:value fragment.
    "Stop sending raw JSON to your users. Nobody reads a wall of brackets.",
    // The word "permalink" used in normal prose (no quote+colon JSON shape).
    "Add a permalink to every post so people can find it later.",
    // Single braces in prose.
    "Use the {first_name} merge tag and personalize at scale.",
    // A hook with an em dash and quotes — clean.
    'She said "this will never work" — so I shipped it that night.',
    // Backticks for inline code emphasis, but not an artifact fence.
    "I renamed the function to `sendDraft` and everything clicked.",
  ];

  for (const [i, body] of clean.entries()) {
    test(`clean post #${i + 1} passes`, () => {
      expect(looksCorruptedDraft(body)).toBeNull();
    });
  }
});

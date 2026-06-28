import { describe, test, expect } from "vitest";
import { looksCorruptedDraft, normalizePostBody } from "@/lib/agent/run";

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

// ---------------------------------------------------------------------------
// normalizePostBody — the "wall of text" safety net (Bug #1). A post that comes
// back as a single dense block (no blank-line paragraph breaks) gets paragraph
// breaks injected so it doesn't render as an unreadable wall. Must be
// conservative: never touch a body that's already formatted, never shatter a
// deliberate short post.
// ---------------------------------------------------------------------------

describe("normalizePostBody — injects paragraph breaks into a wall of text", () => {
  test("a long single-block post gets blank lines between sentences", () => {
    const body =
      "You can have the best offer in your market and still lose. " +
      "I have watched founders spend six months polishing their pricing and their landing page. " +
      "Then they launch to an audience of nobody. " +
      "Distribution is the moat, not the product. " +
      "Build the audience first and the offer second.";
    const out = normalizePostBody(body);
    expect(out).toContain("\n\n");
    // Every paragraph is non-empty and the text is preserved verbatim (minus the
    // single spaces we turned into breaks).
    expect(out.replace(/\n\n/g, " ")).toBe(body);
    expect(out.split("\n\n").length).toBeGreaterThan(2);
  });

  test("leaves a body that ALREADY has blank-line paragraphs untouched", () => {
    const body =
      "You can have the best offer and still lose.\n\n" +
      "I have watched founders polish their pricing for months.\n\n" +
      "Distribution is the moat.";
    expect(normalizePostBody(body)).toBe(body);
  });

  test("leaves a body with any existing single newline untouched (don't reflow)", () => {
    // A single \n is the model's chosen line break (could be a list or CTA line)
    // — reflowing it risks merging lines, so we don't touch it.
    const body =
      "Three things I learned this year and they are all about distribution and audience and the long compounding game that nobody talks about enough honestly.\n- ship daily\n- talk to users\n- distribution first";
    expect(normalizePostBody(body)).toBe(body.replace(/\s+$/, ""));
  });

  test("leaves a genuinely short single-paragraph post as one paragraph", () => {
    const body = "Distribution beats a perfect offer. Build the audience first.";
    expect(normalizePostBody(body)).toBe(body);
    expect(normalizePostBody(body)).not.toContain("\n\n");
  });

  test("does not split inside numbers or decimals", () => {
    const body =
      "We grew revenue from 1.2M to 3.4M in eighteen months by doing one boring thing every single day without fail. " +
      "We posted. " +
      "We replied to every comment. " +
      "We treated distribution as the actual product and the software as the afterthought it deserved to be at that stage.";
    const out = normalizePostBody(body);
    // The decimals stay intact — no break inserted after "1." or "3.".
    expect(out).toContain("1.2M");
    expect(out).toContain("3.4M");
  });

  test("a single very long sentence with no boundary stays as-is (no-op safe)", () => {
    const body =
      "This is one extremely long run-on sentence that keeps going and going without ever reaching a natural sentence boundary that we could split on so it should be returned exactly as it came in without any paragraph breaks injected at all anywhere";
    expect(normalizePostBody(body)).toBe(body);
  });

  test("trims trailing whitespace", () => {
    expect(normalizePostBody("A short post.   \n  ")).toBe("A short post.");
  });
});

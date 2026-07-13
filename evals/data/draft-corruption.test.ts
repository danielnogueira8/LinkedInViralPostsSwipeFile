import { describe, test, expect } from "vitest";
import {
  looksCorruptedDraft,
  stripEmDashes,
  aiTellMetrics,
} from "@/lib/agent/specialists/nets";
import {
  normalizePostBody,
  normalizeNumberedListicleHeadings,
  normalizeSentenceFinalNumberBreaks,
} from "@/lib/post-body-normalize";
import { extractArtifacts } from "@/lib/agent/artifact-policy";

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

  test("hallucinated tool-call XML leaked into the body", () => {
    // The exact symptom from a batch-chat follow-up turn: GLM emits raw
    // tool-call XML as body text instead of using the transport tool_calls
    // channel. Any of these signatures should reject the draft — none are
    // legit LinkedIn post prose.
    expect(
      looksCorruptedDraft(
        "Here's your post:\n<tool_call>get_voice()</tool_call>\nBody continues",
      ),
    ).toBe("tool-call XML leaked into body");
    expect(
      looksCorruptedDraft(
        'Great start\n<invoke name="render_post">\nbody stuff',
      ),
    ).toBe("tool-call XML leaked into body");
    expect(
      looksCorruptedDraft(
        '<parameter name="body">The post itself.</parameter>',
      ),
    ).toBe("tool-call XML leaked into body");
    expect(
      looksCorruptedDraft("<turn_state>drafting</turn_state>\nA post."),
    ).toBe("tool-call XML leaked into body");
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
    // A post that talks about tool calls / XML in general prose (no literal
    // `<tool_call…>`, `<invoke name=`, `<parameter name=`, `<turn_state>`).
    "Every AI product is a tool call away from feeling magical. Wire it right.",
    "The <div> tag is the workhorse of the web. Learn to love it.",
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
  test("normalizeSentenceFinalNumberBreaks repairs the split sentence-final number", () => {
    const body =
      "competing at anything before you turn\n" +
      "20. Here's what gaming taught me.";
    expect(normalizeSentenceFinalNumberBreaks(body)).toBe(
      "competing at anything before you turn 20.\n\n" +
        "Here's what gaming taught me.",
    );
  });

  // Live-observed (output-quality live audit, 2/2 refine runs): GLM breaks the
  // line before a RANGE's second number ("steps 3 through / 9. Activation…"),
  // leaving "9." at line start — which renders as a numbered-list item. The
  // previous line ends mid-phrase ("through", no punctuation) and the
  // continuation starts with an arbitrary capitalized word, so the net must
  // accept any sentence-cased continuation when the expecting-word guard holds.
  test("repairs a range's second number split onto its own line (steps 3 through / 9.)", () => {
    const body =
      "We didn't add tooltips. We deleted steps 3 through\n" +
      "9. Activation went from 31% to 58% in six weeks.";
    expect(normalizeSentenceFinalNumberBreaks(body)).toBe(
      "We didn't add tooltips. We deleted steps 3 through 9.\n\n" +
        "Activation went from 31% to 58% in six weeks.",
    );
  });

  test("repairs a sentence-ending number split onto a fake numbered-list line", () => {
    const body =
      "But they miss what actually happens when you spend 10,000 hours\n" +
      "competing at anything before you turn\n" +
      "20. Here's what gaming taught me that no business book ever did:";

    expect(normalizePostBody(body)).toBe(
      "But they miss what actually happens when you spend 10,000 hours\n" +
        "competing at anything before you turn 20.\n\n" +
        "Here's what gaming taught me that no business book ever did:",
    );
  });

  test("repairs a sentence-ending number before an arrow-led next point", () => {
    const body =
      "→ Generic openers that smell like ChatGPT.\n" +
      "→ \"Let's talk about...\" intros nobody finishes.\n" +
      "→ Lists of 7 things that could've been\n" +
      "2. → Hooks that hedge instead of punch.\n" +
      "→ Posts written for likes, not for buyers.";

    expect(normalizePostBody(body)).toBe(
      "→ Generic openers that smell like ChatGPT.\n" +
        "→ \"Let's talk about...\" intros nobody finishes.\n" +
        "→ Lists of 7 things that could've been 2.\n\n" +
        "→ Hooks that hedge instead of punch.\n" +
        "→ Posts written for likes, not for buyers.",
    );
  });

  test("does not rewrite a real numbered list item after a complete sentence", () => {
    const body =
      "The first lesson is simple.\n" +
      "2. Here's the second lesson.\n\n" +
      "Keep going.";

    expect(normalizePostBody(body)).toBe(body);
  });

  test("does not rewrite a real numbered list item after a colon intro", () => {
    const body =
      "Three things I learned:\n" +
      "1. The first one.\n" +
      "2. The second one.";

    expect(normalizePostBody(body)).toBe(body);
  });

  test("repairs a numbered listicle heading split across its own block", () => {
    const body =
      "1. The obvious tell.\n\n" +
      "Every line has one.\n\n" +
      "2.\n\n" +
      "The rule of three.\n\n" +
      "'Not faster.\n\n" +
      "Not cheaper.\n\n" +
      "Better.' If your post keeps grouping things in threes, the model picked that rhythm for you.";

    expect(normalizePostBody(body)).toBe(
      "1. The obvious tell.\n\n" +
        "Every line has one.\n\n" +
        "2. The rule of three.\n\n" +
        "'Not faster.\n\n" +
        "Not cheaper.\n\n" +
        "Better.' If your post keeps grouping things in threes, the model picked that rhythm for you.",
    );
  });

  test("repairs a later orphaned listicle heading without touching the body copy", () => {
    const body =
      "2. Keep the simple thing simple.\n\n" +
      "Complexity compounds faster than value.\n\n" +
      "3.\n\n" +
      "Remove, don't add.\n\n" +
      "The best code I ever wrote was code I deleted.\n\n" +
      "The best posts I ever wrote were the ones where I cut half the lines.";

    expect(normalizePostBody(body)).toBe(
      "2. Keep the simple thing simple.\n\n" +
        "Complexity compounds faster than value.\n\n" +
        "3. Remove, don't add.\n\n" +
        "The best code I ever wrote was code I deleted.\n\n" +
        "The best posts I ever wrote were the ones where I cut half the lines.",
    );
  });

  test("repairs a split first heading when the marker is glued to the intro", () => {
    const body =
      "Three AI writing tells I catch every day: 1.\n\n" +
      "Em dashes everywhere.\n\n" +
      "One dash turns into five.\n\n" +
      "2.\n\n" +
      "The rule of three.\n\n" +
      "Humans rarely think in tidy triads.";

    expect(normalizePostBody(body)).toBe(
      "Three AI writing tells I catch every day:\n" +
        "1. Em dashes everywhere.\n\n" +
        "One dash turns into five.\n\n" +
        "2. The rule of three.\n\n" +
        "Humans rarely think in tidy triads.",
    );
  });

  test("does not merge a bare numbered line into quoted body copy", () => {
    const body = "2.\n\n'Not faster.\n\nNot cheaper.\n\nBetter.'";
    expect(normalizeNumberedListicleHeadings(body)).toBe(body);
  });

  test("does not touch already-correct numbered headings", () => {
    const body = "2. The rule of three.\n\nReal writing mixes the counts.";
    expect(normalizePostBody(body)).toBe(body);
  });

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

  // Regression: a leaked listicle salvaged by the FORCED-FINAL round used to
  // ship RAW (that one salvage path skipped stripEmDashes + normalizePostBody),
  // so its "1." rendered split from its heading. This locks the contract that
  // running the body through the shared net repairs every item — number line +
  // heading joined, body below — which is what the salvage path now does.
  test("repairs a full multi-item listicle: every marker joins its heading", () => {
    const leakedBody =
      "AI slop comes from four layers being weak: 1.\n\n" +
      "The prompt.\n\n" +
      "Write a post about leadership.\n\n" +
      "2.\n\n" +
      "The voice.\n\n" +
      "If you don't teach the model how you talk, it defaults to LinkedIn.\n\n" +
      "3.\n\n" +
      "The edit.\n\n" +
      "The draft is the raw material, not the post.\n\n" +
      "4.\n\n" +
      "The opinion.\n\n" +
      "AI can't have one.";

    const out = normalizePostBody(leakedBody);
    // Each number is now glued to its heading on one line, body follows below.
    expect(out).toContain("1. The prompt.");
    expect(out).toContain("2. The voice.");
    expect(out).toContain("3. The edit.");
    expect(out).toContain("4. The opinion.");
    // And no orphaned bare-number line survives.
    expect(out).not.toMatch(/^\s*\d+\.\s*$/m);
  });
});

// ---------------------------------------------------------------------------
// extractArtifacts corruption gate (finding #22). The structured render_post
// path already rejects garbled bodies; the LEGACY fence extractor — used by the
// forced-final round + inline no-tool-calls path — did not, so a corrupt fenced
// body became a broken card. The gate now drops corrupt bodies here too.
// ---------------------------------------------------------------------------

describe("extractArtifacts — corruption gate on the legacy fence path", () => {
  test("a corrupt fenced post body is dropped (no artifact)", () => {
    const text =
      "Here's your post:\n\n```post\nI used to write like a spec sheet.}}ermalink Long paragraphs.\n```\n";
    expect(extractArtifacts(text)).toHaveLength(0);
  });

  test("a clean fenced post still produces an artifact", () => {
    const text =
      "```post\nMost cold outreach is dead.\n\nHere's what replaced it.\n```";
    const arts = extractArtifacts(text);
    expect(arts).toHaveLength(1);
    expect(arts[0].kind).toBe("post");
    expect(arts[0].body).toContain("cold outreach is dead");
  });

  test("normalizes split numbered headings in a clean fenced post", () => {
    const text = "```post\n1.\n\nThe rule of three.\n\nReal writing mixes the counts.\n```";
    const arts = extractArtifacts(text);
    expect(arts).toHaveLength(1);
    expect(arts[0].body).toBe(
      "1. The rule of three.\n\nReal writing mixes the counts.",
    );
  });

  test("in a mixed reply, the corrupt fence drops but the clean one survives", () => {
    const text =
      "```post\nA clean post line.\n\nWith a real second paragraph.\n```\n\n" +
      '```post\nGood start "permalink": "https://oops fused json\n```';
    const arts = extractArtifacts(text);
    expect(arts).toHaveLength(1);
    expect(arts[0].kind).toBe("post");
    expect(arts[0].body).toContain("A clean post line");
  });
});

// ---------------------------------------------------------------------------
// stripEmDashes — the deterministic em-dash net. The em dash is THE signature
// AI tell on LinkedIn and the prompt rule alone doesn't hold, so we strip them
// from every rendered draft body. Must read naturally and never lose content.
// ---------------------------------------------------------------------------

describe("stripEmDashes", () => {
  test("spaced em dash between clauses → comma", () => {
    expect(stripEmDashes("Distribution wins — every time.")).toBe(
      "Distribution wins, every time.",
    );
  });

  test("tight em dash welding two words → comma + space", () => {
    expect(stripEmDashes("offer—audience")).toBe("offer, audience");
    expect(stripEmDashes("offer —audience")).toBe("offer, audience");
    expect(stripEmDashes("offer— audience")).toBe("offer, audience");
  });

  test("multiple em dashes in one post are all removed", () => {
    const out = stripEmDashes("A — b — c — d.");
    expect(out).not.toContain("—");
    expect(out).toBe("A, b, c, d.");
  });

  test("em dash hugging terminal punctuation drops the dash, keeps the period", () => {
    expect(stripEmDashes("It works —. Really.")).toBe("It works. Really.");
    expect(stripEmDashes("Wait—. No.")).toBe("Wait. No.");
  });

  test("a leading em dash on a line is dropped", () => {
    expect(stripEmDashes("Hook line.\n— a dangling aside")).toBe(
      "Hook line.\na dangling aside",
    );
  });

  test("leaves en-dash number ranges alone (not the tell)", () => {
    expect(stripEmDashes("We grew 3–5x in a quarter.")).toBe("We grew 3–5x in a quarter.");
  });

  test("leaves hyphenated words alone", () => {
    expect(stripEmDashes("A long-term, well-known play.")).toBe(
      "A long-term, well-known play.",
    );
  });

  test("never produces a double comma", () => {
    expect(stripEmDashes("First, — then second.")).not.toMatch(/,\s*,/);
  });

  test("a clean post with no em dashes is unchanged", () => {
    const clean = "Most cold outreach is dead.\n\nHere's what replaced it.";
    expect(stripEmDashes(clean)).toBe(clean);
  });
});

describe("aiTellMetrics — log-only structural tells (not auto-rewritten)", () => {
  test("flags a rule-of-three comma cadence", () => {
    expect(aiTellMetrics("Numbers, timeframes, names.")).toContain("rule-of-three");
  });

  test("does NOT flag a normal Oxford list (a, b, and c)", () => {
    expect(aiTellMetrics("Numbers, timeframes, and names.")).not.toContain("rule-of-three");
  });

  test("flags a dismissive-negation fragment", () => {
    expect(aiTellMetrics("No fluff. Just the system.")).toContain("dismissive-negation");
    expect(aiTellMetrics("Not another listicle.")).toContain("dismissive-negation");
  });

  test("does NOT flag normal-speech 'No one knows…'", () => {
    expect(aiTellMetrics("No one knows what works anymore.")).not.toContain(
      "dismissive-negation",
    );
  });

  test("a clean post produces no tells", () => {
    expect(aiTellMetrics("A normal, human post about distribution and offers.")).toEqual([]);
  });
});

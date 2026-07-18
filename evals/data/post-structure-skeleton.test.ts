import { describe, expect, test } from "vitest";
import {
  checkStructureMatch,
  computeStructureSkeleton,
  renderStructureSkeletonReference,
  structureMismatchRepairInstruction,
} from "@/lib/post-structure-skeleton";

describe("computeStructureSkeleton", () => {
  test("empty input yields a zeroed skeleton, never throws", () => {
    const s = computeStructureSkeleton("");
    expect(s.totalChars).toBe(0);
    expect(s.hasList).toBe(false);
    expect(s.paragraphCount).toBe(0);
  });

  test("whitespace-only input yields a zeroed skeleton", () => {
    const s = computeStructureSkeleton("   \n\n  ");
    expect(s.totalChars).toBe(0);
  });

  test("counts paragraphs correctly", () => {
    const s = computeStructureSkeleton(
      "First paragraph here.\n\nSecond paragraph here.\n\nThird one closes it out.",
    );
    expect(s.paragraphCount).toBe(3);
  });

  test("detects a list and its dominant marker + item count", () => {
    const s = computeStructureSkeleton(
      "Here's what changed:\n→ faster onboarding\n→ better retention\n→ higher NPS\n\nThat's the whole story.",
    );
    expect(s.hasList).toBe(true);
    expect(s.listMarker).toEqual({ kind: "bullet", glyph: "→" });
    expect(s.listItemCount).toBe(3);
  });

  test("detects emoji-led source beats as a list instead of flattening them into prose", () => {
    const s = computeStructureSkeleton(
      "The moments I remember:\n🔹A reader sent a thoughtful note.\n🔹A teammate saw the work spread.\n🔹A quiet launch found the right people.\n\nThat was the real milestone.",
    );

    expect(s.hasList).toBe(true);
    expect(s.listMarker).toEqual({ kind: "emoji" });
    expect(s.listItemCount).toBe(3);
    expect(s.layout.map((beat) => beat.kind)).toEqual([
      "prose",
      "list",
      "prose",
    ]);
  });

  test("does not mistake a single decorative emoji opener for a list", () => {
    const s = computeStructureSkeleton(
      "🔹A milestone worth celebrating.\n\nThe rest of this post is ordinary prose.",
    );

    expect(s.hasList).toBe(false);
    expect(s.listItemCount).toBe(0);
    expect(s.layout.map((beat) => beat.kind)).toEqual(["prose"]);
  });

  test("does not group unrelated decorative emoji openers into a list", () => {
    const s = computeStructureSkeleton(
      "🎉 We launched the new workflow.\n\n💡 Here is what surprised me.\n\n🧭 This is where we are going next.",
    );

    expect(s.hasList).toBe(false);
    expect(s.layout.map((beat) => beat.kind)).toEqual(["prose"]);
  });

  test("does not group repeated decorative emoji across paragraph boundaries into a list", () => {
    const s = computeStructureSkeleton(
      "💡 First observation.\n\n💡 Second observation.",
    );

    expect(s.hasList).toBe(false);
    expect(s.layout.map((beat) => beat.kind)).toEqual(["prose"]);
  });

  test("recognizes a contiguous mixed-emoji block as one emoji-led list", () => {
    const s = computeStructureSkeleton(
      "The checklist:\n✅ Do this.\n⚠️ Avoid that.\n👩🏽‍💻 Ship the fix.\n\nThen verify it.",
    );

    expect(s.listMarker).toEqual({ kind: "emoji" });
    expect(s.listItemCount).toBe(3);
    expect(s.layout.map((beat) => beat.kind)).toEqual([
      "prose",
      "list",
      "prose",
    ]);
  });

  test("recognizes three repeated emoji-led item paragraphs as a spaced list", () => {
    const s = computeStructureSkeleton(
      "🔹 First item.\n\n🔹 Second item.\n\n🔹 Third item.",
    );

    expect(s.listMarker).toEqual({ kind: "emoji" });
    expect(s.listItemCount).toBe(3);
    expect(s.layout.map((beat) => beat.kind)).toEqual(["list"]);
  });

  test("recognizes repeated emoji markers by Unicode class rather than a marker whitelist", () => {
    for (const source of [
      "✅Check the hook.\n✅Check the proof.\n✅Check the close.",
      "🧭 Pick a direction.\n🧭 Remove distractions.\n🧭 Keep publishing.",
    ]) {
      const s = computeStructureSkeleton(source);
      expect(s).toMatchObject({
        hasList: true,
        listMarker: { kind: "emoji" },
        listItemCount: 3,
      });
    }
  });

  test("recognizes Unicode keycap graphemes without treating plain digits as emoji", () => {
    const keycaps = computeStructureSkeleton(
      "1️⃣ First step.\n2️⃣ Second step.\n3️⃣ Third step.",
    );
    const plainDigits = computeStructureSkeleton(
      "1 First statement.\n2 Second statement.\n3 Third statement.",
    );

    expect(keycaps.listMarker).toEqual({ kind: "emoji" });
    expect(keycaps.listItemCount).toBe(3);
    expect(plainDigits.hasList).toBe(false);
  });

  test("no list present", () => {
    const s = computeStructureSkeleton("Just a plain post with no list at all in it.");
    expect(s.hasList).toBe(false);
    expect(s.listMarker).toBeNull();
    expect(s.listItemCount).toBe(0);
  });

  test("normalizes numbered list markers to an ordered marker kind", () => {
    const s = computeStructureSkeleton("Steps:\n1. do this\n2. do that\n3. done");
    expect(s.listMarker).toEqual({ kind: "ordered" });
    expect(s.listItemCount).toBe(3);
  });

  test("measures hook length via the existing hook heuristic", () => {
    const s = computeStructureSkeleton(
      "Most founders get this wrong.\n\nThey think growth is about more leads.",
    );
    expect(s.hookChars).toBeGreaterThan(0);
  });

  test("measures total length in chars and words", () => {
    const s = computeStructureSkeleton("one two three four five");
    expect(s.totalWords).toBe(5);
    expect(s.totalChars).toBe(23);
  });
});

describe("renderStructureSkeletonReference", () => {
  test("empty skeleton renders an empty block", () => {
    const s = computeStructureSkeleton("");
    expect(renderStructureSkeletonReference(s)).toBe("");
  });

  test("renders soft, non-prescriptive language — never a hard word count", () => {
    const s = computeStructureSkeleton(
      "A punchy hook line.\n\nSome body text explaining the idea in more depth here.",
    );
    const ref = renderStructureSkeletonReference(s);
    expect(ref).toContain("SOURCE STRUCTURE REFERENCE");
    expect(ref.toLowerCase()).toContain("reference point");
    expect(ref.toLowerCase()).toContain("not a limit");
    expect(ref.toLowerCase()).toContain("deviate freely");
    expect(ref).toContain("Never drop, add, or reorder a beat");
  });

  test("includes the list marker + item count guidance when the source has a list", () => {
    const s = computeStructureSkeleton(
      "The plan:\n→ ship it\n→ measure it\n→ iterate\n\nThat's it.",
    );
    const ref = renderStructureSkeletonReference(s);
    expect(ref).toContain('"→"');
    expect(ref).toContain("3 items");
    expect(ref.toLowerCase()).toContain("can flex");
  });

  test("describes normalized emoji markers as an emoji-led list", () => {
    const s = computeStructureSkeleton(
      "🔹Write the hook.\n🔹Build the argument.\n🔹Land the close.",
    );
    const ref = renderStructureSkeletonReference(s);

    expect(ref).toContain("emoji-led list");
    expect(ref).not.toContain('"emoji" list');
  });

  test("omits list guidance entirely when the source has no list", () => {
    const s = computeStructureSkeleton("Just prose here, nothing more, no list to speak of.");
    const ref = renderStructureSkeletonReference(s);
    expect(ref).not.toContain("List:");
  });
});

describe("checkStructureMatch", () => {
  const sourceWithList = computeStructureSkeleton(
    "Here's what changed:\n→ faster onboarding\n→ better retention\n→ higher NPS\n\nThat's the whole story, worth roughly a hundred words to make the length ratio checks behave predictably across every test in this block for consistency.",
  );

  test("passes when the draft keeps the source's list marker and reasonable length", () => {
    const draft = computeStructureSkeleton(
      "Here's what changed for us:\n→ shorter onboarding\n→ stronger retention\n→ improved satisfaction\n\nThat's the whole story, worth roughly a hundred words to make the length ratio checks behave predictably across every test in this block for consistency and balance.",
    );
    expect(checkStructureMatch(sourceWithList, draft)).toBeNull();
  });

  test("flags a missing list when the source has one and the draft doesn't", () => {
    const draft = computeStructureSkeleton(
      "Just a plain prose draft with absolutely no list markers anywhere, roughly matching the source's length so the length check alone would pass, isolating the missing-list signal on its own for this test to verify cleanly.",
    );
    const mismatch = checkStructureMatch(sourceWithList, draft);
    expect(mismatch?.code).toBe("missing_list");
  });

  test("flags a wrong list marker", () => {
    const draft = computeStructureSkeleton(
      "Here's what changed for us:\n- shorter onboarding\n- stronger retention\n- improved satisfaction\n\nThat's the whole story, worth roughly a hundred words to make the length ratio checks behave predictably across every test in this block for consistency and balance.",
    );
    const mismatch = checkStructureMatch(sourceWithList, draft);
    expect(mismatch?.code).toBe("wrong_list_marker");
  });

  test("treats different emoji glyphs as the same marker style", () => {
    const source = computeStructureSkeleton(
      "The source checklist:\n🔹 Keep the hook clear.\n🔹 Support the argument.\n🔹 Land the close with care.",
    );
    const draft = computeStructureSkeleton(
      "The adapted checklist:\n✅ Make the opener useful.\n⚠️ Remove unsupported claims.\n🚀 Publish only after verification.",
    );

    expect(checkStructureMatch(source, draft)).toBeNull();
  });

  test("compares marker style for every list beat, not only the dominant list", () => {
    const source = computeStructureSkeleton(
      "Start here.\n→ First arrow item.\n→ Second arrow item.\n\nNow the steps:\n1. First numbered item.\n2. Second numbered item.",
    );
    const draft = computeStructureSkeleton(
      "Start here.\n→ First adapted item.\n→ Second adapted item.\n\nNow the next block:\n→ Another adapted item.\n→ Final adapted item.",
    );

    expect(checkStructureMatch(source, draft)?.code).toBe(
      "wrong_list_marker",
    );
  });

  test("flags a list that moves to a different structural position", () => {
    const source = computeStructureSkeleton(
      "A sharp opening makes people stop.\n\n→ name the tension\n→ show the cost\n\nThen land the practical takeaway with a direct close.",
    );
    const draft = computeStructureSkeleton(
      "A sharp opening makes people stop.\n\nThen land the practical takeaway with a direct close.\n\n→ name the tension\n→ show the cost",
    );

    expect(checkStructureMatch(source, draft)?.code).toBe("layout_order");
  });

  test("flags a draft that collapses a multi-paragraph source into a different visual density", () => {
    const source = computeStructureSkeleton(
      Array.from({ length: 6 }, (_, index) =>
        `Paragraph ${index + 1} ${"word ".repeat(22)}`,
      ).join("\n\n"),
    );
    const draft = computeStructureSkeleton(
      Array.from({ length: 2 }, (_, index) =>
        `Paragraph ${index + 1} ${"word ".repeat(66)}`,
      ).join("\n\n"),
    );

    expect(checkStructureMatch(source, draft)?.code).toBe(
      "visual_line_density",
    );
  });

  test("does NOT flag a source with no list when the draft also has none", () => {
    const source = computeStructureSkeleton(
      "Just prose in the source, no list here at all, roughly a hundred words long to keep the length ratio inside the acceptable band for this particular test case.",
    );
    const draft = computeStructureSkeleton(
      "Just prose in the draft too, no list here either, roughly a hundred words long to keep the length ratio inside the acceptable band for this particular test case as well.",
    );
    expect(checkStructureMatch(source, draft)).toBeNull();
  });

  test("does NOT flag a moderate length difference within the accepted band", () => {
    const source = computeStructureSkeleton("word ".repeat(100).trim());
    const longerDraft = computeStructureSkeleton("word ".repeat(150).trim()); // 1.5x
    const shorterDraft = computeStructureSkeleton("word ".repeat(65).trim()); // 0.65x
    expect(checkStructureMatch(source, longerDraft)).toBeNull();
    expect(checkStructureMatch(source, shorterDraft)).toBeNull();
  });

  test("flags a draft far shorter than the source", () => {
    const source = computeStructureSkeleton("word ".repeat(100).trim());
    const draft = computeStructureSkeleton("word ".repeat(20).trim()); // 0.2x
    const mismatch = checkStructureMatch(source, draft);
    expect(mismatch?.code).toBe("too_short");
  });

  test("flags a draft far longer than the source", () => {
    const source = computeStructureSkeleton("word ".repeat(100).trim());
    const draft = computeStructureSkeleton("word ".repeat(300).trim()); // 3x
    const mismatch = checkStructureMatch(source, draft);
    expect(mismatch?.code).toBe("too_long");
  });

  test("returns only the FIRST mismatch found (list check wins over length)", () => {
    const source = sourceWithList;
    const draft = computeStructureSkeleton("word ".repeat(5).trim()); // no list AND too short
    const mismatch = checkStructureMatch(source, draft);
    expect(mismatch?.code).toBe("missing_list");
  });

  test("skips the length-ratio check entirely for a short source (a ratio isn't meaningful below ~120 chars)", () => {
    // A one-line hook as the source: a normal-length draft is a 6x+ ratio,
    // which would trip "too_long" if the ratio check applied — but a source
    // this short has no meaningful "length" to hold the draft to.
    const shortSource = computeStructureSkeleton("Most founders get this wrong.");
    const normalDraft = computeStructureSkeleton(
      "Most founders think growth is about more leads. It isn't. Fix the leaks in what you already have before you pour in more water at the top.",
    );
    expect(checkStructureMatch(shortSource, normalDraft)).toBeNull();
  });

  test("still applies the length-ratio check once the source crosses the short-source floor", () => {
    const borderlineSource = computeStructureSkeleton("word ".repeat(25).trim()); // ~125 chars
    const tinyDraft = computeStructureSkeleton("word ".repeat(2).trim()); // far below 0.6x
    const mismatch = checkStructureMatch(borderlineSource, tinyDraft);
    expect(mismatch?.code).toBe("too_short");
  });
});

describe("structureMismatchRepairInstruction", () => {
  test("produces a distinct, actionable instruction per mismatch code", () => {
    const codes = [
      "missing_list",
      "wrong_list_marker",
      "layout_order",
      "visual_line_density",
      "too_short",
      "too_long",
    ] as const;
    const instructions = codes.map((code) =>
      structureMismatchRepairInstruction({ code, message: "irrelevant for this check" }),
    );
    // All distinct.
    expect(new Set(instructions).size).toBe(codes.length);
    // All non-empty and reasonably specific.
    for (const instruction of instructions) {
      expect(instruction.length).toBeGreaterThan(20);
    }
  });
});

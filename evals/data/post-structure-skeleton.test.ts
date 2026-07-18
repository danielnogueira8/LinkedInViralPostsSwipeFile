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
    expect(s.listMarker).toBe("→");
    expect(s.listItemCount).toBe(3);
  });

  test("no list present", () => {
    const s = computeStructureSkeleton("Just a plain post with no list at all in it.");
    expect(s.hasList).toBe(false);
    expect(s.listMarker).toBeNull();
    expect(s.listItemCount).toBe(0);
  });

  test("normalizes numbered list markers to '1.'", () => {
    const s = computeStructureSkeleton("Steps:\n1. do this\n2. do that\n3. done");
    expect(s.listMarker).toBe("1.");
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
});

describe("structureMismatchRepairInstruction", () => {
  test("produces a distinct, actionable instruction per mismatch code", () => {
    const codes = ["missing_list", "wrong_list_marker", "too_short", "too_long"] as const;
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

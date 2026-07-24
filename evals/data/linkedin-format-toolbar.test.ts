import { describe, expect, test } from "vitest";
import {
  clearFormatting,
  toggleStrikethrough,
  toggleStyle,
  toggleBulletList,
  toggleNumberedList,
  SPECIAL_CHARS,
  LINKEDIN_MAX_CHARS,
  LINKEDIN_WARN_CHARS,
} from "@/lib/linkedin-format";

// ---------------------------------------------------------------------------
// The formatting primitives behind the Cowork draft toolbar. LinkedIn stores
// plain Unicode, so every "format" here is a real character transform — which
// makes all of it pure and exactly testable, with no DOM.
// ---------------------------------------------------------------------------

const STRIKE = "\u0336";

describe("toggleStrikethrough", () => {
  test("marks every visible character, and round-trips back to the original", () => {
    const struck = toggleStrikethrough("ship it");
    // one combining mark per visible (non-space) character
    expect(struck).toBe(`s${STRIKE}h${STRIKE}i${STRIKE}p${STRIKE} i${STRIKE}t${STRIKE}`);
    expect(toggleStrikethrough(struck)).toBe("ship it");
  });

  test("never marks whitespace (a struck space renders as a floating dash)", () => {
    const struck = toggleStrikethrough("a b");
    expect(struck.includes(` ${STRIKE}`)).toBe(false);
    // newlines survive untouched, so a multi-line selection keeps its shape
    expect(toggleStrikethrough("a\nb")).toBe(`a${STRIKE}\nb${STRIKE}`);
  });

  test("composes with bold rather than fighting it", () => {
    // Bold first, then strike: the mark attaches to the styled glyph, and
    // un-striking must return the still-bold text (not plain ascii).
    const bold = toggleStyle("hi", "bold");
    const both = toggleStrikethrough(bold);
    expect(both).not.toBe(bold);
    expect(toggleStrikethrough(both)).toBe(bold);
  });

  test("an empty selection is a no-op", () => {
    expect(toggleStrikethrough("")).toBe("");
  });
});

describe("clearFormatting", () => {
  test("strips bold, italic and strikethrough back to plain ascii", () => {
    const messy = toggleStrikethrough(toggleStyle(toggleStyle("Hello", "bold"), "italic"));
    expect(clearFormatting(messy)).toBe("Hello");
  });

  test("removes bullet and numbered list prefixes", () => {
    expect(clearFormatting(toggleBulletList("one\ntwo"))).toBe("one\ntwo");
    expect(clearFormatting(toggleNumberedList("one\ntwo"))).toBe("one\ntwo");
  });

  test("leaves already-plain text and blank lines alone", () => {
    expect(clearFormatting("plain text")).toBe("plain text");
    expect(clearFormatting("a\n\nb")).toBe("a\n\nb");
    expect(clearFormatting("")).toBe("");
  });

  test("clears a body that mixes styling AND list prefixes in one pass", () => {
    // The realistic mess: a bolded bullet list. Clearing must handle both
    // layers, which is the whole reason the escape hatch exists.
    const bulleted = toggleBulletList("alpha\nbeta");
    const styled = bulleted
      .split("\n")
      .map((line) => toggleStyle(line, "bold"))
      .join("\n");
    expect(clearFormatting(styled)).toBe("alpha\nbeta");
  });
});

describe("toolbar constants", () => {
  test("special characters are the LinkedIn-native glyphs, as literal chars", () => {
    expect(SPECIAL_CHARS.map((s) => s.char)).toEqual(["→", "•", "↳", "☑"]);
    // Every entry needs a label — the toolbar renders them as tooltips.
    expect(SPECIAL_CHARS.every((s) => s.label.trim().length > 0)).toBe(true);
  });

  test("the warn threshold sits below the hard cap", () => {
    expect(LINKEDIN_WARN_CHARS).toBeLessThan(LINKEDIN_MAX_CHARS);
    expect(LINKEDIN_WARN_CHARS).toBe(2700);
  });
});

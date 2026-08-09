import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { establishesFixedContainingBlock } from "@/lib/textarea-caret";

// ---------------------------------------------------------------------------
// Why this rule exists.
//
// The selection toolbar ("Ask AI", bold, lists) is positioned with `fixed` and
// viewport coordinates. That only works while no ancestor captures fixed
// positioning — and the draft editor renders inside a Dialog whose content
// carries translate utilities. The dialog is a right-aligned drawer, so the
// toolbar was drawn hundreds of pixels right of the highlighted word.
//
// The suite is Node-only by design, so the DOM WALK cannot run here. The
// DECISION it makes is pure, and that is the part that was wrong.
// ---------------------------------------------------------------------------

describe("what captures fixed positioning", () => {
  it("treats an identity translate as capturing", () => {
    // THE case that shipped. Tailwind's `translate-x-0` still emits a
    // translate, so an element that moves nothing visually still captures
    // fixed descendants. Reading the class list would suggest otherwise.
    //
    // "0px" is the value CHROMIUM ACTUALLY RETURNS for `translate: 0px 0px` —
    // measured, not assumed. Pinning only the two-value form would let a
    // predicate that misses the collapsed one pass this suite while leaving
    // the real bug in place.
    expect(establishesFixedContainingBlock({ translate: "0px" })).toBe(true);
    expect(establishesFixedContainingBlock({ translate: "0px 0px" })).toBe(true);
  });

  it("treats an identity transform matrix as capturing", () => {
    // What getComputedStyle actually returns for a translate utility in the
    // transform property — never the literal "translateX(0)" from the source.
    expect(
      establishesFixedContainingBlock({ transform: "matrix(1, 0, 0, 1, 0, 0)" }),
    ).toBe(true);
  });

  it("recognises the other capturing properties", () => {
    expect(establishesFixedContainingBlock({ filter: "blur(2px)" })).toBe(true);
    expect(establishesFixedContainingBlock({ backdropFilter: "blur(4px)" })).toBe(true);
    expect(establishesFixedContainingBlock({ perspective: "800px" })).toBe(true);
    expect(establishesFixedContainingBlock({ rotate: "45deg" })).toBe(true);
    expect(establishesFixedContainingBlock({ scale: "1.5" })).toBe(true);
    expect(establishesFixedContainingBlock({ contain: "paint" })).toBe(true);
    expect(establishesFixedContainingBlock({ willChange: "transform" })).toBe(true);
  });

  it("does not fire on an ordinary element", () => {
    // A false positive is not harmless: it would subtract that element's
    // offset and push the toolbar off in the other direction.
    expect(
      establishesFixedContainingBlock({
        transform: "none",
        translate: "none",
        rotate: "none",
        scale: "none",
        filter: "none",
        backdropFilter: "none",
        perspective: "none",
        contain: "none",
        willChange: "auto",
      }),
    ).toBe(false);
    expect(establishesFixedContainingBlock({})).toBe(false);
  });

  it("ignores containment and will-change values that do not capture", () => {
    expect(establishesFixedContainingBlock({ contain: "size" })).toBe(false);
    expect(establishesFixedContainingBlock({ willChange: "opacity" })).toBe(false);
    expect(establishesFixedContainingBlock({ willChange: "scroll-position" })).toBe(false);
  });
});

describe("the anchor subtracts that origin", () => {
  const SOURCE = readFileSync(
    path.join(process.cwd(), "lib/textarea-caret.ts"),
    "utf8",
  );

  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  }

  it("applies the offset to both axes", () => {
    // Horizontal was the visible bug because the drawer is right-aligned; the
    // vertical term is just as necessary for a dialog that is not full-height.
    const body = code(SOURCE);
    expect(body).toContain("rect.top + a.top - origin.top");
    expect(body).toContain("rect.left + left - origin.left");
  });

  it("degrades to today's behaviour when nothing captures", () => {
    // The walk returning {0,0} must leave the coordinates untouched, so an
    // editor outside a dialog is unaffected by any of this.
    expect(code(SOURCE)).toContain("return { top: 0, left: 0 };");
  });
});

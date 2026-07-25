import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// The attached image in a Cowork draft rendered oversized AND broke out
// horizontally past the card's rounded border.
//
// The overflow was not a sizing oversight — it's the classic flexbox trap: a
// flex item defaults to `min-width: auto`, meaning "never shrink below my
// content". A wide image therefore widens its whole column past the card
// instead of being constrained by it. `min-w-0` is what opts out of that, and
// it has to be present on every flex ancestor between the image and the card.
//
// Source-level assertions because the eval suite is Node-only (no JSDOM), so
// rendered geometry can't be measured here.
// ---------------------------------------------------------------------------

const source = readFileSync("app/(app)/dashboard/chat-workspace.tsx", "utf8");

describe("draft image is bounded inside the card", () => {
  test("the media preview is width-capped and centred", () => {
    // A draft is a writing surface: the image is a reference thumbnail, not the
    // main event.
    expect(source).toContain("max-w-[320px]");
    expect(source).toMatch(/mx-auto[^"]*max-w-\[320px\]/);
  });

  test("the image preserves aspect ratio and is height-capped", () => {
    expect(source).toContain("max-h-56 w-full object-contain");
  });

  test("media renders INSIDE the editor's scroll box, not beside it", () => {
    // As a sibling the image took its own space in the column and squeezed the
    // text box. In the editor's footer the text keeps its full height and the
    // image is simply further down the same scrolling card.
    expect(source).toMatch(/footer=\{\s*<DraftMediaPreview/);
  });

  test("every flex ancestor of the image can shrink (min-w-0)", () => {
    // The card root...
    expect(source).toMatch(
      /flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden rounded-xl/,
    );
    // ...and the editor column that holds the preview.
    expect(source).toMatch(/flex min-h-0 w-full min-w-0 flex-1 flex-col gap-2/);
  });

  test("the card clips its own children, so nothing escapes the rounded border", () => {
    expect(source).toMatch(/overflow-hidden rounded-xl border border-border bg-white/);
  });
});

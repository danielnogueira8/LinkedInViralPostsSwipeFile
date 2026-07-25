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
const editorSource = readFileSync("app/(app)/dashboard/draft-editor.tsx", "utf8");

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
      /flex w-full min-w-0 flex-col overflow-hidden/,
    );
    // ...and the editor column that holds the preview.
    expect(source).toMatch(/flex w-full min-w-0 flex-col gap-2/);
  });

  test("the fill/height behaviour is desktop-only so mobile scrolls the whole card", () => {
    // On desktop (lg+) the card and its editor column flex to fill the panel and
    // scroll internally. Below lg they are content-sized and the mobile bottom
    // sheet scrolls the whole card — otherwise appended blocks (e.g. the
    // lead-magnet resource card) get squeezed into a short, overflow-hidden
    // column and spill over the pinned toolbar/heading.
    expect(source).toMatch(
      /overflow-hidden bg-card[^"]*lg:min-h-0 lg:flex-1/,
    );
    expect(source).toMatch(/flex w-full min-w-0 flex-col gap-2 px-3 py-2\.5[^"]*lg:min-h-0 lg:flex-1/);
  });

  test("the mobile bottom sheet can actually scroll the whole card (no scroll-lock)", () => {
    // The card is overflow-hidden, which makes its automatic flex min-height 0 —
    // so below lg it would be shrunk to fit the sheet and clipped with nothing
    // to scroll. max-lg:shrink-0 keeps it at full content height so the sheet
    // body's overflow-y-auto scrolls it.
    expect(source).toMatch(/overflow-hidden bg-card[^"]*max-lg:shrink-0/);
    // The sheet body is the single bounded scroll container on mobile.
    expect(source).toMatch(/flex-1 min-h-0 overflow-y-auto p-3\.5 flex flex-col gap-3/);
    expect(source).toMatch(/\{artifactsList\}/);
    // The editor box must not be a second, touch-capturing scroll container
    // below lg — it only owns the scroll on desktop.
    expect(editorSource).toMatch(/footer \? "lg:overflow-y-auto" : ""/);
    expect(editorSource).not.toMatch(/footer \? "overflow-y-auto" : ""/);
  });

  test("the card clips its own children, so a wide image can't escape it", () => {
    // overflow-hidden is the load-bearing part. The border/radius that used to
    // be asserted here is gone on desktop by design — the panel is the surface
    // (see draft-panel-flat.test.ts) — but the clipping must remain.
    expect(source).toMatch(/flex w-full min-w-0 flex-col overflow-hidden bg-card/);
  });
});

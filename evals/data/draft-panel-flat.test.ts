import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// The Cowork draft panel is ONE surface on desktop: the panel is the card, so
// the card must not draw a border/radius/shadow around the thing it fills.
//
// This is pinned because it has already regressed once. #1496 flattened it;
// concurrent mobile fixes (#1491/#1492/#1495) touching the same element
// restored the card styling, and nothing caught it — the panel silently went
// back to three nested outlines.
//
// The rule: SQUARE when docked (desktop panel), ROUNDED when floating (the
// mobile bottom sheet, which sits over a dimmed backdrop and genuinely is a
// separate object).
// ---------------------------------------------------------------------------

const workspace = readFileSync("app/(app)/dashboard/chat-workspace.tsx", "utf8");
const editor = readFileSync("app/(app)/dashboard/draft-editor.tsx", "utf8");

const cardRoot =
  workspace.match(/<div className="flex w-full min-w-0 flex-col overflow-hidden[^"]*"/)?.[0] ?? "";

describe("desktop: the draft card is flush with the panel", () => {
  test("the card root was found (guards this test against silent drift)", () => {
    expect(cardRoot).not.toBe("");
  });

  test("no unconditional border, radius or shadow on the card", () => {
    // Unprefixed = applies at every width, including desktop.
    expect(cardRoot).not.toMatch(/(^|\s)rounded-/);
    expect(cardRoot).not.toMatch(/(^|\s)border(\s|")/);
    expect(cardRoot).not.toMatch(/(^|\s)shadow-/);
  });

  test("the panel itself is white, not tinted", () => {
    // A grey panel behind a white card is the nesting this removed.
    expect(workspace).toMatch(
      /relative hidden lg:flex shrink-0 flex-col border-l border-border bg-card/,
    );
  });
});

describe("mobile: the sheet still reads as a floating object", () => {
  test("the card keeps rounded + border below lg", () => {
    expect(cardRoot).toMatch(/max-lg:rounded-xl/);
    expect(cardRoot).toMatch(/max-lg:border/);
  });

  test("the bottom sheet keeps its top radius", () => {
    // It slides over a dimmed backdrop — genuinely detached, so radius is right.
    expect(workspace).toMatch(/rounded-t-\[1\.35rem\]/);
  });
});

describe("the editor box only draws its own edge when it needs one", () => {
  test("flush inside the Cowork full-toolbar layout on desktop", () => {
    expect(editor).toMatch(/toolbar === "full"[\s\S]{0,80}max-lg:rounded-lg/);
  });

  test("the Posts-board editor keeps its border — it does float", () => {
    expect(editor).toMatch(/: "rounded-lg border border-border"/);
  });
});

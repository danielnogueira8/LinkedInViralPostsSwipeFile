import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// The "Describe changes" prompt only closed on Escape, so clicking away left it
// stranded over the draft — the usual way people abandon a popover.
//
// Source-level assertions: the eval suite is Node-only (no JSDOM), so a real
// click can't be simulated here. These pin the mechanism instead, because the
// details below are each load-bearing and easy to undo by accident.
// ---------------------------------------------------------------------------

const src = readFileSync("app/(app)/dashboard/draft-editor.tsx", "utf8");
const askPrompt = src.slice(src.indexOf("function AskPrompt("));

describe("the Ask-AI prompt dismisses on an outside click", () => {
  test("it listens for document mousedown and closes", () => {
    expect(askPrompt).toMatch(/document\.addEventListener\("mousedown"/);
    expect(askPrompt).toMatch(/boxRef\.current\?\.contains\(e\.target as Node\)/);
  });

  test("the listener is removed on unmount", () => {
    // A leaked document listener would keep calling onClose against a dead
    // component every time the user clicks anywhere in the app.
    expect(askPrompt).toMatch(/removeEventListener\("mousedown"/);
  });

  test("Escape still works — the new path is additive", () => {
    expect(askPrompt).toMatch(/e\.key === "Escape"/);
    expect(askPrompt).toMatch(/removeEventListener\("keydown"/);
  });
});

describe("clicking INSIDE the prompt must not dismiss it", () => {
  test("the box stops mousedown propagation and is the ref'd element", () => {
    // This guard predates the change and is what makes a mousedown listener
    // safe: without it, clicking the input or the submit button would close the
    // prompt before the click landed.
    expect(askPrompt).toMatch(/ref=\{boxRef\}/);
    expect(askPrompt).toMatch(/onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}/);
  });
});

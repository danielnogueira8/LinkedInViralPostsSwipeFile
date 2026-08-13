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
  // The mechanism moved into the shared useDismissOnOutside hook, because the
  // emoji picker had a near-identical copy and BOTH closed themselves on the
  // mousedown that opened them. The behaviour these tests were written to
  // protect is unchanged; it is now implemented once.
  //
  // The hook's own invariants — deferred registration, frame cancellation,
  // capture-phase Escape — live in editor-popover-dismiss.test.ts.
  test("it delegates dismissal to the shared hook", () => {
    expect(askPrompt).toMatch(/useDismissOnOutside\(boxRef, onClose\)/);
  });

  test("it does not re-roll its own document listener", () => {
    // A second copy is how the emoji picker and this prompt drifted into the
    // same bug independently.
    const untilRender = askPrompt.slice(0, askPrompt.indexOf("const submit"));
    expect(untilRender).not.toMatch(/document\.addEventListener\("mousedown"/);
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

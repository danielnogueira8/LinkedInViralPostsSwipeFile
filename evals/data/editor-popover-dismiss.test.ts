import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The emoji picker and the Ask AI prompt closed themselves the instant they
// opened, so both buttons looked dead.
//
// Every control that opens one fires on MOUSEDOWN, not click — ToolbarButton
// and the floating toolbar both preventDefault on mousedown so the textarea
// keeps its selection. The popover therefore mounts while that mousedown is
// still being dispatched; a close-on-outside-mousedown listener registered
// synchronously then receives THAT SAME EVENT as it finishes bubbling to
// document, sees a target outside the popover, and closes it.
//
// Confirmed in Chromium: a document listener added during a descendant's
// mousedown does receive that event (target = the opener button). Deferring
// registration by one frame fixes it and still dismisses on a genuine outside
// click.
//
// The suite is Node-only, so these pin the source-level decisions that made it
// happen — a synchronous registration, and two hand-rolled copies that could
// drift.
// ---------------------------------------------------------------------------

const EDITOR = readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/draft-editor.tsx"),
  "utf8",
);

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
}

describe("popovers survive the event that opened them", () => {
  it("defers the outside-mousedown listener by a frame", () => {
    const body = code(EDITOR);
    const hook = body.slice(
      body.indexOf("function useDismissOnOutside"),
      body.indexOf("function EmojiPicker"),
    );
    expect(hook).toContain("requestAnimationFrame(() => {");
    // The registration must be INSIDE the frame callback. Bound directly, it
    // catches the opening mousedown and the popover never survives its own
    // opening click.
    const frameStart = hook.indexOf("requestAnimationFrame");
    expect(hook.indexOf('addEventListener("mousedown"')).toBeGreaterThan(frameStart);
  });

  it("cancels that frame on unmount", () => {
    // A popover closed within the same frame would otherwise register a
    // listener that outlives it and closes nothing, forever.
    const body = code(EDITOR);
    const hook = body.slice(
      body.indexOf("function useDismissOnOutside"),
      body.indexOf("function EmojiPicker"),
    );
    expect(hook).toContain("cancelAnimationFrame(frame)");
    expect(hook).toContain('removeEventListener("mousedown", onDown)');
  });

  it("keeps Escape on the capture phase", () => {
    // Bubble-phase Escape closes the popover AND the whole editor dialog on one
    // keypress — Base UI's own dismiss listens on document and ignores
    // defaultPrevented.
    const body = code(EDITOR);
    const hook = body.slice(
      body.indexOf("function useDismissOnOutside"),
      body.indexOf("function EmojiPicker"),
    );
    expect(hook).toContain("e.stopPropagation()");
    expect(hook).toContain('addEventListener("keydown", onKey, true)');
  });

  it("binds Escape immediately, not behind the frame", () => {
    // Only the MOUSEDOWN registration races its own opening event; delaying
    // Escape would leave a window where the key does nothing.
    const body = code(EDITOR);
    const hook = body.slice(
      body.indexOf("function useDismissOnOutside"),
      body.indexOf("function EmojiPicker"),
    );
    expect(hook.indexOf('addEventListener("keydown"')).toBeLessThan(
      hook.indexOf("requestAnimationFrame"),
    );
  });
});

describe("one implementation, not two", () => {
  it("both popovers use the shared hook", () => {
    // They had near-identical hand-rolled copies. Fixing one and not the other
    // is exactly how half this bug would have survived.
    const body = code(EDITOR);
    const emoji = body.slice(
      body.indexOf("function EmojiPicker"),
      body.indexOf("EMOJI_GROUPS.map"),
    );
    expect(emoji).toContain("useDismissOnOutside(ref, onClose)");
    const ask = body.slice(
      body.indexOf("function AskPrompt"),
      body.indexOf("const submit = () => {"),
    );
    expect(ask).toContain("useDismissOnOutside(boxRef, onClose)");
  });

  it("neither registers its own outside-mousedown listener", () => {
    const body = code(EDITOR);
    const registrations = body.match(/addEventListener\("mousedown"/g) ?? [];
    // Exactly one, inside the hook.
    expect(registrations).toHaveLength(1);
  });
});

describe("the openers still fire on mousedown", () => {
  it("keeps preventDefault so the selection survives", () => {
    // This is WHY the race exists, and it is not the thing to change: a plain
    // onClick blurs the textarea first, collapsing the selection that Ask AI
    // and the emoji insert both depend on.
    const body = code(EDITOR);
    const toolbarButton = body.slice(
      body.indexOf("function ToolbarButton"),
      body.indexOf("function ToolbarDivider"),
    );
    expect(toolbarButton).toContain("onMouseDown={(e) => {");
    expect(toolbarButton).toContain("e.preventDefault();");
  });
});

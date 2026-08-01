import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const editor = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/draft-editor.tsx"),
  "utf8",
);
const modal = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/draft-editor-modal.tsx"),
  "utf8",
);

describe("new Posts draft paste title wiring", () => {
  test("reports pasted text without preventing the browser's normal text paste", () => {
    const pasteStart = editor.indexOf('onPaste={(event) => {');
    const imagePasteStart = editor.indexOf(
      "if (event.defaultPrevented || !allowImagePaste || !onMediaFiles) return;",
      pasteStart,
    );
    expect(pasteStart).toBeGreaterThan(-1);
    expect(imagePasteStart).toBeGreaterThan(pasteStart);
    expect(editor.slice(pasteStart, imagePasteStart)).toContain(
      'event.clipboardData.getData("text/plain")',
    );
    expect(editor.slice(pasteStart, imagePasteStart)).toContain(
      "onTextPaste?.(pastedText)",
    );
    expect(editor.slice(pasteStart, imagePasteStart)).not.toContain(
      "event.preventDefault()",
    );
  });

  test("derives the title only through the new-draft paste policy", () => {
    const callbackStart = modal.indexOf("onTextPaste={(pastedText) => {");
    const callbackEnd = modal.indexOf("onMediaFiles={addMediaFiles}", callbackStart);
    expect(callbackStart).toBeGreaterThan(-1);
    expect(callbackEnd).toBeGreaterThan(callbackStart);
    const callback = modal.slice(callbackStart, callbackEnd);
    expect(callback).toContain("titleFromNewDraftPaste({");
    expect(callback).toContain("isNew,");
    expect(callback).toContain("currentTitle: titleDraft");
    expect(callback).toContain("currentBody: body");
    expect(callback).toContain("if (nextTitle) setTitleDraft(nextTitle)");
  });
});

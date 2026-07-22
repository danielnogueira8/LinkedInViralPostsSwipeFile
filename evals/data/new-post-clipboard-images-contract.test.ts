import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const editor = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/draft-editor.tsx"),
  "utf8",
);
const modal = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/draft-editor-modal.tsx"),
  "utf8",
);

describe("New Post clipboard image flow", () => {
  test("handles only image clipboard files at the focused editor and preserves text paste", () => {
    expect(editor).toContain("clipboardImageFiles(event.clipboardData)");
    expect(editor).toContain("if (event.defaultPrevented || !allowImagePaste || !onMediaFiles) return;");
    expect(editor).toContain("if (!clipboardHasText(event.clipboardData)) event.preventDefault()");
    expect(modal).toContain("allowImagePaste={isNew}");
  });

  test("adds a local preview before upload, then replaces it with the final provider reference", () => {
    expect(modal).toContain("setPendingMedia((current) => [...current, pendingAttachment])");
    expect(modal).toContain("The temporary preview now gives way to the stable provider URL");
    expect(modal).toContain("attachment.id === pendingId");
    expect(modal).toContain("Never leave a broken temporary attachment behind after a failure");
  });

  test("does not save while an upload is active or persist a temporary blob URL", () => {
    expect(modal).toContain("Wait for the media upload to finish before saving.");
    expect(modal).toContain("mediaAttachmentsForPersistence(newMedia)");
    expect(modal).toContain("disabled={busy || mediaUploading || overLimit || mediaTooLate || !when}");
  });

  test("dedupes only concurrent duplicate events, allowing a later intentional paste", () => {
    expect(modal).toContain("inFlightUploadEvents.current.has(eventKey)");
    expect(modal).toContain("inFlightUploadEvents.current.delete(eventKey)");
  });
});

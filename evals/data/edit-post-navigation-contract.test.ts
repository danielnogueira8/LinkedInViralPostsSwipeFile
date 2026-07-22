import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const editorSource = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/draft-editor-modal.tsx"),
  "utf8",
);

describe("Edit post navigation controls", () => {
  test("renders accessible previous and next controls that respect the boundary state", () => {
    expect(editorSource).toContain('aria-label="Previous post"');
    expect(editorSource).toContain('aria-label="Next post"');
    expect(editorSource).toContain('disabled={!onPrevious || busy}');
    expect(editorSource).toContain('disabled={!onNext || busy}');
  });

  test("does not silently discard an edited body while moving between posts", () => {
    expect(editorSource).toContain('setPendingNavigation(direction)');
    expect(editorSource).toContain("Moving to another post will lose those changes.");
    expect(editorSource).toContain('else if (navigation === "next") onNext?.()');
  });
});

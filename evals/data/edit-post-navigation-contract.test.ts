import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const editorSource = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/draft-editor-modal.tsx"),
  "utf8",
);

describe("Edit post navigation controls", () => {
  test("renders accessible vertical previous and next controls that respect the boundary state", () => {
    expect(editorSource).toContain('aria-label="Previous post"');
    expect(editorSource).toContain('aria-label="Next post"');
    expect(editorSource).toContain('disabled={!onPrevious || busy}');
    expect(editorSource).toContain('disabled={!onNext || busy}');
    expect(editorSource).toContain('<ChevronUp className="h-4 w-4" />');
    expect(editorSource).toContain('<ChevronDown className="h-4 w-4" />');
    expect(editorSource).not.toContain('<ChevronLeft className="h-4 w-4" />');
    expect(editorSource).not.toContain('<ChevronRight className="h-4 w-4" />');
  });

  test("keeps unavailable boundary arrows visible with a lighter disabled treatment", () => {
    expect(editorSource).toContain("{!isNew && (");
    expect(editorSource).not.toContain("{!isNew && (onPrevious || onNext) && (");
    expect(
      editorSource.match(
        /className="text-foreground disabled:text-muted-foreground\/30 disabled:opacity-100"/g,
      ),
    ).toHaveLength(2);
  });

  test("does not silently discard an edited body while moving between posts", () => {
    expect(editorSource).toContain('setPendingNavigation(direction)');
    expect(editorSource).toContain("Moving to another post will lose those changes.");
    expect(editorSource).toContain('else if (navigation === "next") onNext?.()');
  });
});

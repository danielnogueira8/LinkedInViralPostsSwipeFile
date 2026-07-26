import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  "app/(app)/dashboard/voice/preferences.tsx",
  "utf8",
);

describe("learned preference review surface", () => {
  test("shows an accessible evidence disclosure with before and after edits", () => {
    expect(source).toContain("<details");
    expect(source).toContain("<summary");
    expect(source).toContain("Why Cowork learned this");
    expect(source).toContain('label="Before"');
    expect(source).toContain('label="After"');
    expect(source).toContain("Learned from edits");
    expect(source).toContain(
      "Supporting edits are unavailable for this earlier learned rule.",
    );
  });

  test("keeps editing and deletion available for learned rules", () => {
    expect(source).toContain('aria-label="Edit"');
    expect(source).toContain('aria-label="Delete"');
    expect(source).toContain("onStartEdit");
    expect(source).toContain("onDelete");
  });
});

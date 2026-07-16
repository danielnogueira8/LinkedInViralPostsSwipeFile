import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("clipboard call sites", () => {
  test.each([
    "app/(app)/dashboard/chat-workspace.tsx",
    "app/(app)/dashboard/draft-editor-modal.tsx",
    "app/(app)/dashboard/claude/copy.tsx",
  ])("%s uses the truthful shared clipboard helper", (path) => {
    const file = source(path);

    expect(file).toContain("copyToClipboard");
    expect(file).not.toContain("navigator.clipboard.writeText");
  });
});

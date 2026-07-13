import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  "app/(app)/dashboard/chat-workspace.tsx",
  "utf8",
);

describe("Cowork schedule image flow", () => {
  test("offers an image picker inside the schedule panel", () => {
    expect(source).toContain('aria-label="Add image to scheduled post"');
    expect(source).toContain('accept="image/jpeg,image/png,image/gif,image/webp"');
  });

  test("persists the selected image before scheduling", () => {
    expect(source).toContain("media_attachments: scheduleMediaAttachments");
  });
});

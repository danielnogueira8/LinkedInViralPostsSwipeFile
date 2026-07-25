import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  "app/(app)/dashboard/chat-workspace.tsx",
  "utf8",
);

describe("Cowork schedule image flow", () => {
  test("offers an image picker inside the schedule panel", () => {
    expect(source).toContain('aria-label="Add image to scheduled post"');
    // The accept list is no longer hardcoded here: it's derived from
    // IMAGE_MIME (lib/post-media) so the file dialog and the validator can't
    // drift apart. Widening one while the other stayed at four types would
    // silently do nothing — the picker simply wouldn't show the file.
    expect(source).toContain("accept={IMAGE_ACCEPT_ATTR}");
  });

  test("persists the selected image before scheduling", () => {
    expect(source).toContain("media_attachments: scheduleMediaAttachments");
  });
});

import { describe, test, expect } from "vitest";
import { sameMediaAttachments } from "@/app/(app)/dashboard/draft-editor-modal";
import type { PostMediaAttachment } from "@/lib/post-media";

// sameMediaAttachments underpins persistMedia's reconciling rollback: only
// revert an optimistic media change if the CURRENT media is still exactly what
// we set — otherwise a concurrent write (the lead-magnet image worker landing
// an attachment) must be preserved, not clobbered by a snapshot restore.

function att(id: string): PostMediaAttachment {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 10,
    type: "image",
    uploadedAt: "2026-01-01",
  };
}

describe("sameMediaAttachments", () => {
  test("empty lists are equal", () => {
    expect(sameMediaAttachments([], [])).toBe(true);
  });

  test("same ids in same order are equal", () => {
    expect(sameMediaAttachments([att("a"), att("b")], [att("a"), att("b")])).toBe(
      true,
    );
  });

  test("different length → not equal (a concurrent add/remove landed)", () => {
    expect(sameMediaAttachments([att("a")], [att("a"), att("b")])).toBe(false);
    expect(sameMediaAttachments([att("a"), att("b")], [att("a")])).toBe(false);
  });

  test("same length, different id → not equal", () => {
    expect(sameMediaAttachments([att("a")], [att("b")])).toBe(false);
  });

  test("same ids, different order → not equal (order is meaningful)", () => {
    expect(sameMediaAttachments([att("a"), att("b")], [att("b"), att("a")])).toBe(
      false,
    );
  });

  test("compares by id only — other fields differing doesn't matter", () => {
    const a = att("x");
    const b = { ...att("x"), name: "renamed.png", size: 999 };
    expect(sameMediaAttachments([a], [b])).toBe(true);
  });
});

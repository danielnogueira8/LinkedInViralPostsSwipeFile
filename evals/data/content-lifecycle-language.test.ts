import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CONTENT_LIFECYCLE,
  CONTENT_LIFECYCLE_STAGES,
  PUBLIC_DRAFT_STATUS_LABELS,
} from "@/lib/content-lifecycle";

describe("public content lifecycle", () => {
  test("uses one ordered vocabulary from inspiration through publication", () => {
    expect(CONTENT_LIFECYCLE).toEqual([
      "Inspiration",
      "Draft",
      "Ready",
      "Scheduled",
      "Published",
    ]);
    expect(PUBLIC_DRAFT_STATUS_LABELS).toEqual({
      idea: "Inspiration",
      drafting: "Draft",
      ready: "Ready",
      posted: "Published",
    });
    expect(Object.values(CONTENT_LIFECYCLE_STAGES)).toEqual(CONTENT_LIFECYCLE);
  });

  test("Cowork presents lifecycle actions rather than internal review language", () => {
    const source = readFileSync(
      new URL("../../app/(app)/dashboard/chat-workspace.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Mark ready");
    expect(source).toContain("Choose publish time");
    expect(source).toContain("New conversation");
    expect(source).not.toMatch(/>\s*Approve\s*</);
    expect(source).not.toMatch(/>\s*Reject\s*</);
    expect(source).not.toContain("New session</");
  });
});

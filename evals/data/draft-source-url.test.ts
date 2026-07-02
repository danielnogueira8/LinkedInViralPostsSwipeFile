import { describe, test, expect } from "vitest";
import { sourceUrlFromMeta } from "@/app/(app)/dashboard/posts/page";

// ---------------------------------------------------------------------------
// sourceUrlFromMeta — surfaces the "Adapted from ↗" link on a draft card. ONLY
// weekly-batch drafts (meta.source === 'weekly_batch') carry a source_url; a
// hand-authored or chat-saved draft must NOT show a link. Pure, no DOM.
// ---------------------------------------------------------------------------

describe("sourceUrlFromMeta", () => {
  test("returns the source_url for a weekly-batch draft", () => {
    expect(
      sourceUrlFromMeta({ source: "weekly_batch", source_url: "https://linkedin.com/p/1" }),
    ).toBe("https://linkedin.com/p/1");
  });

  test("null when the meta isn't a weekly-batch draft", () => {
    expect(sourceUrlFromMeta({ source: "chat", source_url: "https://x" })).toBeNull();
    expect(sourceUrlFromMeta({ source_url: "https://x" })).toBeNull();
  });

  test("null when a batch draft has no / empty source_url", () => {
    expect(sourceUrlFromMeta({ source: "weekly_batch" })).toBeNull();
    expect(sourceUrlFromMeta({ source: "weekly_batch", source_url: "" })).toBeNull();
    expect(sourceUrlFromMeta({ source: "weekly_batch", source_url: null })).toBeNull();
  });

  test("null for non-object meta (legacy / missing)", () => {
    expect(sourceUrlFromMeta(null)).toBeNull();
    expect(sourceUrlFromMeta(undefined)).toBeNull();
    expect(sourceUrlFromMeta("string")).toBeNull();
  });
});

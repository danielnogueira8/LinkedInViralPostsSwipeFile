import { describe, test, expect } from "vitest";
// Imported via the page's back-compat re-export to pin that it keeps resolving
// (the impl lives in lib/batch/review-draft).
import { sourceUrlFromMeta } from "@/app/(app)/dashboard/posts/page";

// ---------------------------------------------------------------------------
// sourceUrlFromMeta — surfaces the source link on a draft card. Weekly-batch
// drafts and modeled chat drafts both stamp meta.source_url server-side; the
// UI should read that deterministic field instead of relying on model text.
// ---------------------------------------------------------------------------

describe("sourceUrlFromMeta", () => {
  test("returns the source_url for a weekly-batch draft", () => {
    expect(
      sourceUrlFromMeta({ source: "weekly_batch", source_url: "https://linkedin.com/p/1" }),
    ).toBe("https://linkedin.com/p/1");
  });

  test("returns the source_url for a modeled chat draft", () => {
    expect(
      sourceUrlFromMeta({
        source: "model_source",
        source_post_id: "post_1",
        source_url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
      }),
    ).toBe("https://www.linkedin.com/feed/update/urn:li:activity:1/");
  });

  test("returns any valid source_url for future source-backed meta shapes", () => {
    expect(sourceUrlFromMeta({ source_url: "https://example.com/source" })).toBe(
      "https://example.com/source",
    );
  });

  test("null when meta has no / empty source_url", () => {
    expect(sourceUrlFromMeta({ source: "weekly_batch" })).toBeNull();
    expect(sourceUrlFromMeta({ source: "weekly_batch", source_url: "" })).toBeNull();
    expect(sourceUrlFromMeta({ source: "weekly_batch", source_url: null })).toBeNull();
  });

  test("null when source_url is not an http(s) URL", () => {
    expect(sourceUrlFromMeta({ source_url: "not a url" })).toBeNull();
    expect(sourceUrlFromMeta({ source_url: "ftp://example.com/source" })).toBeNull();
  });

  test("null for non-object meta (legacy / missing)", () => {
    expect(sourceUrlFromMeta(null)).toBeNull();
    expect(sourceUrlFromMeta(undefined)).toBeNull();
    expect(sourceUrlFromMeta("string")).toBeNull();
  });
});

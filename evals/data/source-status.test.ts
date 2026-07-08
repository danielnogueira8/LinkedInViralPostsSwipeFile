import { describe, expect, test } from "vitest";
import {
  deriveSourceStatus,
  indexRunProgressByHandle,
  SOURCE_STATUS_META,
} from "@/lib/source-status";

describe("deriveSourceStatus", () => {
  test("untracked is always Paused, even with posts and an errored run", () => {
    expect(
      deriveSourceStatus({
        tracked: false,
        totalPostCount: 12,
        runEntry: { handle: "x", status: "error" },
      }),
    ).toBe("paused");
  });

  test("tracked + posts + no run signal → Active", () => {
    expect(
      deriveSourceStatus({ tracked: true, totalPostCount: 12, runEntry: null }),
    ).toBe("active");
  });

  test("tracked + latest run errored → Needs attention (outranks post count)", () => {
    expect(
      deriveSourceStatus({
        tracked: true,
        totalPostCount: 12,
        runEntry: { handle: "x", status: "error" },
      }),
    ).toBe("needs_attention");
  });

  test("tracked + latest run scraping → Fetching posts", () => {
    expect(
      deriveSourceStatus({
        tracked: true,
        totalPostCount: 0,
        runEntry: { handle: "x", status: "scraping" },
      }),
    ).toBe("fetching");
  });

  test("tracked + checked (scraped) + no posts → No posts found yet", () => {
    expect(
      deriveSourceStatus({
        tracked: true,
        totalPostCount: 0,
        runEntry: { handle: "x", status: "scraped" },
      }),
    ).toBe("no_posts");
  });

  test("tracked + never in a run + no posts → No posts found yet (freshly added)", () => {
    expect(
      deriveSourceStatus({ tracked: true, totalPostCount: 0, runEntry: null }),
    ).toBe("no_posts");
  });

  test("every status has display metadata", () => {
    for (const s of [
      "active",
      "fetching",
      "no_posts",
      "needs_attention",
      "paused",
    ] as const) {
      expect(SOURCE_STATUS_META[s]).toBeDefined();
      expect(SOURCE_STATUS_META[s].label.length).toBeGreaterThan(0);
    }
  });
});

describe("indexRunProgressByHandle", () => {
  test("indexes by lowercased handle; skips entries without a handle", () => {
    const map = indexRunProgressByHandle([
      { handle: "Daniel-Nogueira", status: "scraped" },
      { handle: null, status: "error" },
      { status: "scraping" },
    ]);
    expect(map.get("daniel-nogueira")?.status).toBe("scraped");
    expect(map.size).toBe(1);
  });

  test("null/undefined progress → empty map", () => {
    expect(indexRunProgressByHandle(null).size).toBe(0);
    expect(indexRunProgressByHandle(undefined).size).toBe(0);
  });
});

import { describe, test, expect } from "vitest";
import { sheetFetchLooksTruncated } from "@/lib/sheets";

// ---------------------------------------------------------------------------
// The sheet-sync sanity floor. Google's published-CSV endpoint can serve a
// partial/stale body with a 200, and the sync is an upsert that would "succeed"
// on it (refreshing synced_at) — silently accepting a bad fetch. This guard
// aborts the sync when the fetched roster is dramatically smaller than the
// known one. Only the DROP direction; only past a baseline.
// ---------------------------------------------------------------------------

describe("sheetFetchLooksTruncated", () => {
  test("a fetch under half the known roster (past baseline) → truncated", () => {
    expect(sheetFetchLooksTruncated(40, 100)).toBe(true); // 40 < 50
    expect(sheetFetchLooksTruncated(0, 72)).toBe(true); // an empty body
  });

  test("a fetch covering >= half → not truncated (normal churn passes)", () => {
    expect(sheetFetchLooksTruncated(60, 100)).toBe(false);
    expect(sheetFetchLooksTruncated(50, 100)).toBe(false); // exactly half is OK
    expect(sheetFetchLooksTruncated(120, 100)).toBe(false); // growth passes
  });

  test("no meaningful baseline (< 10 known) → never flags (fresh/empty DB syncs)", () => {
    expect(sheetFetchLooksTruncated(0, 0)).toBe(false); // first sync ever
    expect(sheetFetchLooksTruncated(1, 9)).toBe(false); // tiny roster, don't guard
  });

  test("the boundary: baseline exactly 10", () => {
    expect(sheetFetchLooksTruncated(4, 10)).toBe(true); // 4 < 5
    expect(sheetFetchLooksTruncated(5, 10)).toBe(false); // 5 >= 5
  });
});

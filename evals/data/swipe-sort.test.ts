import { describe, expect, test } from "vitest";
import { resolveSwipeSort, DEFAULT_SORT } from "@/lib/swipe-query";

// The swipe feed's default is now PURE RECENCY (newest-first), not the old
// day-bucketed reactions re-rank. Every post already cleared the is_viral bar,
// so re-ranking by raw reactions just re-surfaced the same loud creators every
// day — recency spreads the feed across whoever posted most recently. These
// tests lock that contract in.

describe("resolveSwipeSort — default is pure recency", () => {
  test("DEFAULT_SORT is 'recent'", () => {
    expect(DEFAULT_SORT).toBe("recent");
  });

  test("no sort param → recent, posted_at DESC, NO day-bucket re-rank", () => {
    const r = resolveSwipeSort({});
    expect(r.sortKey).toBe("recent");
    expect(r.sortCol).toBe("posted_at");
    expect(r.ascending).toBe(false); // newest first
    expect(r.rebucketByDay).toBe(false); // the whole point: no reactions re-rank
    expect(r.rankByRelative).toBe(false);
  });

  test("an unknown sort param falls back to recent (not recent-viral)", () => {
    const r = resolveSwipeSort({ sort: "bogus" });
    expect(r.sortKey).toBe("recent");
    expect(r.rebucketByDay).toBe(false);
  });

  test("'recent' ignores ?dir=asc (intrinsically newest-first)", () => {
    const r = resolveSwipeSort({ sort: "recent", dir: "asc" });
    expect(r.ascending).toBe(false);
  });
});

describe("resolveSwipeSort — other sorts unchanged", () => {
  test("recent-viral still day-buckets + re-ranks by reactions", () => {
    const r = resolveSwipeSort({ sort: "recent-viral" });
    expect(r.sortCol).toBe("posted_at");
    expect(r.ascending).toBe(false);
    expect(r.rebucketByDay).toBe(true); // legacy behavior preserved for opt-in
  });

  test("reactions sort orders by the reactions column, honours ?dir", () => {
    expect(resolveSwipeSort({ sort: "reactions" }).sortCol).toBe("reactions");
    expect(resolveSwipeSort({ sort: "reactions", dir: "desc" }).ascending).toBe(
      false,
    );
    expect(resolveSwipeSort({ sort: "reactions", dir: "asc" }).ascending).toBe(
      true,
    );
    expect(resolveSwipeSort({ sort: "reactions" }).rebucketByDay).toBe(false);
  });

  test("comments sort orders by the comments column", () => {
    expect(resolveSwipeSort({ sort: "comments" }).sortCol).toBe("comments");
  });

  test("posted sort honours ?dir for chronological direction", () => {
    expect(resolveSwipeSort({ sort: "posted", dir: "asc" }).ascending).toBe(true);
    expect(resolveSwipeSort({ sort: "posted", dir: "desc" }).ascending).toBe(
      false,
    );
  });

  test("relative sort ranks by baseline breakout, intrinsically ordered", () => {
    const r = resolveSwipeSort({ sort: "relative", dir: "asc" });
    expect(r.sortCol).toBe("baseline_score");
    expect(r.ascending).toBe(false); // ignores ?dir
    expect(r.rankByRelative).toBe(true);
    expect(r.rebucketByDay).toBe(false);
  });

  test("rec=old flips the recency tiebreak on explicit column sorts", () => {
    expect(resolveSwipeSort({ sort: "reactions", rec: "old" }).recAscending).toBe(
      true,
    );
    expect(resolveSwipeSort({ sort: "reactions" }).recAscending).toBe(false);
  });
});

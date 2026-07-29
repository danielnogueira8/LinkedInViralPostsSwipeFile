import { describe, expect, test } from "vitest";
import {
  isVariedDiscoverySearch,
  variedDiscoveryOrder,
} from "@/lib/discovery-selection";

type Candidate = {
  id: string;
  account_id: string;
  viral_score: number;
};

const CANDIDATES: Candidate[] = Array.from({ length: 20 }, (_, index) => ({
  id: `post-${index + 1}`,
  account_id: `creator-${index + 1}`,
  viral_score: 1_000 - index * 10,
}));

describe("shared discovery selection", () => {
  test("treats normal filtered searches as varied and explicit rankings as strict", () => {
    expect(isVariedDiscoverySearch({ since: "30d", sort: "viral" })).toBe(true);
    expect(isVariedDiscoverySearch({ post_type: "regular" })).toBe(true);
    expect(isVariedDiscoverySearch({ strict_ranking: true })).toBe(false);
    expect(isVariedDiscoverySearch({ sort: "reactions" })).toBe(false);
    expect(isVariedDiscoverySearch({ dir: "asc" })).toBe(false);
    expect(isVariedDiscoverySearch({ min_comments: 500 })).toBe(false);
  });

  test("uses the durable cursor to vary a fresh relevance-ranked pool", () => {
    const first = variedDiscoveryOrder({
      candidates: CANDIDATES,
      usedIds: new Set(),
      cursor: 1,
    });
    const second = variedDiscoveryOrder({
      candidates: CANDIDATES,
      usedIds: new Set(),
      cursor: 2,
    });

    expect(first.slice(0, 5).map((post) => post.id)).not.toEqual(
      second.slice(0, 5).map((post) => post.id),
    );
    expect(
      new Set([
        ...first.slice(0, 5).map((post) => post.id),
        ...second.slice(0, 5).map((post) => post.id),
      ]).size,
    ).toBeGreaterThan(5);
  });

  test("keeps recently modeled sources behind fresh candidates", () => {
    const ordered = variedDiscoveryOrder({
      candidates: CANDIDATES,
      usedIds: new Set(["post-1", "post-2"]),
      cursor: 7,
    });

    expect(ordered.slice(0, 5).map((post) => post.id)).not.toContain("post-1");
    expect(ordered.slice(0, 5).map((post) => post.id)).not.toContain("post-2");
    expect(ordered.at(-1)?.already_used).toBe(true);
  });
});

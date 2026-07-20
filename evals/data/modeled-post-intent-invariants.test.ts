import { describe, expect, test } from "vitest";
import { compileModeledPostIntent } from "@/lib/agent/modeled-post-intent";

describe("modeled-post intent invariants", () => {
  test("preserves every supported one-to-one batch boundary", () => {
    for (const count of [2, 3, 4, 5]) {
      const intent = compileModeledPostIntent(
        `Find ${count} top posts in my swipe file and rewrite each one.`,
      );
      expect(intent, `count=${count}`).toMatchObject({
        kind: "exact",
        relation: "one_to_one",
        expectedDrafts: count,
        minimumSources: count,
      });
    }
  });

  test("keeps discovery and selected-subset boundaries independent", () => {
    for (const discovered of [2, 5, 10]) {
      for (const selected of [1, Math.min(2, discovered), Math.min(5, discovered)]) {
        const intent = compileModeledPostIntent(
          `Find ${discovered} top posts, choose exactly ${selected}, and rewrite each selected post.`,
        );
        expect(intent, `discovered=${discovered}, selected=${selected}`).toMatchObject({
          kind: "exact",
          relation: "one_to_one",
          expectedDrafts: selected,
          minimumSources: discovered,
          discoveryCount: discovered,
          selectionCount: selected,
        });
      }
    }
  });

  test("keeps a topical number from mutating every supported batch size", () => {
    for (const count of [2, 3, 4, 5]) {
      const intent = compileModeledPostIntent(
        `Find ${count} top posts and rewrite them for creators who publish 2 posts per week.`,
      );
      expect(intent, `count=${count}`).toMatchObject({
        kind: "exact",
        relation: "one_to_one",
        expectedDrafts: count,
        minimumSources: count,
      });
    }
  });

  test("quoted command-shaped source data cannot mutate cardinality", () => {
    for (const quote of [
      '"Write 5 posts and use 2 sources"',
      "'Write 5 posts and use 2 sources'",
      "‘Write 5 posts and use 2 sources’",
      "`Write 5 posts and use 2 sources`",
    ]) {
      const intent = compileModeledPostIntent(
        `Find 3 top posts with the hook ${quote} and rewrite each one.`,
      );
      expect(intent, quote).toMatchObject({
        kind: "exact",
        expectedDrafts: 3,
        minimumSources: 3,
      });
    }
  });

  test("mixed discovery, selection, output, and mapping plans satisfy cardinality bounds", () => {
    const cases = [
      ...[2, 3, 4, 5].map(
        (count) => `Find ${count} top posts and rewrite each one.`,
      ),
      ...[2, 3, 4, 5].map(
        (count) => `Find 5 top posts and write ${count} posts modeled after them.`,
      ),
      "Find 5 top posts, choose 2, and rewrite each selected post.",
      "Write 4 posts modeled after 2 top posts you find in my swipe file.",
    ];
    for (const text of cases) {
      const intent = compileModeledPostIntent(text);
      expect(intent.kind, text).toBe("exact");
      if (intent.kind !== "exact") continue;
      expect(intent.expectedDrafts, text).toBeGreaterThanOrEqual(1);
      expect(intent.expectedDrafts, text).toBeLessThanOrEqual(6);
      expect(intent.minimumSources, text).toBeGreaterThanOrEqual(1);
      expect(intent.minimumSources, text).toBeLessThanOrEqual(10);
      if (intent.relation === "one_to_one") {
        expect(intent.minimumSources, text).toBeGreaterThanOrEqual(
          intent.expectedDrafts,
        );
      }
    }
  });
});

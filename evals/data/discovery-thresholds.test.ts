import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_DISCOVERY_THRESHOLDS,
  discoveryThresholdFilter,
  normalizeDiscoveryThresholds,
  passesDiscoveryThreshold,
} from "@/lib/discovery-thresholds";

describe("post-type discovery thresholds", () => {
  test("uses the requested 100-like and 250-comment defaults", () => {
    expect(DEFAULT_DISCOVERY_THRESHOLDS).toEqual({
      regular: { enabled: true, minLikes: 100 },
      leadMagnet: { enabled: true, minComments: 250 },
    });
  });

  test("regular posts use likes only and lead magnets use comments only", () => {
    const config = DEFAULT_DISCOVERY_THRESHOLDS;
    expect(
      passesDiscoveryThreshold(
        { postType: "lead_magnet", reactions: 3, comments: 400 },
        config,
      ),
    ).toBe(true);
    expect(
      passesDiscoveryThreshold(
        { postType: "regular", reactions: 3, comments: 400 },
        config,
      ),
    ).toBe(false);
    expect(
      passesDiscoveryThreshold(
        { postType: "regular", reactions: 120, comments: 0 },
        config,
      ),
    ).toBe(true);
  });

  test("disabling one type never disables or weakens the other", () => {
    const config = {
      regular: { enabled: false, minLikes: 100 },
      leadMagnet: { enabled: true, minComments: 250 },
    };
    expect(
      passesDiscoveryThreshold(
        { postType: "regular", reactions: 0, comments: 0 },
        config,
      ),
    ).toBe(true);
    expect(
      passesDiscoveryThreshold(
        { postType: "lead_magnet", reactions: 10_000, comments: 2 },
        config,
      ),
    ).toBe(false);
  });

  test("normalizes persisted partial or invalid values safely", () => {
    expect(
      normalizeDiscoveryThresholds({
        regular: { enabled: false, minLikes: -10 },
      }),
    ).toEqual({
      regular: { enabled: false, minLikes: 0 },
      leadMagnet: { enabled: true, minComments: 250 },
    });
  });

  test("builds a PostgREST OR filter with independent type branches", () => {
    expect(discoveryThresholdFilter(DEFAULT_DISCOVERY_THRESHOLDS)).toBe(
      "and(post_type.eq.regular,reactions.gte.100),and(post_type.eq.lead_magnet,comments.gte.250)",
    );
    expect(
      discoveryThresholdFilter({
        regular: { enabled: false, minLikes: 100 },
        leadMagnet: { enabled: true, minComments: 250 },
      }),
    ).toBe(
      "post_type.eq.regular,and(post_type.eq.lead_magnet,comments.gte.250)",
    );
  });
});

describe("discovery threshold integration", () => {
  test.each([
    "lib/swipe-query.ts",
    "lib/agent/tools.ts",
    "lib/mcp/register.ts",
    "app/(app)/dashboard/swipe/page.tsx",
  ])("%s applies the shared post-type filter", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain("getDiscoveryThresholds");
    expect(source).toContain("discoveryThresholdFilter");
  });

  test("the last-batch featured rail applies the same post-type filter", () => {
    const source = readFileSync(
      "app/(app)/dashboard/swipe/page.tsx",
      "utf8",
    );
    const railQuery = source.slice(
      source.indexOf("const railPromise"),
      source.indexOf("// Page 0 + the exact total count"),
    );
    expect(railQuery).toContain(
      ".or(discoveryThresholdFilter(railThresholds!))",
    );
  });

  test("settings exposes only likes for regular and comments for lead magnets", () => {
    const source = readFileSync(
      "app/(app)/dashboard/settings/form.tsx",
      "utf8",
    );
    expect(source).toContain("Regular posts");
    expect(source).toContain("Minimum likes");
    expect(source).toContain("Lead magnet posts");
    expect(source).toContain("Minimum comments");
    expect(source).toContain('role="switch"');
  });
});

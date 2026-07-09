import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  computeFreshnessConstraint,
  freshnessEnabled,
  parseFreshnessArgs,
  renderFreshnessBlock,
  FRESHNESS_MAX_MARKERS,
  FRESHNESS_MIN_PRIOR_DRAFTS,
} from "@/lib/agent/specialists/freshness";
import type { RecentDraft } from "@/lib/recent-drafts";

// Pure logic behind the anti-repetition (freshness) tracker. The Sonnet call
// itself is covered by fail-open/skip-path tests; the rendered prompt block +
// arg parsing are the deterministic surface.

describe("renderFreshnessBlock", () => {
  test("empty markers → empty block (nothing injected)", () => {
    expect(renderFreshnessBlock([])).toBe("");
    expect(renderFreshnessBlock(["  ", ""])).toBe("");
  });

  test("markers render as a bulleted avoid-list with the override caveat", () => {
    const block = renderFreshnessBlock([
      "League of Legends past",
      "being from Portugal",
      "hooks are the gate",
    ]);
    expect(block).toContain("FRESHNESS");
    expect(block).toContain("• League of Legends past");
    expect(block).toContain("• being from Portugal");
    expect(block).toContain("• hooks are the gate");
    // The caveat that keeps it a nudge, not a hard ban.
    expect(block.toLowerCase()).toContain("unless the topic genuinely demands");
  });

  test("caps the number of markers rendered", () => {
    const many = Array.from({ length: 12 }, (_, i) => `marker ${i}`);
    const block = renderFreshnessBlock(many);
    const bulletCount = (block.match(/•/g) ?? []).length;
    expect(bulletCount).toBe(FRESHNESS_MAX_MARKERS);
  });

  test("trims whitespace and drops blank markers", () => {
    const block = renderFreshnessBlock(["  real one  ", "", "   ", "second"]);
    expect(block).toContain("• real one");
    expect(block).toContain("• second");
    expect(block).not.toContain("•  \n");
  });
});

describe("parseFreshnessArgs", () => {
  test("well-formed args return the marker list", () => {
    expect(
      parseFreshnessArgs({ overused_markers: ["a", "b", "c"] }),
    ).toEqual(["a", "b", "c"]);
  });

  test("missing / wrong-shape → empty list", () => {
    expect(parseFreshnessArgs(null)).toEqual([]);
    expect(parseFreshnessArgs(undefined)).toEqual([]);
    expect(parseFreshnessArgs({})).toEqual([]);
    expect(parseFreshnessArgs({ overused_markers: "not an array" })).toEqual([]);
  });

  test("filters non-string entries", () => {
    expect(
      parseFreshnessArgs({ overused_markers: ["ok", 1, null, "fine"] }),
    ).toEqual(["ok", "fine"]);
  });
});

describe("computeFreshnessConstraint — fail-open + skip paths", () => {
  beforeEach(() => {
    delete process.env.AGENT_FRESHNESS_TRACKER;
  });
  afterEach(() => {
    delete process.env.AGENT_FRESHNESS_TRACKER;
  });

  const manyDrafts: RecentDraft[] = Array.from({ length: 8 }, (_, i) => ({
    id: `d${i}`,
    body: "A prior draft that mentions League of Legends and Portugal again.",
    createdAt: "2026-01-01",
  }));

  test("disabled via env → empty constraint, no model call", async () => {
    process.env.AGENT_FRESHNESS_TRACKER = "0";
    expect(freshnessEnabled()).toBe(false);
    const result = await computeFreshnessConstraint({
      priorDrafts: manyDrafts,
    });
    expect(result).toEqual({ block: "", markers: [] });
  });

  test("thin history (under the minimum) → empty constraint", async () => {
    const few: RecentDraft[] = Array.from(
      { length: FRESHNESS_MIN_PRIOR_DRAFTS - 1 },
      (_, i) => ({ id: `d${i}`, body: "Prior.", createdAt: "2026-01-01" }),
    );
    const result = await computeFreshnessConstraint({ priorDrafts: few });
    expect(result).toEqual({ block: "", markers: [] });
  });
});

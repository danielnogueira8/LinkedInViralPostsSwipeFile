import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertFlatOnlyConfig,
  planReclassification,
  reclassifiedColumns,
  type ReclassifiablePost,
} from "@/lib/viral-reclassify";
import {
  RELATIVE_CUTOFF_DISABLED,
  type RelativeViralConfig,
  type ViralThresholds,
} from "@/lib/viral";

// ---------------------------------------------------------------------------
// The reclassification pass rewrites a GLOBAL column across every workspace's
// posts. The two things worth pinning are the ones a reviewer cannot check by
// reading the diff: that it refuses to run when its core assumption is false,
// and that the destructive direction stays opt-in.
// ---------------------------------------------------------------------------

const FLOOR: ViralThresholds = { min_reactions: 50, min_comments: 50 };

function cfg(over: Partial<RelativeViralConfig> = {}): RelativeViralConfig {
  return { minHistory: 5, window: 15, cutoffPct: RELATIVE_CUTOFF_DISABLED, ...over };
}

function post(over: Partial<ReclassifiablePost> = {}): ReclassifiablePost {
  return {
    id: "p1",
    reactions: 0,
    comments: 0,
    reposts: 0,
    viral_score: null,
    is_viral: false,
    ...over,
  };
}

describe("reclassification refuses to guess", () => {
  it("throws when the per-creator gate is on", () => {
    // Judging on the flat floor alone would be the WRONG answer here, and it
    // would be written to every row. Refusing beats degrading.
    expect(() => assertFlatOnlyConfig(cfg({ cutoffPct: 30 }))).toThrow(
      /relative gate is on/i,
    );
    expect(() => planReclassification([], FLOOR, cfg({ cutoffPct: 30 }))).toThrow();
  });

  it("proceeds when the gate is off", () => {
    expect(() => assertFlatOnlyConfig(cfg())).not.toThrow();
  });
});

describe("the plan", () => {
  it("recovers a post the 30% gate wrongly rejected", () => {
    // 60 reactions clears the 50 floor. Under cutoffPct=30 against a strong
    // creator this was stamped false at ingest; it is exactly what we want back.
    const plan = planReclassification(
      [post({ id: "recover-me", reactions: 60, is_viral: false })],
      FLOOR,
      cfg(),
    );
    expect(plan.recover).toEqual(["recover-me"]);
    expect(plan.demote).toEqual([]);
    expect(plan.unchanged).toBe(0);
  });

  it("separates demotions rather than lumping them in", () => {
    const plan = planReclassification(
      [post({ id: "too-quiet", reactions: 3, comments: 1, is_viral: true })],
      FLOOR,
      cfg(),
    );
    expect(plan.demote).toEqual(["too-quiet"]);
    expect(plan.recover).toEqual([]);
  });

  it("leaves correct rows alone", () => {
    const plan = planReclassification(
      [
        post({ id: "ok-true", reactions: 200, is_viral: true }),
        post({ id: "ok-false", reactions: 2, is_viral: false }),
      ],
      FLOOR,
      cfg(),
    );
    expect(plan.unchanged).toBe(2);
    expect(plan.recover).toEqual([]);
    expect(plan.demote).toEqual([]);
  });

  it("honours the OR: comments alone can carry a post", () => {
    const plan = planReclassification(
      [post({ id: "comments", reactions: 4, comments: 80, is_viral: false })],
      FLOOR,
      cfg(),
    );
    expect(plan.recover).toEqual(["comments"]);
  });

  it("reports a stale viral_score without acting on it", () => {
    // score() is reactions + comments*3 + reposts*5 = 60, not the stored 9999.
    const plan = planReclassification(
      [post({ id: "stale", reactions: 60, viral_score: 9999, is_viral: true })],
      FLOOR,
      cfg(),
    );
    expect(plan.staleScores).toEqual(["stale"]);
    // Reported only — the row itself is already classified correctly.
    expect(plan.unchanged).toBe(1);
    expect(plan.recover).toEqual([]);
    expect(plan.demote).toEqual([]);
  });

  it("clears the basis columns so they cannot contradict the new verdict", () => {
    // Rows written under the percentile carry viral_basis "relative" and a
    // baseline_score. Leaving those behind would have the row explaining itself
    // with a rule that no longer applied — and baseline_score drives the
    // "relative" sort and its requirePositiveBaseline filter.
    expect(reclassifiedColumns(true)).toEqual({
      is_viral: true,
      viral_basis: "flat_fallback",
      baseline_score: null,
    });
  });
});

describe("script safety", () => {
  const SCRIPT = readFileSync(
    path.join(process.cwd(), "scripts/reclassify-viral.ts"),
    "utf8",
  );

  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  }

  it("writes nothing without --apply", () => {
    const body = code(SCRIPT);
    const guardAt = body.indexOf("if (!apply)");
    const writeAt = body.indexOf(".update(");
    expect(guardAt).toBeGreaterThan(-1);
    // The early return must come before any write, or the dry run is a lie.
    expect(writeAt).toBeGreaterThan(guardAt);
  });

  it("keeps demotions behind a second flag", () => {
    expect(code(SCRIPT)).toContain("include-demotions");
    expect(code(SCRIPT)).toContain("if (includeDemotions) writes.push(");
  });

  it("uses the global rule, not a workspace's", () => {
    // getThresholds(someWorkspace) here would rewrite the shared column with
    // one workspace's opinion — the exact contamination the settings route
    // refuses to commit.
    expect(code(SCRIPT)).toContain("getThresholds(null)");
    expect(code(SCRIPT)).toContain("getRelativeConfig(null)");
  });

  it("checks the gate before reading any rows", () => {
    const body = code(SCRIPT);
    expect(body.indexOf("assertFlatOnlyConfig(config)")).toBeLessThan(
      body.indexOf('.from("posts")'),
    );
  });
});

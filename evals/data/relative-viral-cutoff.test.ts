import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decideRelativeViral,
  normalizeCutoffPct,
  RELATIVE_CUTOFF_DISABLED,
  type RelativeViralConfig,
  type ViralThresholds,
} from "@/lib/viral";

// The per-creator percentile gate is now OFF by default and configurable per
// workspace. These pin the two things that decide whether a post is visible at
// all — the disabled path and the stored-value clamp — because getting either
// wrong silently changes what an entire workspace sees in its Swipe File.

const FLOOR: ViralThresholds = { min_reactions: 50, min_comments: 50 };

function cfg(over: Partial<RelativeViralConfig> = {}): RelativeViralConfig {
  return { minHistory: 5, window: 15, cutoffPct: RELATIVE_CUTOFF_DISABLED, ...over };
}

/** A creator with a strong recent run: a post must beat 100 to be top-20%. */
const STRONG_HISTORY = [200, 150, 120, 100, 80, 60, 40, 20];

describe("relative cutoff disabled (the new default)", () => {
  it("lets the flat floor alone decide", () => {
    // 60 reactions clears the 50 floor but is nowhere near this creator's
    // top 20%. Under the old default this post was invisible; that invisibility
    // was the thing being removed.
    const decision = decideRelativeViral({
      score: 60,
      reactions: 60,
      comments: 0,
      priorScores: STRONG_HISTORY,
      flatThresholds: FLOOR,
      config: cfg(),
    });
    expect(decision.viral).toBe(true);
    expect(decision.basis).toBe("flat_fallback");
  });

  it("still refuses anything under the floor", () => {
    // Removing the relative gate must not turn the floor into a suggestion.
    const decision = decideRelativeViral({
      score: 10,
      reactions: 10,
      comments: 2,
      priorScores: STRONG_HISTORY,
      flatThresholds: FLOOR,
      config: cfg(),
    });
    expect(decision.viral).toBe(false);
  });

  it("reports no baseline, since none was consulted", () => {
    // A dashboard showing "needed X to be top 20%" while the gate is off would
    // be reporting a rule that did not run.
    const decision = decideRelativeViral({
      score: 60,
      reactions: 60,
      comments: 0,
      priorScores: STRONG_HISTORY,
      flatThresholds: FLOOR,
      config: cfg(),
    });
    expect(decision.baseline).toBeNull();
  });

  it("does not depend on the post being inside its own sample", () => {
    // The disabled path is explicit rather than leaning on percentile(s, 0)
    // returning the sample minimum. That coincidence breaks when a re-scraped
    // post is excluded from its own baseline, which the pipeline does.
    const decision = decideRelativeViral({
      score: 55,
      reactions: 55,
      comments: 0,
      // Every prior score is far above this post's.
      priorScores: [500, 400, 300, 200, 100],
      flatThresholds: FLOOR,
      config: cfg(),
    });
    expect(decision.viral).toBe(true);
  });
});

describe("the DEFAULT config, with no explicit override", () => {
  it("does not apply a per-creator gate", () => {
    // The load-bearing assertion of this whole change. Every other test passes
    // an explicit config, so none of them would notice the default silently
    // reverting to 20 — which is exactly what "remove the cutoff" undoes.
    const decision = decideRelativeViral({
      score: 60,
      reactions: 60,
      comments: 0,
      priorScores: STRONG_HISTORY,
      flatThresholds: FLOOR,
      // No `config` on purpose.
    });
    expect(decision.viral).toBe(true);
    expect(decision.basis).toBe("flat_fallback");
  });

  it("is off, not merely permissive", () => {
    expect(RELATIVE_CUTOFF_DISABLED).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// No environment variable may switch the relative gate on.
//
// This is a REGRESSION pin, not a style preference. VIRAL_REL_CUTOFF_PCT was
// set to 30 in production while the settings page showed the filter off. The
// daily scrape runs with workspaceId: null, so those defaults classified every
// workspace's posts — the fleet sat at "top 30% per creator" with no visible
// control, and because is_viral is stamped once at ingest and never recomputed,
// the posts it rejected were lost permanently rather than just hidden.
//
// The module reads its defaults at import time, so re-importing under a hostile
// environment is what actually proves the read is gone.
// ---------------------------------------------------------------------------
describe("the relative cutoff is not reachable from the environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("ignores VIRAL_REL_CUTOFF_PCT for a global (no-workspace) run", async () => {
    vi.stubEnv("VIRAL_REL_CUTOFF_PCT", "30");
    vi.resetModules();
    const viral = await import("@/lib/viral");
    // null workspace = the daily cron's path; it returns the module defaults
    // without touching the database.
    const config = await viral.getRelativeConfig(null);
    expect(config.cutoffPct).toBe(viral.RELATIVE_CUTOFF_DISABLED);
  });

  it("still lets a post outside the top 30% through under that env var", async () => {
    vi.stubEnv("VIRAL_REL_CUTOFF_PCT", "30");
    vi.resetModules();
    const viral = await import("@/lib/viral");
    const config = await viral.getRelativeConfig(null);
    // The exact post the production setting was silently rejecting: clears the
    // floor comfortably, nowhere near this creator's own top slice.
    const decision = viral.decideRelativeViral({
      score: 60,
      reactions: 60,
      comments: 0,
      priorScores: STRONG_HISTORY,
      flatThresholds: FLOOR,
      config,
    });
    expect(decision.viral).toBe(true);
    expect(decision.basis).toBe("flat_fallback");
  });

  it("keeps the per-workspace setting as the only way to turn it on", () => {
    // Assert against CODE, not prose: the comment above the defaults names the
    // removed variable on purpose, and matching that would pass forever.
    const source = readFileSync(
      path.join(process.cwd(), "lib/viral.ts"),
      "utf8",
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    // The sample-size guards stay env-tunable; the editorial choice does not.
    expect(code).toContain("VIRAL_REL_MIN_HISTORY");
    expect(code).toContain("VIRAL_REL_WINDOW");
    expect(code).not.toContain("VIRAL_REL_CUTOFF_PCT");
  });
});

describe("relative cutoff enabled reproduces the old behaviour", () => {
  it("rejects a floor-clearing post outside the creator's top slice", () => {
    const decision = decideRelativeViral({
      score: 60,
      reactions: 60,
      comments: 0,
      priorScores: STRONG_HISTORY,
      flatThresholds: FLOOR,
      config: cfg({ cutoffPct: 20 }),
    });
    expect(decision.viral).toBe(false);
    expect(decision.basis).toBe("relative");
  });

  it("accepts a post inside the top slice", () => {
    const decision = decideRelativeViral({
      score: 250,
      reactions: 250,
      comments: 0,
      priorScores: STRONG_HISTORY,
      flatThresholds: FLOOR,
      config: cfg({ cutoffPct: 20 }),
    });
    expect(decision.viral).toBe(true);
  });

  it("falls back to the floor for a creator with too little history", () => {
    const decision = decideRelativeViral({
      score: 60,
      reactions: 60,
      comments: 0,
      priorScores: [200, 150],
      flatThresholds: FLOOR,
      config: cfg({ cutoffPct: 20 }),
    });
    expect(decision.viral).toBe(true);
    expect(decision.basis).toBe("flat_fallback");
  });
});

describe("normalizeCutoffPct", () => {
  it("accepts the usable range", () => {
    expect(normalizeCutoffPct(1)).toBe(1);
    expect(normalizeCutoffPct(20)).toBe(20);
    expect(normalizeCutoffPct(100)).toBe(100);
  });

  it("rejects out-of-range values instead of clamping them", () => {
    // Clamping a stored 0 to 1 would silently apply "top 1%" to a workspace
    // that asked for something impossible. Null means "fall back to default",
    // which is the honest outcome.
    expect(normalizeCutoffPct(0)).toBeNull();
    expect(normalizeCutoffPct(-5)).toBeNull();
    expect(normalizeCutoffPct(101)).toBeNull();
  });

  it("rejects junk rather than coercing it to a number", () => {
    expect(normalizeCutoffPct(null)).toBeNull();
    expect(normalizeCutoffPct(undefined)).toBeNull();
    expect(normalizeCutoffPct("abc")).toBeNull();
    expect(normalizeCutoffPct({})).toBeNull();
  });

  it("rounds a fractional percentage", () => {
    expect(normalizeCutoffPct(19.6)).toBe(20);
  });

  it("accepts a numeric string, since settings JSON round-trips loosely", () => {
    expect(normalizeCutoffPct("20")).toBe(20);
  });
});

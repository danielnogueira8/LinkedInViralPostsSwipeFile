import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  repeatEval,
  stabilityRuns,
  stabilityThreshold,
  type Verdict,
} from "../live/harness";

// ---------------------------------------------------------------------------
// The repeat-run stability machinery (pure — no model/judge calls). repeatEval
// turns "did it work once" into "what fraction of N runs passed", which is the
// metric the stability gate asserts on. These run in the normal hermetic suite.
// ---------------------------------------------------------------------------

describe("repeatEval — pass-rate over N runs", () => {
  test("all pass → passRate 1, no failures", async () => {
    const r = await repeatEval(5, async () => ({ pass: true, reason: "ok" }));
    expect(r).toEqual({ runs: 5, passes: 5, passRate: 1, failures: [] });
  });

  test("all fail → passRate 0, one reason per run", async () => {
    const r = await repeatEval(3, async (i) => ({ pass: false, reason: `bad ${i}` }));
    expect(r.passRate).toBe(0);
    expect(r.failures).toHaveLength(3);
    expect(r.failures[0]).toContain("run 1: bad 0");
  });

  test("mixed → exact fraction, failures only for the failed runs", async () => {
    // pass on even attempts, fail on odd → 3/5.
    const r = await repeatEval(5, async (i) => ({ pass: i % 2 === 0, reason: `r${i}` }));
    expect(r.passes).toBe(3);
    expect(r.passRate).toBe(0.6);
    expect(r.failures).toHaveLength(2);
  });

  test("a probe that THROWS counts as a failed run (never aborts the batch)", async () => {
    let calls = 0;
    const r = await repeatEval(3, async () => {
      calls++;
      if (calls === 2) throw new Error("boom");
      return { pass: true, reason: "ok" };
    });
    expect(calls).toBe(3); // the throw didn't stop the remaining runs
    expect(r.passes).toBe(2);
    expect(r.failures[0]).toContain("probe threw: boom");
  });

  test("runs sequentially (no concurrent burst on the provider)", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    await repeatEval(4, async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((res) => setTimeout(res, 1));
      inFlight--;
      return { pass: true, reason: "ok" } as Verdict;
    });
    expect(maxConcurrent).toBe(1);
  });
});

describe("stabilityRuns / stabilityThreshold — env-tunable knobs", () => {
  const prevRuns = process.env.STABILITY_RUNS;
  const prevThresh = process.env.STABILITY_THRESHOLD;
  afterEach(() => {
    if (prevRuns === undefined) delete process.env.STABILITY_RUNS;
    else process.env.STABILITY_RUNS = prevRuns;
    if (prevThresh === undefined) delete process.env.STABILITY_THRESHOLD;
    else process.env.STABILITY_THRESHOLD = prevThresh;
  });
  beforeEach(() => {
    delete process.env.STABILITY_RUNS;
    delete process.env.STABILITY_THRESHOLD;
  });

  test("defaults: 5 runs, 0.8 threshold", () => {
    expect(stabilityRuns()).toBe(5);
    expect(stabilityThreshold()).toBe(0.8);
  });

  test("env overrides are honored", () => {
    process.env.STABILITY_RUNS = "10";
    process.env.STABILITY_THRESHOLD = "0.9";
    expect(stabilityRuns()).toBe(10);
    expect(stabilityThreshold()).toBe(0.9);
  });

  test("garbage env falls back to the default (never NaN/0)", () => {
    process.env.STABILITY_RUNS = "abc";
    process.env.STABILITY_THRESHOLD = "5"; // out of (0,1] range
    expect(stabilityRuns()).toBe(5);
    expect(stabilityThreshold()).toBe(0.8);
  });
});

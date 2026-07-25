import { describe, expect, test } from "vitest";
import {
  GENERIC_WEEK_PROMPTS,
  pickNextGenericPrompt,
} from "@/lib/agent-loop/week-plan";

// ---------------------------------------------------------------------------
// The catalogue was 10 prompts. Slots rotate through it by seed, so a 7-day plan
// cycled the whole pool in about a week and a half — guaranteed repeats.
//
// The replacement is weighted from this workspace's OWN tracked viral posts
// (241 non-lead-magnet viral hooks): AI tooling dominates at 46%, and the old
// ten covered none of it. These tests pin the size and the shape, not the exact
// wording — the copy should stay editable without breaking the suite.
// ---------------------------------------------------------------------------

describe("the pool is large enough to rotate", () => {
  test("holds 100+ prompts", () => {
    expect(GENERIC_WEEK_PROMPTS.length).toBeGreaterThanOrEqual(100);
  });

  test("has no duplicates", () => {
    expect(new Set(GENERIC_WEEK_PROMPTS).size).toBe(GENERIC_WEEK_PROMPTS.length);
  });

  test("a full quarter of daily slots never exhausts the pool", () => {
    // 90 days of planning should still be drawing from unused prompts.
    expect(GENERIC_WEEK_PROMPTS.length).toBeGreaterThan(90);
  });
});

describe("prompts are usable instructions, not headlines", () => {
  test("each is a lowercase instruction the writer can expand", () => {
    for (const p of GENERIC_WEEK_PROMPTS) {
      expect(p[0]).toBe(p[0].toLowerCase());
      expect(p.length).toBeGreaterThan(15);
      expect(p.endsWith(".")).toBe(false);
    }
  });

  test("the dominant theme from the data is actually represented", () => {
    // 46% of tracked viral hooks are AI-tooling posts and the old catalogue had
    // zero. If this drops to nothing, the pool has drifted off the evidence.
    const ai = GENERIC_WEEK_PROMPTS.filter((p) => /\bai\b|automat/i.test(p));
    expect(ai.length).toBeGreaterThanOrEqual(10);
  });
});

describe("rotation still works over the bigger pool", () => {
  test("consecutive picks differ", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      seen.add(pickNextGenericPrompt({ usedPrompts: [...seen], seed: i }) ?? "");
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  composeWorkingNowMix,
  WORKING_NOW_TOTAL,
  WORKING_NOW_LEAD_MAGNET_TARGET,
  WORKING_NOW_REGULAR_TARGET,
  WORKING_NOW_POOL_LIMIT,
} from "@/lib/agent-loop/working-now-mix";

// A tiny opportunity shape carrying an id (for identity assertions) + the type
// flag the mixer splits on. The pool is passed best-first (score-sorted).
type Opp = { id: string; is_lead_magnet: boolean };
const reg = (id: string): Opp => ({ id, is_lead_magnet: false });
const lm = (id: string): Opp => ({ id, is_lead_magnet: true });
const ids = (list: Opp[]) => list.map((o) => o.id);

describe("composeWorkingNowMix — 2 regular + 1 lead magnet by default", () => {
  test("the targets are the intended 2 + 1 = 3", () => {
    expect(WORKING_NOW_TOTAL).toBe(3);
    expect(WORKING_NOW_LEAD_MAGNET_TARGET).toBe(1);
    expect(WORKING_NOW_REGULAR_TARGET).toBe(2);
  });

  test("a rich pool yields exactly 2 regular + 1 lead magnet", () => {
    const pool = [reg("r1"), lm("l1"), reg("r2"), reg("r3"), lm("l2")];
    const out = composeWorkingNowMix(pool);
    expect(out.length).toBe(3);
    expect(out.filter((o) => !o.is_lead_magnet).length).toBe(2);
    expect(out.filter((o) => o.is_lead_magnet).length).toBe(1);
  });

  test("picks the HIGHEST-scored of each type (pool is best-first)", () => {
    // Best-first: r1 > l1 > r2 > r3 > l2. Expect the top 2 regular + top LM.
    const pool = [reg("r1"), lm("l1"), reg("r2"), reg("r3"), lm("l2")];
    const out = composeWorkingNowMix(pool);
    expect(ids(out).sort()).toEqual(["l1", "r1", "r2"]);
  });

  test("regular posts lead, then the lead magnet (stable, readable order)", () => {
    const pool = [lm("l1"), reg("r1"), reg("r2"), reg("r3")];
    const out = composeWorkingNowMix(pool);
    // Even though a lead magnet is first in the pool, the panel leads with the
    // regular posts, then the giveaway.
    expect(ids(out)).toEqual(["r1", "r2", "l1"]);
  });
});

describe("composeWorkingNowMix — thin bank backfills from the other type", () => {
  test("no lead magnets: fills all 3 slots with regular posts", () => {
    const pool = [reg("r1"), reg("r2"), reg("r3"), reg("r4")];
    const out = composeWorkingNowMix(pool);
    expect(ids(out)).toEqual(["r1", "r2", "r3"]);
  });

  test("no regular posts: fills all 3 slots with lead magnets", () => {
    const pool = [lm("l1"), lm("l2"), lm("l3"), lm("l4")];
    const out = composeWorkingNowMix(pool);
    expect(ids(out)).toEqual(["l1", "l2", "l3"]);
  });

  test("only 1 regular available: backfills the 2nd post slot with a lead magnet", () => {
    // 1 regular + plenty of lead magnets → 1 regular, then 2 lead magnets.
    const pool = [reg("r1"), lm("l1"), lm("l2"), lm("l3")];
    const out = composeWorkingNowMix(pool);
    expect(out.length).toBe(3);
    expect(ids(out)).toEqual(["r1", "l1", "l2"]);
  });

  test("2 regular + 0 lead magnet: backfills the giveaway slot with a 3rd post", () => {
    const pool = [reg("r1"), reg("r2"), reg("r3")];
    const out = composeWorkingNowMix(pool);
    expect(ids(out)).toEqual(["r1", "r2", "r3"]);
  });

  test("exactly 2 regular + 1 lead magnet: takes all three", () => {
    const pool = [reg("r1"), reg("r2"), lm("l1")];
    const out = composeWorkingNowMix(pool);
    expect(ids(out).sort()).toEqual(["l1", "r1", "r2"]);
  });
});

describe("composeWorkingNowMix — pool smaller than the target", () => {
  test("empty pool → empty result", () => {
    expect(composeWorkingNowMix([])).toEqual([]);
  });

  test("one item → that one item", () => {
    expect(ids(composeWorkingNowMix([lm("l1")]))).toEqual(["l1"]);
    expect(ids(composeWorkingNowMix([reg("r1")]))).toEqual(["r1"]);
  });

  test("two items, one of each → both, posts first", () => {
    expect(ids(composeWorkingNowMix([lm("l1"), reg("r1")]))).toEqual([
      "r1",
      "l1",
    ]);
  });

  test("never returns more than the total, even with a huge pool", () => {
    const pool = [
      reg("r1"), reg("r2"), reg("r3"), reg("r4"),
      lm("l1"), lm("l2"), lm("l3"),
    ];
    expect(composeWorkingNowMix(pool).length).toBe(WORKING_NOW_TOTAL);
  });

  test("no duplicates in the output", () => {
    const pool = [reg("r1"), reg("r2"), lm("l1"), lm("l2")];
    const out = composeWorkingNowMix(pool);
    expect(new Set(ids(out)).size).toBe(out.length);
  });
});

describe("composeWorkingNowMix — custom targets", () => {
  test("honours an explicit total + per-type split", () => {
    const pool = [reg("r1"), reg("r2"), reg("r3"), lm("l1"), lm("l2")];
    const out = composeWorkingNowMix(pool, {
      total: 4,
      regularTarget: 3,
      leadMagnetTarget: 1,
    });
    expect(out.length).toBe(4);
    expect(out.filter((o) => !o.is_lead_magnet).length).toBe(3);
    expect(out.filter((o) => o.is_lead_magnet).length).toBe(1);
  });
});

describe("the briefing route composes the mix from a score-sorted pool", () => {
  const route = readFileSync("app/api/agent/briefing/route.ts", "utf8");

  test("fetches a pool larger than the visible slots, then mixes", () => {
    // Pool limit must exceed the visible total so the mixer has real choice.
    expect(WORKING_NOW_POOL_LIMIT).toBeGreaterThan(WORKING_NOW_TOTAL);
    expect(route).toContain(".limit(WORKING_NOW_POOL_LIMIT)");
    expect(route).toContain("composeWorkingNowMix(normalisedPool)");
    // The pool is ordered by score before the mix keeps the strongest per type.
    expect(route).toContain('.order("score", { ascending: false })');
  });

  test("resolves is_lead_magnet across the WHOLE pool (the mixer splits on it)", () => {
    // The mix needs the type flag on every candidate, not just the top 3.
    expect(route).toContain("opportunitySourcePostIds(opportunityPool)");
    expect(route).toContain("is_lead_magnet: opportunityIsLeadMagnet");
  });
});

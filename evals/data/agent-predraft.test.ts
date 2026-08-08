import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_PREDRAFT_DAILY_CAP,
  PREDRAFT_CANDIDATE_SCAN_CAP,
  PREDRAFT_DRAFTS_PER_TICK,
  PREDRAFT_TURN_BUDGET_MS,
  hasBudgetForAnotherDraft,
  reachedDailyPredraftCap,
  selectPredraftCandidates,
  startOfUtcDay,
} from "@/lib/agent-loop/predraft";

// ---------------------------------------------------------------------------
// Pre-drafting now runs for every workspace, so these bounds are what stand
// between "a post a day people wanted" and "a daily spend across the fleet on
// posts nobody reads". Each is pinned rather than left to a constant.
// ---------------------------------------------------------------------------

describe("pre-draft budget", () => {
  it("refuses to start a turn that cannot finish inside the tick", () => {
    // actOnOpportunity runs to ACT_TIMEOUT_MS = 240s and the cron dies at
    // 300s. Being killed mid-turn loses the work AND leaves the opportunity
    // claimed as `drafting` until stale recovery.
    expect(hasBudgetForAnotherDraft(0)).toBe(true);
    expect(hasBudgetForAnotherDraft(PREDRAFT_TURN_BUDGET_MS - 1)).toBe(true);
    expect(hasBudgetForAnotherDraft(PREDRAFT_TURN_BUDGET_MS)).toBe(false);
  });

  it("leaves headroom under the 300s function ceiling", () => {
    expect(PREDRAFT_TURN_BUDGET_MS).toBeLessThan(300_000);
  });

  it("drafts once per tick, because two turns cannot fit", () => {
    expect(PREDRAFT_DRAFTS_PER_TICK).toBe(1);
  });
});

describe("pre-draft daily cap", () => {
  it("stops at the cap", () => {
    expect(reachedDailyPredraftCap(0)).toBe(false);
    expect(reachedDailyPredraftCap(AGENT_PREDRAFT_DAILY_CAP)).toBe(true);
    expect(reachedDailyPredraftCap(AGENT_PREDRAFT_DAILY_CAP + 5)).toBe(true);
  });

  it("defaults to one draft a day per workspace", () => {
    expect(AGENT_PREDRAFT_DAILY_CAP).toBe(1);
  });

  it("counts from the start of the UTC day", () => {
    expect(startOfUtcDay(new Date("2026-08-08T14:37:11.000Z"))).toBe(
      "2026-08-08T00:00:00.000Z",
    );
  });
});

describe("candidate selection", () => {
  const fleet = ["ws_a", "ws_b", "ws_c", "ws_d"];

  it("skips workspaces that already have today's draft", () => {
    // This exclusion IS the fairness mechanism. The previous hour-bucketed
    // rotation returned the same workspace for every tick within an hour, so
    // at one tick per 5 minutes eleven of twelve ticks were spent rediscovering
    // a workspace had already hit its cap — the fleet moved at ~24/day no
    // matter how often the cron fired.
    expect(
      selectPredraftCandidates(fleet, new Set(["ws_a", "ws_c"])),
    ).toEqual(["ws_b", "ws_d"]);
  });

  it("drains as the day progresses", () => {
    const served = new Set<string>();
    for (let tick = 0; tick < fleet.length; tick += 1) {
      const next = selectPredraftCandidates(fleet, served)[0];
      expect(next).toBeDefined();
      served.add(next!);
    }
    // Every workspace got exactly one turn, and the list is now empty.
    expect(served.size).toBe(fleet.length);
    expect(selectPredraftCandidates(fleet, served)).toEqual([]);
  });

  it("picks up a workspace added mid-day on the very next tick", () => {
    const served = new Set(fleet);
    expect(selectPredraftCandidates([...fleet, "ws_new"], served)).toEqual([
      "ws_new",
    ]);
  });

  it("bounds how many workspaces one tick probes", () => {
    const big = Array.from({ length: 500 }, (_, i) => `ws_${i}`);
    expect(selectPredraftCandidates(big, new Set())).toHaveLength(
      PREDRAFT_CANDIDATE_SCAN_CAP,
    );
  });

  it("handles an empty fleet", () => {
    expect(selectPredraftCandidates([], new Set())).toEqual([]);
  });
});

describe("route wiring", () => {
  const ROUTE = readFileSync(
    path.join(process.cwd(), "app/api/cron/agent-predraft/route.ts"),
    "utf8",
  );
  const VERCEL = readFileSync(path.join(process.cwd(), "vercel.json"), "utf8");

  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  }

  it("runs for the whole fleet, with no opt-in flag left behind", () => {
    expect(ROUTE).toContain("discoverAgentWorkspaceIds");
    // A flag nobody can reach from the UI is worse than no flag: it reads as a
    // control while doing nothing.
    expect(code(ROUTE)).not.toContain("agent_predraft_enabled");
  });

  it("ticks often enough for the fleet to actually be covered", () => {
    const config = JSON.parse(VERCEL) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const predraft = config.crons.find(
      (cron) => cron.path === "/api/cron/agent-predraft",
    );
    // One draft per tick means throughput IS tick frequency. Hourly capped the
    // fleet at ~24 workspaces/day.
    expect(predraft?.schedule).toBe("*/5 * * * *");
  });

  it("checks the whole fleet's daily state in one query", () => {
    // Per-workspace counting after picking meant a tick could do nothing at
    // all; the set is what lets a tick always land on a workspace that needs one.
    expect(ROUTE).toContain("workspacesDraftedToday");
    expect(ROUTE).toContain("selectPredraftCandidates");
  });

  it("moves past a workspace with nothing to draft", () => {
    // Otherwise one quiet workspace at the head of the list blocks the fleet.
    expect(ROUTE).toContain("if (!opportunity) continue;");
  });

  it("drafts through the same path the Draft it button uses", () => {
    expect(ROUTE).toContain("actOnOpportunity");
  });

  it("never publishes or schedules", () => {
    expect(code(ROUTE)).not.toMatch(/publish/i);
    expect(code(ROUTE)).not.toMatch(/\/queue/);
    expect(code(ROUTE)).not.toMatch(/\bschedule\(/);
  });

  it("is authorized like every other cron", () => {
    expect(ROUTE).toContain("isCronAuthorized");
    expect(ROUTE).toContain("cronAuthorizationResponse");
  });
});

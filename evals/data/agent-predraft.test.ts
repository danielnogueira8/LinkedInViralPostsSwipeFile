import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_PREDRAFT_DAILY_CAP,
  AGENT_PREDRAFT_FLAG_KEY,
  PREDRAFT_TURN_BUDGET_MS,
  PREDRAFT_WORKSPACES_PER_TICK,
  hasBudgetForAnotherDraft,
  reachedDailyPredraftCap,
  selectPredraftWorkspaces,
  startOfUtcDay,
} from "@/lib/agent-loop/predraft";

// ---------------------------------------------------------------------------
// Proactive pre-drafting spends real money on the machine's pick and puts a
// post nobody asked for on the board. Every bound below is a safety property,
// so each is pinned rather than left to a constant nobody rereads.
// ---------------------------------------------------------------------------

describe("pre-draft budget", () => {
  it("refuses to start a turn that cannot finish inside the tick", () => {
    // actOnOpportunity runs to ACT_TIMEOUT_MS = 240s and the cron dies at
    // 300s. Being killed mid-turn is the worst outcome: the opportunity is
    // already claimed as `drafting`, so the work is lost AND the idea is
    // locked until stale recovery. Refusing to start beats being cut off.
    expect(hasBudgetForAnotherDraft(0)).toBe(true);
    expect(hasBudgetForAnotherDraft(PREDRAFT_TURN_BUDGET_MS - 1)).toBe(true);
    expect(hasBudgetForAnotherDraft(PREDRAFT_TURN_BUDGET_MS)).toBe(false);
    expect(hasBudgetForAnotherDraft(PREDRAFT_TURN_BUDGET_MS + 60_000)).toBe(false);
  });

  it("leaves headroom under the 300s function ceiling", () => {
    expect(PREDRAFT_TURN_BUDGET_MS).toBeLessThan(300_000);
  });

  it("attempts one workspace per tick, because two turns cannot fit", () => {
    expect(PREDRAFT_WORKSPACES_PER_TICK).toBe(1);
  });
});

describe("pre-draft daily cap", () => {
  it("stops at the cap", () => {
    expect(reachedDailyPredraftCap(0)).toBe(false);
    expect(reachedDailyPredraftCap(AGENT_PREDRAFT_DAILY_CAP)).toBe(true);
    expect(reachedDailyPredraftCap(AGENT_PREDRAFT_DAILY_CAP + 5)).toBe(true);
  });

  it("defaults to one draft a day", () => {
    // A ranking error costs a full turn and an unwanted post here, where a
    // human click made it free. Raise only with the ignored-rate number in
    // hand (step 3).
    expect(AGENT_PREDRAFT_DAILY_CAP).toBe(1);
  });

  it("counts from the start of the UTC day", () => {
    expect(startOfUtcDay(new Date("2026-08-08T14:37:11.000Z"))).toBe(
      "2026-08-08T00:00:00.000Z",
    );
    expect(startOfUtcDay(new Date("2026-08-08T00:00:00.000Z"))).toBe(
      "2026-08-08T00:00:00.000Z",
    );
  });
});

describe("pre-draft workspace selection", () => {
  const ids = ["ws_a", "ws_b", "ws_c", "ws_d"];

  it("takes one workspace per tick", () => {
    expect(selectPredraftWorkspaces(ids, new Date("2026-08-08T00:00:00Z")))
      .toHaveLength(1);
  });

  it("rotates instead of starving the alphabetical tail", () => {
    // A plain slice(0, 1) would pick ws_a forever and ws_d would never be
    // drafted for — deterministically, not just slowly.
    const picked = new Set(
      Array.from({ length: ids.length }, (_, hour) =>
        selectPredraftWorkspaces(
          ids,
          new Date(Date.UTC(2026, 7, 8, hour)),
        )[0],
      ),
    );
    expect(picked.size).toBe(ids.length);
    expect([...picked].sort()).toEqual(ids);
  });

  it("handles an empty and a single-workspace fleet", () => {
    expect(selectPredraftWorkspaces([], new Date())).toEqual([]);
    expect(selectPredraftWorkspaces(["ws_only"], new Date())).toEqual(["ws_only"]);
  });
});

describe("pre-draft route wiring", () => {
  const ROUTE = readFileSync(
    path.join(process.cwd(), "app/api/cron/agent-predraft/route.ts"),
    "utf8",
  );
  const VERCEL = readFileSync(
    path.join(process.cwd(), "vercel.json"),
    "utf8",
  );

  it("is opt-in per workspace, never fleet-wide", () => {
    expect(AGENT_PREDRAFT_FLAG_KEY).toBe("agent_predraft_enabled");
    // The route must SELECT the opt-in list, not scan all workspaces.
    expect(ROUTE).toContain("AGENT_PREDRAFT_FLAG_KEY");
    expect(ROUTE).toContain('.eq("key", AGENT_PREDRAFT_FLAG_KEY)');
  });

  it("drafts through the same path the Draft it button uses", () => {
    // A second drafting code path would drift from voice, grounding, lineage
    // and the agent badge.
    expect(ROUTE).toContain("actOnOpportunity");
  });

  it("never publishes or schedules", () => {
    // Asserted against CODE, not the file: the comments legitimately discuss
    // publishing to explain why this route does not do it, and a bare
    // substring ban would be satisfied by deleting a comment.
    const code = ROUTE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/publish/i);
    expect(code).not.toMatch(/\/queue/);
    expect(code).not.toMatch(/\bschedule\(/);
    // The draft lands on the board and stops there.
    expect(code).toContain("actOnOpportunity");
  });

  it("is authorized like every other cron", () => {
    expect(ROUTE).toContain("isCronAuthorized");
    expect(ROUTE).toContain("cronAuthorizationResponse");
  });

  it("is registered on a schedule that does not collide with the other agent crons", () => {
    const config = JSON.parse(VERCEL) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const predraft = config.crons.find(
      (cron) => cron.path === "/api/cron/agent-predraft",
    );
    expect(predraft).toBeDefined();
    // agent-loop runs at :00 and agent-inbox at :15; both hold their own 300s
    // budget, so this one sits clear of them.
    const collisions = config.crons.filter(
      (cron) =>
        cron.path !== "/api/cron/agent-predraft" &&
        cron.schedule === predraft?.schedule,
    );
    expect(collisions).toEqual([]);
  });
});

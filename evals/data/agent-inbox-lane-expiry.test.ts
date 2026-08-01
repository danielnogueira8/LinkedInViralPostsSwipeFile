import { describe, expect, test } from "vitest";
import {
  AGENT_INBOX_LANES,
  AGENT_INBOX_ACTIVE_PER_LANE,
  laneLifetimeHours,
  type AgentInboxLane,
} from "@/lib/agent-inbox";
import { readFileSync } from "node:fs";

describe("every lane expires", () => {
  test("no lane has an unbounded lifetime", () => {
    // The bug: only newsjacking set expires_at. The other two stored NULL,
    // so their ideas never aged out, the lane sat permanently at the cap, and
    // replenish() stopped requesting it — the board froze while the daily run
    // kept completing "successfully" with zero cards created.
    for (const lane of AGENT_INBOX_LANES) {
      const hours = laneLifetimeHours(lane);
      expect(Number.isFinite(hours)).toBe(true);
      expect(hours).toBeGreaterThan(0);
    }
  });

  test("a timely lane rots faster than an evergreen one", () => {
    expect(laneLifetimeHours("newsjacking")).toBeLessThan(
      laneLifetimeHours("educational"),
    );
  });

  test("every lane survives at least a full day", () => {
    // A card the user meant to act on must still be there tomorrow morning,
    // otherwise expiry becomes its own kind of broken.
    for (const lane of AGENT_INBOX_LANES) {
      expect(laneLifetimeHours(lane)).toBeGreaterThanOrEqual(24);
    }
  });
});

describe("a full lane frees up on its own", () => {
  // Mirrors replenish(): missingLanes = lanes strictly below the cap.
  const missingLanes = (
    active: Array<{ lane: AgentInboxLane; expiresAt: string | null }>,
    now: Date,
  ) => {
    const live = active.filter(
      (idea) => idea.expiresAt === null || Date.parse(idea.expiresAt) > now.getTime(),
    );
    const counts = new Map<AgentInboxLane, number>();
    for (const idea of live) {
      counts.set(idea.lane, (counts.get(idea.lane) ?? 0) + 1);
    }
    return AGENT_INBOX_LANES.filter(
      (lane) => (counts.get(lane) ?? 0) < AGENT_INBOX_ACTIVE_PER_LANE,
    );
  };

  const stamp = (lane: AgentInboxLane, createdAt: Date) =>
    new Date(
      createdAt.getTime() + laneLifetimeHours(lane) * 3_600_000,
    ).toISOString();

  test("a board filled today is not regenerated tomorrow", () => {
    // Correct: fresh cards should be left alone.
    const created = new Date("2026-08-01T07:00:00Z");
    const board = AGENT_INBOX_LANES.flatMap((lane) =>
      Array.from({ length: 3 }, () => ({ lane, expiresAt: stamp(lane, created) })),
    );
    expect(missingLanes(board, new Date("2026-08-02T07:00:00Z"))).toEqual([]);
  });

  test("every lane comes back within a week", () => {
    // The actual regression. With null expiries these lanes NEVER returned.
    const created = new Date("2026-08-01T07:00:00Z");
    const board = AGENT_INBOX_LANES.flatMap((lane) =>
      Array.from({ length: 3 }, () => ({ lane, expiresAt: stamp(lane, created) })),
    );
    const weekLater = new Date("2026-08-08T08:00:00Z");
    expect(missingLanes(board, weekLater).sort()).toEqual(
      [...AGENT_INBOX_LANES].sort(),
    );
  });

  test("newsjacking returns first, days before the evergreen lanes", () => {
    const created = new Date("2026-08-01T07:00:00Z");
    const board = AGENT_INBOX_LANES.flatMap((lane) =>
      Array.from({ length: 3 }, () => ({ lane, expiresAt: stamp(lane, created) })),
    );
    // 4 days on: the timely lane is stale, the evergreen ones are not.
    const day4 = new Date("2026-08-05T08:00:00Z");
    expect(missingLanes(board, day4)).toEqual(["newsjacking"]);
  });

  test("a null-expiry idea still blocks its lane forever", () => {
    // Why migration 162 backfills: fixing the code alone leaves every card
    // created before it permanently occupying a slot.
    const board = [
      { lane: "educational" as const, expiresAt: null },
      { lane: "educational" as const, expiresAt: null },
      { lane: "educational" as const, expiresAt: null },
    ];
    expect(missingLanes(board, new Date("2027-01-01T00:00:00Z"))).not.toContain(
      "educational",
    );
  });
});

describe("migration 162 backfills the stranded rows", () => {
  const sql = readFileSync(
    "db/migration-162-agent-inbox-lane-expiry.sql",
    "utf8",
  );

  test("only touches rows that never had a deadline", () => {
    // A newsjacking card already carries a 72h expiry; overwriting it would
    // silently extend a pitch that should have rotted.
    expect(sql).toMatch(/where\s+expires_at is null/i);
  });

  test("dates from created_at, not now()", () => {
    // An idea sitting for two weeks should fall out on the next sweep, not
    // earn a fresh lease it never had.
    expect(sql).toMatch(/set expires_at = created_at \+/i);
  });

  test("leaves acted and discarded rows alone", () => {
    expect(sql).toMatch(/status in \('active', 'snoozed'\)/i);
  });

  test("its intervals match the code's lifetimes", () => {
    // The two are separate sources of truth; a drift here means the backfill
    // and the synthesizer disagree about when a lane turns over.
    expect(sql).toContain(`interval '${laneLifetimeHours("newsjacking")} hours'`);
    expect(sql).toContain(`interval '${laneLifetimeHours("educational")} hours'`);
  });

  test("is transactional and records the schema version", () => {
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/^commit;/m);
    expect(sql).toContain("162");
  });
});

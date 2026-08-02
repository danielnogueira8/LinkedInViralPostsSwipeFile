import { describe, expect, test } from "vitest";
import {
  scanFreshness,
  freshnessMessage,
  FRESH_WINDOW_HOURS,
} from "@/lib/agent-loop/scan-freshness";

// ---------------------------------------------------------------------------
// The opportunity scan used to run purely on a 06:00 timer, six hours after the
// daily scrape was ENQUEUED (not completed). When the scrape was slow, retried
// or failed, the scan rebuilt "Model recently viral posts" from yesterday's pool
// with no error anywhere. These pin the gate that replaces that hope.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-25T06:00:00.000Z");
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();

describe("scan proceeds only when today's scrape actually finished", () => {
  test("a run completed this morning is fresh", () => {
    const f = scanFreshness(
      { started_at: hoursAgo(6), finished_at: hoursAgo(5) },
      NOW,
    );
    expect(f).toEqual({ fresh: true, reason: "scrape_complete" });
  });

  test("NO completed run → skip (this is the silent-staleness case)", () => {
    const f = scanFreshness(null, NOW);
    expect(f.fresh).toBe(false);
    expect(f.reason).toBe("no_scrape_yet");
  });

  test("a run still IN FLIGHT → skip rather than read a half-filled pool", () => {
    // Scanning mid-scrape would also burn the 30-day per-source cooldown on
    // whichever posts happened to land first.
    const f = scanFreshness({ started_at: hoursAgo(1), finished_at: null }, NOW);
    expect(f.fresh).toBe(false);
    expect(f.reason).toBe("scrape_in_flight");
  });

  test("yesterday's run is stale → skip instead of re-pitching old posts", () => {
    const f = scanFreshness(
      { started_at: hoursAgo(30), finished_at: hoursAgo(29) },
      NOW,
    );
    expect(f.fresh).toBe(false);
    expect(f.reason).toBe("scrape_stale");
  });
});

describe("the freshness window boundary", () => {
  test("exactly at the window is still fresh", () => {
    const f = scanFreshness(
      { started_at: hoursAgo(FRESH_WINDOW_HOURS + 1), finished_at: hoursAgo(FRESH_WINDOW_HOURS) },
      NOW,
    );
    expect(f.fresh).toBe(true);
  });

  test("just past the window is stale", () => {
    const f = scanFreshness(
      {
        started_at: hoursAgo(FRESH_WINDOW_HOURS + 2),
        finished_at: hoursAgo(FRESH_WINDOW_HOURS + 0.5),
      },
      NOW,
    );
    expect(f.fresh).toBe(false);
    expect(f.reason).toBe("scrape_stale");
  });
});

describe("robustness", () => {
  test("a future finished_at (clock skew across instances) counts as fresh", () => {
    // Never compare timestamps written by one instance against another's clock
    // strictly — a small skew must not read as 'impossibly stale' and wedge the
    // scan off for a whole day.
    const f = scanFreshness(
      { started_at: hoursAgo(1), finished_at: new Date(NOW.getTime() + 30_000).toISOString() },
      NOW,
    );
    expect(f.fresh).toBe(true);
  });

  test("an unparseable timestamp fails closed, not with NaN", () => {
    const f = scanFreshness({ started_at: "x", finished_at: "not-a-date" }, NOW);
    expect(f.fresh).toBe(false);
  });
});

describe("freshnessMessage", () => {
  test("every reason has an explanation the log can carry", () => {
    for (const reason of [
      "scrape_complete",
      "no_scrape_yet",
      "scrape_in_flight",
      "scrape_stale",
    ] as const) {
      const msg = freshnessMessage({ fresh: reason === "scrape_complete", reason } as never);
      expect(msg.length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// The creator scan remains hourly because a daily scrape can finish after the
// 06:00 window. Paid Trend Radar has its own per-workspace daily claim, so the
// hourly wake-up does not multiply web searches.
// ---------------------------------------------------------------------------

describe("agent-loop safety invariants", () => {
  test("the agent-loop cron remains hourly for freshness recovery", async () => {
    const vercel = await import("../../vercel.json");
    const crons = (vercel.default ?? vercel).crons as Array<{
      path: string;
      schedule: string;
    }>;
    const loop = crons.find((c) => c.path === "/api/cron/agent-loop");
    expect(loop?.schedule).toBe("0 * * * *");
  });

  test("the scan's own guardrails bound a repeat run", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/agent-loop/scan.ts", "utf8"),
    );
    // A source proposed today is in cooldown for 30 days, so an hourly repeat run
    // re-pitches nothing...
    expect(src).toMatch(/SOURCE_COOLDOWN_DAYS\s*=\s*30/);
    // ...and each run can only ever add a small, bounded number.
    expect(src).toMatch(/MAX_PROPOSED_PER_RUN\s*=\s*3/);
  });

  test("the creator scan does no LLM work", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/agent-loop/scan.ts", "utf8"),
    );
    expect(src).not.toMatch(/completeChat|streamChat/);
  });
});

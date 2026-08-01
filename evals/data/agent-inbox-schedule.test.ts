import { describe, expect, test } from "vitest";
import {
  MAX_WORKSPACES_PER_TICK,
  isDueNow,
  localHourMinute,
  rotateForFairness,
} from "@/lib/agent-inbox/schedule";

// The inbox cron fires at :15 past every hour (vercel.json). These guard the
// two scheduling bugs that let a workspace silently never get an inbox.

describe("isDueNow", () => {
  // 2026-07-30T09:15:00Z — a representative cron tick.
  const tick = (utcHour: number, minute = 15) =>
    new Date(Date.UTC(2026, 6, 30, utcHour, minute));

  test("a workspace is not due before its delivery time", () => {
    expect(isDueNow(tick(7), "UTC", "08:00")).toBe(false);
  });

  test("a workspace is due on the first tick after its delivery time", () => {
    expect(isDueNow(tick(8), "UTC", "08:00")).toBe(true);
  });

  test("a workspace stays due for the rest of its local day", () => {
    // The daily-run claim is what enforces once-per-day, so a wide window is
    // safe and means a tick lost to an outage can still be recovered.
    expect(isDueNow(tick(15), "UTC", "08:00")).toBe(true);
  });

  test("a late delivery time still gets a tick before local midnight", () => {
    // Regression: `localTime >= deliveryLocalTime` never matched a 23:30
    // delivery, because 23:15 is the last tick of the local day. Anyone with a
    // late-evening delivery time received nothing, permanently.
    expect(isDueNow(tick(23), "UTC", "23:30")).toBe(true);
  });

  test("a late delivery time is not due at midday", () => {
    expect(isDueNow(tick(12), "UTC", "23:30")).toBe(false);
  });

  test("delivery time is evaluated in the workspace's own timezone", () => {
    // 12:15 UTC is 08:15 in New York, so an 08:00 delivery is due there and
    // not yet due in Los Angeles (05:15).
    expect(isDueNow(tick(12), "America/New_York", "08:00")).toBe(true);
    expect(isDueNow(tick(12), "America/Los_Angeles", "08:00")).toBe(false);
  });

  test("an unusable timezone falls through to due rather than skipping", () => {
    // A bad stored zone must not silently exclude the workspace forever; the
    // claim RPC validates the zone and rejects it per workspace instead.
    expect(isDueNow(tick(9), "Not/AZone", "08:00")).toBe(true);
  });

  test("localHourMinute is zero-padded so string compare stays ordered", () => {
    expect(localHourMinute(tick(9, 5), "UTC")).toBe("09:05");
  });
});

describe("rotateForFairness", () => {
  const now = new Date(Date.UTC(2026, 6, 30, 9, 15));

  test("returns everything when the list fits inside the cap", () => {
    const items = ["a", "b", "c"];
    expect(rotateForFairness(items, now, 10)).toEqual(items);
  });

  test("caps an oversized list to the limit", () => {
    const items = Array.from({ length: 130 }, (_, i) => `w${i}`);
    expect(rotateForFairness(items, now, 50)).toHaveLength(50);
  });

  test("covers every workspace as the rotation advances", () => {
    // Regression: `workspaces.slice(0, 50)` over an id-sorted list meant
    // workspace 51+ was starved on every tick, deterministically and forever.
    const items = Array.from({ length: 130 }, (_, i) => `w${i}`);
    const seen = new Set<string>();
    for (let hour = 0; hour < 3; hour += 1) {
      const at = new Date(now.getTime() + hour * 3_600_000);
      for (const item of rotateForFairness(items, at, 50)) seen.add(item);
    }
    expect(seen.size).toBe(items.length);
  });

  test("the cap matches the documented per-tick maximum", () => {
    expect(MAX_WORKSPACES_PER_TICK).toBe(50);
  });
});

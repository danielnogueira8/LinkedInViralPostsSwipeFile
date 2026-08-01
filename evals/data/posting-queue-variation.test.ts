import { describe, expect, test } from "vitest";
import {
  POSTING_QUEUE_VARIATION_MINUTES,
  varyPostingQueueInstant,
} from "@/lib/posting-queue-variation";

function varied({
  scheduledAt,
  occurrenceDate = "2026-07-28",
  enabled = true,
  now = "2026-07-27T00:00:00.000Z",
  random,
}: {
  scheduledAt: string;
  occurrenceDate?: string;
  enabled?: boolean;
  now?: string;
  random: number;
}) {
  return varyPostingQueueInstant({
    scheduledAt: new Date(scheduledAt),
    occurrenceDate,
    timezone: "UTC",
    enabled,
    now: new Date(now),
    random: () => random,
  }).toISOString();
}

describe("posting queue organic timing variation", () => {
  test("keeps exact slot times when the setting is disabled", () => {
    expect(
      varied({
        scheduledAt: "2026-07-28T09:00:00.000Z",
        enabled: false,
        random: 0,
      }),
    ).toBe("2026-07-28T09:00:00.000Z");
  });

  test("uses every integer minute from -15 through +15", () => {
    expect(POSTING_QUEUE_VARIATION_MINUTES).toBe(15);
    expect(
      varied({
        scheduledAt: "2026-07-28T09:00:00.000Z",
        random: 0,
      }),
    ).toBe("2026-07-28T08:45:00.000Z");
    expect(
      varied({
        scheduledAt: "2026-07-28T09:00:00.000Z",
        random: 1,
      }),
    ).toBe("2026-07-28T09:15:00.000Z");
  });

  test("never moves a queue occurrence outside its local calendar day", () => {
    expect(
      varied({
        scheduledAt: "2026-07-28T00:05:00.000Z",
        random: 0,
      }),
    ).toBe("2026-07-28T00:00:00.000Z");
    expect(
      varied({
        scheduledAt: "2026-07-28T23:55:00.000Z",
        random: 1,
      }),
    ).toBe("2026-07-28T23:59:00.000Z");
  });

  test("never randomizes a near-term slot into the past", () => {
    expect(
      varied({
        scheduledAt: "2026-07-28T09:05:00.000Z",
        now: "2026-07-28T09:00:00.000Z",
        random: 0,
      }),
    ).toBe("2026-07-28T09:01:00.000Z");
  });
});

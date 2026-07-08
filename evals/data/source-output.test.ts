import { describe, expect, test } from "vitest";
import { formatLastChecked, maxReactionsByAccount } from "@/lib/source-output";

describe("maxReactionsByAccount", () => {
  test("reduces narrow rows to the max reaction per account", () => {
    const map = maxReactionsByAccount([
      { account_id: "a", reactions: 10 },
      { account_id: "a", reactions: 843 },
      { account_id: "a", reactions: 5 },
      { account_id: "b", reactions: 20 },
    ]);
    expect(map.get("a")).toBe(843);
    expect(map.get("b")).toBe(20);
  });

  test("treats null reactions as 0 and omits accounts with no posts", () => {
    const map = maxReactionsByAccount([{ account_id: "a", reactions: null }]);
    expect(map.get("a")).toBe(0);
    expect(map.has("missing")).toBe(false);
  });

  test("null/undefined input → empty map", () => {
    expect(maxReactionsByAccount(null).size).toBe(0);
    expect(maxReactionsByAccount(undefined).size).toBe(0);
  });
});

describe("formatLastChecked", () => {
  // Anchor `now` to local noon so the calendar-day math is timezone-agnostic;
  // build the comparison dates as local-day offsets rather than UTC strings.
  const now = new Date(2026, 6, 8, 12, 0, 0);
  const daysAgo = (n: number, hour = 12) =>
    new Date(2026, 6, 8 - n, hour, 0, 0).toISOString();

  test("null/invalid → Not checked yet (fallback rendering)", () => {
    expect(formatLastChecked(null, now)).toBe("Not checked yet");
    expect(formatLastChecked("garbage", now)).toBe("Not checked yet");
  });

  test("same calendar day → Today", () => {
    expect(formatLastChecked(daysAgo(0, 1), now)).toBe("Last checked: Today");
  });

  test("previous calendar day → Yesterday", () => {
    expect(formatLastChecked(daysAgo(1, 23), now)).toBe("Last checked: Yesterday");
  });

  test("within the week → N days ago", () => {
    expect(formatLastChecked(daysAgo(3), now)).toBe("Last checked: 3 days ago");
  });

  test("older than a week → month/day", () => {
    const out = formatLastChecked(daysAgo(37), now);
    expect(out.startsWith("Last checked: ")).toBe(true);
    expect(out).not.toContain("days ago");
  });
});

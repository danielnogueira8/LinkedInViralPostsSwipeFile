import { describe, expect, test } from "vitest";
import {
  nextOpenScheduleDate,
  suggestedScheduleLocalInput,
} from "@/lib/next-open-schedule-day";

describe("next open schedule day", () => {
  test("starts tomorrow and skips a contiguous run of scheduled days", () => {
    expect(
      nextOpenScheduleDate("2026-07-13", [
        "2026-07-14",
        "2026-07-15",
        "2026-07-16",
        "2026-07-17",
      ]),
    ).toBe("2026-07-18");
  });

  test("returns tomorrow when it has no scheduled posts", () => {
    expect(nextOpenScheduleDate("2026-07-13", ["2026-07-15"])).toBe("2026-07-14");
  });

  test("preselects the open day at the user's preferred local time", () => {
    expect(suggestedScheduleLocalInput("2026-07-18", "09:30")).toBe(
      "2026-07-18T09:30",
    );
  });
});

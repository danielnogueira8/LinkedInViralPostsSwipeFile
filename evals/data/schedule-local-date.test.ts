import { describe, expect, test } from "vitest";
import {
  calendarDateSchema,
  localDateForInstant,
  localDateFromDatetimeInput,
  timeZoneSchema,
} from "@/lib/schedule-local-date";

describe("localDateFromDatetimeInput", () => {
  test("keeps the browser's local date without converting through UTC", () => {
    expect(localDateFromDatetimeInput("2099-12-31T00:30")).toBe("2099-12-31");
  });

  test("rejects empty or malformed datetime-local values", () => {
    expect(localDateFromDatetimeInput("")).toBeNull();
    expect(localDateFromDatetimeInput("2099-12-31")).toBeNull();
    expect(localDateFromDatetimeInput("not-a-date")).toBeNull();
    expect(localDateFromDatetimeInput("2099-02-29T12:00")).toBeNull();
  });

  test("does not reject a written wall time because of host timezone DST rules", () => {
    expect(localDateFromDatetimeInput("2027-03-28T01:30")).toBe("2027-03-28");
  });

  test("shared calendar-date validation rejects impossible dates", () => {
    expect(calendarDateSchema.safeParse("2099-12-31").success).toBe(true);
    expect(calendarDateSchema.safeParse("2099-02-29").success).toBe(false);
    expect(calendarDateSchema.safeParse("2099-99-99").success).toBe(false);
  });
});

describe("localDateForInstant", () => {
  // The bug: a user west of UTC scheduling 8pm local got the UTC calendar day
  // (the NEXT day) as plan_to_post_on. 8pm Dec 31 in New York = 01:00 Jan 1 UTC;
  // the dot must land on the user's LOCAL day.
  test("8pm America/New_York (next day in UTC) stays on the local calendar day", () => {
    expect(localDateForInstant("2100-01-01T01:00:00Z", "America/New_York")).toBe("2099-12-31");
  });

  test("east-of-UTC evening maps forward to the local next day", () => {
    // 23:30 UTC is already the next day in Tokyo (UTC+9).
    expect(localDateForInstant("2099-06-15T23:30:00Z", "Asia/Tokyo")).toBe("2099-06-16");
  });

  test("noon UTC is the same calendar day in a western zone", () => {
    expect(localDateForInstant("2099-06-15T12:00:00Z", "America/Los_Angeles")).toBe("2099-06-15");
  });

  test("falls back to the UTC calendar day without a timezone", () => {
    expect(localDateForInstant("2100-01-01T01:00:00Z")).toBe("2100-01-01");
    expect(localDateForInstant("2100-01-01T01:00:00Z", null)).toBe("2100-01-01");
  });

  test("falls back to the UTC calendar day on an invalid timezone", () => {
    expect(localDateForInstant("2100-01-01T01:00:00Z", "Not/A_Zone")).toBe("2100-01-01");
  });

  test("timezone schema accepts IANA zones and rejects junk", () => {
    expect(timeZoneSchema.safeParse("America/New_York").success).toBe(true);
    expect(timeZoneSchema.safeParse("UTC").success).toBe(true);
    expect(timeZoneSchema.safeParse("Not/A_Zone").success).toBe(false);
    expect(timeZoneSchema.safeParse("EST5EDT nonsense").success).toBe(false);
  });
});

import { describe, expect, test } from "vitest";
import {
  calendarDateSchema,
  localDateFromDatetimeInput,
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

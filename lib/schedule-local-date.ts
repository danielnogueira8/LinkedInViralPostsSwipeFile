import { z } from "zod";

const DATETIME_LOCAL_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function localDateFromDatetimeInput(value: string): string | null {
  const match = DATETIME_LOCAL_RE.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute, second = "00"] = match;
  const date = `${year}-${month}-${day}`;
  if (
    !isValidCalendarDate(date) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return null;
  }
  return date;
}

export function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day)
  );
}

export const calendarDateSchema = z
  .string()
  .refine(isValidCalendarDate, "Expected a valid YYYY-MM-DD date");

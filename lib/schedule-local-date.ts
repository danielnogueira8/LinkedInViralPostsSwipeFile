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

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .refine(isValidTimeZone, "Expected a valid IANA timezone, e.g. 'America/New_York'");

/**
 * Calendar date (YYYY-MM-DD) of a UTC instant as seen in `timeZone`.
 * Without a timezone (or with an invalid one) falls back to the UTC calendar
 * day — the pre-existing behavior for callers that send neither a local date
 * nor a timezone.
 */
export function localDateForInstant(iso: string, timeZone?: string | null): string {
  const date = new Date(iso);
  if (timeZone) {
    try {
      // en-CA formats as YYYY-MM-DD.
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
    } catch {
      // Invalid timezone: fall through to the UTC day.
    }
  }
  return date.toISOString().slice(0, 10);
}

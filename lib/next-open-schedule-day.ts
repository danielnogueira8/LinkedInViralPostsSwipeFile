const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addUtcDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!DATE_RE.test(date) || Number.isNaN(parsed.getTime())) {
    throw new Error("Expected a YYYY-MM-DD calendar date.");
  }
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function nextOpenScheduleDate(
  today: string,
  scheduledDates: Iterable<string>,
): string {
  const occupied = new Set([...scheduledDates].filter((date) => DATE_RE.test(date)));
  let candidate = addUtcDays(today, 1);
  while (occupied.has(candidate)) candidate = addUtcDays(candidate, 1);
  return candidate;
}

export function suggestedScheduleLocalInput(
  date: string,
  localTime = "09:00",
): string {
  if (!DATE_RE.test(date) || !/^\d{2}:\d{2}$/.test(localTime)) {
    throw new Error("Expected a calendar date and local time.");
  }
  return `${date}T${localTime}`;
}

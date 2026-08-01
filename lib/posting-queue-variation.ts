import { postingSlotInstant } from "@/lib/posting-queue";

export const POSTING_QUEUE_VARIATION_MINUTES = 15;

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12))
    .toISOString()
    .slice(0, 10);
}

export function varyPostingQueueInstant({
  scheduledAt,
  occurrenceDate,
  timezone,
  enabled,
  now = new Date(),
  random = Math.random,
}: {
  scheduledAt: Date;
  occurrenceDate: string;
  timezone: string;
  enabled: boolean;
  now?: Date;
  random?: () => number;
}): Date {
  if (!enabled) return scheduledAt;

  const minuteMs = 60_000;
  const scheduledMs = scheduledAt.getTime();
  const dayStart = postingSlotInstant(
    occurrenceDate,
    "00:00",
    timezone,
  ).getTime();
  const nextDayStart = postingSlotInstant(
    addCalendarDays(occurrenceDate, 1),
    "00:00",
    timezone,
  ).getTime();
  const futureFloor =
    Math.floor((now.getTime() - scheduledMs) / minuteMs) + 1;
  const firstMinuteOfDay = Math.ceil((dayStart - scheduledMs) / minuteMs);
  const lastMinuteOfDay = Math.floor(
    (nextDayStart - 1 - scheduledMs) / minuteMs,
  );
  const minimum = Math.max(
    -POSTING_QUEUE_VARIATION_MINUTES,
    firstMinuteOfDay,
    futureFloor,
  );
  const maximum = Math.min(
    POSTING_QUEUE_VARIATION_MINUTES,
    lastMinuteOfDay,
  );

  if (minimum > maximum) return scheduledAt;
  const sample = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  const offset = minimum + Math.floor(sample * (maximum - minimum + 1));
  return new Date(scheduledMs + offset * minuteMs);
}

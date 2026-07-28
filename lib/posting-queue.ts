export type PostingQueueSlot = {
  id: string;
  dayOfWeek: number;
  localTime: string;
  timezone: string;
};

export type PostingQueueDraft = {
  id: string;
  title: string | null;
  scheduledAt: string;
  scheduleStatus: ScheduleStatus;
  postingSlotId: string | null;
  postingSlotOccurrenceDate: string | null;
};

export type PostingQueueOccurrence = {
  slot: PostingQueueSlot;
  scheduledAt: string;
  draft: PostingQueueDraft | null;
};

export type PostingQueueDropTarget = {
  postingSlotId: string;
  postingSlotOccurrenceDate: string;
  timezone: string;
  localTime?: string;
};

export const DRAFT_DRAG_MIME = "application/x-swipein-draft-id";
export const QUEUED_DRAFT_DRAG_MIME =
  "application/x-swipein-queued-draft-id";

export function canReceiveQueuedDraft(
  scheduleStatus: string | null | undefined,
): boolean {
  return scheduleStatus == null || scheduleStatus === "scheduled";
}

export function canDragDraftToPostingQueue(draft: {
  status: string;
  scheduleStatus?: string | null;
}): boolean {
  return (
    draft.status !== "posted" &&
    draft.scheduleStatus !== "publishing" &&
    draft.scheduleStatus !== "published"
  );
}

export type PostingQueueDay = {
  date: string;
  weekday: string;
  dateLabel: string;
  isToday: boolean;
  noSlotsLeftToday: boolean;
  occurrences: PostingQueueOccurrence[];
};

export function postingSlotHasActiveDraft(
  drafts: readonly PostingQueueDraft[],
  slotId: string,
): boolean {
  return drafts.some(
    (draft) =>
      draft.postingSlotId === slotId &&
      (draft.scheduleStatus === "scheduled" ||
        draft.scheduleStatus === "publishing" ||
        draft.scheduleStatus === "failed"),
  );
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

export function localTimeForInstant(
  scheduledAt: string,
  timeZone: string,
): string {
  const parts = zonedParts(new Date(scheduledAt), timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function dateKey(parts: { year: number; month: number; day: number }) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days, 12));
  return next.toISOString().slice(0, 10);
}

/** Resolve a local wall-clock value to an instant. DST gaps advance minute by minute. */
export function postingSlotInstant(
  date: string,
  localTime: string,
  timeZone: string,
): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second = 0] = localTime.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const delta = desired - represented;
    if (delta === 0) return new Date(guess);
    guess += delta;
  }
  // A non-existent DST minute cannot round-trip. Move to the next valid minute,
  // matching the database allocator's behavior.
  for (let offset = 1; offset <= 180; offset += 1) {
    const candidateDesired = desired + offset * 60_000;
    let candidate = candidateDesired;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const actual = zonedParts(new Date(candidate), timeZone);
      const represented = Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        actual.second,
      );
      const delta = candidateDesired - represented;
      if (delta === 0) return new Date(candidate);
      candidate += delta;
    }
  }
  throw new Error("Unable to resolve posting slot timezone");
}

export function buildPostingQueueDays(
  slots: PostingQueueSlot[],
  drafts: PostingQueueDraft[],
  now: Date,
  accountTimezone: string,
): PostingQueueDay[] {
  const today = dateKey(zonedParts(now, accountTimezone));
  const activeDrafts = new Map(
    drafts
      .filter((draft) => draft.scheduleStatus !== "published")
      .map((draft) => [
        `${draft.postingSlotId}:${draft.postingSlotOccurrenceDate}`,
        draft,
      ]),
  );
  return Array.from({ length: 7 }, (_, offset) => {
    const date = addCalendarDays(today, offset);
    const dayOfWeek = new Date(`${date}T12:00:00.000Z`).getUTCDay();
    const occurrences = slots
      .filter((slot) => slot.dayOfWeek === dayOfWeek)
      .map((slot) => {
        const instant = postingSlotInstant(date, slot.localTime, slot.timezone);
        const draft = activeDrafts.get(`${slot.id}:${date}`) ?? null;
        return {
          slot,
          scheduledAt: draft?.scheduledAt ?? instant.toISOString(),
          draft,
        };
      })
      .filter((occurrence) => offset > 0 || occurrence.scheduledAt >= now.toISOString())
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    const hadSlots = slots.some((slot) => slot.dayOfWeek === dayOfWeek);
    return {
      date,
      weekday: new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "short",
      }).format(new Date(`${date}T12:00:00.000Z`)),
      dateLabel: new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
      }).format(new Date(`${date}T12:00:00.000Z`)),
      isToday: offset === 0,
      noSlotsLeftToday: offset === 0 && hadSlots && occurrences.length === 0,
      occurrences,
    };
  });
}

function dayDistance(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T12:00:00.000Z`).getTime() -
      new Date(`${a}T12:00:00.000Z`).getTime()) /
      86_400_000,
  );
}

export function formatScheduleToast(input: {
  scheduledAt: string;
  now?: Date;
  accountTimezone: string;
  browserTimezone?: string;
  action?: "scheduled" | "rescheduled";
}): string {
  const now = input.now ?? new Date();
  const scheduled = new Date(input.scheduledAt);
  const today = dateKey(zonedParts(now, input.accountTimezone));
  const scheduledDate = dateKey(zonedParts(scheduled, input.accountTimezone));
  const distance = dayDistance(today, scheduledDate);
  const relative = distance === 0 ? "Today, " : distance === 1 ? "Tomorrow, " : "";
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: input.accountTimezone,
    month: "short",
    day: "numeric",
  }).format(scheduled);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: input.accountTimezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(scheduled);
  const showZone =
    input.browserTimezone && input.browserTimezone !== input.accountTimezone;
  const zone = showZone
    ? ` ${new Intl.DateTimeFormat("en-US", {
        timeZone: input.accountTimezone,
        timeZoneName: "short",
      })
        .formatToParts(scheduled)
        .find((part) => part.type === "timeZoneName")?.value ?? input.accountTimezone}`
    : "";
  return `Post ${input.action ?? "scheduled"} for ${relative}${date} at ${time}${zone}`;
}
import type { ScheduleStatus } from "@/lib/draft-view";

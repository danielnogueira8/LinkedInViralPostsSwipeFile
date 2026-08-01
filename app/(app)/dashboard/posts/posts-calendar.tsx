"use client";

import { useEffect, useMemo, useState, type DragEvent } from "react";
import { Calendar, CalendarClock, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  DRAFT_DRAG_MIME,
  canDragDraftToPostingQueue,
  postingSlotInstant,
  type PostingQueueDraft,
  type PostingQueueDropTarget,
  type PostingQueueSlot,
} from "@/lib/posting-queue";
import {
  fetchPostingQueueSnapshot,
  type PostingQueueSnapshot,
} from "@/lib/posting-queue-client";
import type { Draft } from "@/lib/draft-view";

// ---------------------------------------------------------------------------
// Calendar view for the Posts page — the Board/Calendar toggle's second half.
// Restored on the CURRENT scheduling model: days are backed by the recurring
// posting queue (slot occurrences), not the retired planning dates. Dragging a
// post onto a day books its earliest OPEN slot occurrence on that date;
// dropping onto the tray unschedules. Pure helpers are exported for tests.
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** A local YYYY-MM-DD key for a Date (calendar day, local time). */
export function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type CalendarCell = { key: string; date: Date; inMonth: boolean };

/** Monday-first 42-cell grid covering the requested month. */
export function buildCalendarMonth(year: number, month: number): CalendarCell[] {
  const first = new Date(year, month, 1);
  // Days since Monday (Mon=0 … Sun=6) for the leading padding.
  const leading = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - leading);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    return { key: dayKey(date), date, inMonth: date.getMonth() === month };
  });
}

export type CalendarOccurrence = {
  slot: PostingQueueSlot;
  scheduledAt: string;
  draft: PostingQueueDraft | null;
};

// A queue draft actively holds its occurrence unless it already went out —
// published occurrences stay VISIBLE (they're the calendar's history) but the
// slot isn't "taken" for booking purposes anymore.
const HOLDING_STATUSES = new Set(["scheduled", "publishing", "failed"]);

/** Every slot occurrence on one local date, with its occupying draft (if any). */
export function occurrencesForDate(
  slots: PostingQueueSlot[],
  queueDrafts: PostingQueueDraft[],
  key: string,
): CalendarOccurrence[] {
  const dayOfWeek = new Date(`${key}T12:00:00.000Z`).getUTCDay();
  const byOccurrence = new Map(
    queueDrafts.map((draft) => [
      `${draft.postingSlotId}:${draft.postingSlotOccurrenceDate}`,
      draft,
    ]),
  );
  return slots
    .filter((slot) => slot.dayOfWeek === dayOfWeek)
    .map((slot) => ({
      slot,
      scheduledAt: postingSlotInstant(key, slot.localTime, slot.timezone).toISOString(),
      draft: byOccurrence.get(`${slot.id}:${key}`) ?? null,
    }))
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/**
 * The occurrence a drop on this date should book: the earliest slot that is
 * still in the future and not actively held. Null when the day can't take a
 * post (past, or every slot occupied).
 */
export function bookableOccurrence(
  slots: PostingQueueSlot[],
  queueDrafts: PostingQueueDraft[],
  key: string,
  now: Date,
): CalendarOccurrence | null {
  return (
    occurrencesForDate(slots, queueDrafts, key).find(
      (occurrence) =>
        occurrence.scheduledAt >= now.toISOString() &&
        (!occurrence.draft || !HOLDING_STATUSES.has(occurrence.draft.scheduleStatus ?? "")),
    ) ?? null
  );
}

/** Drafts with no queue booking and nothing scheduled directly — the tray. */
export function unscheduledDrafts(drafts: Draft[]): Draft[] {
  return drafts.filter((draft) => !draft.scheduledAt && draft.status !== "posted");
}

/**
 * Drafts to render as plain chips on a date: direct (non-queue) schedules on
 * that local day, and published posts on their publish day. Queue-booked
 * drafts render inside their occurrence row instead, never duplicated here.
 */
export function standaloneDraftsForDate(drafts: Draft[], key: string): Draft[] {
  return drafts.filter((draft) => {
    if (draft.postingSlotId && draft.postingSlotOccurrenceDate) return false;
    if (draft.status === "posted") {
      const published = draft.publishedAt ?? draft.scheduledAt;
      return published ? dayKey(new Date(published)) === key : false;
    }
    return draft.scheduledAt ? dayKey(new Date(draft.scheduledAt)) === key : false;
  });
}

// Minimal status cue for chips — mirrors the board's lane colors.
const STATUS_DOT: Record<string, string> = {
  idea: "bg-[oklch(0.60_0.12_60)]",
  drafting: "bg-[oklch(0.54_0.11_300)]",
  ready: "bg-[oklch(0.52_0.11_155)]",
  scheduled: "bg-[oklch(0.54_0.13_245)]",
  posted: "bg-[oklch(0.30_0.008_106)]",
};

type QueueSnapshot = Pick<PostingQueueSnapshot, "slots" | "drafts">;

function draftLabel(draft: Draft | PostingQueueDraft): string {
  const title = "title" in draft && typeof draft.title === "string" ? draft.title.trim() : "";
  if (title) return title;
  if ("body" in draft && typeof draft.body === "string") {
    return draft.body.split("\n")[0]?.trim().slice(0, 40) || "Untitled post";
  }
  return "Untitled post";
}

export function PostsCalendar({
  drafts,
  refreshKey,
  onOpen,
  onSchedule,
  onUnschedule,
}: {
  drafts: Draft[];
  // Bump to refetch the queue snapshot (e.g. after the queue widget changed it).
  refreshKey: number;
  onOpen: (draft: Draft) => void;
  onSchedule: (
    draftId: string,
    target: PostingQueueDropTarget & { localTime?: string },
  ) => Promise<void>;
  onUnschedule: (draftId: string) => Promise<void>;
}) {
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
  const [snapshot, setSnapshot] = useState<QueueSnapshot>({ slots: [], drafts: [] });
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
  const [overTray, setOverTray] = useState(false);
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPostingQueueSnapshot(timezone, { forceRefresh: refreshKey > 0 })
      .then((data) => {
        if (!cancelled) setSnapshot({ slots: data.slots ?? [], drafts: data.drafts ?? [] });
      })
      .catch((error: Error) => {
        if (!cancelled) toast.error(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [timezone, refreshKey]);

  const draftsById = useMemo(() => new Map(drafts.map((draft) => [draft.id, draft])), [drafts]);
  const trayDrafts = useMemo(() => unscheduledDrafts(drafts), [drafts]);
  const todayKey = dayKey(new Date());
  const cells = buildCalendarMonth(cursor.year, cursor.month);

  const prevMonth = () =>
    setCursor((c) => (c.month === 0 ? { year: c.year - 1, month: 11 } : { ...c, month: c.month - 1 }));
  const nextMonth = () =>
    setCursor((c) => (c.month === 11 ? { year: c.year + 1, month: 0 } : { ...c, month: c.month + 1 }));

  const drag = (e: DragEvent, draft: Draft) => {
    e.dataTransfer.setData(DRAFT_DRAG_MIME, draft.id);
    e.dataTransfer.setData("text/plain", draft.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const dropOnDay = async (draftId: string, key: string) => {
    if (busyDraftId) return;
    const draft = draftsById.get(draftId);
    if (!draft || !canDragDraftToPostingQueue(draft)) return;
    if (
      draft.postingSlotId &&
      draft.postingSlotOccurrenceDate === key &&
      occurrencesForDate(snapshot.slots, snapshot.drafts, key).some(
        (occurrence) => occurrence.slot.id === draft.postingSlotId,
      )
    ) {
      return; // dropped back on its own booking — no-op
    }
    if (key < todayKey) {
      toast.error("That day has already passed — pick a future date.");
      return;
    }
    const occurrence = bookableOccurrence(snapshot.slots, snapshot.drafts, key, new Date());
    if (!occurrence) {
      toast.error(
        snapshot.slots.length === 0
          ? "Set up your posting queue first — the calendar books posts into queue slots."
          : "No open queue slot on that day. Every slot is taken or past.",
      );
      return;
    }
    setBusyDraftId(draftId);
    try {
      await onSchedule(draftId, {
        postingSlotId: occurrence.slot.id,
        postingSlotOccurrenceDate: key,
        timezone: occurrence.slot.timezone,
        localTime: occurrence.slot.localTime,
      });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusyDraftId(null);
    }
  };

  const dropOnTray = async (draftId: string) => {
    if (busyDraftId) return;
    const draft = draftsById.get(draftId);
    if (!draft || (!draft.scheduledAt && !draft.postingSlotId)) return;
    setBusyDraftId(draftId);
    try {
      await onUnschedule(draftId);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusyDraftId(null);
    }
  };

  const chip = (draft: Draft, opts: { scheduled: boolean }) => (
    <button
      key={draft.id}
      type="button"
      draggable={canDragDraftToPostingQueue(draft)}
      onDragStart={(e) => drag(e, draft)}
      onClick={() => onOpen(draft)}
      title={draftLabel(draft)}
      disabled={busyDraftId === draft.id}
      className={cn(
        "flex w-full items-center gap-1 rounded border border-border/60 bg-card px-1.5 py-0.5 text-left text-[11px] font-medium",
        canDragDraftToPostingQueue(draft) && "cursor-grab active:cursor-grabbing",
        busyDraftId === draft.id && "opacity-50",
      )}
    >
      {opts.scheduled ? (
        <CalendarClock className="h-3 w-3 shrink-0 text-primary" aria-label="Scheduled on LinkedIn" />
      ) : (
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[draft.status] ?? STATUS_DOT.drafting)} />
      )}
      <span className="truncate">{draftLabel(draft)}</span>
    </button>
  );

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Month grid */}
      <div className="min-w-0 flex-1 rounded-xl border border-border/60 bg-card/70 p-2.5 shadow-soft">
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            onClick={prevMonth}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[140px] text-sm font-semibold">
            {MONTH_NAMES[cursor.month]} {cursor.year}
          </span>
          <button
            type="button"
            onClick={nextMonth}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-border/60 bg-border/60">
          {WEEKDAYS.map((weekday) => (
            <div
              key={weekday}
              className="bg-muted/40 px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {weekday}
            </div>
          ))}
          {cells.map((cell) => {
            const occurrences = occurrencesForDate(snapshot.slots, snapshot.drafts, cell.key);
            const standalone = standaloneDraftsForDate(drafts, cell.key);
            return (
              <div
                key={cell.key}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("text/plain")) return;
                  e.preventDefault();
                  if (dragOverDay !== cell.key) setDragOverDay(cell.key);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setDragOverDay((day) => (day === cell.key ? null : day));
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverDay(null);
                  const id = e.dataTransfer.getData("text/plain");
                  if (id) void dropOnDay(id, cell.key);
                }}
                className={cn(
                  "flex min-h-[96px] flex-col gap-1 bg-background p-1.5",
                  !cell.inMonth && "bg-muted/20",
                  dragOverDay === cell.key && "ring-2 ring-inset ring-primary/50",
                )}
              >
                <span
                  className={cn(
                    "text-[11px] font-medium",
                    cell.key === todayKey
                      ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                      : cell.inMonth
                        ? "text-foreground"
                        : "text-muted-foreground/50",
                  )}
                >
                  {cell.date.getDate()}
                </span>
                {occurrences.map((occurrence) => {
                  const pageDraft = occurrence.draft ? draftsById.get(occurrence.draft.id) : undefined;
                  if (occurrence.draft && pageDraft) {
                    return (
                      <div key={occurrence.slot.id} className="flex items-center gap-1">
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {occurrence.slot.localTime.slice(0, 5)}
                        </span>
                        {chip(pageDraft, { scheduled: true })}
                      </div>
                    );
                  }
                  if (occurrence.draft) {
                    // A queue draft that isn't on the board (e.g. already published).
                    return (
                      <div
                        key={occurrence.slot.id}
                        className="flex items-center gap-1 rounded border border-border/40 bg-muted/30 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        <span className="shrink-0 text-[10px] tabular-nums">
                          {occurrence.slot.localTime.slice(0, 5)}
                        </span>
                        <span className="truncate">{occurrence.draft.title ?? "Untitled post"}</span>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={occurrence.slot.id}
                      className="rounded border border-dashed border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground/70"
                    >
                      {occurrence.slot.localTime.slice(0, 5)} · open slot
                    </div>
                  );
                })}
                {standalone.map((draft) => chip(draft, { scheduled: draft.status !== "posted" }))}
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Drag posts here to book a queue slot on that day.</span>
          <span className="inline-flex items-center gap-1 text-primary">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden /> scheduled on LinkedIn
          </span>
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5" aria-hidden /> dashed rows are open queue slots
          </span>
        </div>
      </div>

      {/* Not-scheduled tray */}
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("text/plain")) return;
          e.preventDefault();
          if (!overTray) setOverTray(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverTray(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOverTray(false);
          const id = e.dataTransfer.getData("text/plain");
          if (id) void dropOnTray(id);
        }}
        className={cn(
          "flex shrink-0 flex-col gap-2 rounded-xl border bg-card/70 p-2.5 shadow-soft lg:w-72",
          overTray ? "border-dashed border-primary bg-primary/5" : "border-border/60",
        )}
      >
        <div className="rounded-xl border border-border/50 bg-background/55 px-3 py-2 text-xs">
          <div className="font-semibold text-foreground">Not scheduled</div>
          <div className="mt-0.5 tabular-nums text-muted-foreground">
            {trayDrafts.length} post{trayDrafts.length === 1 ? "" : "s"}
          </div>
        </div>
        {trayDrafts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/60 bg-background/45 px-3 py-8 text-center text-xs text-muted-foreground">
            Every post is scheduled. Drag one here to unschedule it.
          </div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
            {trayDrafts.map((draft) => (
              <button
                key={draft.id}
                type="button"
                draggable={canDragDraftToPostingQueue(draft)}
                onDragStart={(e) => drag(e, draft)}
                onClick={() => onOpen(draft)}
                disabled={busyDraftId === draft.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-border/60 bg-card px-2.5 py-2 text-left text-[13px] font-medium hover:bg-accent/40",
                  canDragDraftToPostingQueue(draft) && "cursor-grab active:cursor-grabbing",
                  busyDraftId === draft.id && "opacity-50",
                )}
              >
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[draft.status] ?? STATUS_DOT.drafting)} />
                <span className="min-w-0 flex-1 truncate">{draftLabel(draft)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

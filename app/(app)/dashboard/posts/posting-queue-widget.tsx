"use client";

import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Clock3,
  LoaderCircle,
  Move,
  Plus,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  draftOperations,
  type MovedQueuedDraftState,
  type UnscheduledDraftState,
} from "@/lib/draft-operations-client";
import {
  buildPostingQueueDays,
  canReceiveQueuedDraft,
  DRAFT_DRAG_MIME,
  formatScheduleToast,
  localTimeForInstant,
  postingSlotHasActiveDraft,
  QUEUED_DRAFT_DRAG_MIME,
  type PostingQueueDropTarget,
  type PostingQueueDraft,
  type PostingQueueSlot,
} from "@/lib/posting-queue";
import { cn } from "@/lib/utils";

type QueueResponse = {
  ok: true;
  collapsed: boolean;
  timeVariationEnabled: boolean;
  slots: PostingQueueSlot[];
  drafts: PostingQueueDraft[];
};

const SETTINGS_DAYS = [
  { dayOfWeek: 1, label: "Monday" },
  { dayOfWeek: 2, label: "Tuesday" },
  { dayOfWeek: 3, label: "Wednesday" },
  { dayOfWeek: 4, label: "Thursday" },
  { dayOfWeek: 5, label: "Friday" },
  { dayOfWeek: 6, label: "Saturday" },
  { dayOfWeek: 0, label: "Sunday" },
] as const;

export function PostingQueueWidget({
  onOpenDraft,
  onCreateDraftForSlot,
  queueCandidates,
  onScheduleDraftInQueue,
  onDraftRemovedFromQueue,
  onQueuedDraftsMoved,
  onQueueSnapshotLoaded,
}: {
  onOpenDraft: (draftId: string) => void;
  onCreateDraftForSlot: (
    target: PostingQueueDropTarget & { label: string },
  ) => void;
  queueCandidates: Array<{ id: string; title: string }>;
  onScheduleDraftInQueue: (
    draftId: string,
    target: PostingQueueDropTarget,
  ) => Promise<{
    draft: PostingQueueDraft;
    action: "scheduled" | "rescheduled";
  }>;
  onDraftRemovedFromQueue: (
    draftId: string,
    state: UnscheduledDraftState,
  ) => void;
  onQueuedDraftsMoved: (drafts: MovedQueuedDraftState[]) => void;
  onQueueSnapshotLoaded: (drafts: PostingQueueDraft[]) => void;
}) {
  const [slots, setSlots] = useState<PostingQueueSlot[]>([]);
  const [drafts, setDrafts] = useState<PostingQueueDraft[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [timeVariationEnabled, setTimeVariationEnabled] = useState(false);
  const [savingVariation, setSavingVariation] = useState(false);
  const [settingsTimes, setSettingsTimes] = useState<Record<number, string>>(
    () => Object.fromEntries(SETTINGS_DAYS.map((day) => [day.dayOfWeek, "09:00"])),
  );
  const [loaded, setLoaded] = useState(false);
  const [addingDay, setAddingDay] = useState<number | null>(null);
  const [dragOverOccurrence, setDragOverOccurrence] = useState<string | null>(
    null,
  );
  const [pickerTarget, setPickerTarget] = useState<
    (PostingQueueDropTarget & { label: string }) | null
  >(null);
  const [pickerDraftId, setPickerDraftId] = useState("");
  const [timeEditor, setTimeEditor] = useState<{
    draft: PostingQueueDraft;
    target: PostingQueueDropTarget;
    label: string;
  } | null>(null);
  const [editedLocalTime, setEditedLocalTime] = useState("");
  const [movePicker, setMovePicker] = useState<{
    draft: PostingQueueDraft;
    targetKey: string;
  } | null>(null);
  const [removingDraftId, setRemovingDraftId] = useState<string | null>(null);
  const [schedulingDraftId, setSchedulingDraftId] = useState<string | null>(
    null,
  );
  const [time, setTime] = useState("09:00");
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  const load = async () => {
    const response = await fetch(
      `/api/posting-slots?timezone=${encodeURIComponent(timezone)}`,
      { cache: "no-store" },
    );
    const data = (await response.json()) as QueueResponse & { error?: string };
    if (!response.ok || !data.ok)
      throw new Error(data.error || "Couldn't load posting queue.");
    setSlots(data.slots);
    setDrafts(data.drafts);
    onQueueSnapshotLoaded(data.drafts);
    setCollapsed(data.collapsed);
    setTimeVariationEnabled(data.timeVariationEnabled === true);
    setLoaded(true);
  };

  useEffect(() => {
    // The response is external server state; loading it on mount is the
    // synchronization this effect owns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((error: Error) => {
      setLoaded(true);
      toast.error(error.message);
    });
    // Timezone is stable for the mounted browser session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timezone]);

  useEffect(() => {
    const refresh = () => void load().catch(() => undefined);
    window.addEventListener("posting-queue-updated", refresh);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener("posting-queue-updated", refresh);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timezone]);

  const days = useMemo(
    () => buildPostingQueueDays(slots, drafts, new Date(), timezone),
    [slots, drafts, timezone],
  );
  const moveTargets = useMemo(
    () =>
      days.flatMap((day) =>
        day.occurrences
          .filter((occurrence) =>
            canReceiveQueuedDraft(occurrence.draft?.scheduleStatus),
          )
          .map((occurrence) => {
            const scheduledAt =
              occurrence.draft?.scheduledAt ?? occurrence.scheduledAt;
            const timeLabel = new Intl.DateTimeFormat(undefined, {
              timeZone: occurrence.slot.timezone,
              hour: "numeric",
              minute: "2-digit",
            }).format(new Date(scheduledAt));
            return {
              key: `${occurrence.slot.id}:${day.date}`,
              label: `${day.weekday}, ${day.dateLabel} at ${timeLabel}${
                occurrence.draft
                  ? ` — swap with ${occurrence.draft.title || "Untitled post"}`
                  : ""
              }`,
              draftId: occurrence.draft?.id ?? null,
              target: {
                postingSlotId: occurrence.slot.id,
                postingSlotOccurrenceDate: day.date,
                timezone: occurrence.slot.timezone,
              } satisfies PostingQueueDropTarget,
            };
          }),
      ),
    [days],
  );

  const toggleCollapsed = async () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      const response = await fetch("/api/posting-slots", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collapsed: next }),
      });
      if (!response.ok) throw new Error("Couldn't save queue display.");
    } catch (error) {
      setCollapsed(!next);
      toast.error((error as Error).message);
    }
  };

  const addSlot = async (dayOfWeek: number, localTime = time) => {
    try {
      const response = await fetch("/api/posting-slots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dayOfWeek, localTime, timezone }),
      });
      const data = (await response.json()) as {
        ok: boolean;
        slot?: PostingQueueSlot;
        error?: string;
      };
      if (!response.ok || !data.ok || !data.slot) {
        throw new Error(data.error || "Couldn't add posting slot.");
      }
      setSlots((current) =>
        [...current, data.slot!].sort(
          (a, b) =>
            a.dayOfWeek - b.dayOfWeek || a.localTime.localeCompare(b.localTime),
        ),
      );
      setAddingDay(null);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const updateTimeVariation = async () => {
    if (savingVariation) return;
    const next = !timeVariationEnabled;
    setTimeVariationEnabled(next);
    setSavingVariation(true);
    try {
      const response = await fetch("/api/posting-slots", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeVariationEnabled: next }),
      });
      if (!response.ok) throw new Error("Couldn't save queue timing.");
      toast.success(
        next
          ? "Queue time variation enabled"
          : "Queue time variation disabled",
      );
    } catch (error) {
      setTimeVariationEnabled(!next);
      toast.error((error as Error).message);
    } finally {
      setSavingVariation(false);
    }
  };

  const removeSlot = async (slot: PostingQueueSlot) => {
    const occupied = postingSlotHasActiveDraft(drafts, slot.id);
    if (
      occupied &&
      !window.confirm(
        "This slot contains a scheduled post. The post will keep its date and time as a one-off schedule.",
      )
    ) {
      return;
    }
    try {
      const response = await fetch(
        `/api/posting-slots?id=${encodeURIComponent(slot.id)}`,
        {
          method: "DELETE",
        },
      );
      const data = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !data.ok)
        throw new Error(data.error || "Couldn't remove slot.");
      setSlots((current) => current.filter((item) => item.id !== slot.id));
      setDrafts((current) =>
        current.map((draft) =>
          draft.postingSlotId === slot.id
            ? {
                ...draft,
                postingSlotId: null,
                postingSlotOccurrenceDate: null,
              }
            : draft,
        ),
      );
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const removeDraftFromQueue = async (draft: PostingQueueDraft) => {
    if (removingDraftId) return;
    setRemovingDraftId(draft.id);
    try {
      const next = await draftOperations.unschedule(draft.id);
      setDrafts((current) => current.filter((item) => item.id !== draft.id));
      onDraftRemovedFromQueue(draft.id, next);
      toast.success("Post removed from queue. The slot is still available.");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setRemovingDraftId(null);
    }
  };

  const scheduleDraftInOccurrence = async (
    draftId: string,
    target: PostingQueueDropTarget,
  ): Promise<boolean> => {
    if (schedulingDraftId || !draftId) return false;
    setDragOverOccurrence(
      `${target.postingSlotId}:${target.postingSlotOccurrenceDate}`,
    );
    setSchedulingDraftId(draftId);
    try {
      const result = await onScheduleDraftInQueue(draftId, target);
      setDrafts((current) => [
        ...current.filter((draft) => draft.id !== draftId),
        result.draft,
      ]);
      toast.success(
        formatScheduleToast({
          scheduledAt: result.draft.scheduledAt,
          accountTimezone: target.timezone,
          browserTimezone: timezone,
          action: result.action,
        }),
      );
      return true;
    } catch (error) {
      toast.error((error as Error).message);
      return false;
    } finally {
      setDragOverOccurrence(null);
      setSchedulingDraftId(null);
    }
  };

  const moveQueuedDraft = async (
    draftId: string,
    target: PostingQueueDropTarget,
  ): Promise<boolean> => {
    if (schedulingDraftId || !draftId) return false;
    const occurrenceKey = `${target.postingSlotId}:${target.postingSlotOccurrenceDate}`;
    setDragOverOccurrence(occurrenceKey);
    setSchedulingDraftId(draftId);
    try {
      const result = await draftOperations.moveQueue(draftId, {
        postingSlotId: target.postingSlotId,
        postingSlotOccurrenceDate: target.postingSlotOccurrenceDate,
      });
      const movedById = new Map(
        result.drafts.map((draft) => [draft.id, draft]),
      );
      setDrafts((current) =>
        current.map((draft) => {
          const moved = movedById.get(draft.id);
          return moved
            ? {
                ...draft,
                scheduledAt: moved.scheduledAt,
                scheduleStatus: moved.scheduleStatus,
                postingSlotId: moved.postingSlotId,
                postingSlotOccurrenceDate: moved.postingSlotOccurrenceDate,
              }
            : draft;
        }),
      );
      onQueuedDraftsMoved(result.drafts);
      const movedDraft = result.drafts.find((draft) => draft.id === draftId);
      if (movedDraft) {
        toast.success(
          result.swapped
            ? "Posts swapped in the posting queue."
            : formatScheduleToast({
                scheduledAt: movedDraft.scheduledAt,
                accountTimezone: result.timezone,
                browserTimezone: timezone,
                action: "rescheduled",
              }),
        );
      }
      return true;
    } catch (error) {
      toast.error((error as Error).message);
      try {
        await load();
      } catch {
        toast.error(
          "Couldn't refresh the posting queue. Reload the page to confirm the move.",
        );
      }
      return false;
    } finally {
      setDragOverOccurrence(null);
      setSchedulingDraftId(null);
    }
  };

  const dropDraft = (
    event: DragEvent<HTMLDivElement>,
    target: PostingQueueDropTarget,
  ) => {
    event.preventDefault();
    const queuedDraftId = event.dataTransfer
      .getData(QUEUED_DRAFT_DRAG_MIME)
      .trim();
    if (queuedDraftId) {
      void moveQueuedDraft(queuedDraftId, target);
      return;
    }
    const draftId = (
      event.dataTransfer.getData(DRAFT_DRAG_MIME) ||
      event.dataTransfer.getData("text/plain")
    ).trim();
    void scheduleDraftInOccurrence(draftId, target);
  };

  if (!loaded) {
    return <div className="h-16 animate-pulse rounded-xl border bg-muted/30" />;
  }

  return (
    <section
      className="rounded-xl border border-border bg-card shadow-soft"
      aria-label="Posting queue"
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <CalendarClock className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold">Posting queue</span>
          <span className="ml-2 text-xs text-muted-foreground">
            {slots.length === 0
              ? "Add a recurring time to enable one-click scheduling."
              : "Your next 7 days"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
          aria-label="Queue settings"
          title="Posting queue settings"
        >
          <Settings2 className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
          aria-label={`Posting queue, ${collapsed ? "expand" : "collapse"}`}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronUp className="h-4 w-4" />
          )}
        </button>
      </div>
      {!collapsed && (
        <div className="overflow-x-auto border-t">
          <div className="grid min-w-[840px] grid-cols-7 divide-x">
            {days.map((day) => {
              const daySlots = slots.filter(
                (slot) =>
                  slot.dayOfWeek ===
                  new Date(`${day.date}T12:00:00.000Z`).getUTCDay(),
              );
              return (
                <div
                  key={day.date}
                  className={cn(
                    "min-h-32 p-2",
                    day.isToday && "bg-primary/[0.04]",
                  )}
                >
                  <div className="flex items-start justify-between gap-1">
                    <div>
                      <div className="text-xs font-semibold">{day.weekday}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {day.dateLabel}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setAddingDay(
                          daySlots[0]?.dayOfWeek ??
                            new Date(`${day.date}T12:00:00.000Z`).getUTCDay(),
                        )
                      }
                      disabled={daySlots.length >= 3}
                      className="rounded p-1 text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                      aria-label={`Add slot on ${day.weekday}`}
                      title={
                        daySlots.length >= 3
                          ? "Maximum three slots per day"
                          : "Add posting slot"
                      }
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {day.items.map((item) => {
                      if (item.kind === "one_off") {
                        const draft = item.draft;
                        const timeLabel = new Intl.DateTimeFormat(undefined, {
                          timeZone: timezone,
                          hour: "numeric",
                          minute: "2-digit",
                        }).format(new Date(draft.scheduledAt));
                        return (
                          <div
                            key={`one-off:${draft.id}`}
                            role="group"
                            className="rounded-lg border border-accent-brand/25 bg-accent-brand/[0.06] px-2 py-1.5"
                            aria-label={`${day.weekday}, ${day.dateLabel} at ${timeLabel} one-off schedule`}
                          >
                            <div className="text-[10px] font-medium uppercase tracking-wide text-accent-brand">
                              One-off · {timeLabel}
                            </div>
                            <button
                              type="button"
                              onClick={() => onOpenDraft(draft.id)}
                              className="mt-0.5 block w-full truncate text-left text-[11px] text-primary hover:underline"
                              title={draft.title || "Untitled post"}
                            >
                              {draft.title || "Untitled post"}
                            </button>
                          </div>
                        );
                      }
                      const occurrence = item.occurrence;
                      const occurrenceKey = `${occurrence.slot.id}:${day.date}`;
                      const isDropTarget = dragOverOccurrence === occurrenceKey;
                      const canReceiveQueuedMove = canReceiveQueuedDraft(
                        occurrence.draft?.scheduleStatus,
                      );
                      const displayedAt =
                        occurrence.draft?.scheduledAt ?? occurrence.scheduledAt;
                      const timeLabel = new Intl.DateTimeFormat(undefined, {
                        timeZone: occurrence.slot.timezone,
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(new Date(displayedAt));
                      return (
                        <div
                          key={occurrence.slot.id}
                          role="group"
                          draggable={
                            occurrence.draft?.scheduleStatus === "scheduled"
                          }
                          aria-disabled={
                            (occurrence.draft != null &&
                              !canReceiveQueuedMove) ||
                            undefined
                          }
                          title={
                            occurrence.draft && !canReceiveQueuedMove
                              ? "This queue occurrence is locked and cannot be moved."
                              : undefined
                          }
                          aria-label={`${day.weekday}, ${day.dateLabel} at ${timeLabel} posting slot`}
                          onDragEnter={(event) => {
                            const isQueuedMove =
                              event.dataTransfer.types.includes(
                                QUEUED_DRAFT_DRAG_MIME,
                              );
                            if (
                              !occurrence.draft ||
                              (isQueuedMove && canReceiveQueuedMove)
                            ) {
                              event.preventDefault();
                              setDragOverOccurrence(occurrenceKey);
                            }
                          }}
                          onDragOver={(event) => {
                            const isQueuedMove =
                              event.dataTransfer.types.includes(
                                QUEUED_DRAFT_DRAG_MIME,
                              );
                            if (
                              !occurrence.draft ||
                              (isQueuedMove && canReceiveQueuedMove)
                            ) {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              setDragOverOccurrence(occurrenceKey);
                            }
                          }}
                          onDragLeave={(event) => {
                            if (
                              event.relatedTarget instanceof Node &&
                              event.currentTarget.contains(event.relatedTarget)
                            ) {
                              return;
                            }
                            setDragOverOccurrence((current) =>
                              current === occurrenceKey ? null : current,
                            );
                          }}
                          onDrop={(event) => {
                            const isQueuedMove =
                              event.dataTransfer.types.includes(
                                QUEUED_DRAFT_DRAG_MIME,
                              );
                            if (
                              occurrence.draft &&
                              (!isQueuedMove || !canReceiveQueuedMove)
                            ) {
                              return;
                            }
                            void dropDraft(event, {
                              postingSlotId: occurrence.slot.id,
                              postingSlotOccurrenceDate: day.date,
                              timezone: occurrence.slot.timezone,
                            });
                          }}
                          onDragStart={(event) => {
                            if (
                              occurrence.draft?.scheduleStatus !== "scheduled"
                            ) {
                              event.preventDefault();
                              return;
                            }
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData(
                              QUEUED_DRAFT_DRAG_MIME,
                              occurrence.draft.id,
                            );
                          }}
                          className={cn(
                            "group rounded-lg border bg-background/80 px-2 py-1.5 transition-colors",
                            !occurrence.draft &&
                              "border-dashed hover:border-accent-brand/50",
                            occurrence.draft?.scheduleStatus === "scheduled" &&
                              "cursor-grab active:cursor-grabbing",
                            isDropTarget &&
                              "border-accent-brand bg-accent-brand/[0.10] ring-2 ring-accent-brand/30",
                          )}
                        >
                          <div className="flex items-center gap-1">
                            <span className="text-[11px] font-medium">
                              {timeLabel}
                            </span>
                            <button
                              type="button"
                              onClick={() => void removeSlot(occurrence.slot)}
                              className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                              aria-label="Remove posting slot"
                            >
                              <Trash2 className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </div>
                          {occurrence.draft ? (
                            <div className="mt-0.5 flex min-w-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() =>
                                  onOpenDraft(occurrence.draft!.id)
                                }
                                className="min-w-0 flex-1 truncate text-left text-[11px] text-primary hover:underline"
                                title={
                                  occurrence.draft.title || "Untitled post"
                                }
                              >
                                {occurrence.draft.title || "Untitled post"}
                              </button>
                              {occurrence.draft.scheduleStatus ===
                                "scheduled" && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const firstTarget = moveTargets.find(
                                        (target) =>
                                          target.draftId !==
                                          occurrence.draft!.id,
                                      );
                                      setMovePicker({
                                        draft: occurrence.draft!,
                                        targetKey: firstTarget?.key ?? "",
                                      });
                                    }}
                                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                    aria-label={`Move ${
                                      occurrence.draft.title || "untitled post"
                                    } to another queue slot`}
                                    title="Move to another queue slot"
                                  >
                                    <Move
                                      className="h-3 w-3"
                                      aria-hidden="true"
                                    />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditedLocalTime(
                                        localTimeForInstant(
                                          occurrence.draft!.scheduledAt,
                                          occurrence.slot.timezone,
                                        ),
                                      );
                                      setTimeEditor({
                                        draft: occurrence.draft!,
                                        target: {
                                          postingSlotId: occurrence.slot.id,
                                          postingSlotOccurrenceDate: day.date,
                                          timezone: occurrence.slot.timezone,
                                        },
                                        label: `${day.weekday}, ${day.dateLabel}`,
                                      });
                                    }}
                                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                    aria-label={`Change scheduled hour for ${
                                      occurrence.draft.title || "untitled post"
                                    }`}
                                    title="Change scheduled hour"
                                  >
                                    <Clock3
                                      className="h-3 w-3"
                                      aria-hidden="true"
                                    />
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  void removeDraftFromQueue(occurrence.draft!)
                                }
                                disabled={
                                  removingDraftId !== null ||
                                  occurrence.draft.scheduleStatus ===
                                    "publishing"
                                }
                                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-40"
                                aria-label={`Remove ${
                                  occurrence.draft.title || "untitled post"
                                } from queue`}
                                title={
                                  occurrence.draft.scheduleStatus ===
                                  "publishing"
                                    ? "This post is being published"
                                    : "Remove post from queue"
                                }
                              >
                                <X className="h-3 w-3" aria-hidden="true" />
                              </button>
                            </div>
                          ) : (
                            <div
                              className={cn(
                                "flex items-center justify-between gap-1 text-[10px] text-muted-foreground",
                                isDropTarget && "font-medium text-accent-brand",
                              )}
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  onCreateDraftForSlot({
                                    postingSlotId: occurrence.slot.id,
                                    postingSlotOccurrenceDate: day.date,
                                    timezone: occurrence.slot.timezone,
                                    localTime: occurrence.slot.localTime,
                                    label: `${day.weekday}, ${day.dateLabel} at ${timeLabel}`,
                                  })
                                }
                                className="min-w-0 flex-1 truncate rounded text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
                                aria-label={`Create a post for ${day.weekday}, ${day.dateLabel} at ${timeLabel}`}
                              >
                                {schedulingDraftId && isDropTarget ? (
                                  <span className="inline-flex items-center gap-1">
                                    <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
                                    Scheduling…
                                  </span>
                                ) : isDropTarget ? (
                                  "Drop post here"
                                ) : (
                                  "Open · Create or drop a post"
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setPickerDraftId(
                                    queueCandidates[0]?.id ?? "",
                                  );
                                  setPickerTarget({
                                    postingSlotId: occurrence.slot.id,
                                    postingSlotOccurrenceDate: day.date,
                                    timezone: occurrence.slot.timezone,
                                    label: `${day.weekday}, ${day.dateLabel} at ${timeLabel}`,
                                  });
                                }}
                                className="shrink-0 rounded px-1 py-0.5 font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
                                aria-label={`Choose a post for ${day.weekday}, ${day.dateLabel} at ${timeLabel}`}
                              >
                                Choose
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {day.noSlotsLeftToday && (
                      <p className="text-[10px] leading-snug text-muted-foreground">
                        No slots left today.
                      </p>
                    )}
                    {day.occurrences.length === 0 &&
                      day.oneOffDrafts.length === 0 &&
                      !day.noSlotsLeftToday && (
                        <p className="text-[10px] text-muted-foreground">
                          No slots
                        </p>
                      )}
                  </div>
                  {addingDay ===
                    new Date(`${day.date}T12:00:00.000Z`).getUTCDay() && (
                    <div className="mt-2 flex gap-1">
                      <input
                        type="time"
                        value={time}
                        onChange={(event) => setTime(event.target.value)}
                        className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1 text-[11px]"
                        aria-label={`New ${day.weekday} posting time`}
                      />
                      <Button
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => void addSlot(addingDay)}
                      >
                        Add
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="left-auto right-0 top-0 h-dvh max-h-dvh w-full max-w-md translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] rounded-none p-0 sm:max-w-md">
          <DialogHeader className="border-b px-5 py-4 pr-12 text-left">
            <DialogTitle>Posting queue settings</DialogTitle>
            <DialogDescription>
              Set the recurring times that power Add to Queue.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain px-5 py-4">
            <section className="rounded-xl border border-border p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold">
                    Natural timing variation
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Schedule each newly queued post up to 15 minutes before or
                    after its slot. Times you choose manually stay exact.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={timeVariationEnabled}
                  aria-label="Vary posting queue times by up to 15 minutes"
                  disabled={savingVariation}
                  onClick={() => void updateTimeVariation()}
                  className="grid size-11 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-wait disabled:opacity-60"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "relative h-6 w-11 rounded-full transition-colors",
                      timeVariationEnabled
                        ? "bg-primary"
                        : "bg-muted-foreground/25",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
                        timeVariationEnabled
                          ? "translate-x-5"
                          : "translate-x-0",
                      )}
                    />
                  </span>
                </button>
              </div>
            </section>

            <section aria-labelledby="recurring-times-heading">
              <div className="mb-3">
                <h3
                  id="recurring-times-heading"
                  className="text-sm font-semibold"
                >
                  Recurring posting times
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Add up to three times per day. Removing an occupied slot keeps
                  its post scheduled as a one-off.
                </p>
              </div>
              <div className="space-y-3">
                {SETTINGS_DAYS.map((day) => {
                  const daySlots = slots
                    .filter((slot) => slot.dayOfWeek === day.dayOfWeek)
                    .sort((a, b) => a.localTime.localeCompare(b.localTime));
                  return (
                    <div
                      key={day.dayOfWeek}
                      className="rounded-xl border border-border p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold">
                          {day.label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {daySlots.length}/3
                        </span>
                      </div>
                      {daySlots.length > 0 ? (
                        <div className="mt-2 space-y-1.5">
                          {daySlots.map((slot) => (
                            <div
                              key={slot.id}
                              className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-2"
                            >
                              <Clock3
                                className="h-3.5 w-3.5 text-muted-foreground"
                                aria-hidden="true"
                              />
                              <span className="text-sm">
                                {slot.localTime.slice(0, 5)}
                              </span>
                              <button
                                type="button"
                                onClick={() => void removeSlot(slot)}
                                className="ml-auto rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                                aria-label={`Remove ${day.label} ${slot.localTime.slice(0, 5)} posting slot`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-muted-foreground">
                          No posting times
                        </p>
                      )}
                      <div className="mt-2 flex gap-2">
                        <input
                          type="time"
                          value={settingsTimes[day.dayOfWeek] ?? "09:00"}
                          disabled={daySlots.length >= 3}
                          onChange={(event) =>
                            setSettingsTimes((current) => ({
                              ...current,
                              [day.dayOfWeek]: event.target.value,
                            }))
                          }
                          className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm disabled:opacity-50"
                          aria-label={`New ${day.label} posting time in settings`}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            daySlots.length >= 3 ||
                            !settingsTimes[day.dayOfWeek]
                          }
                          onClick={() =>
                            void addSlot(
                              day.dayOfWeek,
                              settingsTimes[day.dayOfWeek] ?? "09:00",
                            )
                          }
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={pickerTarget !== null}
        onOpenChange={(open) => {
          if (!open && !schedulingDraftId) setPickerTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Schedule a post here</DialogTitle>
            <DialogDescription>
              {pickerTarget?.label}. Choose any idea, draft, ready post, or
              existing schedule.
            </DialogDescription>
          </DialogHeader>
          {queueCandidates.length > 0 ? (
            <div className="space-y-4">
              <label className="grid gap-1.5 text-sm font-medium">
                Post
                <select
                  value={pickerDraftId}
                  onChange={(event) => setPickerDraftId(event.target.value)}
                  className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
                >
                  {queueCandidates.map((draft) => (
                    <option key={draft.id} value={draft.id}>
                      {draft.title}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                className="w-full"
                disabled={!pickerDraftId || schedulingDraftId !== null}
                onClick={async () => {
                  if (!pickerTarget || !pickerDraftId) return;
                  const scheduled = await scheduleDraftInOccurrence(
                    pickerDraftId,
                    pickerTarget,
                  );
                  if (scheduled) setPickerTarget(null);
                }}
              >
                {schedulingDraftId ? (
                  <>
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    Scheduling…
                  </>
                ) : (
                  "Schedule here"
                )}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              There are no eligible posts to schedule yet.
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={movePicker !== null}
        onOpenChange={(open) => {
          if (!open && !schedulingDraftId) setMovePicker(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Move queued post</DialogTitle>
            <DialogDescription>
              Choose a new queue time. If it already contains a post, the two
              posts will swap places.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5 text-sm font-medium">
            Destination
            <select
              value={movePicker?.targetKey ?? ""}
              onChange={(event) =>
                setMovePicker((current) =>
                  current
                    ? {
                        ...current,
                        targetKey: event.target.value,
                      }
                    : null,
                )
              }
              className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
            >
              {moveTargets
                .filter((target) => target.draftId !== movePicker?.draft.id)
                .map((target) => (
                  <option key={target.key} value={target.key}>
                    {target.label}
                  </option>
                ))}
            </select>
          </label>
          <Button
            disabled={!movePicker?.targetKey || schedulingDraftId !== null}
            onClick={async () => {
              if (!movePicker) return;
              const destination = moveTargets.find(
                (target) => target.key === movePicker.targetKey,
              );
              if (!destination) return;
              const moved = await moveQueuedDraft(
                movePicker.draft.id,
                destination.target,
              );
              if (moved) setMovePicker(null);
            }}
          >
            {schedulingDraftId ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" />
                Moving…
              </>
            ) : (
              "Move post"
            )}
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={timeEditor !== null}
        onOpenChange={(open) => {
          if (!open && !schedulingDraftId) setTimeEditor(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Change scheduled hour</DialogTitle>
            <DialogDescription>
              {timeEditor?.label}. This post will stay in its current queue
              slot.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5 text-sm font-medium">
            Publishing time
            <input
              type="time"
              value={editedLocalTime}
              onChange={(event) => setEditedLocalTime(event.target.value)}
              className="h-10 rounded-lg border bg-background px-3 text-sm"
            />
          </label>
          <Button
            disabled={
              !timeEditor || !editedLocalTime || schedulingDraftId !== null
            }
            onClick={async () => {
              if (!timeEditor || !editedLocalTime) return;
              const scheduled = await scheduleDraftInOccurrence(
                timeEditor.draft.id,
                {
                  ...timeEditor.target,
                  localTime: editedLocalTime,
                },
              );
              if (scheduled) setTimeEditor(null);
            }}
          >
            {schedulingDraftId ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save time"
            )}
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}

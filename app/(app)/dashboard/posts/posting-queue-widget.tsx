"use client";

import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Plus,
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
  type UnscheduledDraftState,
} from "@/lib/draft-operations-client";
import {
  buildPostingQueueDays,
  DRAFT_DRAG_MIME,
  formatScheduleToast,
  postingSlotHasActiveDraft,
  type PostingQueueDropTarget,
  type PostingQueueDraft,
  type PostingQueueSlot,
} from "@/lib/posting-queue";
import { cn } from "@/lib/utils";

type QueueResponse = {
  ok: true;
  collapsed: boolean;
  slots: PostingQueueSlot[];
  drafts: PostingQueueDraft[];
};

export function PostingQueueWidget({
  onOpenDraft,
  queueCandidates,
  onScheduleDraftInQueue,
  onDraftRemovedFromQueue,
}: {
  onOpenDraft: (draftId: string) => void;
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
}) {
  const [slots, setSlots] = useState<PostingQueueSlot[]>([]);
  const [drafts, setDrafts] = useState<PostingQueueDraft[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [addingDay, setAddingDay] = useState<number | null>(null);
  const [dragOverOccurrence, setDragOverOccurrence] = useState<string | null>(
    null,
  );
  const [pickerTarget, setPickerTarget] =
    useState<(PostingQueueDropTarget & { label: string }) | null>(null);
  const [pickerDraftId, setPickerDraftId] = useState("");
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
    if (!response.ok || !data.ok) throw new Error(data.error || "Couldn't load posting queue.");
    setSlots(data.slots);
    setDrafts(data.drafts);
    setCollapsed(data.collapsed);
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

  const addSlot = async (dayOfWeek: number) => {
    try {
      const response = await fetch("/api/posting-slots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dayOfWeek, localTime: time, timezone }),
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
          (a, b) => a.dayOfWeek - b.dayOfWeek || a.localTime.localeCompare(b.localTime),
        ),
      );
      setAddingDay(null);
    } catch (error) {
      toast.error((error as Error).message);
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
      const response = await fetch(`/api/posting-slots?id=${encodeURIComponent(slot.id)}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || "Couldn't remove slot.");
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

  const dropDraft = (
    event: DragEvent<HTMLDivElement>,
    target: PostingQueueDropTarget,
  ) => {
    event.preventDefault();
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
    <section className="rounded-xl border border-border bg-card shadow-soft" aria-label="Posting queue">
      <button
        type="button"
        onClick={toggleCollapsed}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={!collapsed}
      >
        <CalendarClock className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Posting queue</span>
        <span className="text-xs text-muted-foreground">
          {slots.length === 0 ? "Add a recurring time to enable one-click scheduling." : "Your next 7 days"}
        </span>
        {collapsed ? (
          <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="ml-auto h-4 w-4 text-muted-foreground" />
        )}
      </button>
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
                  className={cn("min-h-32 p-2", day.isToday && "bg-primary/[0.04]")}
                >
                  <div className="flex items-start justify-between gap-1">
                    <div>
                      <div className="text-xs font-semibold">{day.weekday}</div>
                      <div className="text-[11px] text-muted-foreground">{day.dateLabel}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAddingDay(daySlots[0]?.dayOfWeek ?? new Date(`${day.date}T12:00:00.000Z`).getUTCDay())}
                      disabled={daySlots.length >= 3}
                      className="rounded p-1 text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                      aria-label={`Add slot on ${day.weekday}`}
                      title={daySlots.length >= 3 ? "Maximum three slots per day" : "Add posting slot"}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {day.occurrences.map((occurrence) => {
                      const occurrenceKey = `${occurrence.slot.id}:${day.date}`;
                      const isDropTarget =
                        dragOverOccurrence === occurrenceKey &&
                        !occurrence.draft;
                      const timeLabel = new Intl.DateTimeFormat(undefined, {
                        timeZone: occurrence.slot.timezone,
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(new Date(occurrence.scheduledAt));
                      return (
                        <div
                          key={occurrence.slot.id}
                          role="group"
                          aria-label={`${day.weekday}, ${day.dateLabel} at ${timeLabel} posting slot`}
                          onDragEnter={(event) => {
                            if (!occurrence.draft) {
                              event.preventDefault();
                              setDragOverOccurrence(occurrenceKey);
                            }
                          }}
                          onDragOver={(event) => {
                            if (!occurrence.draft) {
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
                            if (occurrence.draft) return;
                            void dropDraft(event, {
                              postingSlotId: occurrence.slot.id,
                              postingSlotOccurrenceDate: day.date,
                              timezone: occurrence.slot.timezone,
                            });
                          }}
                          className={cn(
                            "group rounded-lg border bg-background/80 px-2 py-1.5 transition-colors",
                            !occurrence.draft &&
                              "border-dashed hover:border-primary/40",
                            isDropTarget &&
                              "border-primary bg-primary/[0.08] ring-2 ring-primary/20",
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
                                onClick={() => onOpenDraft(occurrence.draft!.id)}
                                className="min-w-0 flex-1 truncate text-left text-[11px] text-primary hover:underline"
                                title={occurrence.draft.title || "Untitled post"}
                              >
                                {occurrence.draft.title || "Untitled post"}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void removeDraftFromQueue(occurrence.draft!)
                                }
                                disabled={
                                  removingDraftId !== null ||
                                  occurrence.draft.scheduleStatus === "publishing"
                                }
                                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-40"
                                aria-label={`Remove ${
                                  occurrence.draft.title || "untitled post"
                                } from queue`}
                                title={
                                  occurrence.draft.scheduleStatus === "publishing"
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
                                isDropTarget && "font-medium text-primary",
                              )}
                            >
                              <span>
                                {schedulingDraftId && isDropTarget ? (
                                  <span className="inline-flex items-center gap-1">
                                    <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
                                    Scheduling…
                                  </span>
                                ) : isDropTarget ? (
                                  "Drop post here"
                                ) : (
                                  "Open · Drop a post"
                                )}
                              </span>
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
                    {day.occurrences.length === 0 && !day.noSlotsLeftToday && (
                      <p className="text-[10px] text-muted-foreground">No slots</p>
                    )}
                  </div>
                  {addingDay === new Date(`${day.date}T12:00:00.000Z`).getUTCDay() && (
                    <div className="mt-2 flex gap-1">
                      <input
                        type="time"
                        value={time}
                        onChange={(event) => setTime(event.target.value)}
                        className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1 text-[11px]"
                        aria-label={`New ${day.weekday} posting time`}
                      />
                      <Button size="sm" className="h-7 px-2 text-[11px]" onClick={() => void addSlot(addingDay)}>
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
    </section>
  );
}

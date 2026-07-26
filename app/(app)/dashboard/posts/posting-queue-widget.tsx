"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  buildPostingQueueDays,
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
}: {
  onOpenDraft: (draftId: string) => void;
}) {
  const [slots, setSlots] = useState<PostingQueueSlot[]>([]);
  const [drafts, setDrafts] = useState<PostingQueueDraft[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [addingDay, setAddingDay] = useState<number | null>(null);
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
    const occupied = drafts.some(
      (draft) =>
        draft.postingSlotId === slot.id &&
        (draft.scheduleStatus === "scheduled" || draft.scheduleStatus === "failed"),
    );
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
                    {day.occurrences.map((occurrence) => (
                      <div
                        key={occurrence.slot.id}
                        className="group rounded-lg border bg-background/80 px-2 py-1.5"
                      >
                        <div className="flex items-center gap-1">
                          <span className="text-[11px] font-medium">
                            {new Intl.DateTimeFormat(undefined, {
                              timeZone: occurrence.slot.timezone,
                              hour: "numeric",
                              minute: "2-digit",
                            }).format(new Date(occurrence.scheduledAt))}
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
                          <button
                            type="button"
                            onClick={() => onOpenDraft(occurrence.draft!.id)}
                            className="mt-0.5 block w-full truncate text-left text-[11px] text-primary hover:underline"
                            title={occurrence.draft.title || "Untitled post"}
                          >
                            {occurrence.draft.title || "Untitled post"}
                          </button>
                        ) : (
                          <div className="text-[10px] text-muted-foreground">Open</div>
                        )}
                      </div>
                    ))}
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
    </section>
  );
}

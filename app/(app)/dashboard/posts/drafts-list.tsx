"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import {
  Search,
  Calendar,
  CalendarClock,
  AlertCircle,
  Plus,
  LayoutGrid,
  ChevronLeft,
  ChevronRight,
  Paperclip,
  Link as LinkIcon,
  Gift,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  byId,
  removeById,
  reinsertById,
  patchById,
  restoreFieldById,
} from "@/lib/optimistic";
import type { PostPreviewAuthor } from "../draft-editor-modal";
import type {
  Draft,
  DraftKind,
  DraftStatus,
} from "@/lib/draft-view";
export type { Draft, DraftKind, DraftStatus, ScheduleStatus } from "@/lib/draft-view";
import {
  StatusPill,
  Surface,
  Toolbar,
  segmentedControlClass,
  segmentedItemClass,
} from "@/components/app-surface";

const DraftEditorModal = dynamic(
  () => import("../draft-editor-modal").then((mod) => mod.DraftEditorModal),
  { loading: () => null },
);

// Drafts pipeline board. Each saved post/hook (a chat_artifacts row) is a card
// in one of four columns — idea → drafting → ready → posted (migration 047).
// Move a card by dragging it to another column or via its status menu; both call
// the same PATCH. An optional "plan to post on" date sorts cards within a column.
// Client-side so move/edit/delete are optimistic with no full reload.

export type BoardColumnId = DraftStatus | "scheduled";

// Filter-toggle labels (the "Regular Post" internal value reads as "Posts").
const KIND_FILTER_LABEL: Record<"all" | DraftKind, string> = {
  all: "All",
  post: "Posts",
  lead_magnet: "Lead magnets",
  hook: "Hooks",
};

// The small colored badge shown on a board card for the non-regular kinds.
// A regular post gets no badge (it's the default); hooks + lead magnets are
// tagged so they stand out in a mixed column. Null = no badge.
function kindBadge(kind: DraftKind): { label: string; cls: string } | null {
  if (kind === "hook")
    return { label: "Hook", cls: "border-state-warning-border bg-state-warning-bg text-state-warning" };
  if (kind === "lead_magnet")
    return { label: "Lead Magnet", cls: "border-primary/15 bg-primary/[0.07] text-primary" };
  return null;
}

// A committed, timed LinkedIn publish (distinct from planToPostOn, the soft
// calendar date). Null scheduleStatus = planning-only. Lifecycle:
// scheduled → publishing → published | failed (set by the cron).

// Reconcile a fresh server snapshot into the current client list — ADD-ONLY.
// A router.refresh() (e.g. when a weekly batch files new drafts) passes a new
// `server` array; we prepend drafts present server-side but missing locally (the
// freshly-filed batch cards, newest-first) and keep every existing local card
// untouched, so an in-flight optimistic edit/drag isn't clobbered by a refresh.
// Returns the SAME reference when nothing is new (no needless re-render). Pure +
// exported for tests.
export function mergeServerDrafts(current: Draft[], server: Draft[]): Draft[] {
  const localIds = new Set(current.map((d) => d.id));
  const additions = server.filter((d) => !localIds.has(d.id));
  if (additions.length === 0) return current;
  return [...additions, ...current];
}

// Pure board model: filter by search query + kind, group by status, sort each
// column by planned date (soonest first, undated last) then recency. Extracted
// + exported so it's unit-testable independent of the React component.
export function groupDraftsForBoard(
  drafts: Draft[],
  query: string,
  kindFilter: "all" | DraftKind,
): Record<BoardColumnId, Draft[]> {
  const q = query.trim().toLowerCase();
  const groups: Record<BoardColumnId, Draft[]> = {
    idea: [],
    drafting: [],
    ready: [],
    scheduled: [],
    posted: [],
  };
  for (const d of drafts) {
    if (kindFilter !== "all" && d.kind !== kindFilter) continue;
    if (
      q &&
      !(d.title ?? "").toLowerCase().includes(q) &&
      !d.body.toLowerCase().includes(q)
    )
      continue;
    groups[boardColumnForDraft(d)].push(d);
  }
  for (const s of Object.keys(groups) as BoardColumnId[]) {
    groups[s].sort((a, b) => {
      if (a.planToPostOn && b.planToPostOn)
        return a.planToPostOn.localeCompare(b.planToPostOn);
      if (a.planToPostOn) return -1;
      if (b.planToPostOn) return 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }
  return groups;
}

export function boardColumnForDraft(draft: Draft): BoardColumnId {
  if (draft.scheduleStatus === "scheduled" || draft.scheduleStatus === "publishing") {
    return "scheduled";
  }
  if (draft.scheduleStatus === "published") {
    return "posted";
  }
  return draft.status;
}

// ---------------------------------------------------------------------------
// Calendar-view helpers (pure + exported so the month math is unit-tested).
// ---------------------------------------------------------------------------

// A local YYYY-MM-DD key for a Date (calendar day, local time).
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Bucket posts by their plan_to_post_on day, and collect undated ones. Filtered
// by the same search/kind filter as the board so the two views agree.
export function groupPostsByDay(
  drafts: Draft[],
  query: string,
  kindFilter: "all" | DraftKind,
): { byDay: Record<string, Draft[]>; unscheduled: Draft[] } {
  const q = query.trim().toLowerCase();
  const byDay: Record<string, Draft[]> = {};
  const unscheduled: Draft[] = [];
  for (const d of drafts) {
    if (kindFilter !== "all" && d.kind !== kindFilter) continue;
    if (
      q &&
      !(d.title ?? "").toLowerCase().includes(q) &&
      !d.body.toLowerCase().includes(q)
    )
      continue;
    if (d.planToPostOn) (byDay[d.planToPostOn] ??= []).push(d);
    else unscheduled.push(d);
  }
  return { byDay, unscheduled };
}

// The 6-week (42-cell) grid for a month, Monday-first, including the leading/
// trailing days from adjacent months so the grid is always full. Each cell
// carries its date, dayKey, and whether it's in the displayed month.
export function buildCalendarMonth(
  year: number,
  month: number, // 0-11
): { date: Date; key: string; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  // Monday-first offset: getDay() is 0=Sun..6=Sat → shift so Monday=0.
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  const cells: { date: Date; key: string; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ date: d, key: dayKey(d), inMonth: d.getMonth() === month });
  }
  return cells;
}

// Card background tint per status — same color language as the board's dots.
// Used for the calendar day chips.
export const STATUS_CHIP: Record<DraftStatus, string> = {
  idea: "bg-state-warning-bg text-state-warning border-state-warning-border",
  drafting: "bg-state-info-bg text-state-info border-state-info-border",
  ready: "bg-state-success-bg text-state-success border-state-success-border",
  posted: "bg-muted text-muted-foreground border-border/70",
};

// The columns, in pipeline order. `accent` tints the header so the stages read
// as a progression. Scheduled is display-only: scheduling requires choosing a
// date/time from the post drawer, so drag/drop never writes a "scheduled" status.
const COLUMNS: {
  id: BoardColumnId;
  moveStatus?: DraftStatus;
  label: string;
  description: string;
  accent: string;
  dot: string;
}[] = [
  {
    id: "idea",
    moveStatus: "idea",
    label: "Idea",
    description: "Capture raw angles before they become drafts.",
    accent: "text-state-warning",
    dot: "bg-state-warning",
  },
  {
    id: "drafting",
    moveStatus: "drafting",
    label: "Draft",
    description: "Edit drafts before approving them.",
    accent: "text-state-info",
    dot: "bg-state-info",
  },
  {
    id: "ready",
    moveStatus: "ready",
    label: "Ready",
    description: "Approved posts waiting for a publish plan.",
    accent: "text-state-success",
    dot: "bg-state-success",
  },
  {
    id: "scheduled",
    label: "Scheduled",
    description: "Posts queued to publish on LinkedIn.",
    accent: "text-primary",
    dot: "bg-primary",
  },
  {
    id: "posted",
    moveStatus: "posted",
    label: "Posted",
    description: "Published posts and completed work.",
    accent: "text-muted-foreground",
    dot: "bg-muted-foreground/45",
  },
];
const STATUS_LABEL: Record<DraftStatus, string> = {
  idea: "Idea",
  drafting: "Draft",
  ready: "Ready",
  posted: "Posted",
};
const STATUS_HELP: Record<BoardColumnId, string> = {
  idea: "Idea: a raw angle or hook that still needs drafting.",
  drafting: "Draft: a post still being written or edited.",
  ready: "Ready: reviewed and ready to schedule or publish.",
  scheduled: "Scheduled: queued to auto-publish on LinkedIn. Open the post to change the schedule.",
  posted: "Posted: already published or archived as done.",
};
const KIND_HELP: Record<DraftKind, string> = {
  post: "Regular Post: a standard thought-leadership or engagement post.",
  lead_magnet: "Lead Magnet Post: designed to drive replies, signups, or interest.",
  hook: "Hook: a short opening idea or angle, not a full post yet.",
};

export function DraftsList({
  initialDrafts,
  author,
}: {
  initialDrafts: Draft[];
  author: PostPreviewAuthor;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(initialDrafts);
  // Reconcile server refreshes into local state. `initialDrafts` is a mount-time
  // snapshot; a router.refresh() (e.g. when a weekly batch files new drafts)
  // re-runs the server component and passes a NEW initialDrafts prop, but a plain
  // useState initializer ignores prop changes — so the board never showed the
  // batch's drafts until a full page reload. This merges the incoming set in:
  // ADD drafts we don't have yet (the freshly-filed batch cards), and refresh the
  // server-owned fields of ones we do — WITHOUT clobbering a card the user is
  // optimistically editing (we keep locals not present server-side, e.g. a brand
  // new unsaved one, and don't overwrite while an edit is mid-flight elsewhere).
  useEffect(() => {
    // Syncing an external prop (the server snapshot) into local state IS the
    // sanctioned use of this pattern; mergeServerDrafts returns the same ref when
    // nothing's new, so there's no cascading-render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrafts((cur) => mergeServerDrafts(cur, initialDrafts));
  }, [initialDrafts]);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | DraftKind>("all");
  // The big editor modal. `null` draft = creating a new one; a Draft = editing
  // it. `editorOpen` drives the dialog so closing animates out before we drop
  // the target.
  const [editorOpen, setEditorOpen] = useState(false);
  // Board vs calendar view. Default to Kanban; the last choice is remembered in
  // localStorage so it sticks across visits. We MUST start at the SSR default
  // ("board") so the server and first client render agree (a localStorage read
  // in the initializer would mismatch and throw a hydration error). The saved
  // choice is applied right after mount, before paint, via useLayoutEffect-like
  // timing — using useEffect here is fine: the flash is one frame and only for a
  // user who previously chose calendar.
  const [view, setView] = useState<"board" | "calendar">("board");
  useEffect(() => {
    const saved = window.localStorage.getItem("swipein:posts-view");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved === "calendar") setView("calendar");
  }, []);
  const chooseView = (v: "board" | "calendar") => {
    setView(v);
    try {
      localStorage.setItem("swipein:posts-view", v);
    } catch {
      /* non-fatal */
    }
  };
  // Track the OPEN post by id (not a frozen copy) so the drawer always reflects
  // the live draft — optimistic title/status/date changes flow straight in.
  // `null` = the "new post" mode.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Which column a dragged card is hovering, for the drop highlight.
  const [dragOver, setDragOver] = useState<DraftStatus | null>(null);
  // Mobile: the board is one column at a time, selected by a tab strip. Default
  // to the first NON-EMPTY column (in pipeline order) so a mobile user never
  // lands on an empty "Drafting" while their drafts sit in Ready/Ideas. Falls
  // back to drafting when there are no drafts at all.
  const [mobileCol, setMobileCol] = useState<BoardColumnId>(
    () =>
      COLUMNS.find((c) => initialDrafts.some((d) => boardColumnForDraft(d) === c.id))
        ?.id ?? "drafting",
  );

  const remove = async (id: string) => {
    // Reconcile-don't-restore: capture the removed draft + index, and on failure
    // re-insert it into the CURRENT list (not a stale snapshot), so a concurrent
    // edit/delete during the await isn't clobbered. See lib/optimistic.ts.
    const removed = byId(drafts, id);
    setDrafts((d) => removeById(d, id)); // optimistic
    try {
      const res = await fetch(`/api/drafts/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to delete");
      toast.success("Post removed");
    } catch (e) {
      setDrafts((cur) => reinsertById(cur, removed)); // roll back, reconciled
      toast.error((e as Error).message);
    }
  };

  const applyEdit = (id: string, body: string) =>
    setDrafts((d) => d.map((x) => (x.id === id ? { ...x, body } : x)));

  // Optimistic merge of a property change (title / status / date) from the
  // detail drawer. The drawer fires the PATCH itself; this just keeps the board
  // in sync so the card name / dot / column update instantly. Also re-points the
  // mobile column when status changes so the moved card stays visible.
  const applyMeta = (id: string, patch: Partial<Draft>) => {
    // Derive the mobile column from the MERGED draft (via boardColumnForDraft
    // — the single source of truth this file already uses for the desktop
    // column grouping and the status dot), read out of the SAME functional
    // update as the patch itself — never the `drafts` closure. That closure
    // can be stale by the time an async caller's response lands (e.g.
    // ScheduleRow's cancel() captures onMeta before an overlapping
    // Status-dropdown change re-renders with a newer closure), which used to
    // snap the mobile tab back to a status the draft no longer has.
    let nextColumn: BoardColumnId | undefined;
    setDrafts((d) =>
      d.map((x) => {
        if (x.id !== id) return x;
        const merged = { ...x, ...patch };
        nextColumn = boardColumnForDraft(merged);
        return merged;
      }),
    );
    if (nextColumn) setMobileCol(nextColumn);
  };

  // A draft created on the board (via the modal). Prepend it so it's visible
  // immediately; the API already persisted it. New drafts land in "idea", so on
  // mobile we hop the column selector there so the user sees what they just made.
  const addDraft = (draft: Draft) => {
    setDrafts((d) => [draft, ...d]);
    setMobileCol(draft.status);
    setEditingId(draft.id);
  };

  const openNew = () => {
    setEditingId(null);
    setEditorOpen(true);
  };
  const openEdit = (draft: Draft) => {
    setEditingId(draft.id);
    setEditorOpen(true);
  };
  // The live draft for the open drawer, derived from `drafts` by id (so meta
  // edits reflect instantly). null when creating a new post.
  const editing = editingId ? drafts.find((d) => d.id === editingId) ?? null : null;

  // Move a card to a new status (optimistic; rolls back on failure). Shared by
  // the per-card status menu and drag-and-drop.
  const moveTo = async (id: string, status: DraftStatus) => {
    const card = drafts.find((x) => x.id === id);
    if (!card || card.status === status) return;
    // Reconcile-don't-restore: capture only the ONE field's prior value, not a
    // whole-list snapshot. On failure we revert just this card's status on the
    // CURRENT list, so a card deleted/moved elsewhere during the await isn't
    // resurrected or clobbered (the snapshot-restore bug — see lib/optimistic).
    const priorStatus = card.status;
    setDrafts((d) => patchById(d, id, { status }));
    try {
      const res = await fetch(`/api/drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to move");
      toast.success(`Moved to ${STATUS_LABEL[status]}`);
    } catch (e) {
      setDrafts((cur) => restoreFieldById(cur, id, "status", priorStatus));
      toast.error((e as Error).message);
    }
  };

  // Set/clear a post's planned date (optimistic). Used by calendar drag-to-
  // schedule (drop on a day) and the "remove from calendar" action.
  const setDate = async (id: string, date: string | null) => {
    const card = drafts.find((x) => x.id === id);
    if (!card || (card.planToPostOn ?? null) === date) return;
    // Reconcile-don't-restore (see moveTo): revert only planToPostOn on failure.
    const priorDate = card.planToPostOn ?? null;
    setDrafts((d) => patchById(d, id, { planToPostOn: date }));
    try {
      const res = await fetch(`/api/drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_to_post_on: date }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to schedule");
      toast.success(date ? "Planning date set" : "Planning date cleared");
    } catch (e) {
      setDrafts((cur) => restoreFieldById(cur, id, "planToPostOn", priorDate));
      toast.error((e as Error).message);
    }
  };

  // Filtered + grouped-by-status (pure helper, memoized).
  const byStatus = useMemo(
    () => groupDraftsForBoard(drafts, query, kindFilter),
    [drafts, query, kindFilter],
  );
  // Filtered + grouped-by-day for the calendar view.
  const calendar = useMemo(
    () => groupPostsByDay(drafts, query, kindFilter),
    [drafts, query, kindFilter],
  );
  const onDrop = (e: DragEvent, status: DraftStatus) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData("text/plain");
    if (id) void moveTo(id, status);
  };

  const cardFor = (d: Draft) => (
    <DraftCard
      key={d.id}
      draft={d}
      onOpen={() => openEdit(d)}
      onMove={(status) => void moveTo(d.id, status)}
      draggable={boardColumnForDraft(d) !== "scheduled"}
    />
  );
  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: search + kind filter */}
      <Toolbar className="flex flex-wrap items-center gap-2 p-2 sm:p-2.5">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search posts…"
            className="h-9 w-full rounded-xl border border-transparent bg-background/80 pl-8 pr-3 text-sm shadow-soft outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/25 focus:ring-2 focus:ring-ring/25"
          />
        </div>
        <div className={segmentedControlClass()}>
          {(["all", "post", "lead_magnet", "hook"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter(k)}
              title={k === "all" ? "Show every post type." : KIND_HELP[k]}
              className={segmentedItemClass(kindFilter === k)}
            >
              {KIND_FILTER_LABEL[k]}
            </button>
          ))}
        </div>
        {/* Board / Calendar view toggle. */}
        <div className={segmentedControlClass()}>
          <button
            type="button"
            onClick={() => chooseView("board")}
            title="Show posts grouped by pipeline status."
            className={segmentedItemClass(view === "board")}
            aria-pressed={view === "board"}
          >
            <LayoutGrid className="h-3.5 w-3.5" /> Board
          </button>
          <button
            type="button"
            onClick={() => chooseView("calendar")}
            title="Show planning dates and LinkedIn schedules on a calendar."
            className={segmentedItemClass(view === "calendar")}
            aria-pressed={view === "calendar"}
          >
            <Calendar className="h-3.5 w-3.5" /> Calendar
          </button>
        </div>
        <Button size="sm" className="gap-1.5 shrink-0" onClick={openNew}>
          <Plus className="h-4 w-4" /> New post
        </Button>
      </Toolbar>

      {view === "board" && (
        <>
          {/* Mobile column selector (the full board doesn't fit a phone). */}
          <div className="flex lg:hidden items-center gap-1 overflow-x-auto -mx-1 px-1">
            {COLUMNS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setMobileCol(c.id)}
                title={STATUS_HELP[c.id]}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  mobileCol === c.id
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-muted-foreground",
                )}
              >
                {c.label}{" "}
                <span className="opacity-70">({byStatus[c.id].length})</span>
              </button>
            ))}
          </div>

          {/* Mobile: a single selected column. */}
          <div className="lg:hidden flex flex-col gap-3">
            {(() => {
              const column = COLUMNS.find((c) => c.id === mobileCol) ?? COLUMNS[0];
              return (
                <div className="rounded-lg border border-border/60 bg-card/70 px-3 py-2.5 shadow-soft">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={cn("h-2 w-2 rounded-full", column.dot)} aria-hidden />
                        <span className={cn("text-sm font-semibold", column.accent)}>
                          {column.label}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-snug text-muted-foreground">
                        {column.description}
                      </p>
                    </div>
                    <span className="rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                      {byStatus[column.id].length}
                    </span>
                  </div>
                </div>
              );
            })()}
            <ColumnCards cards={byStatus[mobileCol]} renderCard={cardFor} />
          </div>

          {/* Desktop: the five-lane board. */}
          <div className="hidden lg:grid grid-cols-5 gap-3 items-start">
            {COLUMNS.map((c) => (
              <div
                key={c.id}
                onDragOver={(e) => {
                  if (!c.moveStatus) return;
                  e.preventDefault();
                  if (dragOver !== c.moveStatus) setDragOver(c.moveStatus);
                }}
                onDragLeave={(e) => {
                  if (!c.moveStatus) return;
                  // Only clear when the pointer actually leaves the COLUMN — not
                  // when it crosses onto a child card (relatedTarget still inside).
                  // Without this the highlight flickers as you drag over the cards.
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    const moveStatus = c.moveStatus;
                    setDragOver((s) => (s === moveStatus ? null : s));
                  }
                }}
                onDrop={(e) => {
                  if (!c.moveStatus) return;
                  onDrop(e, c.moveStatus);
                }}
                className={cn(
                  "rounded-xl border bg-card/70 p-2.5 flex flex-col gap-2 min-h-[220px] shadow-soft",
                  c.moveStatus && dragOver === c.moveStatus
                    ? "border-primary border-dashed bg-primary/5"
                    : "border-border/60",
                )}
              >
                <div className="flex items-start justify-between gap-2 rounded-xl border border-border/50 bg-background/55 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cn("h-2 w-2 rounded-full", c.dot)} aria-hidden />
                      <span className={cn("text-xs font-semibold", c.accent)} title={STATUS_HELP[c.id]}>
                        {c.label}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                      {c.description}
                    </p>
                  </div>
                  <span className="rounded-full border border-border/60 bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                    {byStatus[c.id].length}
                  </span>
                </div>
                <ColumnCards cards={byStatus[c.id]} renderCard={cardFor} />
              </div>
            ))}
          </div>
        </>
      )}

      {view === "calendar" && (
        <CalendarView
          byDay={calendar.byDay}
          unscheduled={calendar.unscheduled}
          onSchedule={setDate}
          onOpen={openEdit}
        />
      )}

      <DraftEditorModal
        open={editorOpen}
        onOpenChange={setEditorOpen}
        draft={editing}
        author={author}
        onCreated={addDraft}
        onSaved={applyEdit}
        onMeta={applyMeta}
        onDelete={remove}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar view: a month grid of planning dates (status-colored chips) plus a
// tray for posts with no planning date. Drag a chip from the tray onto a day to
// plan it; drag a day chip onto another day to move it, or onto the tray to
// clear the planning date.
// ---------------------------------------------------------------------------
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function CalendarView({
  byDay,
  unscheduled,
  onSchedule,
  onOpen,
}: {
  byDay: Record<string, Draft[]>;
  unscheduled: Draft[];
  onSchedule: (id: string, date: string | null) => void;
  onOpen: (draft: Draft) => void;
}) {
  // Start on the month of the soonest scheduled post, else today.
  const [cursor, setCursor] = useState(() => {
    const days = Object.keys(byDay).sort();
    const base = days[0] ? new Date(`${days[0]}T00:00:00`) : new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
  const [overTray, setOverTray] = useState(false);
  const todayKey = dayKey(new Date());
  const cells = buildCalendarMonth(cursor.year, cursor.month);

  const prevMonth = () =>
    setCursor((c) =>
      c.month === 0 ? { year: c.year - 1, month: 11 } : { ...c, month: c.month - 1 },
    );
  const nextMonth = () =>
    setCursor((c) =>
      c.month === 11 ? { year: c.year + 1, month: 0 } : { ...c, month: c.month + 1 },
    );

  const drag = (e: DragEvent, id: string) => {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Calendar */}
      <Surface className="flex-1 min-w-0" padding="sm">
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
          {WEEKDAYS.map((w) => (
            <div
              key={w}
              className="bg-muted/40 px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {w}
            </div>
          ))}
          {cells.map((cell) => {
            const posts = byDay[cell.key] ?? [];
            return (
              <div
                key={cell.key}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragOverDay !== cell.key) setDragOverDay(cell.key);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setDragOverDay((d) => (d === cell.key ? null : d));
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverDay(null);
                  const id = e.dataTransfer.getData("text/plain");
                  if (id) onSchedule(id, cell.key);
                }}
                className={cn(
                  "min-h-[96px] bg-background p-1.5 flex flex-col gap-1",
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
                {posts.map((p) => {
                  const onLinkedIn = boardColumnForDraft(p) === "scheduled";
                  const StatusIcon = onLinkedIn ? CalendarClock : Calendar;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      draggable
                      onDragStart={(e) => drag(e, p.id)}
                      onClick={() => onOpen(p)}
                      title={p.title ?? p.body.slice(0, 80)}
                      className={cn(
                        "flex items-center gap-1 rounded border px-1.5 py-0.5 text-left text-[11px] font-medium cursor-grab active:cursor-grabbing",
                        STATUS_CHIP[p.status],
                      )}
                    >
                      <StatusIcon
                        className={cn(
                          "h-3 w-3 shrink-0",
                          onLinkedIn && "text-primary",
                        )}
                        aria-label={
                          onLinkedIn ? "Scheduled on LinkedIn" : "Planned only"
                        }
                      />
                      <span className="truncate">
                        {(p.title ?? p.body.split("\n")[0]).slice(0, 40) ||
                          "Untitled"}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Drag posts here to set a planning date.</span>
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5" aria-hidden /> planned only
          </span>
          <span className="inline-flex items-center gap-1 text-primary">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden /> scheduled on LinkedIn
          </span>
        </div>
      </Surface>

      {/* Unscheduled tray */}
      <div
        onDragOver={(e) => {
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
          if (id) onSchedule(id, null); // drop on tray = clear the date
        }}
        className={cn(
          "lg:w-72 shrink-0 rounded-xl border bg-card/70 p-2.5 flex flex-col gap-2 shadow-soft",
          overTray ? "border-primary border-dashed bg-primary/5" : "border-border/60",
        )}
      >
        <div className="rounded-xl border border-border/50 bg-background/55 px-3 py-2 text-xs">
          <div className="font-semibold text-foreground">No planning date</div>
          <div className="mt-0.5 text-muted-foreground tabular-nums">
            {unscheduled.length} post{unscheduled.length === 1 ? "" : "s"}
          </div>
        </div>
        {unscheduled.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/60 bg-background/45 px-3 py-8 text-center text-xs text-muted-foreground">
            Every post has a planning date. Drag a post here to clear it.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto">
            {unscheduled.map((p) => (
              <button
                key={p.id}
                type="button"
                draggable
                onDragStart={(e) => drag(e, p.id)}
                onClick={() => onOpen(p)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border bg-card px-2.5 py-2 text-left text-[13px] font-medium cursor-grab active:cursor-grabbing hover:bg-accent/40",
                  "border-border/60",
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    STATUS_DOT[p.status],
                  )}
                />
                <span className="min-w-0 flex-1 truncate">
                  {(p.title ?? "").trim() || p.body.split("\n")[0].slice(0, 40) || "Untitled"}
                </span>
                {(() => {
                  const b = kindBadge(p.kind);
                  return b ? (
                    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", b.cls)}>
                      {b.label}
                    </span>
                  ) : null;
                })()}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// How many cards a column shows before collapsing the rest behind "Show more".
// Keeps a busy column (e.g. 20 Ready posts) from becoming an endless scroll —
// the Notion board pattern.
export const COLUMN_PREVIEW_COUNT = 10;

// Decide a column's collapse state. Pure + exported so the threshold/slice is
// unit-testable without rendering. `visibleCount` is how many cards to show,
// `overflow` is how many are hidden when collapsed (the "Show N more" number;
// 0 means no toggle).
export function columnCollapse(
  total: number,
  expanded: boolean,
): { visibleCount: number; overflow: number } {
  const overflow = Math.max(0, total - COLUMN_PREVIEW_COUNT);
  const visibleCount = expanded || overflow === 0 ? total : COLUMN_PREVIEW_COUNT;
  return { visibleCount, overflow };
}

// Renders a column's cards with a collapse: the first COLUMN_PREVIEW_COUNT are
// always shown; the rest hide behind a "Show N more" toggle (per column, so each
// expands independently). Empty → the dashed placeholder.
function ColumnCards({
  cards,
  renderCard,
}: {
  cards: Draft[];
  renderCard: (d: Draft) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (cards.length === 0) return <EmptyColumn />;

  const { visibleCount, overflow } = columnCollapse(cards.length, expanded);
  const visible = cards.slice(0, visibleCount);

  return (
    <>
      {visible.map((d) => renderCard(d))}
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 w-full rounded-lg border border-border/60 bg-background py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {expanded ? "Show less" : `Show ${overflow} more`}
        </button>
      )}
    </>
  );
}

function EmptyColumn() {
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-background/45 px-3 py-8 text-center text-xs text-muted-foreground">
      No posts in this lane
    </div>
  );
}

// A status → dot-color map so the minimal card carries a glance-able stage cue
// (the column already groups by status, but the dot helps on the mobile single-
// column view and reinforces the pipeline color language).
const STATUS_DOT: Record<BoardColumnId, string> = {
  idea: "bg-state-warning",
  drafting: "bg-state-info",
  ready: "bg-state-success",
  scheduled: "bg-primary",
  posted: "bg-muted-foreground/40",
};

function formatShortDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = value.includes("T") ? new Date(value) : new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// The board card, Notion-minimal: just the post's preview name (title), a small
// status dot, and the hook tag. Everything else — body editing, status, due
// date, rename, copy, delete, Model in Chat — lives in the detail drawer that
// opens on click. The whole card is the open target; it stays draggable for
// column moves.
function DraftCard({
  draft,
  onOpen,
  onMove,
  draggable: canDrag,
}: {
  draft: Draft;
  onOpen: () => void;
  onMove: (status: DraftStatus) => void;
  draggable: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Keyboard-accessible lane moves (drag-and-drop is mouse-only): a small
  // "Move to" menu per card. Focus shows it, just like hover.
  const [moveOpen, setMoveOpen] = useState(false);
  const moveTriggerRef = useRef<HTMLButtonElement>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (moveOpen) {
      moveMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
  }, [moveOpen]);
  const onMoveMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMoveOpen(false);
      moveTriggerRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = Array.from(
        moveMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
      );
      if (items.length === 0) return;
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "ArrowDown"
          ? (idx + 1) % items.length
          : (idx - 1 + items.length) % items.length;
      items[next]?.focus();
      return;
    }
    if (e.key === "Tab") setMoveOpen(false);
  };

  // Fall back to a body-derived label if the title is somehow empty, so a card
  // is never blank.
  const name =
    (draft.title ?? "").trim() ||
    draft.body.split("\n")[0].slice(0, 80).trim() ||
    "Untitled post";
  const preview = draft.body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  const plannedDate = formatShortDate(draft.planToPostOn);
  const scheduledDate = formatShortDate(draft.scheduledAt);
  const publishedDate = formatShortDate(draft.publishedAt);
  const mediaCount = draft.mediaAttachments?.length ?? 0;
  const badge = kindBadge(draft.kind);
  const column = boardColumnForDraft(draft);

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      draggable={canDrag}
      onDragStart={(e) => {
        if (!canDrag) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData("text/plain", draft.id);
        e.dataTransfer.effectAllowed = "move";
        if (cardRef.current) {
          e.dataTransfer.setDragImage(cardRef.current, 20, 20);
        }
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        "group relative rounded-xl border border-border/60 bg-card px-3 py-3 text-card-foreground shadow-soft",
        "cursor-pointer transition-colors hover:border-primary/20 hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35",
        draft.status === "posted" && !dragging && "opacity-70",
        canDrag ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        dragging && "opacity-40",
      )}
      title={`Open post. ${STATUS_HELP[column]}`}
    >
      {/* "Move to" menu — the keyboard/touch alternative to drag-and-drop.
          Visible on hover, on card focus, and while its trigger is focused. */}
      <div className="absolute right-2 top-2">
        <button
          ref={moveTriggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={moveOpen}
          aria-label={`Move ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            setMoveOpen((v) => !v);
          }}
          onKeyDown={(e) => {
            // Keep the card's Enter/Space → open behavior from firing.
            if (e.key === "Enter" || e.key === " ") e.stopPropagation();
          }}
          className="grid size-7 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 group-hover:opacity-100 group-focus-within:opacity-100 data-[open]:opacity-100"
          data-open={moveOpen || undefined}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {moveOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={(e) => {
                e.stopPropagation();
                setMoveOpen(false);
              }}
              aria-hidden="true"
            />
            <div
              ref={moveMenuRef}
              role="menu"
              aria-label={`Move ${name} to`}
              onKeyDown={onMoveMenuKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-full z-50 mt-1 min-w-36 rounded-lg border border-border/60 bg-card py-1 shadow-soft-lg"
            >
              {COLUMNS.filter((c) => c.moveStatus && c.id !== column).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoveOpen(false);
                    onMove(c.moveStatus!);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                >
                  <span className={cn("h-2 w-2 rounded-full", c.dot)} aria-hidden />
                  Move to {c.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex items-start gap-2.5">
        <span
          className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", STATUS_DOT[column])}
          title={STATUS_HELP[column]}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2 pr-7">
            <span className="min-w-0 flex-1 text-[13px] font-semibold leading-5 tracking-tight">
              {name}
            </span>
            {badge && (
              <span
                className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", badge.cls)}
                title={KIND_HELP[draft.kind]}
              >
                {badge.label}
              </span>
            )}
          </div>
          {preview && (
            <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
              {preview}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {draft.scheduleStatus === "scheduled" || draft.scheduleStatus === "publishing" ? (
              <StatusPill tone="info" title="Scheduled to auto-publish on LinkedIn.">
                <CalendarClock className="h-3 w-3" aria-hidden />
                {draft.scheduleStatus === "publishing" ? "Publishing" : scheduledDate ?? "Scheduled"}
              </StatusPill>
            ) : draft.scheduleStatus === "published" ? (
              <StatusPill tone="success" title="Published on LinkedIn.">
                <CalendarClock className="h-3 w-3" aria-hidden />
                {publishedDate ?? "Published"}
              </StatusPill>
            ) : draft.scheduleStatus === "failed" ? (
              <StatusPill tone="danger" title="LinkedIn publishing failed. Open the post to reschedule.">
                <AlertCircle className="h-3 w-3" aria-hidden />
                Failed
              </StatusPill>
            ) : plannedDate ? (
              <StatusPill tone="neutral" title="Planning date only. Open the post to schedule publishing.">
                <Calendar className="h-3 w-3" aria-hidden />
                {plannedDate}
              </StatusPill>
            ) : null}
            {mediaCount > 0 && (
              <StatusPill tone="neutral" title={`${mediaCount} media attachment${mediaCount === 1 ? "" : "s"}`}>
                <Paperclip className="h-3 w-3" aria-hidden />
                {mediaCount}
              </StatusPill>
            )}
            {draft.leadMagnet && (
              <StatusPill
                tone="brand"
                title={`Lead magnet giveaway: ${draft.leadMagnet.title}`}
              >
                <Gift className="h-3 w-3" aria-hidden />
                Giveaway
              </StatusPill>
            )}
            {draft.sourceUrl && (
              <StatusPill tone="neutral" title="Modeled from a source post.">
                <LinkIcon className="h-3 w-3" aria-hidden />
                Source
              </StatusPill>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

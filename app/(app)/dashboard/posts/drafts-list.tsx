"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import {
  FileText,
  Search,
  Calendar,
  CalendarClock,
  AlertCircle,
  Plus,
  LayoutGrid,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { byId, removeById, reinsertById } from "@/lib/optimistic";
import { DraftEditorModal } from "../draft-editor-modal";

// Drafts pipeline board. Each saved post/hook (a chat_artifacts row) is a card
// in one of four columns — idea → drafting → ready → posted (migration 047).
// Move a card by dragging it to another column or via its status menu; both call
// the same PATCH. An optional "plan to post on" date sorts cards within a column.
// Client-side so move/edit/delete are optimistic with no full reload.

export type DraftStatus = "idea" | "drafting" | "ready" | "posted";

export type DraftKind = "post" | "hook" | "lead_magnet";

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
    return { label: "hook", cls: "bg-amber-100 text-amber-700" };
  if (kind === "lead_magnet")
    return { label: "lead magnet", cls: "bg-primary/10 text-primary" };
  return null;
}

// A committed, timed LinkedIn publish (distinct from planToPostOn, the soft
// calendar date). Null scheduleStatus = planning-only. Lifecycle:
// scheduled → publishing → published | failed (set by the cron).
export type ScheduleStatus =
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | null;

export type Draft = {
  id: string;
  title: string | null;
  body: string;
  kind: DraftKind;
  status: DraftStatus;
  planToPostOn: string | null; // YYYY-MM-DD
  chatId: string | null;
  createdAt: string;
  // For a draft the weekly batch adapted from a real post: the source post's
  // URL, so the card can show an "Adapted from ↗" link. Null for hand-authored
  // or chat-saved drafts (they weren't adapted from a specific post).
  sourceUrl?: string | null;
  // LinkedIn auto-publish schedule (via Zernio). scheduledAt is a precise ISO
  // instant; publishedAt is stamped by the cron on a successful publish (so the
  // card can read "Published at …" instead of the picker); publishError carries
  // a human message on a failed run.
  scheduledAt?: string | null;
  scheduleStatus?: ScheduleStatus;
  firstComment?: string | null;
  publishedAt?: string | null;
  publishError?: string | null;
};

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
): Record<DraftStatus, Draft[]> {
  const q = query.trim().toLowerCase();
  const groups: Record<DraftStatus, Draft[]> = {
    idea: [],
    drafting: [],
    ready: [],
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
    groups[d.status].push(d);
  }
  for (const s of Object.keys(groups) as DraftStatus[]) {
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
  idea: "bg-amber-100 text-amber-900 border-amber-200",
  drafting: "bg-blue-100 text-blue-900 border-blue-200",
  ready: "bg-emerald-100 text-emerald-900 border-emerald-200",
  posted: "bg-muted text-muted-foreground border-border",
};

// The columns, in pipeline order. `accent` tints the header so the stages read
// as a progression.
const COLUMNS: { status: DraftStatus; label: string; accent: string }[] = [
  { status: "idea", label: "Ideas & hooks", accent: "text-amber-600" },
  { status: "drafting", label: "Drafting", accent: "text-blue-600" },
  { status: "ready", label: "Ready", accent: "text-emerald-600" },
  { status: "posted", label: "Posted", accent: "text-muted-foreground" },
];
const STATUS_LABEL: Record<DraftStatus, string> = {
  idea: "Ideas & hooks",
  drafting: "Drafting",
  ready: "Ready",
  posted: "Posted",
};

export function DraftsList({
  initialDrafts,
}: {
  initialDrafts: Draft[];
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
  const [mobileCol, setMobileCol] = useState<DraftStatus>(
    () =>
      COLUMNS.find((c) => initialDrafts.some((d) => d.status === c.status))
        ?.status ?? "drafting",
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
    setDrafts((d) => d.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    if (patch.status) setMobileCol(patch.status);
  };

  // A draft created on the board (via the modal). Prepend it so it's visible
  // immediately; the API already persisted it. New drafts land in "idea", so on
  // mobile we hop the column selector there so the user sees what they just made.
  const addDraft = (draft: Draft) => {
    setDrafts((d) => [draft, ...d]);
    setMobileCol(draft.status);
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
    const prev = drafts;
    setDrafts((d) => d.map((x) => (x.id === id ? { ...x, status } : x)));
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
      setDrafts(prev);
      toast.error((e as Error).message);
    }
  };

  // Set/clear a post's planned date (optimistic). Used by calendar drag-to-
  // schedule (drop on a day) and the "remove from calendar" action.
  const setDate = async (id: string, date: string | null) => {
    const card = drafts.find((x) => x.id === id);
    if (!card || (card.planToPostOn ?? null) === date) return;
    const prev = drafts;
    setDrafts((d) => d.map((x) => (x.id === id ? { ...x, planToPostOn: date } : x)));
    try {
      const res = await fetch(`/api/drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_to_post_on: date }),
      });
      const data = await res.json();
      // This sets a PLANNING date only (plan_to_post_on) — it does NOT publish.
      // "Planned" keeps that distinct from a real auto-publish ("Scheduled"),
      // which is the "Publish at" control in the editor. Same word for both was
      // the #1 confusion: a dragged card looked like it would post itself.
      if (!data.ok) throw new Error(data.error || "Failed to set the date");
      toast.success(date ? "Planned" : "Date cleared");
    } catch (e) {
      setDrafts(prev);
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

  if (drafts.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center justify-center text-center gap-3 py-20 border border-dashed border-border/60 rounded-xl">
          <div className="h-12 w-12 rounded-xl bg-accent flex items-center justify-center">
            <FileText className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">No posts yet</p>
          <p className="text-sm text-muted-foreground max-w-sm">
            Write one now, or generate a post in the chat and hit{" "}
            <span className="font-medium">Save draft</span>. Either way it lands
            here, ready to move through your pipeline.
          </p>
          <Button size="sm" className="gap-1.5 mt-1" onClick={openNew}>
            <Plus className="h-4 w-4" /> New post
          </Button>
        </div>
        <DraftEditorModal
          open={editorOpen}
          onOpenChange={setEditorOpen}
          draft={editing}
          onCreated={addDraft}
          onSaved={applyEdit}
          onMeta={applyMeta}
          onDelete={remove}
        />
      </>
    );
  }

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
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: search + kind filter */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search posts…"
            className="w-full rounded-lg border border-input bg-background pl-8 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
        <div className="flex items-center rounded-lg border border-input p-0.5 text-xs">
          {(["all", "post", "lead_magnet", "hook"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter(k)}
              className={cn(
                "px-2.5 py-1 rounded-md font-medium transition-colors",
                kindFilter === k
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {KIND_FILTER_LABEL[k]}
            </button>
          ))}
        </div>
        {/* Board / Calendar view toggle. */}
        <div className="flex items-center rounded-lg border border-input p-0.5 text-xs">
          <button
            type="button"
            onClick={() => chooseView("board")}
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-medium transition-colors",
              view === "board"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={view === "board"}
          >
            <LayoutGrid className="h-3.5 w-3.5" /> Board
          </button>
          <button
            type="button"
            onClick={() => chooseView("calendar")}
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-medium transition-colors",
              view === "calendar"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={view === "calendar"}
          >
            <Calendar className="h-3.5 w-3.5" /> Calendar
          </button>
        </div>
        <Button size="sm" className="gap-1.5 shrink-0" onClick={openNew}>
          <Plus className="h-4 w-4" /> New post
        </Button>
      </div>

      {view === "board" && (
        <>
          {/* Mobile column selector (the 4-column board doesn't fit a phone). */}
          <div className="flex lg:hidden items-center gap-1 overflow-x-auto -mx-1 px-1">
            {COLUMNS.map((c) => (
              <button
                key={c.status}
                type="button"
                onClick={() => setMobileCol(c.status)}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  mobileCol === c.status
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-muted-foreground",
                )}
              >
                {c.label}{" "}
                <span className="opacity-70">({byStatus[c.status].length})</span>
              </button>
            ))}
          </div>

          {/* Mobile: a single selected column. */}
          <div className="lg:hidden flex flex-col gap-3">
            <ColumnCards cards={byStatus[mobileCol]} renderCard={cardFor} />
          </div>

          {/* Desktop: the four-column board. */}
          <div className="hidden lg:grid grid-cols-4 gap-3 items-start">
            {COLUMNS.map((c) => (
              <div
                key={c.status}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragOver !== c.status) setDragOver(c.status);
                }}
                onDragLeave={(e) => {
                  // Only clear when the pointer actually leaves the COLUMN — not
                  // when it crosses onto a child card (relatedTarget still inside).
                  // Without this the highlight flickers as you drag over the cards.
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setDragOver((s) => (s === c.status ? null : s));
                  }
                }}
                onDrop={(e) => onDrop(e, c.status)}
                className={cn(
                  "rounded-xl border bg-muted/30 p-2 flex flex-col gap-2 min-h-[120px]",
                  dragOver === c.status ? "border-primary border-dashed bg-primary/5" : "border-border/60",
                )}
              >
                <div className="flex items-center justify-between px-1 pt-1">
                  <span className={cn("text-xs font-semibold", c.accent)}>{c.label}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {byStatus[c.status].length}
                  </span>
                </div>
                <ColumnCards cards={byStatus[c.status]} renderCard={cardFor} />
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
        onCreated={addDraft}
        onSaved={applyEdit}
        onMeta={applyMeta}
        onDelete={remove}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar view: a month grid of dated posts (status-colored chips) plus an
// "Unscheduled" tray. Drag a chip from the tray onto a day to schedule it; drag
// a day chip onto another day to move it, or onto the tray to unschedule.
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
      <div className="flex-1 min-w-0">
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
                {posts.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    draggable
                    onDragStart={(e) => drag(e, p.id)}
                    onClick={() => onOpen(p)}
                    title={p.title ?? p.body.slice(0, 80)}
                    className={cn(
                      "truncate rounded border px-1.5 py-0.5 text-left text-[11px] font-medium cursor-grab active:cursor-grabbing",
                      STATUS_CHIP[p.status],
                    )}
                  >
                    {(p.title ?? p.body.split("\n")[0]).slice(0, 40) || "Untitled"}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Drag a post from Not planned onto a day to pencil in a date. Drag a
          day&apos;s post to another day to move it. (To auto-publish at a set
          time, open a post and use Publish&nbsp;to&nbsp;LinkedIn.)
        </p>
      </div>

      {/* "Not planned" tray — posts with no planning date yet. */}
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
          "lg:w-64 shrink-0 rounded-xl border bg-muted/30 p-2 flex flex-col gap-2",
          overTray ? "border-primary border-dashed bg-primary/5" : "border-border/60",
        )}
      >
        <div className="px-1 pt-1 text-xs font-semibold text-muted-foreground">
          Not planned{" "}
          <span className="tabular-nums">({unscheduled.length})</span>
        </div>
        {unscheduled.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/50 py-6 text-center text-xs text-muted-foreground">
            Everything has a date. Drag a post here to remove its date.
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
    <div className="rounded-lg border border-dashed border-border/50 py-6 text-center text-xs text-muted-foreground">
      Nothing here
    </div>
  );
}

// A status → dot-color map so the minimal card carries a glance-able stage cue
// (the column already groups by status, but the dot helps on the mobile single-
// column view and reinforces the pipeline color language).
const STATUS_DOT: Record<DraftStatus, string> = {
  idea: "bg-amber-500",
  drafting: "bg-blue-500",
  ready: "bg-emerald-500",
  posted: "bg-muted-foreground/40",
};

// The board card, Notion-minimal: just the post's preview name (title), a small
// status dot, and the hook tag. Everything else — body editing, status, due
// date, rename, copy, delete, Model in Chat — lives in the detail drawer that
// opens on click. The whole card is the open target; it stays draggable for
// column moves.
function DraftCard({
  draft,
  onOpen,
}: {
  draft: Draft;
  onOpen: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  // Fall back to a body-derived label if the title is somehow empty, so a card
  // is never blank.
  const name =
    (draft.title ?? "").trim() ||
    draft.body.split("\n")[0].slice(0, 80).trim() ||
    "Untitled post";

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
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", draft.id);
        e.dataTransfer.effectAllowed = "move";
        if (cardRef.current) {
          e.dataTransfer.setDragImage(cardRef.current, 20, 20);
        }
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        "group flex items-center gap-2.5 rounded-lg border border-border/60 bg-card px-3 py-2.5 text-card-foreground shadow-sm",
        "cursor-pointer hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        draft.status === "posted" && !dragging && "opacity-70",
        dragging && "opacity-40",
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[draft.status])}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">
        {name}
      </span>
      {/* Schedule indicator: a real LinkedIn auto-publish (scheduled/publishing)
          shows a primary clock; a failed publish shows a destructive alert; a
          planning-only date keeps the plain calendar. Real schedule wins. */}
      {draft.scheduleStatus === "scheduled" || draft.scheduleStatus === "publishing" ? (
        <CalendarClock
          className="h-3.5 w-3.5 shrink-0 text-primary"
          aria-label="Scheduled to publish"
        />
      ) : draft.scheduleStatus === "failed" ? (
        <AlertCircle
          className="h-3.5 w-3.5 shrink-0 text-destructive"
          aria-label="Publish failed"
        />
      ) : draft.planToPostOn ? (
        <Calendar className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      ) : null}
      {(() => {
        const b = kindBadge(draft.kind);
        return b ? (
          <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", b.cls)}>
            {b.label}
          </span>
        ) : null;
      })()}
    </div>
  );
}

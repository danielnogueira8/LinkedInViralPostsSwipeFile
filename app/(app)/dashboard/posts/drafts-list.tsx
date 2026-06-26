"use client";

import { useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { FileText, Search, Calendar, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DraftEditorModal } from "../draft-editor-modal";

// Drafts pipeline board. Each saved post/hook (a chat_artifacts row) is a card
// in one of four columns — idea → drafting → ready → posted (migration 047).
// Move a card by dragging it to another column or via its status menu; both call
// the same PATCH. An optional "plan to post on" date sorts cards within a column.
// Client-side so move/edit/delete are optimistic with no full reload.

export type DraftStatus = "idea" | "drafting" | "ready" | "posted";

export type Draft = {
  id: string;
  title: string | null;
  body: string;
  kind: "post" | "hook";
  status: DraftStatus;
  planToPostOn: string | null; // YYYY-MM-DD
  chatId: string | null;
  createdAt: string;
};

// Pure board model: filter by search query + kind, group by status, sort each
// column by planned date (soonest first, undated last) then recency. Extracted
// + exported so it's unit-testable independent of the React component.
export function groupDraftsForBoard(
  drafts: Draft[],
  query: string,
  kindFilter: "all" | "post" | "hook",
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
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "post" | "hook">("all");
  // The big editor modal. `null` draft = creating a new one; a Draft = editing
  // it. `editorOpen` drives the dialog so closing animates out before we drop
  // the target.
  const [editorOpen, setEditorOpen] = useState(false);
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
    const prev = drafts;
    setDrafts((d) => d.filter((x) => x.id !== id)); // optimistic
    try {
      const res = await fetch(`/api/drafts/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to delete");
      toast.success("Post removed");
    } catch (e) {
      setDrafts(prev); // roll back
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

  // Filtered + grouped-by-status (pure helper, memoized).
  const byStatus = useMemo(
    () => groupDraftsForBoard(drafts, query, kindFilter),
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
          {(["all", "post", "hook"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter(k)}
              className={cn(
                "px-2.5 py-1 rounded-md font-medium transition-colors capitalize",
                kindFilter === k
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "all" ? "All" : k === "post" ? "Posts" : "Hooks"}
            </button>
          ))}
        </div>
        <Button size="sm" className="gap-1.5 shrink-0" onClick={openNew}>
          <Plus className="h-4 w-4" /> New post
        </Button>
      </div>

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

// How many cards a column shows before collapsing the rest behind "Show more".
// Keeps a busy column (e.g. 20 Ready posts) from becoming an endless scroll —
// the Notion board pattern.
export const COLUMN_PREVIEW_COUNT = 5;

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
      {draft.planToPostOn && (
        <Calendar className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      )}
      {draft.kind === "hook" && (
        <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
          hook
        </span>
      )}
    </div>
  );
}

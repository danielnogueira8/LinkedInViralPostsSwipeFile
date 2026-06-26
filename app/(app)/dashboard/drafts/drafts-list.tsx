"use client";

import { useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import {
  Copy,
  Check,
  Trash2,
  FileText,
  Pencil,
  Search,
  Calendar,
  GripVertical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AvatarImg } from "@/components/avatar-img";
import { cn } from "@/lib/utils";
import { renderRichText, type Author } from "../chat-workspace";
import { DraftEditor } from "../draft-editor";

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
  author,
  initialDrafts,
}: {
  author: Author;
  initialDrafts: Draft[];
}) {
  const [drafts, setDrafts] = useState<Draft[]>(initialDrafts);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "post" | "hook">("all");
  // Which column a dragged card is hovering, for the drop highlight.
  const [dragOver, setDragOver] = useState<DraftStatus | null>(null);
  // Mobile: the board is one column at a time, selected by a tab strip.
  const [mobileCol, setMobileCol] = useState<DraftStatus>("drafting");

  const remove = async (id: string) => {
    const prev = drafts;
    setDrafts((d) => d.filter((x) => x.id !== id)); // optimistic
    try {
      const res = await fetch(`/api/drafts/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to delete");
      toast.success("Draft removed");
    } catch (e) {
      setDrafts(prev); // roll back
      toast.error((e as Error).message);
    }
  };

  const applyEdit = (id: string, body: string) =>
    setDrafts((d) => d.map((x) => (x.id === id ? { ...x, body } : x)));

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

  const setPlanDate = async (id: string, date: string | null) => {
    const prev = drafts;
    setDrafts((d) => d.map((x) => (x.id === id ? { ...x, planToPostOn: date } : x)));
    try {
      const res = await fetch(`/api/drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_to_post_on: date }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update date");
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
      <div className="flex flex-col items-center justify-center text-center gap-3 py-20 border border-dashed border-border/60 rounded-xl">
        <div className="h-12 w-12 rounded-xl bg-accent flex items-center justify-center">
          <FileText className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">No saved drafts yet</p>
        <p className="text-sm text-muted-foreground max-w-sm">
          When the chat generates a post, hit <span className="font-medium">Save draft</span>{" "}
          and it&apos;ll show up here, ready to move through your pipeline.
        </p>
      </div>
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
      author={author}
      onDelete={() => remove(d.id)}
      onSaved={(body) => applyEdit(d.id, body)}
      onMove={(s) => moveTo(d.id, s)}
      onSetDate={(date) => setPlanDate(d.id, date)}
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
            placeholder="Search drafts…"
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
        {byStatus[mobileCol].length === 0 ? (
          <EmptyColumn />
        ) : (
          byStatus[mobileCol].map((d) => cardFor(d))
        )}
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
            {byStatus[c.status].length === 0 ? (
              <EmptyColumn />
            ) : (
              byStatus[c.status].map((d) => cardFor(d))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyColumn() {
  return (
    <div className="rounded-lg border border-dashed border-border/50 py-6 text-center text-xs text-muted-foreground">
      Nothing here
    </div>
  );
}

function DraftCard({
  draft,
  author,
  onDelete,
  onSaved,
  onMove,
  onSetDate,
}: {
  draft: Draft;
  author: Author;
  onDelete: () => void;
  onSaved: (body: string) => void;
  onMove: (status: DraftStatus) => void;
  onSetDate: (date: string | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  const [saving, setSaving] = useState(false);
  const dirty = body !== draft.body;

  const copy = async () => {
    await navigator.clipboard.writeText(editing ? body : draft.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const save = async () => {
    if (saving || !dirty) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save");
      onSaved(body);
      setEditing(false);
      toast.success("Draft saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const initials = author.name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const cardRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      ref={cardRef}
      // Draggable only when not editing, so a text selection in the editor isn't
      // hijacked by the drag. The id rides on the drag payload.
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", draft.id);
        e.dataTransfer.effectAllowed = "move";
        // Pin the drag image to THIS card so the ghost is exactly the card the
        // user grabbed — not the browser's default snapshot, which (with the
        // column re-rendering on dragover) read as "the whole column moves".
        if (cardRef.current) {
          e.dataTransfer.setDragImage(cardRef.current, 20, 20);
        }
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        "group rounded-xl border border-border/60 bg-card text-card-foreground shadow-sm overflow-hidden flex flex-col",
        // No CSS transition on the card: it would replay on every re-render the
        // board does while dragover state changes, making the column look like
        // it's animating. The only state-driven class is the drag opacity.
        draft.status === "posted" && !dragging && "opacity-70",
        dragging && "opacity-40",
        !editing && "cursor-grab active:cursor-grabbing",
      )}
    >
      {/* LinkedIn-style header */}
      <div className="flex items-center gap-2.5 px-3 pt-3">
        <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0 -ml-1 hidden lg:block opacity-0 group-hover:opacity-100 transition-opacity" />
        <AvatarImg
          src={author.avatarUrl}
          className="h-9 w-9 rounded-full object-cover shrink-0"
          fallback={
            <div className="h-9 w-9 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-semibold shrink-0">
              {initials || "in"}
            </div>
          }
        />
        <div className="min-w-0 leading-tight flex-1">
          <p className="text-[13px] font-semibold truncate">{author.name}</p>
          {author.headline && (
            <p className="text-[11px] text-muted-foreground truncate">{author.headline}</p>
          )}
        </div>
        {draft.kind === "hook" && (
          <span className="shrink-0 rounded-full bg-amber-100 text-amber-700 px-1.5 py-0.5 text-[10px] font-medium">
            hook
          </span>
        )}
        <button
          type="button"
          onClick={() => (editing ? save() : setEditing(true))}
          disabled={saving}
          className={cn(
            "shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-60",
            editing
              ? "bg-foreground text-background hover:opacity-90"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {editing ? (
            <>
              <Check className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Done"}
            </>
          ) : (
            <>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </>
          )}
        </button>
      </div>

      {/* Body */}
      {editing ? (
        <div className="px-3 py-2.5 max-h-96 overflow-y-auto">
          <DraftEditor value={body} onChange={setBody} />
        </div>
      ) : (
        // Bounded, self-clipping body. A board card sizes to content, so we cap
        // the height here directly (max-h + overflow-y-auto on THIS element) —
        // ScrollableBody's h-full strategy needs a height-constrained flex
        // parent, which a board card isn't, so long posts would overflow.
        <div className="max-h-56 overflow-y-auto px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap">
          {renderRichText(draft.body)}
        </div>
      )}

      <div className="border-t border-border/60" />

      {/* Footer: status move + planned date + copy/delete */}
      <div className="flex flex-col gap-2 px-3 py-2.5 bg-muted/40">
        <div className="flex items-center gap-2">
          {/* Status move menu — the always-available path (and the only path on
              touch, where drag is awkward). */}
          <select
            value={draft.status}
            onChange={(e) => onMove(e.target.value as DraftStatus)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring/40"
            aria-label="Move draft to a stage"
          >
            {COLUMNS.map((c) => (
              <option key={c.status} value={c.status}>
                {c.label}
              </option>
            ))}
          </select>
          {/* Optional planned post date (the user's own plan; SwipeIn doesn't
              post for them). Empty clears it. */}
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <Calendar className="h-3.5 w-3.5" />
            <input
              type="date"
              value={draft.planToPostOn ?? ""}
              onChange={(e) => onSetDate(e.target.value || null)}
              className="h-8 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus:ring-2 focus:ring-ring/40"
              aria-label="Plan to post on"
            />
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          {editing && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8"
              onClick={save}
              disabled={saving || !dirty}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-8 ml-auto text-muted-foreground hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

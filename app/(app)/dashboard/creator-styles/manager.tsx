"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AvatarImg } from "@/components/avatar-img";
import { EmptyState, StatusPill, Toolbar } from "@/components/app-surface";
import {
  Plus,
  Trash2,
  Pencil,
  Loader2,
  RefreshCw,
  MessageSquare,
  AlertCircle,
  Fingerprint,
  Search,
  X,
  ChevronRight,
  MousePointerClick,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/api-fetch";
import { byId, removeById, reinsertById } from "@/lib/optimistic";
import {
  STYLE_NAME_MAX,
  sanitizeCreatorStyleProfile,
  creatorStyleQualityWarning,
  type CreatorStyleRow,
} from "@/lib/creator-styles";
import { StyleDetailDrawer } from "./style-detail-drawer";

// A tracked creator the create-flow can build a style from.
export type PickerCreator = {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
};

// How often we re-poll while any style is still generating.
const POLL_MS = 3000;

// The top structure tags shown on a card (from profile_json.structure_patterns).
function structureTags(row: CreatorStyleRow): string[] {
  if (!row.profile_json) return [];
  return sanitizeCreatorStyleProfile(row.profile_json).structure_patterns
    .map((s) => s.name)
    .filter(Boolean)
    .slice(0, 3);
}

function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Session-scoped cache of the last list this tab saw, so a nav-away-and-back
// paints the freshest known styles (incl. an in-progress "generating" one)
// IMMEDIATELY — before the mount refetch lands — instead of flashing the
// possibly-stale server snapshot. Keyed per-tab; cleared when the tab closes.
const CACHE_KEY = "creator-styles-cache-v1";

function readCache(): CreatorStyleRow[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CreatorStyleRow[]) : null;
  } catch {
    return null;
  }
}

function writeCache(rows: CreatorStyleRow[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(rows));
  } catch {
    /* quota / disabled storage — non-fatal, we just lose the fast-paint */
  }
}

// Pick the fresher of the server snapshot and the session cache. The cache wins
// when it's non-empty (it reflects the most recent client-known state, incl. a
// generating row the server render predates); otherwise fall back to `initial`.
// Either way the mount refetch reconciles against the DB right after.
function seedStyles(initial: CreatorStyleRow[]): CreatorStyleRow[] {
  const cached = readCache();
  if (cached && cached.length > 0) return cached;
  return initial;
}

export function CreatorStylesManager({
  initial,
  creators,
}: {
  initial: CreatorStyleRow[];
  creators: PickerCreator[];
}) {
  const router = useRouter();
  const [styles, setStyles] = useState(() => seedStyles(initial));
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<CreatorStyleRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CreatorStyleRow | null>(null);
  // The style whose full-detail drawer is open (null = closed).
  const [detailId, setDetailId] = useState<string | null>(null);

  // Keep the session cache in lock-step with the live list, so the next mount
  // (nav-back) paints from it. Runs on every list change (create, poll, delete,
  // refetch).
  useEffect(() => {
    writeCache(styles);
  }, [styles]);

  // Poll while ANY style is still generating — refetch the list and merge fresh
  // rows in. Stops once nothing is generating (a settled list needs no polling).
  const anyGenerating = styles.some((s) => s.status === "generating");
  // Count consecutive failed polls so a persistent network problem surfaces as a
  // toast instead of an eternal "Distilling…" spinner (the server also recovers a
  // genuinely-dead generation to 'failed' on a SUCCESSFUL poll, so this covers
  // the "polls keep failing" case that self-heal can't).
  const pollFailuresRef = useRef(0);
  const failToastShownRef = useRef(false);
  const refetch = useCallback(async () => {
    try {
      const data = await fetchJson<{ ok: boolean; styles?: CreatorStyleRow[] }>(
        "/api/creator-styles",
        { cache: "no-store" },
      );
      if (data?.ok && Array.isArray(data.styles)) {
        setStyles(data.styles);
        pollFailuresRef.current = 0;
        failToastShownRef.current = false;
      }
    } catch {
      // Surface a single toast after several consecutive failures — enough to
      // ride out a transient blip, but not so many that a stuck style spins
      // silently forever. Reset once a poll succeeds (above).
      pollFailuresRef.current += 1;
      if (pollFailuresRef.current >= 4 && !failToastShownRef.current) {
        failToastShownRef.current = true;
        toast.error("Couldn't refresh creator styles. Check your connection and reload.");
      }
    }
  }, []);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!anyGenerating) return;
    pollRef.current = setInterval(() => void refetch(), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [anyGenerating, refetch]);

  // Reconcile against the DB on every mount. Next.js's client-side Router Cache
  // can replay a stale RSC snapshot on back-nav — so a style you generated (or
  // one that finished generating) after the last server render would vanish
  // until a hard refresh. A single live fetch on mount papers over that: the
  // list always reflects the server, regardless of what the router cache served.
  // (setStyles fires only AFTER refetch's await resolves — not synchronously in
  // the effect body — so the cascading-render lint is a false positive here.)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refetch();
  }, [refetch]);

  const remove = async (id: string) => {
    const removed = byId(styles, id);
    setStyles((s) => removeById(s, id));
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/creator-styles/${id}`,
        { method: "DELETE" },
      );
      if (!data?.ok) throw new Error(data?.error || "Failed to delete");
      toast.success("Style deleted");
    } catch (e) {
      setStyles((cur) => reinsertById(cur, removed));
      toast.error((e as Error).message);
    }
  };

  const regenerate = async (row: CreatorStyleRow) => {
    // Optimistically flip to generating so the card shows the spinner + the poll
    // kicks in; the server re-runs in after().
    setStyles((cur) =>
      cur.map((s) => (s.id === row.id ? { ...s, status: "generating", error: null } : s)),
    );
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/creator-styles/${row.id}/regenerate`,
        { method: "POST" },
      );
      if (!data?.ok) throw new Error(data?.error || "Couldn't regenerate");
      toast.success("Regenerating this style…");
    } catch (e) {
      await refetch();
      toast.error((e as Error).message);
    }
  };

  const openInCowork = (row: CreatorStyleRow) => {
    // Hand off to Cowork with this style preselected in the composer picker
    // (PR 3 reads ?style=<id> on mount). Mirrors the ?model= / ?skill= handoffs.
    router.push(`/dashboard?style=${encodeURIComponent(row.id)}`);
  };

  return (
    <div className="space-y-4">
      <Toolbar className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Style library</div>
          <div className="text-xs text-muted-foreground">
            {styles.length > 0
              ? `${styles.length} creator style${styles.length === 1 ? "" : "s"} ready for Cowork`
              : "No creator styles yet"}
          </div>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setCreating(true)} disabled={creators.length === 0}>
          <Plus className="h-4 w-4" /> New style
        </Button>
      </Toolbar>

      {styles.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {styles.map((row) => (
            <StyleCard
              key={row.id}
              row={row}
              onUse={() => openInCowork(row)}
              onRegenerate={() => regenerate(row)}
              onRename={() => setRenaming(row)}
              onDelete={() => setConfirmDelete(row)}
              onOpenDetail={() => setDetailId(row.id)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Fingerprint className="h-6 w-6" />}
          title="Create a style from a tracked creator"
          description={
            creators.length === 0
              ? "Track a creator first, then distill their hooks, rhythm, formatting, and structure into a reusable Cowork style."
              : "We will study their posts and distill how they write, so you can create original posts with a similar rhythm and structure."
          }
          action={
            creators.length > 0 ? (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> New style
              </Button>
            ) : null
          }
        />
      )}

      {/* Create */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto">
          <CreateStyleForm
            creators={creators}
            onCreated={(row) => {
              setStyles((cur) => [row, ...cur]);
              setCreating(false);
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Rename */}
      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="max-w-md">
          {renaming && (
            <RenameStyleForm
              style={renaming}
              onSaved={(row) => {
                setStyles((cur) => cur.map((x) => (x.id === row.id ? row : x)));
                setRenaming(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={confirmDelete ? `Delete "${confirmDelete.name}"?` : "Delete style?"}
        description="This removes the creator style for the whole workspace."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (confirmDelete) await remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />

      {/* Full-detail slide-over */}
      <StyleDetailDrawer
        styleId={detailId}
        open={detailId !== null}
        onOpenChange={(o) => !o && setDetailId(null)}
        onUse={(id) => {
          const row = styles.find((s) => s.id === id);
          if (row) openInCowork(row);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
function StyleCard({
  row,
  onUse,
  onRegenerate,
  onRename,
  onDelete,
  onOpenDetail,
}: {
  row: CreatorStyleRow;
  onUse: () => void;
  onRegenerate: () => void;
  onRename: () => void;
  onDelete: () => void;
  onOpenDetail: () => void;
}) {
  const generating = row.status === "generating";
  const failed = row.status === "failed";
  const tags = structureTags(row);
  // A ready card opens its detail drawer on click; generating/failed cards
  // aren't clickable (nothing to show yet).
  const clickable = !generating && !failed;
  return (
    <Card
      className={cn(
        "flex flex-col overflow-hidden border-border/70 bg-card/90 shadow-soft transition-[border-color,box-shadow,opacity] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
        clickable && "hover:border-primary/18 hover:shadow-soft-lg",
      )}
    >
      <CardContent
        className={cn(
          "group/card flex flex-1 flex-col gap-3 p-4",
          clickable && "cursor-pointer",
        )}
        onClick={clickable ? onOpenDetail : undefined}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        title={clickable ? "Click to see the full style breakdown" : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpenDetail();
                }
              }
            : undefined
        }
      >
        <div className="flex items-start gap-2.5">
          <AvatarImg
            src={row.creator_avatar_url}
            className="h-10 w-10 rounded-xl object-cover ring-1 ring-border/60"
            fallback={
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Fingerprint className="h-4 w-4" />
              </div>
            }
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="truncate text-sm font-semibold">{row.name}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {(generating || failed) && (
                <StatusPill tone={generating ? "warning" : "danger"} className="h-5 px-2 text-[10px]">
                  {generating ? "Generating" : "Needs retry"}
                </StatusPill>
              )}
              <StatusPill tone="success" className="h-5 px-2 text-[10px]">
                {row.creator_name || row.creator_handle || "Creator"}
              </StatusPill>
              {row.sample_count > 0 && (
                <StatusPill tone="neutral" className="h-5 px-2 text-[10px]">
                  {row.sample_count} posts
                </StatusPill>
              )}
            </div>
          </div>
          {clickable && (
            <button
              type="button"
              aria-label="See the full style breakdown"
              title="See the full style breakdown"
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetail();
              }}
              // WCAG AA fix: /60 opacity measured ~1.97:1 against the white
              // card (icons need 3:1) — full-opacity muted-foreground clears
              // ~3.47:1, matching the sibling IconBtn icons on this same card.
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <MousePointerClick className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Status / content region */}
        {generating ? (
          <div className="flex items-center gap-2 rounded-lg border border-state-warning-border bg-state-warning-bg px-3 py-2.5 text-xs text-state-warning">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Distilling this
            creator&rsquo;s writing style…
          </div>
        ) : failed ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{row.error || "Generation failed."}</span>
          </div>
        ) : (
          <>
            {row.description && (
              <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">{row.description}</p>
            )}
            {creatorStyleQualityWarning(row.sample_count) && (
              <div className="flex items-start gap-1.5 rounded-md border border-state-warning-border bg-state-warning-bg px-2.5 py-1.5 text-xs text-state-warning">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{creatorStyleQualityWarning(row.sample_count)}</span>
              </div>
            )}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <StatusPill key={t} tone="neutral" className="h-5 px-2 text-[10px]">
                    {t}
                  </StatusPill>
                ))}
              </div>
            )}
          </>
        )}

        <div
          className="mt-auto flex items-center justify-between gap-2 border-t border-border/50 pt-3"
          onClick={(e) => e.stopPropagation()}
          role="presentation"
        >
          {clickable ? (
            // At rest: the timestamp. On card hover: a "View details" button —
            // its own click target (the footer stops propagation, so the button
            // calls onOpenDetail directly).
            <button
              type="button"
              onClick={onOpenDetail}
              className="relative inline-flex items-center text-[10px] text-muted-foreground"
              title="See the full style breakdown"
            >
              <span className="group-hover/card:opacity-0 group-focus-within/card:opacity-0 [@media(hover:none)]:opacity-0">
                {relativeTime(row.updated_at)}
              </span>
              <span className="absolute left-0 inline-flex items-center gap-0.5 whitespace-nowrap font-medium text-primary opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(hover:none)]:opacity-100 hover:underline">
                View details <ChevronRight className="h-3 w-3" />
              </span>
            </button>
          ) : (
            <span className="text-[10px] text-muted-foreground">
              {relativeTime(row.updated_at)}
            </span>
          )}
          <div className="flex items-center gap-1">
            {failed ? (
              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onRegenerate}>
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </Button>
            ) : (
              <>
                <IconBtn label="Regenerate" onClick={onRegenerate} disabled={generating}>
                  <RefreshCw className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn label="Rename" onClick={onRename}>
                  <Pencil className="h-3.5 w-3.5" />
                </IconBtn>
              </>
            )}
            <IconBtn label="Delete" onClick={onDelete} className="hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </IconBtn>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={onUse}
              disabled={generating || failed}
              title="Take this style into the chat and write in it"
            >
              <MessageSquare className="h-3.5 w-3.5" /> Model with Cowork
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Create form — pick a tracked creator + name → POST → optimistic generating row
// ---------------------------------------------------------------------------
function CreateStyleForm({
  creators,
  onCreated,
}: {
  creators: PickerCreator[];
  onCreated: (row: CreatorStyleRow) => void;
}) {
  const [creatorId, setCreatorId] = useState<string>(creators[0]?.id ?? "");
  const chosen = creators.find((c) => c.id === creatorId);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  // Filter the tracked-creator list by name or handle so a large workspace can
  // find one fast instead of scrolling. Matches the Creators-page picker search.
  const filteredCreators = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return creators;
    return creators.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.handle ?? "").toLowerCase().includes(q),
    );
  }, [creators, search]);

  // Default the name to the creator's when one is chosen and the user hasn't typed.
  const effectiveName = name.trim() || (chosen ? `${chosen.name}'s style` : "");

  const submit = async () => {
    if (busy || !creatorId) return;
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; style?: CreatorStyleRow }>(
        "/api/creator-styles",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: effectiveName, sourceAccountId: creatorId }),
        },
      );
      if (!data?.ok || !data.style) throw new Error(data?.error || "Couldn't create the style");
      toast.success("Generating your style — it'll be ready shortly.");
      onCreated(data.style);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New creator style</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <Label>Creator</Label>
          {creators.length > 5 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search creators…"
                className="h-8 pl-8 pr-8 text-sm"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-1">
            {filteredCreators.length === 0 ? (
              <div className="px-2.5 py-6 text-center text-xs text-muted-foreground">
                No creators match &ldquo;{search}&rdquo;.
              </div>
            ) : (
              filteredCreators.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCreatorId(c.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                    creatorId === c.id ? "bg-primary/10" : "hover:bg-muted",
                  )}
                >
                  <AvatarImg
                    src={c.avatarUrl}
                    className="h-7 w-7 rounded-full object-cover"
                    fallback={
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                        {c.name.slice(0, 2).toUpperCase()}
                      </div>
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{c.name}</div>
                    {c.handle && (
                      <div className="truncate text-xs text-muted-foreground">@{c.handle}</div>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            We&rsquo;ll analyze this creator&rsquo;s top posts and distill their writing
            style. Only mechanics — never their topics or words.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="style-name">Name</Label>
          <Input
            id="style-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={chosen ? `${chosen.name}'s style` : "Name this style"}
            maxLength={STYLE_NAME_MAX}
          />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={busy || !creatorId || !effectiveName}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
          Generate style
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rename form
// ---------------------------------------------------------------------------
function RenameStyleForm({
  style,
  onSaved,
}: {
  style: CreatorStyleRow;
  onSaved: (row: CreatorStyleRow) => void;
}) {
  const [name, setName] = useState(style.name);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; style?: CreatorStyleRow }>(
        `/api/creator-styles/${style.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        },
      );
      if (!data?.ok || !data.style) throw new Error(data?.error || "Couldn't rename");
      onSaved(data.style);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename style</DialogTitle>
      </DialogHeader>
      <div className="py-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={STYLE_NAME_MAX}
          autoFocus
        />
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

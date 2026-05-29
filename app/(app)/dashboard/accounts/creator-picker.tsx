"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, ExternalLink, Loader2, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { DeleteAccountButton } from "./account-actions";

export type PickerCreator = {
  id: string;
  name: string;
  linkedin_handle: string;
  profile_url: string;
  profile_pic_url: string | null;
  synced_at: string | null;
  category_id: string | null;
  is_manual: boolean;
};

// Stable warm tint per name for the avatar fallback — mirrors the palette
// used on the post/bookmark cards so initials circles look consistent.
const AVATAR_TINTS = [
  "bg-amber-100 text-amber-800",
  "bg-orange-100 text-orange-800",
  "bg-rose-100 text-rose-800",
  "bg-stone-200 text-stone-700",
  "bg-yellow-100 text-yellow-800",
  "bg-red-100 text-red-800",
  "bg-lime-100 text-lime-800",
  "bg-fuchsia-100 text-fuchsia-800",
];

function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(h) % AVATAR_TINTS.length];
}

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export type PickerCategory = {
  id: string;
  label: string;
};

const UNCATEGORIZED_ID = "__uncategorized__";
// A cross-cutting rail filter (not a real category): manual creators can sit
// in any category, so "Custom creators" filters on is_manual instead of
// category_id. Treated like UNCATEGORIZED for bulk-toggle (fan out by ids,
// since these rows have no single category_id to hit /by-category with).
const CUSTOM_ID = "__custom__";

export function CreatorPicker({
  categories,
  creators,
  trackedAccountIds,
}: {
  categories: PickerCategory[];
  creators: PickerCreator[];
  trackedAccountIds: string[];
}) {
  const router = useRouter();
  const serverTracked = useMemo(() => new Set(trackedAccountIds), [trackedAccountIds]);
  // Optimistic overrides: id -> desired tracked state. Applied on top of the
  // server set so the checkmark flips the instant you click, before the
  // /track round-trip + router.refresh lands. Cleared per-id once the server
  // prop catches up, so we never fight the source of truth.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const trackedSet = useMemo(() => {
    if (overrides.size === 0) return serverTracked;
    const next = new Set(serverTracked);
    for (const [id, want] of overrides) {
      if (want) next.add(id);
      else next.delete(id);
    }
    return next;
  }, [serverTracked, overrides]);
  const [selectedCat, setSelectedCat] = useState<string>("__all__");
  const [search, setSearch] = useState("");
  const [busyCategory, setBusyCategory] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [busyBulk, setBusyBulk] = useState<"track" | "untrack" | null>(null);
  const [, startTransition] = useTransition();

  // NOTE: we deliberately do NOT prune overrides whose desired state now
  // matches the server. `trackedSet` above merges idempotently — an override
  // that agrees with `serverTracked` produces the identical result whether or
  // not it's present (add an already-present id / delete an absent id are both
  // no-ops). Pruning previously lived in a useEffect+setState, which the React
  // Compiler flags (set-state-in-effect: cascading renders). The Map is bounded
  // by how many creators a user toggles in one session, so leaving confirmed
  // entries in place is cheap and keeps reconciliation a pure render-time
  // derivation rather than an effect.

  function setOverride(id: string, want: boolean) {
    setOverrides((prev) => new Map(prev).set(id, want));
  }
  function clearOverride(id: string) {
    setOverrides((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }
  function setOverridesBulk(ids: string[], want: boolean) {
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, want);
      return next;
    });
  }
  function clearOverridesBulk(ids: string[]) {
    setOverrides((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  // Derive per-category state once for the left rail
  const catStats = useMemo(() => {
    const map = new Map<string, { total: number; tracked: number }>();
    for (const c of creators) {
      const key = c.category_id ?? UNCATEGORIZED_ID;
      const cur = map.get(key) ?? { total: 0, tracked: 0 };
      cur.total += 1;
      if (trackedSet.has(c.id)) cur.tracked += 1;
      map.set(key, cur);
    }
    return map;
  }, [creators, trackedSet]);

  const totalTracked = trackedSet.size;
  const totalCreators = creators.length;
  const uncategorizedStats = catStats.get(UNCATEGORIZED_ID);

  // Stats for the cross-cutting "Custom creators" rail row. Computed
  // separately from catStats because it spans categories (is_manual, not
  // category_id).
  const customStats = useMemo(() => {
    let total = 0;
    let tracked = 0;
    for (const c of creators) {
      if (!c.is_manual) continue;
      total += 1;
      if (trackedSet.has(c.id)) tracked += 1;
    }
    return { total, tracked };
  }, [creators, trackedSet]);

  // Right pane: filter creators by selected category + search
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = creators;
    if (selectedCat === UNCATEGORIZED_ID) {
      rows = rows.filter((c) => c.category_id === null);
    } else if (selectedCat === CUSTOM_ID) {
      rows = rows.filter((c) => c.is_manual);
    } else if (selectedCat !== "__all__") {
      rows = rows.filter((c) => c.category_id === selectedCat);
    }
    if (q) {
      rows = rows.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.linkedin_handle.toLowerCase().includes(q),
      );
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }, [creators, selectedCat, search]);

  const visibleStats = useMemo(() => {
    let tracked = 0;
    for (const c of visible) if (trackedSet.has(c.id)) tracked += 1;
    return { tracked, total: visible.length };
  }, [visible, trackedSet]);

  async function toggleOne(creator: PickerCreator) {
    const wasTracked = trackedSet.has(creator.id);
    const want = !wasTracked;
    setOverride(creator.id, want); // optimistic — flip the checkmark now
    setBusyAccount(creator.id);
    try {
      const res = await fetch("/api/accounts/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: creator.id, action: want ? "track" : "untrack" }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      startTransition(() => router.refresh());
    } catch (e) {
      clearOverride(creator.id); // roll back the optimistic flip
      toast.error((e as Error).message);
    }
    setBusyAccount(null);
  }

  async function bulkToggleCategory(catId: string, action: "track" | "untrack") {
    // Uncategorized can't be bulk-toggled via /by-category — those creators have no category_id.
    // Fall through to the visible-rows bulk path for that case.
    if (catId === UNCATEGORIZED_ID) {
      return bulkToggleIds(
        creators.filter((c) => c.category_id === null).map((c) => c.id),
        action,
      );
    }
    // "Custom creators" is a cross-cutting filter, not a real category — same
    // deal: fan out by ids rather than calling /by-category.
    if (catId === CUSTOM_ID) {
      return bulkToggleIds(
        creators.filter((c) => c.is_manual).map((c) => c.id),
        action,
      );
    }
    const catIds = creators.filter((c) => c.category_id === catId).map((c) => c.id);
    setOverridesBulk(catIds, action === "track"); // optimistic
    setBusyCategory(catId);
    try {
      const res = await fetch("/api/accounts/by-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category_ids: [catId], action }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      toast.success(
        action === "track"
          ? `Tracking ${data.affected} creators`
          : `Untracked ${data.affected} creators`,
      );
      startTransition(() => router.refresh());
    } catch (e) {
      clearOverridesBulk(catIds); // roll back
      toast.error((e as Error).message);
    }
    setBusyCategory(null);
  }

  // Lower-level worker: fans out the per-id /track calls, manages optimistic
  // overrides + busy state, refreshes on success. No toast UI — the caller
  // owns wording so the wrapper can attach an Undo action only where it makes
  // sense (i.e. on untrack).
  async function runBulkToggle(ids: string[], action: "track" | "untrack"): Promise<{ ok: boolean; failed: number }> {
    if (ids.length === 0) return { ok: true, failed: 0 };
    setOverridesBulk(ids, action === "track");
    setBusyBulk(action);
    try {
      // No bulk-by-ids endpoint, so fan out. These are upserts/deletes so order
      // doesn't matter; do them in parallel for speed.
      const results = await Promise.all(
        ids.map((id) =>
          fetch("/api/accounts/track", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ account_id: id, action }),
          }).then((r) => r.json()),
        ),
      );
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) clearOverridesBulk(ids); // let server refresh settle truth
      startTransition(() => router.refresh());
      return { ok: failed === 0, failed };
    } catch (e) {
      clearOverridesBulk(ids);
      toast.error((e as Error).message);
      return { ok: false, failed: ids.length };
    } finally {
      setBusyBulk(null);
    }
  }

  async function bulkToggleIds(ids: string[], action: "track" | "untrack") {
    if (ids.length === 0) return;
    // No more native confirm() for bulk untrack — destructive-feeling but fully
    // reversible. Show an Undo button on the success toast instead, which
    // re-runs the bulk in reverse. Friendlier and faster than a popup.
    const result = await runBulkToggle(ids, action);
    if (!result.ok) {
      toast.error(`${result.failed} of ${ids.length} failed`);
      return;
    }
    if (action === "untrack") {
      toast.success(`Untracked ${ids.length} creators`, {
        action: {
          label: "Undo",
          onClick: () => {
            // Re-track the same ids. Fire-and-forget from the toast callback —
            // it manages its own toast state if anything fails.
            void runBulkToggle(ids, "track").then((r) => {
              if (!r.ok) toast.error(`${r.failed} of ${ids.length} failed to restore`);
            });
          },
        },
      });
    } else {
      toast.success(`Tracking ${ids.length} creators`);
    }
  }

  function clickCategoryCheckbox(
    e: React.MouseEvent,
    catId: string,
    state: "none" | "some" | "all",
  ) {
    e.stopPropagation();
    bulkToggleCategory(catId, state === "all" ? "untrack" : "track");
  }

  // Build the rail rows
  type RailRow = {
    id: string;
    label: string;
    tracked: number;
    total: number;
    state: "none" | "some" | "all";
    bulkable: boolean;
  };
  const railRows: RailRow[] = [
    {
      id: "__all__",
      label: "All creators",
      tracked: totalTracked,
      total: totalCreators,
      state:
        totalTracked === 0 ? "none" : totalTracked === totalCreators ? "all" : "some",
      bulkable: false,
    },
    ...categories.map<RailRow>((c) => {
      const s = catStats.get(c.id) ?? { total: 0, tracked: 0 };
      const state: "none" | "some" | "all" =
        s.total === 0
          ? "none"
          : s.tracked === 0
            ? "none"
            : s.tracked === s.total
              ? "all"
              : "some";
      return { id: c.id, label: c.label, tracked: s.tracked, total: s.total, state, bulkable: s.total > 0 };
    }),
  ];
  if (uncategorizedStats && uncategorizedStats.total > 0) {
    railRows.push({
      id: UNCATEGORIZED_ID,
      label: "Uncategorized",
      tracked: uncategorizedStats.tracked,
      total: uncategorizedStats.total,
      state:
        uncategorizedStats.tracked === 0
          ? "none"
          : uncategorizedStats.tracked === uncategorizedStats.total
            ? "all"
            : "some",
      bulkable: true,
    });
  }
  // "Custom creators" — only shown once the workspace has added at least one.
  // Pinned last so it reads as a distinct, cross-cutting view below the
  // category list.
  if (customStats.total > 0) {
    railRows.push({
      id: CUSTOM_ID,
      label: "Custom creators",
      tracked: customStats.tracked,
      total: customStats.total,
      state:
        customStats.tracked === 0
          ? "none"
          : customStats.tracked === customStats.total
            ? "all"
            : "some",
      bulkable: true,
    });
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] min-h-[520px]">
        {/* LEFT: Category rail */}
        <div className="border-b md:border-b-0 md:border-r border-border bg-muted/30">
          <div className="px-4 pt-4 pb-2">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Categories
            </div>
          </div>
          <nav className="px-2 pb-3 space-y-0.5">
            {railRows.map((row) => {
              const isSelected = selectedCat === row.id;
              const isBusy = busyCategory === row.id;
              const isAllRow = row.id === "__all__";
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelectedCat(row.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm transition-colors",
                    isSelected
                      ? "bg-background border border-border shadow-sm"
                      : "hover:bg-background/60 border border-transparent",
                  )}
                >
                  {row.bulkable && !isAllRow ? (
                    <span
                      role="checkbox"
                      aria-checked={
                        row.state === "all"
                          ? "true"
                          : row.state === "some"
                            ? "mixed"
                            : "false"
                      }
                      tabIndex={0}
                      onClick={(e) => clickCategoryCheckbox(e, row.id, row.state)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          clickCategoryCheckbox(e as unknown as React.MouseEvent, row.id, row.state);
                        }
                      }}
                      className={cn(
                        "h-4 w-4 shrink-0 rounded border flex items-center justify-center cursor-pointer transition-colors",
                        row.state === "all"
                          ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                          : row.state === "some"
                            ? "border-primary bg-primary/30 hover:bg-primary/40"
                            : "border-border bg-background hover:border-primary/60",
                      )}
                      title={
                        row.state === "all"
                          ? "Untrack all in this category"
                          : "Track all in this category"
                      }
                    >
                      {isBusy ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      ) : row.state === "all" ? (
                        <Check className="h-3 w-3" />
                      ) : row.state === "some" ? (
                        <span className="h-0.5 w-2 bg-primary-foreground" />
                      ) : null}
                    </span>
                  ) : (
                    <span className="h-4 w-4 shrink-0" />
                  )}
                  <span className="flex-1 min-w-0 truncate">{row.label}</span>
                  <span
                    className={cn(
                      "text-xs tabular-nums shrink-0",
                      row.state === "all"
                        ? "text-primary font-medium"
                        : row.state === "some"
                          ? "text-foreground"
                          : "text-muted-foreground",
                    )}
                  >
                    {row.tracked}/{row.total}
                  </span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* RIGHT: Creator list */}
        <div className="flex flex-col">
          <div className="px-4 pt-4 pb-3 border-b border-border space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">
                  {railRows.find((r) => r.id === selectedCat)?.label ?? "All creators"}
                </div>
                <div className="text-xs text-muted-foreground tabular-nums mt-0.5">
                  {visibleStats.tracked} of {visibleStats.total} tracked
                  {search && (
                    <>
                      <span className="mx-1.5 text-border">·</span>
                      filtered by &ldquo;{search}&rdquo;
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
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
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto max-h-[60vh]">
            {visible.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                {search
                  ? "No creators match your search."
                  : selectedCat === CUSTOM_ID
                    ? "You haven't added any custom creators yet."
                    : "No creators in this category yet."}
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 p-4">
                {visible.map((c) => {
                  const tracked = trackedSet.has(c.id);
                  const busy = busyAccount === c.id;
                  const catLabel = c.category_id
                    ? categories.find((cat) => cat.id === c.category_id)?.label ?? null
                    : null;
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        "group/card relative flex flex-col items-center gap-2 rounded-xl border p-4 text-center transition-all",
                        tracked
                          ? "border-primary/40 bg-primary/[0.04] ring-1 ring-primary/30"
                          : "border-border/60 bg-card hover:border-border hover:shadow-soft",
                      )}
                    >
                      {/* Hover overlay: open profile + delete (manual only). */}
                      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/card:opacity-100 focus-within:opacity-100 transition-opacity">
                        <a
                          href={c.profile_url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          title="Open LinkedIn profile"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                        {c.is_manual && <DeleteAccountButton id={c.id} name={c.name} />}
                      </div>

                      <div className="relative h-12 w-12 shrink-0">
                        {c.profile_pic_url ? (
                          <Image
                            src={c.profile_pic_url}
                            alt={c.name}
                            width={48}
                            height={48}
                            sizes="48px"
                            className="h-12 w-12 rounded-full object-cover bg-muted"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              const img = e.currentTarget;
                              img.style.display = "none";
                              img.nextElementSibling?.classList.remove("hidden");
                            }}
                          />
                        ) : null}
                        <div
                          className={cn(
                            "h-12 w-12 rounded-full grid place-items-center text-sm font-semibold",
                            tintFor(c.name),
                            c.profile_pic_url && "hidden",
                          )}
                        >
                          {initialsFor(c.name) || "?"}
                        </div>
                        {tracked && (
                          <span className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-primary text-primary-foreground grid place-items-center ring-2 ring-card">
                            <Check className="h-2.5 w-2.5" />
                          </span>
                        )}
                      </div>

                      <div className="min-w-0 w-full">
                        <div className="text-sm font-semibold truncate" title={c.name}>
                          {c.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          @{c.linkedin_handle}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        {c.is_manual && (
                          // Marks a creator this workspace added by hand, vs. one
                          // from the shared global catalog. Primary tint so it
                          // reads as "yours" and stands apart from the neutral
                          // category tag.
                          <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 font-medium shrink-0">
                            Added by you
                          </span>
                        )}
                        {catLabel && (
                          <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground/70 truncate max-w-[100px]">
                            {catLabel}
                          </span>
                        )}
                        <span className="tabular-nums" title={c.synced_at ? new Date(c.synced_at).toLocaleString() : ""}>
                          {c.synced_at ? formatSyncedAt(c.synced_at) : "—"}
                        </span>
                      </div>

                      <Button
                        type="button"
                        size="sm"
                        variant={tracked ? "outline" : "default"}
                        className="h-7 w-full text-xs mt-1"
                        onClick={() => toggleOne(c)}
                        disabled={busy}
                      >
                        {busy ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : tracked ? (
                          <>
                            <Check className="h-3 w-3" /> Tracking
                          </>
                        ) : (
                          <>
                            <Plus className="h-3 w-3" /> Track
                          </>
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {visible.length > 0 && (
            <div className="border-t border-border px-4 py-2.5 flex items-center justify-between gap-3 bg-muted/20">
              <div className="text-xs text-muted-foreground tabular-nums">
                {visibleStats.tracked === visibleStats.total
                  ? "All visible creators tracked"
                  : `${visibleStats.total - visibleStats.tracked} not yet tracked`}
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={
                    busyBulk !== null ||
                    visibleStats.tracked === 0
                  }
                  onClick={() => {
                    const ids = visible
                      .filter((c) => trackedSet.has(c.id))
                      .map((c) => c.id);
                    bulkToggleIds(ids, "untrack");
                  }}
                >
                  {busyBulk === "untrack" && <Loader2 className="h-3 w-3 animate-spin" />}
                  Clear all in view
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={
                    busyBulk !== null ||
                    visibleStats.tracked === visibleStats.total
                  }
                  onClick={() => {
                    const ids = visible
                      .filter((c) => !trackedSet.has(c.id))
                      .map((c) => c.id);
                    bulkToggleIds(ids, "track");
                  }}
                >
                  {busyBulk === "track" && <Loader2 className="h-3 w-3 animate-spin" />}
                  Track all in view
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function formatSyncedAt(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "1d ago";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

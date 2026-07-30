"use client";

import Image from "next/image";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDownAZ,
  BadgeCheck,
  BarChart3,
  Check,
  Compass,
  ExternalLink,
  Layers3,
  Loader2,
  PackageOpen,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { StatusPill, Surface } from "@/components/app-surface";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/api-fetch";
import { creatorAvatarFallback } from "@/lib/post-card-helpers";
import {
  rankDiscoveryCreators,
  selectDisplayDiscoveryTags,
  selectStarterPack,
  type DiscoveryCreator,
  type DiscoverySort,
} from "@/lib/creator-discovery";
import {
  DISCOVERY_CREATOR_BATCH_SIZE,
  CREATOR_CARD_GRID_CLASS,
  getCreatorDisplayWindow,
  getStarterPackTrackingSummary,
  INITIAL_DISCOVERY_CREATOR_COUNT,
  INITIAL_SOURCE_CREATOR_COUNT,
  SOURCE_CREATOR_BATCH_SIZE,
} from "@/lib/discovery-display-policy";
import { DeleteAccountButton, EditAccountButton } from "./account-actions";
import { SOURCE_STATUS_META, type SourceStatus } from "@/lib/source-status";
import { HorizontalCategoryRail } from "@/components/horizontal-category-rail";

export type PickerCreator = {
  id: string;
  name: string;
  linkedin_handle: string;
  profile_url: string;
  profile_pic_url: string | null;
  headline: string | null;
  recommendation_reason: string | null;
  discovery_tags: string[];
  is_featured: boolean;
  source: string;
  manual_owner_workspace_id: string | null;
  synced_at: string | null;
  category_id: string | null;
  is_manual: boolean;
  total_post_count: number;
  viral_post_count: number;
  top_reactions: number | null;
  source_status: SourceStatus;
};

export type PickerCategory = {
  id: string;
  label: string;
  workspace_id: string | null;
};

const AVATAR_TINTS = [
  "bg-state-warning-bg text-state-warning",
  "bg-state-warning-bg text-state-warning",
  "bg-state-danger-bg text-state-danger",
  "bg-stone-200 text-stone-700",
  "bg-state-warning-bg text-state-warning",
  "bg-state-danger-bg text-state-danger",
  "bg-state-success-bg text-state-success",
  "bg-state-brand-bg text-state-brand",
];

function tintFor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length];
}

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

function toDiscoveryCreator(creator: PickerCreator): DiscoveryCreator {
  return {
    id: creator.id,
    name: creator.name,
    linkedinHandle: creator.linkedin_handle,
    headline: creator.headline,
    recommendationReason: creator.recommendation_reason,
    discoveryTags: creator.discovery_tags,
    categoryId: creator.category_id,
    source: creator.source,
    manualOwnerWorkspaceId: creator.manual_owner_workspace_id,
    isFeatured: creator.is_featured,
    totalPostCount: creator.total_post_count,
    topReactions: creator.top_reactions,
  };
}

function CreatorAvatar({ creator, size = "default" }: { creator: PickerCreator; size?: "default" | "small" }) {
  const dimensions = size === "small" ? "h-9 w-9" : "h-14 w-14";
  const pixels = size === "small" ? 36 : 56;
  return (
    <div className={cn("relative shrink-0", dimensions)}>
      {creator.profile_pic_url ? (
        <Image
          src={creator.profile_pic_url}
          alt=""
          width={pixels}
          height={pixels}
          sizes={`${pixels}px`}
          className={cn(dimensions, "rounded-full bg-muted object-cover")}
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.style.display = "none";
            event.currentTarget.nextElementSibling?.classList.remove("hidden");
          }}
        />
      ) : null}
      {/* Missing/expired photo → a stable DiceBear glyphs avatar; the
          initials tile below is the last resort if that CDN fails too. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- external SVG; next/image won't optimize it */}
      <img
        src={creatorAvatarFallback(creator.name)}
        alt=""
        className={cn(
          dimensions,
          "rounded-full bg-muted object-cover",
          creator.profile_pic_url && "hidden",
        )}
        referrerPolicy="no-referrer"
        onError={(event) => {
          event.currentTarget.style.display = "none";
          event.currentTarget.nextElementSibling?.classList.remove("hidden");
        }}
      />
      <div
        className={cn(
          dimensions,
          "grid place-items-center rounded-full font-semibold hidden",
          size === "small" ? "text-xs" : "text-base",
          tintFor(creator.name),
        )}
      >
        {initialsFor(creator.name) || "?"}
      </div>
    </div>
  );
}

function TopicButton({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count?: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-[13px] font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border/70 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined && (
        <span className={cn("text-xs tabular-nums", active ? "text-primary-foreground/75" : "text-muted-foreground/70")}>{count}</span>
      )}
    </button>
  );
}

function CreatorCard({
  creator,
  categoryLabel,
  categories,
  tracked,
  busy,
  mode,
  onToggle,
  onEdited,
  onRemoved,
  onRestore,
}: {
  creator: PickerCreator;
  categoryLabel: string | null;
  categories: PickerCategory[];
  tracked: boolean;
  busy: boolean;
  mode: "explore" | "sources";
  onToggle: () => void;
  onEdited: (next: { name: string; categoryId: string | null }) => void;
  onRemoved: () => void;
  onRestore: () => void;
}) {
  const effectiveStatus: SourceStatus = !tracked
    ? "paused"
    : creator.source_status === "paused"
      ? creator.total_post_count > 0
        ? "active"
        : "no_posts"
      : creator.source_status;
  const statusMeta = SOURCE_STATUS_META[effectiveStatus];

  return (
    <article
      className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border/60 bg-card px-4 py-5 shadow-soft sm:p-5"
    >
      <div className="flex min-w-0 items-start gap-3">
        <CreatorAvatar creator={creator} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold tracking-tight" title={creator.name}>{creator.name}</h3>
              <p className="truncate text-sm text-muted-foreground">@{creator.linkedin_handle}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button nativeButton={false} variant="ghost" size="icon-lg" render={<a href={creator.profile_url} target="_blank" rel="noreferrer" aria-label={`Open ${creator.name} on LinkedIn`} />}>
                <ExternalLink />
              </Button>
              {mode === "sources" && creator.is_manual && (
                <>
                  <EditAccountButton
                    id={creator.id}
                    name={creator.name}
                    categoryId={creator.category_id}
                    categories={categories.map((category) => ({ id: category.id, label: category.label }))}
                    onSaved={onEdited}
                  />
                  <DeleteAccountButton
                    id={creator.id}
                    name={creator.name}
                    onOptimisticDelete={onRemoved}
                    onRollback={onRestore}
                  />
                </>
              )}
            </div>
          </div>
          {creator.headline && (
            <p className="mt-2 line-clamp-2 text-sm leading-5 text-foreground/80">{creator.headline}</p>
          )}
        </div>
      </div>

      {creator.recommendation_reason && (
        <div className="flex gap-2.5 rounded-xl bg-muted/55 px-3 py-2.5 text-sm leading-5 text-muted-foreground">
          <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            <span className="font-medium text-foreground">Why recommended: </span>
            {creator.recommendation_reason}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {categoryLabel && <StatusPill tone="neutral">{categoryLabel}</StatusPill>}
        {selectDisplayDiscoveryTags(
          creator.discovery_tags,
          categoryLabel,
          3,
        ).map((tag) => (
          <span key={tag} className="text-xs text-muted-foreground">#{tag.replaceAll(" ", "-")}</span>
        ))}
        {mode === "sources" && (
          <StatusPill tone={statusMeta.tone}>
            {effectiveStatus === "fetching" && <Loader2 className="animate-spin" />}
            {statusMeta.label}
          </StatusPill>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/50 pt-3">
        <div className="text-xs leading-5 text-muted-foreground">
          {creator.total_post_count > 0 ? (
            <>
              <span className="font-medium text-foreground">{creator.total_post_count.toLocaleString()}</span> saved posts
              {creator.top_reactions ? <span> · best {creator.top_reactions.toLocaleString()} reactions</span> : null}
            </>
          ) : (
            "Ready to start collecting posts"
          )}
        </div>
        <Button
          size="lg"
          variant={tracked ? "outline" : "default"}
          className="min-w-28"
          onClick={onToggle}
          disabled={busy}
        >
          {busy ? <Loader2 className="animate-spin" /> : tracked ? <Check /> : <Layers3 />}
          {tracked ? "Untrack" : "Track"}
        </Button>
      </div>
    </article>
  );
}

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
  const [, startTransition] = useTransition();
  const serverTracked = useMemo(() => new Set(trackedAccountIds), [trackedAccountIds]);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [mode, setMode] = useState<"explore" | "sources">(
    trackedAccountIds.length === 0 ? "explore" : "sources",
  );
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DiscoverySort>("best-match");
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const [sourceCategory, setSourceCategory] = useState("__all__");
  const [visibleCount, setVisibleCount] = useState(
    trackedAccountIds.length === 0
      ? INITIAL_DISCOVERY_CREATOR_COUNT
      : INITIAL_SOURCE_CREATOR_COUNT,
  );
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [busyBulk, setBusyBulk] = useState(false);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Map<string, { name: string; category_id: string | null }>>(new Map());

  const trackedSet = useMemo(() => {
    const next = new Set(serverTracked);
    for (const [id, tracked] of overrides) {
      if (tracked) next.add(id);
      else next.delete(id);
    }
    return next;
  }, [overrides, serverTracked]);

  const effectiveCreators = useMemo(
    () => creators
      .filter((creator) => !removedIds.has(creator.id))
      .map((creator) => {
        const edit = edits.get(creator.id);
        return edit ? { ...creator, ...edit } : creator;
      }),
    [creators, edits, removedIds],
  );
  const byId = useMemo(() => new Map(effectiveCreators.map((creator) => [creator.id, creator])), [effectiveCreators]);
  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category.label])), [categories]);
  const globalCategories = categories.filter((category) => category.workspace_id === null);
  const privateCategories = categories.filter((category) => category.workspace_id !== null);
  const globalCreators = effectiveCreators.filter(
    (creator) => creator.source !== "manual" && creator.manual_owner_workspace_id === null,
  );

  const discoveryRows = useMemo(() => {
    const ranked = rankDiscoveryCreators(globalCreators.map(toDiscoveryCreator), {
      query,
      categoryIds: topicIds,
      sort,
    });
    return ranked.map((row) => byId.get(row.id)).filter((row): row is PickerCreator => Boolean(row));
  }, [byId, globalCreators, query, sort, topicIds]);

  const sourceRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return effectiveCreators
      .filter((creator) => trackedSet.has(creator.id))
      .filter((creator) => sourceCategory === "__all__" || creator.category_id === sourceCategory)
      .filter((creator) => !normalizedQuery || [creator.name, creator.linkedin_handle, creator.headline, creator.recommendation_reason, ...creator.discovery_tags].filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [effectiveCreators, query, sourceCategory, trackedSet]);

  const starterPack = useMemo(() => {
    const selected = topicIds.length > 0
      ? topicIds
      : ["linkedin-content", "ai", "gtm"].filter((id) => categoryById.has(id));
    return selectStarterPack(globalCreators.map(toDiscoveryCreator), { categoryIds: selected, limit: 8 })
      .map((row) => byId.get(row.id))
      .filter((row): row is PickerCreator => Boolean(row));
  }, [byId, categoryById, globalCreators, topicIds]);
  const starterPackUntracked = starterPack.filter((creator) => !trackedSet.has(creator.id));
  const starterPackSummary = getStarterPackTrackingSummary(
    starterPack.length,
    starterPackUntracked.length,
  );

  function resetVisibleCreatorCount(targetMode: "explore" | "sources" = mode) {
    setVisibleCount(
      targetMode === "explore"
        ? INITIAL_DISCOVERY_CREATOR_COUNT
        : INITIAL_SOURCE_CREATOR_COUNT,
    );
  }

  function setOverride(id: string, tracked: boolean) {
    setOverrides((current) => new Map(current).set(id, tracked));
  }

  async function toggleOne(creator: PickerCreator) {
    const want = !trackedSet.has(creator.id);
    setOverride(creator.id, want);
    setBusyAccount(creator.id);
    try {
      await fetchJson("/api/accounts/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: creator.id, action: want ? "track" : "untrack" }),
      });
      startTransition(() => router.refresh());
    } catch (error) {
      setOverrides((current) => {
        const next = new Map(current);
        next.delete(creator.id);
        return next;
      });
      toast.error((error as Error).message);
    } finally {
      setBusyAccount(null);
    }
  }

  async function setMany(ids: string[], action: "track" | "untrack", globalBaselineOnly = false) {
    if (ids.length === 0) return;
    const tracked = action === "track";
    setOverrides((current) => {
      const next = new Map(current);
      for (const id of ids) next.set(id, tracked);
      return next;
    });
    setBusyBulk(true);
    try {
      const result = await fetchJson<{ ok: boolean; affected: number }>("/api/accounts/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_ids: ids, action, global_baseline_only: globalBaselineOnly }),
      });
      if (action === "track") {
        toast.success(`Tracking ${result.affected} creators`);
      } else {
        toast.success(`Untracked ${result.affected} creators`, {
          action: {
            label: "Undo",
            onClick: () => void setMany(ids, "track", globalBaselineOnly),
          },
        });
      }
      startTransition(() => router.refresh());
    } catch (error) {
      setOverrides((current) => {
        const next = new Map(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      toast.error((error as Error).message);
    } finally {
      setBusyBulk(false);
    }
  }

  function toggleTopic(id: string) {
    resetVisibleCreatorCount("explore");
    setTopicIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  const allRows = mode === "explore" ? discoveryRows : sourceRows;
  const batchSize = mode === "explore"
    ? DISCOVERY_CREATOR_BATCH_SIZE
    : SOURCE_CREATOR_BATCH_SIZE;
  const displayWindow = getCreatorDisplayWindow(allRows.length, visibleCount, batchSize);
  const visibleRows = allRows.slice(0, displayWindow.visibleCount);
  const resultsHeading = mode === "sources"
    ? "My creators"
    : query
      ? "Search results"
      : topicIds.length > 0
        ? "Creators for your topics"
        : "Recommended creators";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 border-b border-border/60 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex h-12 w-full items-center rounded-xl bg-muted p-1 sm:w-auto">
          <button
            type="button"
            aria-pressed={mode === "explore"}
            onClick={() => {
              setMode("explore");
              setQuery("");
              resetVisibleCreatorCount("explore");
            }}
            className={cn("flex h-10 flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors sm:flex-none", mode === "explore" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            <Compass className="h-4 w-4" /> Explore creators
          </button>
          <button
            type="button"
            aria-pressed={mode === "sources"}
            onClick={() => {
              setMode("sources");
              setQuery("");
              resetVisibleCreatorCount("sources");
            }}
            className={cn("flex h-10 flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors sm:flex-none", mode === "sources" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            <Users className="h-4 w-4" /> My creators <span className="text-xs tabular-nums opacity-70">{trackedSet.size}</span>
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          {mode === "explore" ? "Find proven voices by topic—no LinkedIn expertise needed." : "Review, pause, or organize the creators feeding your Swipe File."}
        </p>
      </div>

      {mode === "explore" && (
        <>
          <section aria-labelledby="topics-heading" className="space-y-3">
            <div>
              <h2 id="topics-heading" className="text-base font-semibold">What do you want to learn from?</h2>
              <p className="mt-1 text-sm text-muted-foreground">Choose any topics, or browse the full catalog.</p>
            </div>
            <HorizontalCategoryRail className="-mx-4 gap-2 px-4 pb-1 text-[13px] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
              {globalCategories.map((category) => (
                <TopicButton
                  key={category.id}
                  active={topicIds.includes(category.id)}
                  label={category.label}
                  count={globalCreators.filter((creator) => creator.category_id === category.id).length}
                  onClick={() => toggleTopic(category.id)}
                />
              ))}
            </HorizontalCategoryRail>
          </section>

          {starterPack.length > 0 && (
            <Surface tone="flat" padding="lg" className="overflow-hidden border-primary/20 bg-primary/[0.045]">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                <div className="max-w-2xl space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-primary"><PackageOpen className="h-4 w-4" /> Recommended starter pack</div>
                  <h2 className="text-xl font-semibold tracking-tight">Start with a balanced set of {starterPack.length}</h2>
                  <p className="text-sm leading-6 text-muted-foreground">A mix of proven creators across {topicIds.length > 0 ? "your selected topics" : "LinkedIn, AI, and growth"}. You can tune the set anytime.</p>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="flex -space-x-2" aria-label={`${starterPack.length} creators in the starter pack`}>
                    {starterPack.slice(0, 6).map((creator) => <div key={creator.id} className="rounded-full ring-2 ring-background"><CreatorAvatar creator={creator} size="small" /></div>)}
                  </div>
                  <div className="space-y-1.5 sm:text-right">
                    <Button size="lg" disabled={busyBulk || starterPackSummary.untrackedCount === 0} onClick={() => setMany(starterPackUntracked.map((creator) => creator.id), "track", true)}>
                      {busyBulk ? <Loader2 className="animate-spin" /> : <Layers3 />}
                      {starterPackSummary.actionLabel}
                    </Button>
                    <p className="text-xs text-muted-foreground">{starterPackSummary.detail}</p>
                  </div>
                </div>
              </div>
            </Surface>
          )}
        </>
      )}

      {mode === "sources" && (
        <section aria-labelledby="creator-filters-heading" className="space-y-3">
          <div>
            <h2 id="creator-filters-heading" className="text-base font-semibold">Filter your creators</h2>
            <p className="mt-1 text-sm text-muted-foreground">Filtering never changes what you track.</p>
          </div>
          <HorizontalCategoryRail className="-mx-4 gap-2 px-4 pb-1 text-[13px] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
            <TopicButton active={sourceCategory === "__all__"} label="All creators" count={trackedSet.size} onClick={() => { setSourceCategory("__all__"); resetVisibleCreatorCount("sources"); }} />
            {globalCategories.map((category) => {
              const count = effectiveCreators.filter((creator) => trackedSet.has(creator.id) && creator.category_id === category.id).length;
              return count > 0 ? <TopicButton key={category.id} active={sourceCategory === category.id} label={category.label} count={count} onClick={() => { setSourceCategory(category.id); resetVisibleCreatorCount("sources"); }} /> : null;
            })}
          </HorizontalCategoryRail>
          {privateCategories.some((category) => effectiveCreators.some((creator) => trackedSet.has(creator.id) && creator.category_id === category.id)) && (
            <div className="space-y-2 border-t border-border/50 pt-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Your categories</p>
              <div className="flex flex-wrap gap-2">
                {privateCategories.map((category) => {
                  const count = effectiveCreators.filter((creator) => trackedSet.has(creator.id) && creator.category_id === category.id).length;
                  return count > 0 ? <TopicButton key={category.id} active={sourceCategory === category.id} label={category.label} count={count} onClick={() => { setSourceCategory(category.id); resetVisibleCreatorCount("sources"); }} /> : null;
                })}
              </div>
            </div>
          )}
        </section>
      )}

      <div className="flex flex-col gap-3 border-y border-border/60 py-3 sm:flex-row sm:items-center">
        <SearchField
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              resetVisibleCreatorCount();
            }}
            onClear={() => {
              setQuery("");
              resetVisibleCreatorCount();
            }}
            placeholder={mode === "explore" ? "Search by creator, expertise, or topic" : "Search your creators"}
            aria-label="Search creators"
            containerClassName="min-w-0 flex-1"
            className="h-11"
          />
        {mode === "explore" && (
          <label className="flex h-11 items-center gap-2 rounded-xl border border-border/70 bg-background px-3 text-sm text-muted-foreground">
            {sort === "highest-engagement" ? <BarChart3 className="h-4 w-4" /> : <ArrowDownAZ className="h-4 w-4" />}
            <span className="sr-only">Sort creators</span>
            <select value={sort} onChange={(event) => { setSort(event.target.value as DiscoverySort); resetVisibleCreatorCount("explore"); }} className="bg-transparent text-foreground outline-none">
              <option value="best-match">Best match</option>
              <option value="most-saved">Most saved</option>
              <option value="highest-engagement">Highest engagement</option>
              <option value="name">Name A–Z</option>
            </select>
          </label>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{resultsHeading}</h2>
          <p className="text-sm text-muted-foreground">
            Showing {displayWindow.visibleCount} of {allRows.length} {allRows.length === 1 ? "creator" : "creators"}{query ? " matching your search" : ""}
          </p>
        </div>
        {mode === "sources" && visibleRows.length > 0 && (
          <Button variant="ghost" size="sm" disabled={busyBulk} onClick={() => setMany(visibleRows.map((creator) => creator.id), "untrack")}>
            {busyBulk && <Loader2 className="animate-spin" />} Untrack visible
          </Button>
        )}
      </div>

      {visibleRows.length === 0 ? (
        <Surface tone="muted" padding="lg" className="border-dashed text-center">
          <Compass className="mx-auto h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">{mode === "explore" ? "No creators found" : "No creators here yet"}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "explore" ? "Try a broader search or clear a topic filter." : "Explore creators and track the ones you want SwipeIn to watch."}
          </p>
        </Surface>
      ) : (
        <div className="space-y-5">
          <div className={CREATOR_CARD_GRID_CLASS} data-testid="creator-card-grid">
            {visibleRows.map((creator) => (
              <CreatorCard
                key={creator.id}
                creator={creator}
                categoryLabel={creator.category_id ? categoryById.get(creator.category_id) ?? null : null}
                categories={categories}
                tracked={trackedSet.has(creator.id)}
                busy={busyAccount === creator.id}
                mode={mode}
                onToggle={() => toggleOne(creator)}
                onEdited={(next) => setEdits((current) => new Map(current).set(creator.id, { name: next.name, category_id: next.categoryId }))}
                onRemoved={() => setRemovedIds((current) => new Set(current).add(creator.id))}
                onRestore={() => setRemovedIds((current) => { const next = new Set(current); next.delete(creator.id); return next; })}
              />
            ))}
          </div>
          {displayWindow.remainingCount > 0 && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="lg"
                onClick={() => setVisibleCount((current) => current + displayWindow.nextCount)}
              >
                Show {displayWindow.nextCount} more
                <span className="text-muted-foreground">· {displayWindow.remainingCount} remaining</span>
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

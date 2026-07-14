import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { visibleCategoriesOr } from "@/lib/categories";
import { listWritableLibraries } from "@/lib/shared-bookmarks";
import {
  countSwipePosts,
  fetchSwipePage,
  resolveSwipeAccountIds,
  SWIPE_POST_COLS,
  type SwipeAccountScope,
} from "@/lib/swipe-query";
import { FeaturedPostCard } from "@/components/featured-post-card";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Flame, Trophy } from "lucide-react";
import { SwipeFilters } from "./filters";
import { SwipeGrid } from "./swipe-grid";
import { NextDrop } from "./next-drop";
import { retryRead } from "@/lib/retry-read";
import { Suspense } from "react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Toolbar,
} from "@/components/app-surface";
import { SwipeFilterPersistence } from "@/components/persisted-filter-state";
import { BookmarksView, type BookmarksSearchParams } from "../bookmarks/bookmarks-view";
import { InspirationTabs } from "./inspiration-tabs";
import { SavePostButton } from "./save-post-button";
import { canonicalSwipeCategory } from "@/lib/swipe-category";
import {
  DEFAULT_SWIPE_RECENCY,
  DEFAULT_SWIPE_SORT,
  isDefaultSwipeSort,
} from "@/lib/swipe-filter-policy";
import { CategoryFilterRail } from "./category-filter-rail";

// No `force-dynamic` — this page is naturally dynamic via auth() + searchParams,
// but dropping force-dynamic lets Next's client-side Router Cache (~30s default)
// kick in on back-nav, making sidebar clicks feel instant.

type SP = {
  category?: string;
  sort?: string;
  dir?: string;
  rec?: string;
  from?: string;
  to?: string;
  minR?: string;
  minC?: string;
  type?: string;
  q?: string;
  tab?: string;
  share?: string;
  // Legacy: ?view=saved used to flip the page into a bookmarks view. Now
  // bookmarks live under the Inspiration route at ?tab=bookmarks. We keep the
  // param in the type so we can detect old URLs in history and redirect.
  view?: string;
};

type SwipeCategory = { id: string; label: string };
type SwipeCategoryData = {
  allCategories: SwipeCategory[];
  trackedCategories: SwipeCategory[];
};

async function loadSwipeCategoryData(): Promise<SwipeCategoryData> {
  const sb = await scopedSupabase();
  const [
    { data: workspaceCategoryRows, error: workspaceCategoryErr },
    { data: categoryRows, error: categoryErr },
  ] = await Promise.all([
    retryRead(() => sb.workspaceAccountsSelect("accounts!inner(category_id)")),
    retryRead(() =>
      sb.raw
        .from("categories")
        .select("id, label, sort_order")
        .or(visibleCategoriesOr(sb.workspaceId))
        .order("sort_order"),
    ),
  ]);
  if (workspaceCategoryErr || categoryErr) {
    console.error(
      "Swipe category rail failed (degrading to no chips):",
      (workspaceCategoryErr ?? categoryErr)?.message,
    );
  }
  const trackedCategoryIds = new Set(
    ((workspaceCategoryRows ?? []) as unknown as Array<{
      accounts: { category_id: string | null } | { category_id: string | null }[];
    }>)
      .map((row) => {
        const account = Array.isArray(row.accounts) ? row.accounts[0] : row.accounts;
        return account?.category_id ?? null;
      })
      .filter((id): id is string => Boolean(id)),
  );
  const allCategories = (categoryRows ?? []) as SwipeCategory[];
  return {
    allCategories,
    trackedCategories: allCategories.filter((category) => trackedCategoryIds.has(category.id)),
  };
}

// PostgREST .or() values are comma-separated, so any literal comma or paren in
// the user's input would corrupt the filter expression. We don't expect commas
// in creator names, but strip them defensively along with the % wildcard so a
// stray character can't broaden the match unexpectedly.
function sanitizeCreatorQuery(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,()%*]/g, "").trim().slice(0, 80);
  return cleaned.length >= 1 ? cleaned : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDayStart(d: string | undefined): string | null {
  if (!d || !DATE_RE.test(d)) return null;
  const dt = new Date(`${d}T00:00:00.000Z`);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function parseDayEnd(d: string | undefined): string | null {
  if (!d || !DATE_RE.test(d)) return null;
  const dt = new Date(`${d}T23:59:59.999Z`);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

const POST_TYPES = new Set(["regular", "lead_magnet"]);

const SORT_COLUMN: Record<string, string> = {
  reactions: "reactions",
  viral: "viral_score",
  comments: "comments",
  posted: "posted_at",
  // "recent" — pure newest-first (posted_at DESC), no engagement re-rank. The
  // default. Keeps the feed from re-surfacing the same high-reaction creators
  // every day (each post already cleared the is_viral bar). See swipe-query.ts.
  recent: "posted_at",
  // "recent-viral" — legacy default, now opt-in: ordered by posted_at DESC,
  // then re-bucketed by day + ranked by reactions in JS after fetch. The
  // mapping here is a sentinel so the param validates.
  "recent-viral": "posted_at",
  // "relative" ranks by score/baseline (handled in fetchSwipePage); sentinel
  // so the param validates here too.
  relative: "baseline_score",
};

export default async function SwipePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;

  // Backward compat: ?view=saved used to flip this page into a bookmarks
  // view; bookmarks now have their own route. Forward old URLs while
  // preserving the active niche filter.
  if (sp.view === "saved") {
    const target = sp.category
      ? `/dashboard/swipe?tab=bookmarks&category=${encodeURIComponent(sp.category)}`
      : "/dashboard/swipe?tab=bookmarks";
    redirect(target);
  }

  if (sp.tab === "bookmarks") {
    return <BookmarksView searchParams={sp as BookmarksSearchParams} />;
  }

  // Preload category chrome without awaiting it at the page root. The rail,
  // active label, save action, and posts section can now resolve in parallel
  // instead of every category navigation paying for chrome before feed work
  // is even allowed to begin.
  const categoryDataPromise = loadSwipeCategoryData();

  const sortKey = sp.sort && SORT_COLUMN[sp.sort] ? sp.sort : DEFAULT_SWIPE_SORT;
  const ascending = sp.dir === "asc";
  const rec = sp.rec === "old" ? "old" : DEFAULT_SWIPE_RECENCY;
  const minR = sp.minR ? Math.max(0, parseInt(sp.minR, 10) || 0) : null;
  const minC = sp.minC ? Math.max(0, parseInt(sp.minC, 10) || 0) : null;
  const fromIso = parseDayStart(sp.from);
  const toIso = parseDayEnd(sp.to);
  const postType = sp.type && POST_TYPES.has(sp.type) ? sp.type : null;
  const creatorQuery = sanitizeCreatorQuery(sp.q);
  const filtersActive =
    !isDefaultSwipeSort(sortKey, sp.dir) ||
    rec !== DEFAULT_SWIPE_RECENCY ||
    !!fromIso ||
    !!toIso ||
    !!minR ||
    !!minC ||
    !!postType ||
    !!creatorQuery;

  // Stable Suspense key — when any filter changes, React unmounts the old
  // <PostsSection> and shows the fallback instantly (no janky wait for the
  // server query before the UI reacts).
  const filterKey = JSON.stringify({
    c: sp.category ?? "",
    s: sp.sort ?? "",
    d: sp.dir ?? "",
    r: sp.rec ?? "",
    f: sp.from ?? "",
    t: sp.to ?? "",
    mr: sp.minR ?? "",
    mc: sp.minC ?? "",
    pt: sp.type ?? "",
    q: creatorQuery ?? "",
  });

  return (
    <PageShell width="wide">
      <SwipeFilterPersistence />
      {/* Page header — desktop only; mobile already has the app top bar. */}
      <PageHeader
        className="hidden lg:flex"
        title="Swipe File"
        description={
          <>
            <span>
              Source inspiration from the most viral daily posts by creators you track.
              Save outside posts manually into Bookmarks when you find something worth modeling.
            </span>
            {(!isDefaultSwipeSort(sortKey, ascending ? "asc" : "desc") || rec === "old") && (
              <>
                <span className="mx-1.5 text-border">/</span>
                <span>{labelForSort(sortKey, ascending, rec === "old")}</span>
              </>
            )}
            {sp.category && (
              <>
                <span className="mx-1.5 text-border">/</span>
                <span>
                  filtered to{" "}
                  <span className="font-medium text-foreground">
                    <Suspense fallback="selected category">
                      <ActiveCategoryLabel
                        categoryId={sp.category}
                        categoryDataPromise={categoryDataPromise}
                      />
                    </Suspense>
                  </span>
                </span>
              </>
            )}
            {creatorQuery && (
              <>
                <span className="mx-1.5 text-border">/</span>
                <span>creator matching <span className="font-medium text-foreground">&ldquo;{creatorQuery}&rdquo;</span></span>
              </>
            )}
          </>
        }
        actions={<NextDrop />}
      />

      <InspirationTabs
        active="swipe"
        action={
          <Suspense fallback={null}>
            <SavePostAction categoryDataPromise={categoryDataPromise} />
          </Suspense>
        }
      />

      {/* Toolbar card: category rail + filter chips, grouped */}
      <Toolbar className="overflow-hidden">
        {/* Category rail — lists categories the workspace's tracked
            accounts belong to. Hidden when no tracked accounts have a
            category (uncategorized creators land in the empty state). */}
        <Suspense fallback={<CategoryRailSkeleton />}>
          <SwipeCategoryRail sp={sp} categoryDataPromise={categoryDataPromise} />
        </Suspense>

        {/* Filters */}
        <div className="px-4 sm:px-5 py-3">
          <SwipeFilters />
        </div>
      </Toolbar>

      <Suspense key={filterKey} fallback={<PostsSkeleton />}>
        <PostsSection sp={sp} filtersActive={filtersActive} />
      </Suspense>
    </PageShell>
  );
}

async function ActiveCategoryLabel({
  categoryId,
  categoryDataPromise,
}: {
  categoryId: string;
  categoryDataPromise: Promise<SwipeCategoryData>;
}) {
  const { allCategories } = await categoryDataPromise;
  return allCategories.find((category) => category.id === categoryId)?.label ?? "All categories";
}

async function SavePostAction({
  categoryDataPromise,
}: {
  categoryDataPromise: Promise<SwipeCategoryData>;
}) {
  const { allCategories } = await categoryDataPromise;
  return <SavePostButton categories={allCategories} />;
}

async function SwipeCategoryRail({
  sp,
  categoryDataPromise,
}: {
  sp: SP;
  categoryDataPromise: Promise<SwipeCategoryData>;
}) {
  const { allCategories, trackedCategories } = await categoryDataPromise;
  const canonicalCategory = canonicalSwipeCategory(
    sp.category,
    allCategories.map((category) => category.id),
  );
  if (sp.category && canonicalCategory !== sp.category) {
    redirect(preserveSort(sp, { category: canonicalCategory ?? undefined }));
  }
  if (trackedCategories.length === 0) return null;

  return (
    <div className="border-b border-border/60 bg-background/40 px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <div className="hidden shrink-0 text-xs font-medium text-muted-foreground sm:block">
          Category
        </div>
        <CategoryFilterRail
          activeCategoryId={sp.category ?? null}
          allHref={preserveSort(sp, { category: undefined })}
          categories={trackedCategories.map((category) => ({
            ...category,
            href: preserveSort(sp, { category: category.id }),
          }))}
        />
      </div>
    </div>
  );
}

function CategoryRailSkeleton() {
  return <div className="h-[69px] animate-pulse border-b border-border/60 bg-background/40" />;
}

async function PostsSection({ sp, filtersActive }: { sp: SP; filtersActive: boolean }) {
  const sb = await scopedSupabase();
  // The featured rail is hidden whenever a category or advanced filter is
  // active. Avoid loading the full tracked-id set on those requests; the
  // narrowed resolver below can answer a category click directly in one join.
  const needsFeaturedRail = !sp.category && !filtersActive;
  const allTrackedIds = needsFeaturedRail
    ? await trackedAccountIds(sb.workspaceId)
    : [];

  // Kick off featured-rail decoration concurrently with the feed. Filtered
  // requests skip this block entirely: the rail is hidden and bookmark
  // libraries load on demand, so unrelated reads cannot delay the results.
  //
  // This side data is NON-ESSENTIAL decoration: clients power per-card brand
  // colours, lastRun powers the "Top from last batch" label, libraries power
  // the bookmark picker. None of it is needed to render the feed itself. So
  // the whole block is wrapped to NEVER throw — each read is retried
  // (retryRead) to self-heal a cold-socket blip after idle, and the block as
  // a whole degrades to empty/null on a persistent failure instead of taking
  // down the entire swipe page. (This block was the last un-retried,
  // throw-capable group on the swipe render path — a fresh-load failure after
  // hours idle landed exactly here because Promise.all rejects whole if any
  // member rejects, and the rejection surfaced unguarded at the await below.)
  const sideDataPromise = needsFeaturedRail
    ? (async () => {
        try {
          const [clientsRes, lastRunRes, libraries] = await Promise.all([
            retryRead<Array<{ id: string; name: string; brand_colors: { name?: string; hex: string }[] }>>(
              () => sb.clientsSelect("id, name, brand_colors").order("name"),
            ),
            retryRead<{ started_at: string | null; finished_at: string | null }>(() =>
              sb
                .runsSelect("started_at, finished_at")
                .eq("status", "ok")
                .order("started_at", { ascending: false })
                .limit(1)
                .maybeSingle(),
            ),
            listWritableLibraries(),
          ]);
          return {
            clients: clientsRes.data ?? null,
            lastRun: lastRunRes.data ?? null,
            libraries,
          };
        } catch {
          // Side data is decoration — never let it crash the feed.
          return { clients: null, lastRun: null, libraries: undefined };
        }
      })()
    : Promise.resolve({ clients: null, lastRun: null, libraries: undefined });

  // Resolve the (category + creator)-narrowed account-id set, then fetch
  // the first page of viral posts. Pagination beyond page 0 is handled
  // client-side by <SwipeGrid> hitting GET /api/swipe-posts — which runs
  // the SAME fetchSwipePage helper, so the lazily-loaded pages match the
  // SSR'd first page exactly. (Previously this was a hard .limit(100),
  // which silently dropped viral posts past the newest 100 by posted_at.)
  const creatorQuery = sanitizeCreatorQuery(sp.q);
  const accountScope: SwipeAccountScope =
    sp.category && !creatorQuery
      ? { workspaceId: sb.workspaceId }
      : {
          accountIds: await resolveSwipeAccountIds(
            sb.workspaceId,
            sp.category ?? null,
            creatorQuery,
          ),
        };

  const fromIso = parseDayStart(sp.from);
  const toIso = parseDayEnd(sp.to);
  const minR = sp.minR ? Math.max(0, parseInt(sp.minR, 10) || 0) : null;
  const minC = sp.minC ? Math.max(0, parseInt(sp.minC, 10) || 0) : null;

  const swipeFilters = {
    category: sp.category ?? null,
    sort: sp.sort ?? null,
    dir: sp.dir ?? null,
    rec: sp.rec ?? null,
    from: fromIso,
    to: toIso,
    minR,
    minC,
    type: sp.type ?? null,
    q: creatorQuery,
  };

  // Start the feed as soon as its narrowed account ids are ready. Previously
  // page 0 and its count waited for clients, run metadata, and bookmark
  // libraries even though those independent reads had already started. This
  // turns the remaining latency from side-data + feed into the slower of the
  // two groups.
  const feedPromise = Promise.all([
    fetchSwipePage({ ...accountScope, filters: swipeFilters, offset: 0 }),
    countSwipePosts({ ...accountScope, filters: swipeFilters }),
  ]);

  // Resolve the side data started up top. Libraries are prop-drilled to every
  // card. Already retried + degraded to null/[] above, so this never throws.
  const { clients, lastRun, libraries } = await sideDataPromise;

  // Last-batch featured rail: top 10 by reactions among posts scraped in
  // the most recent run, across all tracked accounts, ignoring the user's
  // current sort / pattern filters. It depends only on `lastRun` and
  // `allTrackedIds` (both resolved above), not on the narrowed page-0
  // results — so we fold it into the same Promise.all below instead of
  // running it as an extra serial round-trip after. Skipped entirely when
  // filters are active (the rail is hidden then anyway) or when there's no
  // run / no tracked accounts.
  const railPromise =
    !sp.category && !filtersActive && lastRun?.started_at && allTrackedIds.length > 0
      ? retryRead(() =>
          sb.raw
            .from("posts")
            .select(SWIPE_POST_COLS)
            .in("account_id", allTrackedIds)
            .eq("is_viral", true)
            .gte("scraped_at", lastRun.started_at!)
            .order("reactions", { ascending: false, nullsFirst: false })
            .limit(10),
        )
      : Promise.resolve({ data: null });

  // Page 0 + the exact total count + the featured rail, in parallel. The
  // count powers the "N viral posts" header (was "N+" when we only knew
  // there was a next page). count uses head:true so it transfers no rows.
  const [[{ posts, nextOffset }, totalCount], railRes] = await Promise.all([
    feedPromise,
    railPromise,
  ]);

  // Filter params the client grid replays (sans offset) when loading more.
  // creatorQuery is the sanitized value so the API re-sanitizes to the same.
  const swipeQueryParams = new URLSearchParams();
  if (sp.category) swipeQueryParams.set("category", sp.category);
  if (sp.sort) swipeQueryParams.set("sort", sp.sort);
  if (sp.dir) swipeQueryParams.set("dir", sp.dir);
  if (sp.rec) swipeQueryParams.set("rec", sp.rec);
  if (sp.from) swipeQueryParams.set("from", sp.from);
  if (sp.to) swipeQueryParams.set("to", sp.to);
  if (sp.minR) swipeQueryParams.set("minR", sp.minR);
  if (sp.minC) swipeQueryParams.set("minC", sp.minC);
  if (sp.type) swipeQueryParams.set("type", sp.type);
  if (creatorQuery) swipeQueryParams.set("q", creatorQuery);
  const swipeQuery = swipeQueryParams.toString();
  // Remount the grid when filters change so it resets to the new page 0.
  const swipeFilterKey = swipeQuery;

  // Flatten the featured-rail rows fetched above (in parallel with page 0).
  // Deriving the rail from `posts` (the already-sorted/filtered main result)
  // made it biased — e.g. when the user sorted by comments, the rail could
  // miss the top-by-reactions posts entirely — so it's its own query.
  const lastBatchPosts: typeof posts | null = railRes.data
    ? (railRes.data.map((p) => ({
        ...p,
        accounts: Array.isArray(p.accounts) ? p.accounts[0] ?? null : p.accounts,
      })) as typeof posts)
    : null;

  const featuredPosts = (lastBatchPosts && lastBatchPosts.length > 0 ? lastBatchPosts : posts) ?? [];
  const showFeatured = !sp.category && !filtersActive && featuredPosts.length >= 5;
  const lastBatchLabel = lastRun?.finished_at
    ? new Date(lastRun.finished_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;

  return (
    <>
      {showFeatured && (
        <section className="hidden lg:block space-y-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-primary/15 bg-primary/[0.06] text-primary">
              <Trophy className="h-3.5 w-3.5" aria-hidden />
            </span>
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="text-sm font-semibold tracking-tight">Top from last batch</h2>
              <span className="text-xs text-muted-foreground">
                highest engagement among your tracked accounts
                {lastBatchLabel && <> · {lastBatchLabel}</>}
              </span>
            </div>
          </div>
          <div className="flex gap-3 overflow-x-auto -mx-8 px-8 pb-2 no-scrollbar">
            {(() => {
              const top5 = featuredPosts.slice(0, 5);
              const firstWithImg = top5.findIndex(
                (p) => p.media_type === "image" && (p.media_urls as string[] | undefined)?.[0],
              );
              return top5.map((p, i) => (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                <FeaturedPostCard key={p.id} post={p as any} rank={i} priority={i === firstWithImg} />
              ));
            })()}
          </div>
        </section>
      )}

      <div className="hidden lg:block text-xs text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{totalCount.toLocaleString()}</span>{" "}
        viral post{totalCount === 1 ? "" : "s"}
      </div>

      {posts && posts.length > 0 ? (
        // One responsive infinite-scroll grid on every screen size (1 col on
        // mobile → 2 → 3 on wide). Mobile now SCROLLS like the bookmarks page
        // instead of the old card-swipe deck.
        <SwipeGrid
          // Remount on filter change so state resets to the new first page.
          key={swipeFilterKey}
          initialPosts={posts}
          initialNextOffset={nextOffset}
          query={swipeQuery}
          clients={clients ?? []}
          libraries={libraries}
        />
      ) : (
        <EmptyState
          className="mt-3"
          icon={<Flame className="h-6 w-6" aria-hidden />}
          title="No posts match these filters"
          description={
            filtersActive
              ? "Try widening the date range or lowering the minimums."
              : "Track creators first, then run a scrape to fill your swipe file with posts to model."
          }
          action={
            filtersActive ? (
                <Link
                  href={sp.category ? `/dashboard/swipe?category=${encodeURIComponent(sp.category)}` : "/dashboard/swipe"}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors"
                >
                  Reset filters
                </Link>
            ) : (
              <Link
                href="/dashboard/accounts"
                className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90"
              >
                Track creators
              </Link>
            )
          }
        />
      )}
    </>
  );
}

function PostsSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 animate-pulse mt-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border/60 bg-card shadow-soft p-4 space-y-3">
          <div className="flex items-center gap-2.5">
            <div className="h-10 w-10 rounded-full bg-muted shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 w-32 rounded bg-muted" />
              <div className="h-3 w-20 rounded bg-muted/70" />
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="h-3 w-full rounded bg-muted/70" />
            <div className="h-3 w-11/12 rounded bg-muted/70" />
            <div className="h-3 w-4/5 rounded bg-muted/70" />
          </div>
          <div className="flex items-center gap-3 pt-1">
            <div className="h-3 w-12 rounded bg-muted/70" />
            <div className="h-3 w-10 rounded bg-muted/70" />
            <div className="h-3 w-10 rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

function labelForSort(sortKey: string, asc: boolean, recAsc: boolean): string {
  const arrow = asc ? "↑" : "↓";
  const recencyTail = recAsc ? " / oldest first" : " / newest first";
  if (sortKey === "recent") return "newest first";
  if (sortKey === "recent-viral") return "newest day first, top reactions within each day";
  if (sortKey === "relative") return "biggest breakouts first, ranked vs each creator's own baseline";
  if (sortKey === "reactions") return `sorted by reactions ${arrow}${recencyTail}`;
  if (sortKey === "viral") return `ranked by engagement score${recencyTail}`;
  if (sortKey === "comments") return `sorted by comments ${arrow}${recencyTail}`;
  if (sortKey === "posted") return asc ? "sorted by date posted, oldest first" : "sorted by date posted, newest first";
  return "newest day first, top reactions within each day";
}

// Build an href that keeps current sort/filter params and updates the category.
// `patch.category === undefined` (or key absent) means "clear the category" —
// used by the "All" chip. Use `'category' in patch` to distinguish from "not
// patching".
function preserveSort(sp: SP, patch: { category?: string }): string {
  const params = new URLSearchParams();
  if (sp.sort) params.set("sort", sp.sort);
  if (sp.dir) params.set("dir", sp.dir);
  if (sp.rec) params.set("rec", sp.rec);
  if (sp.from) params.set("from", sp.from);
  if (sp.to) params.set("to", sp.to);
  if (sp.minR) params.set("minR", sp.minR);
  if (sp.minC) params.set("minC", sp.minC);
  if (sp.type) params.set("type", sp.type);
  if (sp.q) params.set("q", sp.q);
  if ("category" in patch) {
    if (patch.category) params.set("category", patch.category);
  } else if (sp.category) {
    params.set("category", sp.category);
  }
  const qs = params.toString();
  return qs ? `/dashboard/swipe?${qs}` : "/dashboard/swipe";
}

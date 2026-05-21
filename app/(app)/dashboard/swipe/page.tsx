import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { PostCard } from "@/components/post-card";
import { FeaturedPostCard } from "@/components/featured-post-card";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Flame, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { SwipeFilters } from "./filters";
import { SwipeDeck } from "./swipe-deck";
import { Suspense } from "react";

// No `force-dynamic` — this page is naturally dynamic via auth() + searchParams,
// but dropping force-dynamic lets Next's client-side Router Cache (~30s default)
// kick in on back-nav, making sidebar clicks feel instant.

type SP = {
  category?: string;
  sort?: string;
  dir?: string;
  since?: string;
  from?: string;
  to?: string;
  minR?: string;
  minC?: string;
  type?: string;
};

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
  viral: "viral_score",
  reactions: "reactions",
  comments: "comments",
  posted: "posted_at",
};

function sinceCutoff(since?: string): string | null {
  const days = since === "1d" ? 1 : since === "7d" ? 7 : since === "30d" ? 30 : null;
  if (!days) return null;
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

export default async function SwipePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await scopedSupabase();

  // Pull the category rail (small, fast query). Chips are the canonical
  // categories that this workspace's tracked accounts belong to — not the
  // raw `accounts.niche` free-text. Posts + clients get their own Suspense
  // boundary so the toolbar paints immediately when the user toggles a chip.
  const [{ data: workspaceCategoryRows }, { data: categoryRows }] = await Promise.all([
    sb.workspaceAccountsSelect("accounts!inner(category_id)"),
    sb.raw.from("categories").select("id, label, sort_order").order("sort_order"),
  ]);
  const trackedCategoryIds = new Set(
    ((workspaceCategoryRows ?? []) as unknown as Array<{
      accounts: { category_id: string | null } | { category_id: string | null }[];
    }>)
      .map((r) => {
        const acc = Array.isArray(r.accounts) ? r.accounts[0] : r.accounts;
        return acc?.category_id ?? null;
      })
      .filter((id): id is string => !!id),
  );
  const categories = ((categoryRows ?? []) as Array<{ id: string; label: string }>)
    .filter((c) => trackedCategoryIds.has(c.id));
  const activeCategoryLabel =
    categories.find((c) => c.id === sp.category)?.label ?? "All categories";

  const sortKey = sp.sort && SORT_COLUMN[sp.sort] ? sp.sort : "viral";
  const ascending = sp.dir === "asc";
  const minR = sp.minR ? Math.max(0, parseInt(sp.minR, 10) || 0) : null;
  const minC = sp.minC ? Math.max(0, parseInt(sp.minC, 10) || 0) : null;
  const fromIso = parseDayStart(sp.from);
  const toIso = parseDayEnd(sp.to);
  const postType = sp.type && POST_TYPES.has(sp.type) ? sp.type : null;
  const filtersActive =
    !!(sp.sort && sp.sort !== "viral") ||
    !!(sp.dir && sp.dir !== "desc") ||
    !!(sp.since && sp.since !== "all") ||
    !!fromIso ||
    !!toIso ||
    !!minR ||
    !!minC ||
    !!postType;

  // Stable Suspense key — when any filter changes, React unmounts the old
  // <PostsSection> and shows the fallback instantly (no janky wait for the
  // server query before the UI reacts).
  const filterKey = JSON.stringify({
    c: sp.category ?? "",
    s: sp.sort ?? "",
    d: sp.dir ?? "",
    si: sp.since ?? "",
    f: sp.from ?? "",
    t: sp.to ?? "",
    mr: sp.minR ?? "",
    mc: sp.minC ?? "",
    pt: sp.type ?? "",
  });

  return (
    <div className="space-y-6">
      {/* Page header — hidden on mobile to give the deck more room */}
      <div className="hidden lg:flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display tracking-tight">Swipe File</h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            <span>{labelForSort(sortKey, ascending)}</span>
            {sp.category && (
              <>
                <span className="mx-1.5 text-border">·</span>
                <span>filtered to <span className="font-medium text-foreground">{activeCategoryLabel}</span></span>
              </>
            )}
          </p>
        </div>
      </div>

      {/* Toolbar card: category rail + filter chips, grouped */}
      <div className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
        {/* Category rail — only categories the workspace tracks */}
        <div className="px-4 sm:px-5 py-3 border-b border-border/60 bg-background/40">
          <div className="flex items-center gap-3">
            <div className="text-xs font-medium text-muted-foreground shrink-0 hidden sm:block">
              Category
            </div>
            <div className="flex-1 min-w-0 relative">
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar py-0.5">
                <FilterChip href={preserveSort(sp, { category: undefined })} active={!sp.category}>
                  All <span className="ml-1 text-[10px] opacity-60">{categories.length}</span>
                </FilterChip>
                {categories.map((c) => (
                  <FilterChip
                    key={c.id}
                    href={preserveSort(sp, { category: c.id })}
                    active={sp.category === c.id}
                  >
                    {c.label}
                  </FilterChip>
                ))}
              </div>
            </div>
            <div className="hidden md:flex items-center text-[11px] text-muted-foreground shrink-0 pl-2 border-l border-border/60">
              <span className="font-medium text-foreground">{activeCategoryLabel}</span>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="px-4 sm:px-5 py-3">
          <SwipeFilters />
        </div>
      </div>

      <Suspense key={filterKey} fallback={<PostsSkeleton />}>
        <PostsSection sp={sp} filtersActive={filtersActive} />
      </Suspense>
    </div>
  );
}

async function PostsSection({ sp, filtersActive }: { sp: SP; filtersActive: boolean }) {
  const sb = await scopedSupabase();
  const allTrackedIds = await trackedAccountIds(sb.workspaceId);

  // If the user has picked a category, narrow the account-id set to just the
  // tracked accounts whose global category matches. Doing this in two steps
  // (here, then `.in()` below) keeps the posts query a single round-trip and
  // avoids embedding `accounts.category_id=` filters that PostgREST applies
  // *after* the join — which would return matched posts but with `accounts`
  // null for the others.
  let accountIds = allTrackedIds;
  if (sp.category && allTrackedIds.length > 0) {
    const { data: catFiltered } = await sb.raw
      .from("accounts")
      .select("id")
      .in("id", allTrackedIds)
      .eq("category_id", sp.category);
    accountIds = (catFiltered ?? []).map((r) => r.id as string);
  }

  const sortKey = sp.sort && SORT_COLUMN[sp.sort] ? sp.sort : "viral";
  const sortCol = SORT_COLUMN[sortKey];
  const ascending = sp.dir === "asc";
  const minR = sp.minR ? Math.max(0, parseInt(sp.minR, 10) || 0) : null;
  const minC = sp.minC ? Math.max(0, parseInt(sp.minC, 10) || 0) : null;
  const cutoff = sinceCutoff(sp.since);
  const fromIso = parseDayStart(sp.from);
  const toIso = parseDayEnd(sp.to);
  const postType = sp.type && POST_TYPES.has(sp.type) ? sp.type : null;

  const POST_COLS =
    "id, text, post_url, posted_at, reactions, comments, reposts, media_type, media_urls, visual_kind, scraped_at, accounts!inner(name, niche, linkedin_handle, profile_pic_url), templates(id, template_text)";

  const [clientsRes, lastRunRes] = await Promise.all([
    sb.clientsSelect("id, name, brand_colors").order("name"),
    sb.runsSelect("started_at, finished_at")
      .eq("status", "ok")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const clients = clientsRes.data;
  const lastRun = lastRunRes.data;

  let q = sb.raw
    .from("posts")
    .select(POST_COLS)
    .in("account_id", accountIds.length ? accountIds : ["00000000-0000-0000-0000-000000000000"])
    .eq("is_viral", true)
    .order(sortCol, { ascending, nullsFirst: false })
    .limit(100);
  if (cutoff) q = q.gte("posted_at", cutoff);
  if (fromIso) q = q.gte("posted_at", fromIso);
  if (toIso) q = q.lte("posted_at", toIso);
  if (minR !== null) q = q.gte("reactions", minR);
  if (minC !== null) q = q.gte("comments", minC);
  if (postType) q = q.eq("post_type", postType);
  const { data: rawPosts } = await q;
  const posts = (rawPosts ?? []).map((p) => ({
    ...p,
    accounts: Array.isArray(p.accounts) ? p.accounts[0] ?? null : p.accounts,
    templates: p.templates ?? [],
  }));

  // Derive last-batch featured rail from the result set we already fetched —
  // avoids a second round trip.
  let lastBatchPosts: typeof posts | null = null;
  if (lastRun?.started_at) {
    const cutoffMs = new Date(lastRun.started_at).getTime();
    lastBatchPosts = [...posts]
      .filter((p) => p.scraped_at && new Date(p.scraped_at).getTime() >= cutoffMs)
      .sort((a, b) => (b.reactions ?? 0) - (a.reactions ?? 0))
      .slice(0, 10);
  }

  const featuredPosts = (lastBatchPosts && lastBatchPosts.length > 0 ? lastBatchPosts : posts) ?? [];
  const showFeatured = !sp.category && !filtersActive && featuredPosts.length >= 5;
  const lastBatchLabel = lastRun?.finished_at
    ? new Date(lastRun.finished_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;

  return (
    <>
      {showFeatured && (
        <section className="hidden lg:block space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold tracking-tight">Top from last batch</h2>
            <span className="text-xs text-muted-foreground">
              · highest engagement among your tracked accounts
              {lastBatchLabel && <> · {lastBatchLabel}</>}
            </span>
          </div>
          <div className="flex gap-3 overflow-x-auto -mx-8 px-8 pb-2 no-scrollbar">
            {(() => {
              const top5 = featuredPosts.slice(0, 5);
              const firstWithImg = top5.findIndex((p) => p.media_type === "image" && p.media_urls?.[0]);
              return top5.map((p, i) => (
                <FeaturedPostCard key={p.id} post={p} rank={i} priority={i === firstWithImg} />
              ));
            })()}
          </div>
        </section>
      )}

      <div className="hidden lg:block text-xs text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{posts?.length ?? 0}</span> viral posts
      </div>

      {posts && posts.length > 0 ? (
        <>
          {/* Desktop grid */}
          <div className="hidden lg:grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 mt-3">
            {posts.map((p, i) => <PostCard key={p.id} post={p} clients={clients ?? []} priority={i < 2} />)}
          </div>
          {/* Mobile swipe deck */}
          <div className="lg:hidden">
            <SwipeDeck posts={posts} clients={clients ?? []} />
          </div>
        </>
      ) : (
        <Card className="border-dashed bg-card/50 mt-3">
          <CardContent className="py-16 px-6 text-center space-y-4 max-w-md mx-auto">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-orange-500/15 to-primary/10 grid place-items-center mx-auto ring-1 ring-orange-500/10">
              <Flame className="h-6 w-6 text-orange-500" />
            </div>
            <div className="space-y-1">
              <div className="text-base font-semibold tracking-tight">No posts match these filters</div>
              <div className="text-sm text-muted-foreground leading-relaxed">
                {filtersActive
                  ? "Try widening the date range or lowering the minimums."
                  : <>Run a scrape on the <Link className="underline underline-offset-2 hover:text-foreground" href="/dashboard/accounts">Accounts</Link> page, or lower the thresholds in <Link className="underline underline-offset-2 hover:text-foreground" href="/dashboard/settings">Settings</Link>.</>
                }
              </div>
            </div>
            {filtersActive && (
              <div className="pt-2">
                <Link
                  href={sp.category ? `/dashboard/swipe?category=${encodeURIComponent(sp.category)}` : "/dashboard/swipe"}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors"
                >
                  Reset filters
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
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

function labelForSort(sortKey: string, asc: boolean): string {
  const arrow = asc ? "↑" : "↓";
  if (sortKey === "viral") return "ranked by engagement score";
  if (sortKey === "reactions") return `sorted by reactions ${arrow}`;
  if (sortKey === "comments") return `sorted by comments ${arrow}`;
  if (sortKey === "posted") return `sorted by date posted ${arrow}`;
  return "ranked by engagement score";
}

// Build an href that keeps current sort/filter params and updates the category.
// `patch.category === undefined` (or key absent) means "clear the category" —
// used by the "All" chip. Use `'category' in patch` to distinguish from "not
// patching".
function preserveSort(sp: SP, patch: { category?: string }): string {
  const params = new URLSearchParams();
  if (sp.sort) params.set("sort", sp.sort);
  if (sp.dir) params.set("dir", sp.dir);
  if (sp.since) params.set("since", sp.since);
  if (sp.from) params.set("from", sp.from);
  if (sp.to) params.set("to", sp.to);
  if (sp.minR) params.set("minR", sp.minR);
  if (sp.minC) params.set("minC", sp.minC);
  if (sp.type) params.set("type", sp.type);
  if ("category" in patch) {
    if (patch.category) params.set("category", patch.category);
  } else if (sp.category) {
    params.set("category", sp.category);
  }
  const qs = params.toString();
  return qs ? `/dashboard/swipe?${qs}` : "/dashboard/swipe";
}

function FilterChip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center text-xs px-3 py-1.5 rounded-full transition-all font-medium whitespace-nowrap shrink-0",
        active
          ? "bg-foreground text-background shadow-soft"
          : "text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
    >
      {children}
    </Link>
  );
}

import { auth, currentUser } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { assertNoQueryError } from "@/lib/query-error";
import { resolveWorkspaceDisplays } from "@/lib/workspace-display";
import {
  fetchBookmarksPage,
  BOOKMARK_SORTS,
  normalizeBookmarkSort,
  type BookmarkSortKey,
} from "@/lib/bookmarks-query";
import { normalizePostType, type PostType } from "@/lib/post-type";
import { verifiedPrimaryEmail } from "@/lib/shared-bookmarks";
import { BookmarksGrid } from "./bookmarks-grid";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Bookmark, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { SavePostButton } from "../swipe/save-post-button";
import { SharedBookmarksManager } from "./shared-manager";
import { Suspense } from "react";

// Sharable bookmark libraries
// ---------------------------
// /dashboard/bookmarks shows the caller's own library by default. When
// `?share=<id>` is set we render the OWNER's library (with auth gating
// via the share row). The recipient sees:
//   - the owner's saves + any saves they themselves contributed
//   - their per-save notes + niche tags layered over the owner's, via
//     saved_post_overrides
//   - "Added by <name>" attribution for non-owner contributions
//
// All cross-library access is mediated by app-layer joins; RLS on
// saved_posts allows it as defense-in-depth (see migration 021).

type SP = {
  category?: string;
  share?: string;
  sort?: string;
  type?: string;
};

// The post-type filter options for the segmented control. `key: null` is the
// "All" tab (no ?type= param). Mirrors saved_posts.post_type values.
const POST_TYPE_FILTERS: { key: PostType | null; label: string }[] = [
  { key: null, label: "All" },
  { key: "regular", label: "Regular" },
  { key: "lead_magnet", label: "Lead magnets" },
];

type Share = {
  id: string;
  owner_workspace_id: string;
  status: string;
};

export default async function BookmarksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await scopedSupabase();
  const { userId } = await auth();

  // Resolve email-based pending invites to user_id (idempotent — only
  // touches rows that haven't been resolved yet). Same routine the GET
  // /api/shared-bookmarks endpoint runs; doing it here means a fresh
  // signup who lands on this page first sees their invite immediately
  // without an explicit API call.
  if (userId) {
    const user = await currentUser();
    // Bind invites only to a VERIFIED primary email — an unverified address
    // must never resolve someone else's pending invite. Already lowercased.
    const email = verifiedPrimaryEmail(user);
    if (email) {
      await sb.raw
        .from("shared_bookmarks")
        .update({ recipient_user_id: userId })
        .eq("recipient_email", email)
        .eq("status", "pending")
        .is("recipient_user_id", null);
    }
  }

  // These three reads are independent of each other — run them concurrently.
  // (The pending→accepted email resolution above must stay before them, so
  // they observe the freshly-linked recipient_user_id.) Same data, just
  // overlapped instead of three sequential round-trips.
  const [acceptedRes, pendingRes, outgoingRes] = await Promise.all([
    // Accepted shares = the tab list the caller can navigate between.
    userId
      ? sb.raw
          .from("shared_bookmarks")
          .select("id, owner_workspace_id, status")
          .eq("recipient_user_id", userId)
          .eq("status", "accepted")
      : Promise.resolve({ data: [] as Share[] }),
    // Pending invites surface in the share manager modal.
    userId
      ? sb.raw
          .from("shared_bookmarks")
          .select("id, owner_workspace_id, recipient_email, status, created_at")
          .eq("recipient_user_id", userId)
          .eq("status", "pending")
      : Promise.resolve({ data: [] as Array<{ id: string; owner_workspace_id: string; status: string; created_at: string }> }),
    // Outgoing invites for the manager modal (this workspace's invites).
    sb.raw
      .from("shared_bookmarks")
      .select("id, recipient_email, recipient_user_id, status, created_at, accepted_at")
      .eq("owner_workspace_id", sb.workspaceId)
      .in("status", ["pending", "accepted"])
      .order("created_at", { ascending: false }),
  ]);
  const shares = (acceptedRes.data ?? []) as Share[];
  const pending = (pendingRes.data ?? []) as Array<{
    id: string;
    owner_workspace_id: string;
    recipient_email: string;
    status: string;
    created_at: string;
  }>;
  const outgoingShares = outgoingRes.data;

  // Active library: ?share=<id> selects an accepted share. Otherwise
  // we render the caller's own workspace.
  const activeShare = sp.share ? shares.find((s) => s.id === sp.share) : null;
  const activeWorkspaceId = activeShare?.owner_workspace_id ?? sb.workspaceId;
  const isOwnView = !activeShare;

  // Resolve display names + category data — all independent, run concurrently.
  const ownerWsIds = Array.from(
    new Set([
      ...shares.map((s) => s.owner_workspace_id),
      ...pending.map((p) => p.owner_workspace_id),
    ]),
  );
  const [displays, categoryRes, savedCategoryRes] = await Promise.all([
    resolveWorkspaceDisplays(ownerWsIds),
    sb.raw.from("categories").select("id, label, sort_order").order("sort_order"),
    sb.raw
      .from("saved_posts")
      .select("category_id")
      .eq("workspace_id", activeWorkspaceId)
      .not("category_id", "is", null),
  ]);
  // Surface a transient read failure rather than silently hiding the niche
  // filter rail (gated on categories.length > 0).
  assertNoQueryError("bookmark categories", categoryRes, savedCategoryRes);
  const { data: categoryRows } = categoryRes;
  const { data: savedCategoryRows } = savedCategoryRes;
  const allCategories = (categoryRows ?? []) as Array<{ id: string; label: string }>;
  const savedCategoryIds = new Set(
    ((savedCategoryRows ?? []) as Array<{ category_id: string | null }>)
      .map((r) => r.category_id)
      .filter((id): id is string => !!id),
  );
  let categories = allCategories.filter((c) => savedCategoryIds.has(c.id));
  if (sp.category && !categories.some((c) => c.id === sp.category)) {
    const orphan = allCategories.find((c) => c.id === sp.category);
    if (orphan) categories = [...categories, orphan];
  }
  const activeCategoryLabel =
    allCategories.find((c) => c.id === sp.category)?.label ?? "All bookmarks";

  const sortKey = normalizeBookmarkSort(sp.sort);
  const postType = normalizePostType(sp.type);
  const activeTypeLabel =
    POST_TYPE_FILTERS.find((t) => t.key === postType)?.label ?? "All";
  // Sort + type are part of the Suspense key so changing either remounts
  // BookmarksSection (and the grid) with a freshly-filtered first page — same
  // mechanism as tab/niche switches.
  const filterKey = JSON.stringify({
    s: sp.share ?? "",
    c: sp.category ?? "",
    o: sortKey,
    t: postType ?? "",
  });

  // Shared between the desktop and mobile headers — the writable-library
  // actions (Save a post + the share manager). Both layouts render the same
  // components so the mobile experience never silently drops the Save button
  // (the old bug: the whole header was `hidden lg:flex`, so once you had ≥1
  // bookmark there was no way to add one on a phone).
  const headerActions = (
    <>
      {/* Save button shows in every library the viewer can write to —
          their own AND any shared library they've accepted. shareId
          threads through so the POST lands in the right workspace
          (the API attributes it via created_by_user_id). */}
      <SavePostButton categories={allCategories} shareId={activeShare?.id ?? null} />
      <SharedBookmarksManager
        outgoing={(outgoingShares ?? []) as Array<{
          id: string;
          recipient_email: string;
          recipient_user_id: string | null;
          status: string;
          created_at: string;
          accepted_at: string | null;
        }>}
        incoming={pending.map((p) => ({
          id: p.id,
          owner_name: displays.get(p.owner_workspace_id)?.name ?? "Someone",
          owner_email: displays.get(p.owner_workspace_id)?.email ?? null,
          created_at: p.created_at,
        }))}
      />
    </>
  );

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Desktop header */}
      <div className="hidden lg:flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display tracking-tight">Bookmarks</h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            <Bookmark className="inline h-3.5 w-3.5 mr-1 -mt-0.5 fill-current text-primary/80" />
            {isOwnView ? (
              <span>posts you&rsquo;ve bookmarked from across LinkedIn</span>
            ) : (
              <span>
                shared library from{" "}
                <span className="font-medium text-foreground">
                  {displays.get(activeWorkspaceId)?.name ?? "another workspace"}
                </span>
              </span>
            )}
            {sp.category && (
              <>
                <span className="mx-1.5 text-border">·</span>
                <span>
                  filtered to{" "}
                  <span className="font-medium text-foreground">{activeCategoryLabel}</span>
                </span>
              </>
            )}
            {postType && (
              <>
                <span className="mx-1.5 text-border">·</span>
                <span>
                  showing{" "}
                  <span className="font-medium text-foreground">{activeTypeLabel}</span>
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">{headerActions}</div>
      </div>

      {/* Mobile header — compact title + the same actions, always reachable. */}
      <div className="lg:hidden flex items-center justify-between gap-3">
        <h1 className="text-2xl font-display tracking-tight">Bookmarks</h1>
        <div className="flex items-center gap-2">{headerActions}</div>
      </div>

      {/* Tab strip — own library + accepted shares. Hidden when there
          are zero shared libraries (no clutter for solo users). */}
      {(shares.length > 0 || activeShare) && (
        <div className="flex gap-1 overflow-x-auto no-scrollbar border-b border-border/60">
          <TabLink href={hrefFor({}, { share: undefined })} active={isOwnView}>
            <Bookmark className="h-3.5 w-3.5" /> My bookmarks
          </TabLink>
          {shares.map((s) => {
            const d = displays.get(s.owner_workspace_id);
            return (
              <TabLink
                key={s.id}
                href={hrefFor({}, { share: s.id })}
                active={sp.share === s.id}
                title={d?.email ?? undefined}
              >
                <Users className="h-3.5 w-3.5" />
                {d?.name ?? "Shared"}
              </TabLink>
            );
          })}
        </div>
      )}

      {categories.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
          <div className="px-4 sm:px-5 py-3 bg-background/40">
            <div className="flex items-center gap-3">
              <div className="text-xs font-medium text-muted-foreground shrink-0 hidden sm:block">
                Niche
              </div>
              <div className="flex-1 min-w-0 relative">
                <div className="flex gap-1.5 overflow-x-auto no-scrollbar py-0.5">
                  <FilterChip href={hrefFor(sp, { category: undefined })} active={!sp.category}>
                    All <span className="ml-1 text-[10px] opacity-60">{categories.length}</span>
                  </FilterChip>
                  {categories.map((c) => (
                    <FilterChip
                      key={c.id}
                      href={hrefFor(sp, { category: c.id })}
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
        </div>
      )}

      {/* Type + Sort controls. Type (post_type) filter on the left, Sort
          pushed right. Both are segmented controls that scroll horizontally on
          mobile so they don't get clipped on narrow screens. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-muted-foreground shrink-0">Type</span>
          <div className="min-w-0 overflow-x-auto no-scrollbar -mx-0.5 px-0.5">
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-card p-0.5 shadow-soft">
              {POST_TYPE_FILTERS.map((t) => (
                <SortTab
                  key={t.key ?? "all"}
                  href={hrefFor(sp, { type: t.key ?? undefined })}
                  active={postType === t.key}
                >
                  {t.label}
                </SortTab>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 min-w-0 sm:ml-auto">
          <span className="text-xs font-medium text-muted-foreground shrink-0">Sort</span>
          <div className="min-w-0 overflow-x-auto no-scrollbar -mx-0.5 px-0.5">
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-card p-0.5 shadow-soft">
              {BOOKMARK_SORTS.map((s) => (
                <SortTab
                  key={s.key}
                  href={hrefFor(sp, { sort: s.key })}
                  active={sortKey === s.key}
                >
                  {s.label}
                </SortTab>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Suspense key={filterKey} fallback={<BookmarksSkeleton />}>
        <BookmarksSection
          activeWorkspaceId={activeWorkspaceId}
          activeShareId={activeShare?.id ?? null}
          userId={userId ?? null}
          isOwnView={isOwnView}
          categoryId={sp.category || null}
          categories={allCategories}
          sort={sortKey}
          postType={postType}
        />
      </Suspense>
    </div>
  );
}

async function BookmarksSection({
  activeWorkspaceId,
  activeShareId,
  userId,
  isOwnView,
  categoryId,
  categories,
  sort,
  postType,
}: {
  activeWorkspaceId: string;
  activeShareId: string | null;
  userId: string | null;
  isOwnView: boolean;
  categoryId: string | null;
  categories: Array<{ id: string; label: string }>;
  sort: BookmarkSortKey;
  postType: PostType | null;
}) {
  const categoryLabels = new Map(categories.map((c) => [c.id, c.label]));

  // First page only. The infinite-scroll grid fetches the rest from
  // GET /api/saved-posts, which runs the SAME fetchBookmarksPage helper
  // so card props never drift between SSR and lazily-loaded rows.
  const { cards, nextOffset } = await fetchBookmarksPage({
    activeWorkspaceId,
    userId,
    isOwnView,
    categoryId,
    categoryLabels,
    offset: 0,
    sort,
    postType,
  });

  return (
    <>
      <div className="hidden lg:block text-xs text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{cards.length}</span>
        {nextOffset !== null ? "+" : ""} bookmark{cards.length === 1 && nextOffset === null ? "" : "s"}
      </div>

      {cards.length > 0 ? (
        <BookmarksGrid
          // Key on the first card id + count so a router.refresh() after a
          // save/delete (newest row becomes first, or count changes)
          // remounts the grid with fresh server data. Tab/niche switches
          // already remount via the outer Suspense key.
          key={`${cards[0].row.id}:${cards.length}`}
          initialCards={cards}
          initialNextOffset={nextOffset}
          shareId={activeShareId}
          categoryId={categoryId}
          sort={sort}
          postType={postType}
        />
      ) : (
        <Card className="border-dashed bg-card/50 mt-3">
          <CardContent className="py-16 px-6 text-center space-y-4 max-w-md mx-auto">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary/15 to-amber-500/10 grid place-items-center mx-auto ring-1 ring-primary/10">
              <Bookmark className="h-6 w-6 text-primary" />
            </div>
            <div className="space-y-1">
              <div className="text-base font-semibold tracking-tight">
                {isOwnView ? "No bookmarks yet" : "No bookmarks in this shared library yet"}
              </div>
              <div className="text-sm text-muted-foreground leading-relaxed">
                Paste any LinkedIn post link to bookmark it here.
              </div>
            </div>
            <div className="pt-2">
              <SavePostButton categories={categories} shareId={activeShareId} />
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function BookmarksSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 animate-pulse mt-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
          <div className="px-4 py-2 border-b border-border/60 bg-muted/30 flex items-center justify-between">
            <div className="h-3 w-20 rounded bg-muted/70" />
            <div className="h-3 w-12 rounded bg-muted/70" />
          </div>
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2.5">
              <div className="h-10 w-10 rounded-full bg-muted/70 shrink-0" />
              <div className="space-y-1.5">
                <div className="h-3 w-28 rounded bg-muted/70" />
                <div className="h-2.5 w-20 rounded bg-muted/50" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="h-2.5 w-full rounded bg-muted/50" />
              <div className="h-2.5 w-11/12 rounded bg-muted/50" />
              <div className="h-2.5 w-4/5 rounded bg-muted/50" />
            </div>
            <div className="aspect-[16/10] rounded-lg bg-muted/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

function hrefFor(
  sp: { category?: string; share?: string; sort?: string; type?: string },
  patch: { category?: string; share?: string; sort?: string; type?: string },
): string {
  const params = new URLSearchParams();
  // category
  if ("category" in patch) {
    if (patch.category) params.set("category", patch.category);
  } else if (sp.category) {
    params.set("category", sp.category);
  }
  // share — note: switching tab clears category by design (each library
  // has its own niche set)
  if ("share" in patch) {
    if (patch.share) params.set("share", patch.share);
  } else if (sp.share) {
    params.set("share", sp.share);
  }
  // sort — preserved across category/tab navigation
  if ("sort" in patch) {
    if (patch.sort) params.set("sort", patch.sort);
  } else if (sp.sort) {
    params.set("sort", sp.sort);
  }
  // type (post_type filter) — preserved across category/sort/tab navigation
  if ("type" in patch) {
    if (patch.type) params.set("type", patch.type);
  } else if (sp.type) {
    params.set("type", sp.type);
  }
  const qs = params.toString();
  return qs ? `/dashboard/bookmarks?${qs}` : "/dashboard/bookmarks";
}

function TabLink({
  href,
  active,
  title,
  children,
}: {
  href: string;
  active: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 -mb-px transition-colors whitespace-nowrap",
        active
          ? "border-foreground text-foreground font-medium"
          : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
      )}
    >
      {children}
    </Link>
  );
}

function SortTab({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center text-xs px-3 py-1.5 rounded-md transition-all font-medium whitespace-nowrap",
        active
          ? "bg-foreground text-background shadow-soft"
          : "text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
    >
      {children}
    </Link>
  );
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


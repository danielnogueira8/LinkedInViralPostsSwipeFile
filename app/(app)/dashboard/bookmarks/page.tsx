import { auth, currentUser } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { resolveWorkspaceDisplays, resolveUserNames } from "@/lib/workspace-display";
import { SavedPostCard, type SavedPostRow } from "@/components/saved-post-card";
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
};

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
    const email =
      user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? null;
    if (email) {
      await sb.raw
        .from("shared_bookmarks")
        .update({ recipient_user_id: userId })
        .eq("recipient_email", email.toLowerCase())
        .eq("status", "pending")
        .is("recipient_user_id", null);
    }
  }

  // Accepted shares = the tab list the caller can navigate between.
  const { data: acceptedShares } = userId
    ? await sb.raw
        .from("shared_bookmarks")
        .select("id, owner_workspace_id, status")
        .eq("recipient_user_id", userId)
        .eq("status", "accepted")
    : { data: [] as Share[] };
  const shares = (acceptedShares ?? []) as Share[];

  // Pending invites surface in the share manager modal.
  const { data: pendingShares } = userId
    ? await sb.raw
        .from("shared_bookmarks")
        .select("id, owner_workspace_id, recipient_email, status, created_at")
        .eq("recipient_user_id", userId)
        .eq("status", "pending")
    : { data: [] as Array<{ id: string; owner_workspace_id: string; status: string; created_at: string }> };
  const pending = (pendingShares ?? []) as Array<{
    id: string;
    owner_workspace_id: string;
    recipient_email: string;
    status: string;
    created_at: string;
  }>;

  // Outgoing invites for the manager modal (this workspace's invites).
  const { data: outgoingShares } = await sb.raw
    .from("shared_bookmarks")
    .select("id, recipient_email, recipient_user_id, status, created_at, accepted_at")
    .eq("owner_workspace_id", sb.workspaceId)
    .in("status", ["pending", "accepted"])
    .order("created_at", { ascending: false });

  // Active library: ?share=<id> selects an accepted share. Otherwise
  // we render the caller's own workspace.
  const activeShare = sp.share ? shares.find((s) => s.id === sp.share) : null;
  const activeWorkspaceId = activeShare?.owner_workspace_id ?? sb.workspaceId;
  const isOwnView = !activeShare;

  // Resolve display names for the tab strip + pending list.
  const ownerWsIds = Array.from(
    new Set([
      ...shares.map((s) => s.owner_workspace_id),
      ...pending.map((p) => p.owner_workspace_id),
    ]),
  );
  const displays = await resolveWorkspaceDisplays(ownerWsIds);

  // Categories (curated list + which appear on the active library's saves).
  const [{ data: categoryRows }, { data: savedCategoryRows }] = await Promise.all([
    sb.raw.from("categories").select("id, label, sort_order").order("sort_order"),
    sb.raw
      .from("saved_posts")
      .select("category_id")
      .eq("workspace_id", activeWorkspaceId)
      .not("category_id", "is", null),
  ]);
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

  const filterKey = JSON.stringify({ s: sp.share ?? "", c: sp.category ?? "" });

  return (
    <div className="space-y-6">
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
          </p>
        </div>
        <div className="flex items-center gap-2">
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
        </div>
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

      <Suspense key={filterKey} fallback={<BookmarksSkeleton />}>
        <BookmarksSection
          activeWorkspaceId={activeWorkspaceId}
          activeShareId={activeShare?.id ?? null}
          userId={userId ?? null}
          isOwnView={isOwnView}
          categoryId={sp.category || null}
          categories={allCategories}
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
}: {
  activeWorkspaceId: string;
  activeShareId: string | null;
  userId: string | null;
  isOwnView: boolean;
  categoryId: string | null;
  categories: Array<{ id: string; label: string }>;
}) {
  const sb = await scopedSupabase();
  let query = sb.raw
    .from("saved_posts")
    .select(
      "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, category_id, saved_at, created_by_user_id",
    )
    .eq("workspace_id", activeWorkspaceId);
  if (categoryId) {
    // Known limitation in shared views: this filters on the owner's
    // category, not the recipient's override. A recipient who re-tagged
    // a post may still see the original tag in the filter rail. We can
    // make this exact by moving the filter to JS post-fetch or
    // computing a coalesce in SQL — left for a follow-up since the
    // common case (no override) is unaffected.
    query = query.eq("category_id", categoryId);
  }
  const { data: rows } = await query
    .order("saved_at", { ascending: false })
    .limit(200);
  const saved = (rows ?? []) as Array<SavedPostRow & { created_by_user_id: string | null }>;

  // For shared views: pull this recipient's overrides + Clerk display
  // names for contributors so we can show "Added by <name>" chips on
  // saves the recipient didn't create.
  const overrides = new Map<string, { note: string | null; category_id: string | null }>();
  if (!isOwnView && userId && saved.length > 0) {
    const { data: ovs } = await sb.raw
      .from("saved_post_overrides")
      .select("saved_post_id, note, category_id")
      .eq("recipient_user_id", userId)
      .in(
        "saved_post_id",
        saved.map((s) => s.id),
      );
    for (const o of ovs ?? []) {
      overrides.set(o.saved_post_id as string, {
        note: (o.note as string | null) ?? null,
        category_id: (o.category_id as string | null) ?? null,
      });
    }
  }

  // Collect contributor user_ids for the "Added by …" attribution chip.
  const contributorIds = new Set<string>();
  for (const s of saved) {
    if (s.created_by_user_id && (isOwnView ? s.created_by_user_id !== userId : true)) {
      // Own view: show "Added by X" only for non-self contributions.
      // Shared view: show for everyone except the owner (we can't easily
      // tell who the owner is by user_id alone, but we can hide attribution
      // for the current viewer's contributions).
      if (s.created_by_user_id !== userId) contributorIds.add(s.created_by_user_id);
    }
  }
  // Cached cross-request (see lib/workspace-display.ts) so the same
  // contributors don't re-hit Clerk on every bookmarks render.
  const contributorNames =
    contributorIds.size > 0
      ? await resolveUserNames(Array.from(contributorIds))
      : new Map<string, string>();

  const categoryLabels = new Map(categories.map((c) => [c.id, c.label]));

  return (
    <>
      <div className="hidden lg:block text-xs text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{saved.length}</span> bookmark
        {saved.length === 1 ? "" : "s"}
      </div>

      {saved.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-3">
          {saved.map((row) => {
            const ov = overrides.get(row.id);
            // Override values win for the recipient's view. Owner view
            // ignores overrides entirely.
            const effectiveNote =
              !isOwnView && ov?.note !== undefined ? ov.note ?? row.note : row.note;
            const effectiveCategoryId =
              !isOwnView && ov?.category_id !== undefined
                ? ov.category_id ?? row.category_id
                : row.category_id;
            const contributorName =
              row.created_by_user_id && row.created_by_user_id !== userId
                ? contributorNames.get(row.created_by_user_id) ?? null
                : null;
            return (
              <SavedPostCard
                key={row.id}
                row={{ ...row, note: effectiveNote, category_id: effectiveCategoryId }}
                categoryLabel={
                  effectiveCategoryId
                    ? categoryLabels.get(effectiveCategoryId) ?? null
                    : null
                }
                contributorName={contributorName}
                shareId={activeShareId}
              />
            );
          })}
        </div>
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
          <div className="h-[568px] bg-muted/30" />
        </div>
      ))}
    </div>
  );
}

function hrefFor(
  sp: { category?: string; share?: string },
  patch: { category?: string; share?: string },
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
      prefetch={false}
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


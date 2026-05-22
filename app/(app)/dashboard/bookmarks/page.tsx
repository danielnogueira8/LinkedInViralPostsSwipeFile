import { scopedSupabase } from "@/lib/supabase-scoped";
import { SavedPostCard, type SavedPostRow } from "@/components/saved-post-card";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Bookmark } from "lucide-react";
import { cn } from "@/lib/utils";
import { SavePostButton } from "../swipe/save-post-button";
import { Suspense } from "react";

// Split from /dashboard/swipe (was the ?view=saved tab). Bookmarks is its
// own product surface: user-curated posts, with a niche taxonomy that's
// independent of which accounts the workspace tracks for the scraped feed.
//
// Naturally dynamic via auth() + searchParams — no need for force-dynamic;
// the Router Cache makes nav feel instant on back-nav.

type SP = {
  category?: string;
};

export default async function BookmarksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await scopedSupabase();

  // Pull the full curated category list once (for the SavePostButton modal)
  // and a separate query for which categories already appear on saves in
  // this workspace (for the chip rail).
  const [{ data: categoryRows }, { data: savedCategoryRows }] = await Promise.all([
    sb.raw.from("categories").select("id, label, sort_order").order("sort_order"),
    sb.raw
      .from("saved_posts")
      .select("category_id")
      .eq("workspace_id", sb.workspaceId)
      .not("category_id", "is", null),
  ]);
  const allCategories = (categoryRows ?? []) as Array<{ id: string; label: string }>;
  const savedCategoryIds = new Set(
    ((savedCategoryRows ?? []) as Array<{ category_id: string | null }>)
      .map((r) => r.category_id)
      .filter((id): id is string => !!id),
  );
  let categories = allCategories.filter((c) => savedCategoryIds.has(c.id));
  // If the user filters by a niche that just emptied (deleted last post in
  // it), keep the chip visible so they can click "All" to recover. Without
  // this, the rail silently drops the chip with ?category= still in the URL.
  if (sp.category && !categories.some((c) => c.id === sp.category)) {
    const orphan = allCategories.find((c) => c.id === sp.category);
    if (orphan) categories = [...categories, orphan];
  }
  const activeCategoryLabel =
    allCategories.find((c) => c.id === sp.category)?.label ?? "All bookmarks";

  // Stable Suspense key — flips fallback in instantly on chip toggle.
  const filterKey = JSON.stringify({ c: sp.category ?? "" });

  return (
    <div className="space-y-6">
      {/* Page header — hidden on mobile to give the deck more room */}
      <div className="hidden lg:flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display tracking-tight">Bookmarks</h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            <Bookmark className="inline h-3.5 w-3.5 mr-1 -mt-0.5 fill-current text-primary/80" />
            <span>posts you&rsquo;ve bookmarked from across LinkedIn</span>
            {sp.category && (
              <>
                <span className="mx-1.5 text-border">·</span>
                <span>filtered to <span className="font-medium text-foreground">{activeCategoryLabel}</span></span>
              </>
            )}
          </p>
        </div>
        <SavePostButton categories={allCategories} />
      </div>

      {/* Niche rail — only shows when at least one save has a niche tag. */}
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
        <BookmarksSection categoryId={sp.category || null} categories={allCategories} />
      </Suspense>
    </div>
  );
}

async function BookmarksSection({
  categoryId,
  categories,
}: {
  categoryId: string | null;
  // Pass the FULL curated list (not the rail's narrowed slice) so the
  // SavePostButton modal can offer any niche on a fresh save.
  categories: Array<{ id: string; label: string }>;
}) {
  const sb = await scopedSupabase();
  let query = sb.raw
    .from("saved_posts")
    .select(
      "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, category_id, saved_at",
    )
    .eq("workspace_id", sb.workspaceId);
  if (categoryId) {
    query = query.eq("category_id", categoryId);
  }
  const { data: rows } = await query
    .order("saved_at", { ascending: false })
    .limit(200);
  const saved = (rows ?? []) as SavedPostRow[];
  const categoryLabels = new Map(categories.map((c) => [c.id, c.label]));

  return (
    <>
      <div className="hidden lg:block text-xs text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{saved.length}</span> bookmark
        {saved.length === 1 ? "" : "s"}
      </div>

      {saved.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-3">
          {saved.map((row) => (
            <SavedPostCard
              key={row.id}
              row={row}
              categoryLabel={row.category_id ? categoryLabels.get(row.category_id) ?? null : null}
            />
          ))}
        </div>
      ) : (
        <Card className="border-dashed bg-card/50 mt-3">
          <CardContent className="py-16 px-6 text-center space-y-4 max-w-md mx-auto">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary/15 to-amber-500/10 grid place-items-center mx-auto ring-1 ring-primary/10">
              <Bookmark className="h-6 w-6 text-primary" />
            </div>
            <div className="space-y-1">
              <div className="text-base font-semibold tracking-tight">No bookmarks yet</div>
              <div className="text-sm text-muted-foreground leading-relaxed">
                Paste any LinkedIn post link to bookmark it here.
              </div>
            </div>
            <div className="pt-2">
              <SavePostButton categories={categories} />
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

// Build an href that updates the niche category param while preserving any
// other state. Mirrors swipe/page.tsx's preserveSort but only knows about
// `category` since Bookmarks has no sort/filter params today.
function hrefFor(sp: SP, patch: { category?: string }): string {
  const params = new URLSearchParams();
  if ("category" in patch) {
    if (patch.category) params.set("category", patch.category);
  } else if (sp.category) {
    params.set("category", sp.category);
  }
  const qs = params.toString();
  return qs ? `/dashboard/bookmarks?${qs}` : "/dashboard/bookmarks";
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

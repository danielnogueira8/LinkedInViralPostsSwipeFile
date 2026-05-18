import { supabaseAdmin } from "@/lib/supabase";
import { PostCard } from "@/components/post-card";
import { FeaturedPostCard } from "@/components/featured-post-card";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Flame, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { SwipeFilters } from "./filters";

export const dynamic = "force-dynamic";

type SP = {
  niche?: string;
  sort?: string;
  dir?: string;
  since?: string;
  minR?: string;
  minC?: string;
  type?: string;
};

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
  const sb = supabaseAdmin();

  const sortKey = sp.sort && SORT_COLUMN[sp.sort] ? sp.sort : "viral";
  const sortCol = SORT_COLUMN[sortKey];
  const ascending = sp.dir === "asc";
  const minR = sp.minR ? Math.max(0, parseInt(sp.minR, 10) || 0) : null;
  const minC = sp.minC ? Math.max(0, parseInt(sp.minC, 10) || 0) : null;
  const cutoff = sinceCutoff(sp.since);
  const postType = sp.type && POST_TYPES.has(sp.type) ? sp.type : null;

  const { data: clients } = await sb.from("clients").select("id, name, brand_colors").order("name");

  let q = sb
    .from("posts")
    .select("*, accounts!inner(name, niche, profile_url, linkedin_handle), templates(id, template_text)")
    .eq("is_viral", true)
    .order(sortCol, { ascending, nullsFirst: false })
    .limit(100);
  if (sp.niche) q = q.eq("accounts.niche", sp.niche);
  if (cutoff) q = q.gte("posted_at", cutoff);
  if (minR !== null) q = q.gte("reactions", minR);
  if (minC !== null) q = q.gte("comments", minC);
  if (postType) q = q.eq("post_type", postType);
  const { data: posts } = await q;

  const { data: allAccounts } = await sb.from("accounts").select("niche");
  const niches = Array.from(new Set((allAccounts ?? []).map((a) => a.niche).filter(Boolean))).sort();

  const filtersActive = !!(sp.sort && sp.sort !== "viral") || !!(sp.dir && sp.dir !== "desc") || !!(sp.since && sp.since !== "all") || !!minR || !!minC || !!postType;
  // Featured rail makes sense only when showing "Top engagement", no niche, no filters
  const showFeatured = !sp.niche && !filtersActive && posts && posts.length >= 5;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Swipe File</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {posts?.length ?? 0} viral posts · {labelForSort(sortKey, ascending)}.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterChip href={preserveSort(sp, { niche: undefined })} active={!sp.niche}>All</FilterChip>
        {niches.map((n) => (
          <FilterChip key={n} href={preserveSort(sp, { niche: n! })} active={sp.niche === n}>{n}</FilterChip>
        ))}
      </div>

      <SwipeFilters />

      {showFeatured && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Top this week</h2>
            <span className="text-xs text-muted-foreground">· highest engagement among your tracked accounts</span>
          </div>
          <div className="flex gap-3 overflow-x-auto -mx-8 px-8 pb-2 [scrollbar-width:thin]">
            {posts!.slice(0, 5).map((p, i) => (
              <FeaturedPostCard key={p.id} post={p} rank={i} />
            ))}
          </div>
        </section>
      )}

      {posts && posts.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {posts.map((p) => <PostCard key={p.id} post={p} clients={clients ?? []} />)}
        </div>
      ) : (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <div className="h-10 w-10 rounded-full bg-muted grid place-items-center mx-auto"><Flame className="h-5 w-5 text-muted-foreground" /></div>
            <div className="text-sm font-medium">No posts match these filters</div>
            <div className="text-xs text-muted-foreground">
              {filtersActive
                ? "Try widening the date range or lowering the minimums."
                : <>Run a scrape on the <Link className="underline" href="/accounts">Accounts</Link> page, or lower the thresholds in <Link className="underline" href="/settings">Settings</Link>.</>
              }
            </div>
          </CardContent>
        </Card>
      )}
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

// Build an href that keeps current sort/filter params and updates the niche.
function preserveSort(sp: SP, patch: { niche?: string }): string {
  const params = new URLSearchParams();
  if (sp.sort) params.set("sort", sp.sort);
  if (sp.dir) params.set("dir", sp.dir);
  if (sp.since) params.set("since", sp.since);
  if (sp.minR) params.set("minR", sp.minR);
  if (sp.minC) params.set("minC", sp.minC);
  if (sp.type) params.set("type", sp.type);
  if (patch.niche !== undefined) {
    if (patch.niche) params.set("niche", patch.niche);
    else params.delete("niche");
  } else if (sp.niche) {
    params.set("niche", sp.niche);
  }
  const qs = params.toString();
  return qs ? `/swipe?${qs}` : "/swipe";
}

function FilterChip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center text-xs px-3 py-1.5 rounded-full transition-colors font-medium",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-card border border-border/70 text-muted-foreground hover:text-foreground hover:border-primary/30",
      )}
    >
      {children}
    </Link>
  );
}

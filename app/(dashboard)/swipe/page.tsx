import { supabaseAdmin } from "@/lib/supabase";
import { PostCard } from "@/components/post-card";
import { FeaturedPostCard } from "@/components/featured-post-card";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Flame, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SwipePage({ searchParams }: { searchParams: Promise<{ niche?: string }> }) {
  const sp = await searchParams;
  const sb = supabaseAdmin();
  const { data: clients } = await sb.from("clients").select("id, name, brand_colors").order("name");
  let q = sb
    .from("posts")
    .select("*, accounts!inner(name, niche, profile_url, linkedin_handle), templates(id, template_text)")
    .eq("is_viral", true)
    .order("viral_score", { ascending: false, nullsFirst: false })
    .limit(100);
  if (sp.niche) q = q.eq("accounts.niche", sp.niche);
  const { data: posts } = await q;

  const { data: allAccounts } = await sb.from("accounts").select("niche");
  const niches = Array.from(new Set((allAccounts ?? []).map((a) => a.niche).filter(Boolean))).sort();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Swipe File</h1>
        <p className="text-sm text-muted-foreground mt-1">{posts?.length ?? 0} viral posts · ranked by engagement score.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterChip href="/swipe" active={!sp.niche}>All</FilterChip>
        {niches.map((n) => (
          <FilterChip key={n} href={`/swipe?niche=${encodeURIComponent(n!)}`} active={sp.niche === n}>{n}</FilterChip>
        ))}
      </div>

      {!sp.niche && posts && posts.length >= 5 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Top this week</h2>
            <span className="text-xs text-muted-foreground">· highest engagement among your tracked accounts</span>
          </div>
          <div className="flex gap-3 overflow-x-auto -mx-8 px-8 pb-2 [scrollbar-width:thin]">
            {posts.slice(0, 5).map((p, i) => (
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
            <div className="text-sm font-medium">No viral posts yet</div>
            <div className="text-xs text-muted-foreground">Run a scrape on the <Link className="underline" href="/accounts">Accounts</Link> page, or lower the thresholds in <Link className="underline" href="/settings">Settings</Link>.</div>
          </CardContent>
        </Card>
      )}
    </div>
  );
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

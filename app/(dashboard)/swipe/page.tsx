import { supabaseAdmin } from "@/lib/supabase";
import { PostCard } from "@/components/post-card";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Flame } from "lucide-react";

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
    <Link href={href}>
      <Badge variant={active ? "default" : "outline"} className="cursor-pointer hover:bg-secondary transition-colors text-xs">
        {children}
      </Badge>
    </Link>
  );
}

import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { Flame, ArrowRight, Clock } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isAdmin } from "@/lib/admin";
import { PostCard } from "@/components/post-card";

export const revalidate = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

const POST_COLS =
  "id, text, post_url, posted_at, scraped_at, reactions, comments, reposts, media_type, media_urls, visual_kind, accounts!inner(name, niche, linkedin_handle, profile_pic_url), templates(id, template_text)";

export default async function Dashboard() {
  const sb = await scopedSupabase();
  const admin = await isAdmin();
  const accountIds = await trackedAccountIds(sb.workspaceId);

  const noAccounts = accountIds.length === 0;
  const accountFilter = noAccounts ? ["00000000-0000-0000-0000-000000000000"] : accountIds;

  const [{ data: lastRun }, { data: viralRecent }, { data: clients }] = await Promise.all([
    sb.runsSelect("status, started_at, finished_at, posts_count, viral_count, accounts_count, error")
      .eq("status", "ok")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb.raw
      .from("posts")
      .select(POST_COLS)
      .in("account_id", accountFilter)
      .eq("is_viral", true)
      .order("scraped_at", { ascending: false })
      .limit(30),
    sb.clientsSelect("id, name, brand_colors").order("name"),
  ]);

  const recentPosts = (viralRecent ?? []).map((p) => ({
    ...p,
    accounts: Array.isArray(p.accounts) ? p.accounts[0] ?? null : p.accounts,
    templates: p.templates ?? [],
  }));

  // Bucket by the last pull. If we have a successful run, "today's haul" =
  // posts scraped at-or-after that run. Otherwise fall back to last 24h.
  const cutoffMs = lastRun?.started_at
    ? new Date(lastRun.started_at).getTime()
    : Date.now() - DAY_MS;
  const fresh = recentPosts.filter(
    (p) => p.scraped_at && new Date(p.scraped_at).getTime() >= cutoffMs,
  );
  const showingFallback = fresh.length === 0 && recentPosts.length > 0;
  const feed = fresh.length > 0 ? fresh : recentPosts.slice(0, 12);

  const lastPullLabel = lastRun?.finished_at
    ? formatPull(lastRun.finished_at)
    : null;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-4xl font-display tracking-tight">Today&apos;s haul</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {noAccounts ? (
              <>Add accounts to start tracking viral posts.</>
            ) : lastRun ? (
              <>
                <span className="font-medium text-foreground tabular-nums">{lastRun.viral_count ?? 0}</span> viral
                <span className="mx-1.5 text-border">·</span>
                <span className="font-medium text-foreground tabular-nums">{lastRun.posts_count ?? 0}</span> scraped
                <span className="mx-1.5 text-border">·</span>
                <span className="font-medium text-foreground tabular-nums">{lastRun.accounts_count ?? 0}</span> accounts
              </>
            ) : (
              <>Daily pull is scheduled — first batch lands within 24h.</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastPullLabel && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
              <Clock className="h-3 w-3 shrink-0" />
              Last pull <span className="font-medium text-foreground tabular-nums">{lastPullLabel}</span>
            </span>
          )}
          {admin && (
            <Link href="/dashboard/accounts">
              <Button size="sm" variant="outline">Run scrape <ArrowRight className="h-4 w-4" /></Button>
            </Link>
          )}
        </div>
      </div>

      {noAccounts ? (
        <EmptyCard
          title="No accounts yet"
          body={
            <>Head to <Link className="underline" href="/dashboard/accounts">Accounts</Link> and add the LinkedIn profiles you want to track. The daily job picks them up automatically.</>
          }
        />
      ) : feed.length === 0 ? (
        <EmptyCard
          title="Nothing pulled yet"
          body={<>Posts pull on the daily schedule. Your first batch will appear here within 24h.</>}
        />
      ) : (
        <div className="space-y-4">
          {showingFallback && (
            <div className="inline-flex items-center gap-2 text-xs text-muted-foreground border rounded-full px-3 py-1.5">
              <Flame className="h-3 w-3 text-orange-500" />
              No new viral posts since the last pull — showing your most recent haul.
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {feed.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                clients={clients ?? []}
              />
            ))}
          </div>
          <div className="pt-2">
            <Link
              href="/dashboard/swipe"
              className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              See the full swipe file <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}

      {lastRun?.error && (
        <div className="text-destructive text-xs bg-destructive/10 rounded px-2 py-1.5">
          Last run reported: {lastRun.error}
        </div>
      )}
    </div>
  );
}

function EmptyCard({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <Card className="border-dashed bg-card/50">
      <CardContent className="py-16 px-6 text-center space-y-4 max-w-md mx-auto">
        <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-orange-500/15 to-primary/10 grid place-items-center mx-auto ring-1 ring-orange-500/10">
          <Flame className="h-6 w-6 text-orange-500" />
        </div>
        <div className="space-y-1">
          <div className="text-base font-semibold tracking-tight">{title}</div>
          <div className="text-sm text-muted-foreground leading-relaxed">{body}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function formatPull(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 60 * 60 * 1000) {
    const m = Math.max(1, Math.floor(diffMs / 60_000));
    return `${m}m ago`;
  }
  if (diffMs < DAY_MS) {
    const h = Math.floor(diffMs / (60 * 60 * 1000));
    return `${h}h ago`;
  }
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}

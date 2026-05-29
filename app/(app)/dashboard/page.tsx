import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { Flame, ArrowRight, Clock } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { FeaturedPostCard } from "@/components/featured-post-card";
import { cn } from "@/lib/utils";

export const revalidate = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

// Compact shape FeaturedPostCard renders. Keep the column list tight — the
// dashboard only needs enough to render the top-3 heroes and aggregate.
const HERO_COLS =
  "id, text, post_url, reactions, comments, reposts, media_type, media_urls, viral_score, accounts!inner(name, niche, profile_pic_url)";

// Wider, lighter projection used purely for aggregation (niche/format/creator).
const AGG_COLS =
  "reactions, media_type, post_type, scraped_at, account_id, accounts!inner(name, niche, category_id, profile_pic_url)";

type AggRow = {
  reactions: number | null;
  media_type: string | null;
  post_type: string | null;
  scraped_at: string | null;
  account_id: string;
  accounts:
    | { name: string; niche: string | null; category_id: string | null; profile_pic_url: string | null }
    | { name: string; niche: string | null; category_id: string | null; profile_pic_url: string | null }[]
    | null;
};

const FORMAT_LABELS: Record<string, string> = {
  none: "Text only",
  text: "Text only",
  image: "Image",
  video: "Video",
  document: "Document",
  article: "Article",
};

function formatLabel(mediaType: string | null): string {
  if (!mediaType) return "Text only";
  return FORMAT_LABELS[mediaType] ?? mediaType.charAt(0).toUpperCase() + mediaType.slice(1);
}

const AVATAR_TINTS = [
  "bg-amber-100 text-amber-800",
  "bg-orange-100 text-orange-800",
  "bg-rose-100 text-rose-800",
  "bg-stone-200 text-stone-700",
  "bg-yellow-100 text-yellow-800",
  "bg-red-100 text-red-800",
  "bg-lime-100 text-lime-800",
  "bg-fuchsia-100 text-fuchsia-800",
];
function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(h) % AVATAR_TINTS.length];
}
function initialsFor(name: string): string {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?";
}

function unwrapAccount<T>(a: T | T[] | null): T | null {
  return Array.isArray(a) ? a[0] ?? null : a;
}

export default async function Dashboard() {
  const sb = await scopedSupabase();
  const accountIds = await trackedAccountIds(sb.workspaceId);

  const noAccounts = accountIds.length === 0;
  const accountFilter = noAccounts ? ["00000000-0000-0000-0000-000000000000"] : accountIds;

  const [{ data: lastRun }, { data: heroRows }, { data: catRows }, { data: aggRows }] =
    await Promise.all([
      sb.runsSelect("status, started_at, finished_at, posts_count, viral_count, accounts_count, error")
        .eq("status", "ok")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb.raw
        .from("posts")
        .select(HERO_COLS)
        .in("account_id", accountFilter)
        .eq("is_viral", true)
        .order("viral_score", { ascending: false, nullsFirst: false })
        .limit(3),
      sb.raw.from("categories").select("id, label"),
      // Pull the recent viral corpus once and aggregate in JS. The corpus is
      // small (~hundreds) so a single windowed read is cheaper than 3 round-trips.
      sb.raw
        .from("posts")
        .select(AGG_COLS)
        .in("account_id", accountFilter)
        .eq("is_viral", true)
        .gte("scraped_at", new Date(Date.now() - MONTH_MS).toISOString())
        .order("scraped_at", { ascending: false })
        .limit(1000),
    ]);

  const heroes = (heroRows ?? []).map((p) => ({
    id: p.id as string,
    text: (p.text as string | null) ?? null,
    post_url: (p.post_url as string | null) ?? null,
    reactions: (p.reactions as number | null) ?? 0,
    comments: (p.comments as number | null) ?? 0,
    reposts: (p.reposts as number | null) ?? 0,
    media_type: (p.media_type as string) ?? "none",
    media_urls: (p.media_urls as string[] | null) ?? [],
    accounts: unwrapAccount(p.accounts as never) as
      | { name: string; niche: string | null; profile_pic_url?: string | null }
      | null,
  }));

  const catLabels = new Map<string, string>(
    (catRows ?? []).map((c) => [c.id as string, c.label as string]),
  );

  const rows = (aggRows ?? []) as AggRow[];
  const now = Date.now();

  // 1. Viral by niche — rolling 7d count per category/niche.
  const weekRows = rows.filter((r) => r.scraped_at && new Date(r.scraped_at).getTime() >= now - WEEK_MS);
  const nicheBase = weekRows.length >= 5 ? weekRows : rows;
  const nicheWindowLabel = weekRows.length >= 5 ? "past 7 days" : "all recent";
  const nicheCounts = new Map<string, number>();
  for (const r of nicheBase) {
    const acc = unwrapAccount(r.accounts);
    const key =
      (acc?.category_id ? catLabels.get(acc.category_id) : null) ?? acc?.niche ?? "Uncategorized";
    nicheCounts.set(key, (nicheCounts.get(key) ?? 0) + 1);
  }
  const niches = [...nicheCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  const nicheMax = niches.reduce((m, n) => Math.max(m, n.count), 0);

  // 2. Format performance — rolling 30d avg reactions per media_type.
  const fmtAgg = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const label = formatLabel(r.media_type);
    const cur = fmtAgg.get(label) ?? { sum: 0, n: 0 };
    cur.sum += r.reactions ?? 0;
    cur.n += 1;
    fmtAgg.set(label, cur);
  }
  const formats = [...fmtAgg.entries()]
    .map(([label, { sum, n }]) => ({ label, avg: Math.round(sum / n), n }))
    .filter((f) => f.n > 0)
    .sort((a, b) => b.avg - a.avg);
  const formatMax = formats.reduce((m, f) => Math.max(m, f.avg), 0);
  const leadMagnetCount = rows.filter((r) => r.post_type === "lead_magnet").length;
  const regularCount = rows.length - leadMagnetCount;

  // 3. Top creators — viral count over the rolling 7-day window (matches the
  // "this week's viral posts" subtitle). Previously this counted only since
  // the last cron run (~24h), so every creator showed ~1 viral post even
  // when several of them had multiple viral posts that week — the subtitle
  // promised "week" but the math was "last run." Fixed.
  //
  // Same sparse-fallback pattern as the niche widget below: if the 7-day
  // slice is too thin to be interesting, broaden to the whole 30-day
  // corpus so new workspaces don't see an empty card.
  const creatorBase = weekRows.length >= 5 ? weekRows : rows;
  const creatorAgg = new Map<
    string,
    { name: string; profile_pic_url: string | null; count: number }
  >();
  for (const r of creatorBase) {
    const acc = unwrapAccount(r.accounts);
    if (!acc) continue;
    const cur = creatorAgg.get(r.account_id) ?? {
      name: acc.name,
      profile_pic_url: acc.profile_pic_url ?? null,
      count: 0,
    };
    cur.count += 1;
    creatorAgg.set(r.account_id, cur);
  }
  const topCreators = [...creatorAgg.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  const lastPullLabel = lastRun?.finished_at ? formatPull(lastRun.finished_at) : null;
  const totalViral = lastRun?.viral_count ?? 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-4xl font-display tracking-tight">Insights</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {noAccounts ? (
              <>Add accounts to start tracking viral posts.</>
            ) : lastRun ? (
              <>
                <span className="font-medium text-foreground tabular-nums">{totalViral}</span> viral
                <span className="mx-1.5 text-border">·</span>
                <span className="font-medium text-foreground tabular-nums">
                  {lastRun.accounts_count ?? 0}
                </span>{" "}
                accounts tracked
              </>
            ) : (
              <>Daily pull is scheduled — first batch lands within 24h.</>
            )}
          </p>
        </div>
        {lastPullLabel && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
            <Clock className="h-3 w-3 shrink-0" />
            Last pull{" "}
            <span className="font-medium text-foreground tabular-nums">{lastPullLabel}</span>
          </span>
        )}
      </div>

      {noAccounts ? (
        <EmptyCard
          title="No accounts yet"
          body={
            <>
              Head to{" "}
              <Link className="underline" href="/dashboard/accounts">
                Accounts
              </Link>{" "}
              and add the LinkedIn profiles you want to track. The daily job picks them up
              automatically.
            </>
          }
        />
      ) : rows.length === 0 && heroes.length === 0 ? (
        <EmptyCard
          title="Nothing pulled yet"
          body={<>Posts pull on the daily schedule. Your first batch will appear here within 24h.</>}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <InsightCard title="Viral by niche" subtitle={nicheWindowLabel}>
              {niches.length === 0 ? (
                <EmptyHint>No viral posts in this window yet.</EmptyHint>
              ) : (
                <ul className="space-y-2.5">
                  {niches.map((n) => (
                    <li key={n.label} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate font-medium">{n.label}</span>
                        <span className="tabular-nums text-muted-foreground">{n.count}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${nicheMax ? (n.count / nicheMax) * 100 : 0}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </InsightCard>

            <InsightCard title="Format performance" subtitle="avg reactions · past 30 days">
              {formats.length === 0 ? (
                <EmptyHint>No data in this window yet.</EmptyHint>
              ) : (
                <>
                  <ul className="space-y-2.5">
                    {formats.map((f) => (
                      <li key={f.label} className="space-y-1">
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="truncate font-medium">{f.label}</span>
                          <span className="tabular-nums text-muted-foreground">
                            {f.avg.toLocaleString()}
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-orange-500"
                            style={{ width: `${formatMax ? (f.avg / formatMax) * 100 : 0}%` }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 pt-3 border-t border-border/60 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                      <span className="font-medium text-foreground tabular-nums">{regularCount}</span>{" "}
                      regular
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                      <span className="font-medium text-foreground tabular-nums">
                        {leadMagnetCount}
                      </span>{" "}
                      lead magnet
                    </span>
                  </div>
                </>
              )}
            </InsightCard>

            <InsightCard title="Top creators" subtitle="this week's viral posts">
              {topCreators.length === 0 ? (
                <EmptyHint>No viral posts since the last pull.</EmptyHint>
              ) : (
                <ul className="space-y-2.5">
                  {topCreators.map((c, i) => (
                    <li key={c.name + i} className="flex items-center gap-2.5">
                      {c.profile_pic_url ? (
                        <Image
                          src={c.profile_pic_url}
                          alt={c.name}
                          width={28}
                          height={28}
                          sizes="28px"
                          className="h-7 w-7 rounded-full object-cover shrink-0 bg-muted"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div
                          className={cn(
                            "h-7 w-7 rounded-full grid place-items-center text-[10px] font-semibold shrink-0",
                            tintFor(c.name),
                          )}
                        >
                          {initialsFor(c.name)}
                        </div>
                      )}
                      <span className="text-xs font-medium truncate flex-1 min-w-0">{c.name}</span>
                      <span className="inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground shrink-0">
                        <Flame className="h-3 w-3 text-orange-500" />
                        {c.count}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </InsightCard>
          </div>

          {heroes.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold tracking-tight">Top viral posts</h2>
                <Link
                  href="/dashboard/swipe"
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  See all in swipe file <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1">
                {heroes.map((post, i) => (
                  <FeaturedPostCard key={post.id} post={post} rank={i} priority={i === 0} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {lastRun?.error && (
        <div className="text-destructive text-xs bg-destructive/10 rounded px-2 py-1.5">
          Last run reported: {lastRun.error}
        </div>
      )}
    </div>
  );
}

function InsightCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="shadow-soft">
      <CardContent className="p-4 space-y-3">
        <div className="space-y-0.5">
          <div className="text-sm font-semibold tracking-tight">{title}</div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {subtitle}
          </div>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-muted-foreground py-4 text-center">{children}</div>;
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

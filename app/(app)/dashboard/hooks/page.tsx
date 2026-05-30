import Link from "next/link";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { assertNoQueryError } from "@/lib/query-error";
import { Card, CardContent } from "@/components/ui/card";
import { Quote } from "lucide-react";
import { cn } from "@/lib/utils";
import { HookCard } from "./hook-card";

type SP = {
  type?: string;
  sort?: string;
};

// Post-type slices. Mirrors posts.post_type, denormalized onto hooks.post_type
// (migration 030). A lead-magnet opener plays by different rules than an
// editorial hook, so the library lets you study each in isolation.
const POST_TYPES: { key: string; label: string }[] = [
  { key: "regular", label: "Regular" },
  { key: "lead_magnet", label: "Lead magnets" },
];
const POST_TYPE_KEYS = new Set(POST_TYPES.map((t) => t.key));

// Sort options operate on the joined post's metrics. PostgREST can't order
// top-level rows by an embedded resource's column, so we fetch and sort in
// JS (the library is capped at 200 rows — trivial to sort in memory).
const SORTS: { key: string; label: string; col: "reactions" | "comments" | "posted_at" }[] = [
  { key: "reactions", label: "Reactions", col: "reactions" },
  { key: "comments", label: "Comments", col: "comments" },
  { key: "posted", label: "Most recent", col: "posted_at" },
];
const SORT_MAP = new Map(SORTS.map((s) => [s.key, s]));
const DEFAULT_SORT = "reactions";

export default async function HooksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await scopedSupabase();
  const accountIds = await trackedAccountIds(sb.workspaceId);
  const idFilter = accountIds.length ? accountIds : ["00000000-0000-0000-0000-000000000000"];

  const postType = sp.type && POST_TYPE_KEYS.has(sp.type) ? sp.type : null;
  const sortKey = sp.sort && SORT_MAP.has(sp.sort) ? sp.sort : DEFAULT_SORT;
  const sort = SORT_MAP.get(sortKey)!;

  // Hooks are global, but we filter by workspace tracked accounts via the
  // posts join. Use !inner so PostgREST applies the account filter as a
  // join restriction rather than a post-filter. post_type is denormalized
  // onto hooks (migration 030) so the type filter needs no extra join.
  // We fetch up to 200 and sort in JS — see SORTS comment above.
  let q = sb.raw
    .from("hooks")
    .select(
      "id, hook_text, post_type, posts!inner(id, post_url, text, media_type, media_urls, reactions, comments, posted_at, account_id, accounts(name, niche))",
    )
    .in("posts.account_id", idFilter)
    .limit(200);
  if (postType) q = q.eq("post_type", postType);

  const [hooksRes, typeCountRes] = await Promise.all([
    q,
    sb.raw
      .from("hooks")
      .select("post_type, posts!inner(account_id)")
      .in("posts.account_id", idFilter)
      .limit(10000),
  ]);
  // Surface a transient read failure rather than rendering the library as
  // "No hooks yet" (with misleading "run a scrape" copy) or zeroing the
  // chip counts.
  assertNoQueryError("hook library", hooksRes, typeCountRes);
  const { data: rawHooks } = hooksRes;
  const { data: typeCountRows } = typeCountRes;

  const hooks = (rawHooks ?? []).map((h) => {
    const firstPost = Array.isArray(h.posts) ? h.posts[0] ?? null : h.posts;
    const normalizedPost = firstPost
      ? {
          ...firstPost,
          accounts: Array.isArray(firstPost.accounts) ? firstPost.accounts[0] ?? null : firstPost.accounts,
        }
      : null;
    return { ...h, posts: normalizedPost };
  });

  // Sort in JS by the selected post metric, descending. Nulls (legacy rows
  // without posted_at) sort last.
  hooks.sort((a, b) => {
    const av = a.posts?.[sort.col] ?? null;
    const bv = b.posts?.[sort.col] ?? null;
    if (sort.col === "posted_at") {
      const at = av ? new Date(av as string).getTime() : -Infinity;
      const bt = bv ? new Date(bv as string).getTime() : -Infinity;
      return bt - at;
    }
    return ((bv as number) ?? -Infinity) - ((av as number) ?? -Infinity);
  });

  const typeCounts = new Map<string, number>();
  for (const r of typeCountRows ?? []) {
    const t = (r.post_type as string | null) ?? "regular";
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }
  const totalCount = (typeCountRows ?? []).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-display tracking-tight">Hook Library</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          The openers from your strongest posts — high-engagement regular posts
          that beat the creator&rsquo;s norm, and lead magnets that drove real
          comment volume.
        </p>
      </div>

      {/* Controls: post-type segmented control + sort, on one tidy row */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <Segmented>
          <SegmentTab href={hrefFor(sp, { type: undefined })} active={!postType}>
            All
            <Count n={totalCount} />
          </SegmentTab>
          {POST_TYPES.map((t) => (
            <SegmentTab key={t.key} href={hrefFor(sp, { type: t.key })} active={postType === t.key}>
              {t.label}
              <Count n={typeCounts.get(t.key) ?? 0} />
            </SegmentTab>
          ))}
        </Segmented>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Sort</span>
          <Segmented>
            {SORTS.map((s) => (
              <SegmentTab key={s.key} href={hrefFor(sp, { sort: s.key })} active={sortKey === s.key}>
                {s.label}
              </SegmentTab>
            ))}
          </Segmented>
        </div>
      </div>

      {hooks.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {hooks.map((h) => (
            <HookCard key={h.id} row={h} />
          ))}
        </div>
      ) : (
        <Card className="border-dashed bg-card/50">
          <CardContent className="py-16 px-6 text-center space-y-4 max-w-md mx-auto">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-orange-500/15 to-primary/10 grid place-items-center mx-auto ring-1 ring-orange-500/10">
              <Quote className="h-6 w-6 text-orange-500" />
            </div>
            <div className="space-y-1">
              <div className="text-base font-semibold tracking-tight">No hooks yet</div>
              <div className="text-sm text-muted-foreground leading-relaxed">
                Hooks are extracted automatically from each daily scrape. Run a scrape on the <Link href="/dashboard/accounts" className="underline">Accounts</Link> page or wait for the next pull.
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function hrefFor(sp: SP, patch: { type?: string; sort?: string }): string {
  const params = new URLSearchParams();
  const nextType = "type" in patch ? patch.type : sp.type;
  const nextSort = "sort" in patch ? patch.sort : sp.sort;
  if (nextType) params.set("type", nextType);
  if (nextSort) params.set("sort", nextSort);
  const qs = params.toString();
  return qs ? `/dashboard/hooks?${qs}` : "/dashboard/hooks";
}

function Segmented({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-card p-0.5 shadow-soft">
      {children}
    </div>
  );
}

function SegmentTab({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-all font-medium whitespace-nowrap",
        active
          ? "bg-foreground text-background shadow-soft"
          : "text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
    >
      {children}
    </Link>
  );
}

function Count({ n }: { n: number }) {
  if (!n) return null;
  return <span className="text-[10px] opacity-60 tabular-nums">{n}</span>;
}

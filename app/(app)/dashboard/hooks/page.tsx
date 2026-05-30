import Link from "next/link";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { assertNoQueryError } from "@/lib/query-error";
import { Card, CardContent } from "@/components/ui/card";
import { Quote } from "lucide-react";
import { cn } from "@/lib/utils";
import { HookCard } from "./hook-card";

type SP = {
  pattern?: string;
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

const PATTERNS: { key: string; label: string }[] = [
  { key: "contrarian", label: "Contrarian" },
  { key: "personal_failure", label: "Personal failure" },
  { key: "numbered_promise", label: "Numbered promise" },
  { key: "curiosity_gap", label: "Curiosity gap" },
  { key: "authority_drop", label: "Authority drop" },
  { key: "stat_shock", label: "Stat shock" },
  { key: "question", label: "Question" },
  { key: "confession", label: "Confession" },
  { key: "story_setup", label: "Story setup" },
  { key: "direct_callout", label: "Direct callout" },
];

const PATTERN_KEYS = new Set(PATTERNS.map((p) => p.key));

const SORT_COLUMN: Record<string, string> = {
  reactions: "reactions",
  comments: "comments",
  posted: "posted_at",
};
const DEFAULT_SORT = "reactions";

export default async function HooksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await scopedSupabase();
  const accountIds = await trackedAccountIds(sb.workspaceId);
  const idFilter = accountIds.length ? accountIds : ["00000000-0000-0000-0000-000000000000"];

  const pattern = sp.pattern && PATTERN_KEYS.has(sp.pattern) ? sp.pattern : null;
  const postType = sp.type && POST_TYPE_KEYS.has(sp.type) ? sp.type : null;
  const sortKey = sp.sort && SORT_COLUMN[sp.sort] ? sp.sort : DEFAULT_SORT;
  const sortCol = SORT_COLUMN[sortKey];

  // Hooks are global, but we filter by workspace tracked accounts via the
  // posts join. Use !inner so PostgREST applies the account filter as a
  // join restriction rather than a post-filter. post_type is denormalized
  // onto hooks (migration 030) so the type filter needs no extra join.
  let q = sb.raw
    .from("hooks")
    .select(
      "id, hook_text, pattern_tag, post_type, posts!inner(id, post_url, reactions, comments, posted_at, account_id, accounts(name, niche))",
    )
    .in("posts.account_id", idFilter)
    .order(sortCol, { foreignTable: "posts", ascending: false, nullsFirst: false })
    .limit(200);
  if (pattern) q = q.eq("pattern_tag", pattern);
  if (postType) q = q.eq("post_type", postType);

  // Pattern counts shown on the chips need to be independent of the active
  // pattern filter — otherwise selecting a chip zeros out every other count
  // and the user can't tell what's available. This second query mirrors the
  // tracked-accounts constraint but skips the pattern_tag filter and
  // ordering, returning just the data we aggregate into Maps. It DOES respect
  // the active post-type filter, so pattern counts reflect the current type
  // slice; the post-type counts themselves are computed independent of the
  // type filter (so switching type doesn't zero the other type's count).
  let patternCountQ = sb.raw
    .from("hooks")
    .select("pattern_tag, posts!inner(account_id)")
    .in("posts.account_id", idFilter)
    .not("pattern_tag", "is", null)
    .limit(10000);
  if (postType) patternCountQ = patternCountQ.eq("post_type", postType);

  const [hooksRes, countRes, typeCountRes] = await Promise.all([
    q,
    patternCountQ,
    sb.raw
      .from("hooks")
      .select("post_type, posts!inner(account_id)")
      .in("posts.account_id", idFilter)
      .limit(10000),
  ]);
  // Surface a transient read failure rather than rendering the library as
  // "No hooks yet" (with misleading "run a scrape" copy) or zeroing the
  // chip counts.
  assertNoQueryError("hook library", hooksRes, countRes, typeCountRes);
  const { data: rawHooks } = hooksRes;
  const { data: countRows } = countRes;
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

  const patternCounts = new Map<string, number>();
  for (const r of countRows ?? []) {
    if (!r.pattern_tag) continue;
    patternCounts.set(r.pattern_tag, (patternCounts.get(r.pattern_tag) ?? 0) + 1);
  }

  const typeCounts = new Map<string, number>();
  for (const r of typeCountRows ?? []) {
    const t = (r.post_type as string | null) ?? "regular";
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-display tracking-tight">Hook Library</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {hooks.length} hooks · the openers from your strongest posts —
            high-engagement regular posts that beat the creator&rsquo;s norm,
            and lead magnets that drove real comment volume.
          </p>
        </div>
      </div>

      {/* Post-type + pattern chips */}
      <div className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
        {/* Post type — Regular vs Lead magnets. */}
        <div className="px-4 sm:px-5 py-3 border-b border-border/60 bg-background/40">
          <div className="flex items-center gap-3">
            <div className="text-xs font-medium text-muted-foreground shrink-0 hidden sm:block">Post type</div>
            <div className="flex-1 min-w-0">
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar py-0.5">
                <FilterChip href={hrefFor(sp, { type: undefined })} active={!postType}>
                  All
                </FilterChip>
                {POST_TYPES.map((t) => (
                  <FilterChip key={t.key} href={hrefFor(sp, { type: t.key })} active={postType === t.key}>
                    {t.label}
                    {typeCounts.get(t.key) ? (
                      <span className="ml-1 text-[10px] opacity-60">{typeCounts.get(t.key)}</span>
                    ) : null}
                  </FilterChip>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 sm:px-5 py-3 border-b border-border/60 bg-background/40">
          <div className="flex items-center gap-3">
            <div className="text-xs font-medium text-muted-foreground shrink-0 hidden sm:block">Pattern</div>
            <div className="flex-1 min-w-0">
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar py-0.5">
                <FilterChip href={hrefFor(sp, { pattern: undefined })} active={!pattern}>
                  All
                </FilterChip>
                {PATTERNS.map((p) => (
                  <FilterChip key={p.key} href={hrefFor(sp, { pattern: p.key })} active={pattern === p.key}>
                    {p.label}
                    {patternCounts.get(p.key) ? (
                      <span className="ml-1 text-[10px] opacity-60">{patternCounts.get(p.key)}</span>
                    ) : null}
                  </FilterChip>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Sort row */}
        <div className="px-4 sm:px-5 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs font-medium text-muted-foreground">Sort by</span>
          <SortPill href={hrefFor(sp, { sort: undefined })} active={sortKey === DEFAULT_SORT}>
            Reactions
          </SortPill>
          <SortPill href={hrefFor(sp, { sort: "comments" })} active={sortKey === "comments"}>
            Comments
          </SortPill>
          <SortPill href={hrefFor(sp, { sort: "posted" })} active={sortKey === "posted"}>
            Most recent
          </SortPill>
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

function hrefFor(
  sp: SP,
  patch: { pattern?: string; type?: string; sort?: string },
): string {
  const params = new URLSearchParams();
  const nextPattern = "pattern" in patch ? patch.pattern : sp.pattern;
  const nextType = "type" in patch ? patch.type : sp.type;
  const nextSort = "sort" in patch ? patch.sort : sp.sort;
  if (nextPattern) params.set("pattern", nextPattern);
  if (nextType) params.set("type", nextType);
  if (nextSort) params.set("sort", nextSort);
  const qs = params.toString();
  return qs ? `/dashboard/hooks?${qs}` : "/dashboard/hooks";
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

function SortPill({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center text-xs px-2.5 py-1 rounded-md transition-all font-medium",
        active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
    >
      {children}
    </Link>
  );
}

import Link from "next/link";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { PageHeader, PageShell } from "@/components/app-surface";
import { DigestView, type DigestRow } from "./view";

export const dynamic = "force-dynamic";

// Daily Brief — the read side of the daily-digest cron.
//
// One stored brief per day: what the day's tracked posts were about, the
// strongest hook, the format that over-performed, and what to write next.
// Written by /api/cron/daily-digest at 02:00 UTC; nothing is generated at
// page-view time, so this page is a pure read and costs nothing to open.

/** How much history to offer. A fortnight is enough to see a trend without
 *  turning the rail into an archive nobody scrolls. */
const HISTORY_DAYS = 14;

export default async function DigestPage() {
  const sb = await scopedSupabase();
  // `new Date()` rather than `Date.now()`: the purity lint flags the latter as
  // an impure call inside a component body, and this is a render-time read.
  const now = new Date();
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const { data } = await sb.raw
    .from("daily_digests")
    .select("digest_date, content, post_count")
    .eq("workspace_id", sb.workspaceId)
    .gte("digest_date", since)
    .order("digest_date", { ascending: false });

  const digests: DigestRow[] = (data ?? [])
    .filter((row) => typeof row.content === "string" && row.content.trim())
    .map((row) => ({
      digestDate: String(row.digest_date),
      content: String(row.content),
      postCount: Number(row.post_count ?? 0),
    }));

  return (
    <PageShell>
      <PageHeader
        title="Daily Brief"
        description="What the creators you track posted about today — the theme, the strongest hook, the format that worked, and what to write next."
      />
      {digests.length === 0 ? (
        <EmptyState />
      ) : (
        <DigestView
          digests={digests}
          todayIso={now.toISOString().slice(0, 10)}
        />
      )}
    </PageShell>
  );
}

/**
 * Empty state.
 *
 * Deliberately explains WHY there is nothing rather than just saying there is
 * nothing: a brief needs a day's worth of posts to describe, so a new workspace
 * or a thin roster is the usual cause, and adding creators is the fix.
 */
function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
      <h2 className="text-sm font-semibold">No brief yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        A brief is written each morning once the creators you track have posted
        enough that day to show a real pattern. Track a few more creators and
        the first one will arrive tomorrow.
      </p>
      <Link
        href="/dashboard/accounts"
        className="mt-4 inline-flex h-9 items-center rounded-lg border border-border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        Manage creators
      </Link>
    </div>
  );
}

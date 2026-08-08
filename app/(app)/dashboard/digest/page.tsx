import Link from "next/link";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { PageHeader, PageShell } from "@/components/app-surface";
import { selectInChunks } from "@/lib/db-paginate";
import { trackedAccountIds } from "@/lib/supabase-scoped";
import { SWIPE_POST_COLS } from "@/lib/swipe-query";
import { referencedPostIds } from "@/lib/digest-view-model";
import type { PostCardRow } from "@/lib/post-card-row";
import { DigestView, type DigestRow } from "./view";
import { AGENT_SUGGESTED_BY } from "@/lib/agent-loop/constants";
import { TodaysAgentDraft, type TodaysAgentDraft as TodaysAgentDraftRow } from "./todays-draft";

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

  // The posts the brief cites, so the reader can see the evidence rather than
  // taking the model's word for it. The ids are ALREADY in the stored content
  // (the prompt asks for them) — nothing about the cron changes to support
  // this. Scoped by tracked account, the same predicate every other posts read
  // uses, so a stale id from another workspace resolves to nothing.
  const citedIds = referencedPostIds(
    digests.map((digest) => digest.content).join("\n"),
  );
  let referencedPosts: PostCardRow[] = [];
  if (citedIds.length > 0) {
    const accountIds = await trackedAccountIds(sb.workspaceId);
    if (accountIds.length > 0) {
      referencedPosts = (await selectInChunks<PostCardRow>(citedIds, (ids) =>
        sb.raw
          .from("posts")
          .select(SWIPE_POST_COLS)
          .in("id", ids)
          .in("account_id", accountIds) as never,
      ).catch(() => [])) as PostCardRow[];
    }
  }

  // The post the agent wrote today, if it wrote one. Unscheduled only: once a
  // draft is queued it belongs to the posting queue, not to today's decision.
  // A pure read like the rest of this page — pre-drafting happens on its own
  // cron, so opening the Brief never generates anything.
  const { data: agentDraftRows } = await sb.raw
    .from("chat_artifacts")
    .select("id, title, body")
    .eq("workspace_id", sb.workspaceId)
    .eq("meta->>suggested_by", AGENT_SUGGESTED_BY)
    .is("schedule_status", null)
    .gte("created_at", `${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
    .order("created_at", { ascending: false })
    .limit(3);

  const todaysDrafts: TodaysAgentDraftRow[] = (agentDraftRows ?? [])
    .filter((row) => typeof row.body === "string" && row.body.trim())
    .map((row) => ({
      id: String(row.id),
      title: typeof row.title === "string" ? row.title : null,
      body: String(row.body),
    }));

  return (
    <PageShell>
      <PageHeader
        title="Daily Brief"
        description="What the creators you track posted about today — the theme, the strongest hook, and the format that worked."
      />
      <TodaysAgentDraft drafts={todaysDrafts} />
      {digests.length === 0 && todaysDrafts.length === 0 ? (
        <EmptyState />
      ) : digests.length === 0 ? null : (
        <DigestView
          digests={digests}
          todayIso={now.toISOString().slice(0, 10)}
          referencedPosts={referencedPosts}
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

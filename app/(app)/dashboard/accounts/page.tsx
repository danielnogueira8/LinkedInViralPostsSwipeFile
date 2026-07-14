import { scopedSupabase } from "@/lib/supabase-scoped";
import { TrackedCreators } from "@/lib/tracked-creators";
import { createSupabaseTrackedCreatorsRepository } from "@/lib/tracked-creators-supabase";
import { AddAccountButton } from "./account-actions";
import {
  CreatorPicker,
  type PickerCategory,
  type PickerCreator,
} from "./creator-picker";
import {
  PageHeader,
  PageShell,
  StatusPill,
  Surface,
} from "@/components/app-surface";
import {
  deriveSourceStatus,
  indexRunProgressByHandle,
  type RunProgressEntry,
} from "@/lib/source-status";
import {
  maxReactionsByAccount,
  SOURCE_POSTS_FETCH_CAP,
  type PostReactionRow,
} from "@/lib/source-output";

// Dropped `force-dynamic` — auth() already makes this dynamic, and removing
// it lets the client-side Router Cache snapshot the page so sidebar back-nav
// feels instant.

type CategoryRow = {
  id: string;
  label: string;
  sort_order: number;
  workspace_id: string | null;
};

// Compact "what happens next" primer — shown only between the first source add
// and the first scraped post. Three steps, one line each. Deliberately NOT a
// wizard or a large onboarding panel; it disappears on its own once posts land.
const NEXT_STEPS = [
  "We check their recent posts",
  "Top posts go to Swipe File",
  "You bookmark or model the best ones in Cowork",
];

function WhatHappensNext() {
  return (
    <Surface tone="muted" padding="sm" className="border-dashed">
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          What happens next?
        </div>
        <ol className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
          {NEXT_STEPS.map((step, i) => (
            <li
              key={i}
              className="flex items-center gap-2 text-sm text-foreground"
            >
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/[0.08] text-[11px] font-semibold text-primary tabular-nums">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </Surface>
  );
}

// The category list backs the left rail: the curated/global buckets
// (workspace_id IS NULL) plus this workspace's own custom categories. It's tiny
// and service-role read — yet the rail intermittently rendered empty on refresh
// because a transient Supabase/network blip returned { data: null } and the
// page silently treated that as "zero categories" (`?? []`). A single retry
// papers over the blip; if it STILL fails we throw rather than render a
// misleadingly empty rail, so the error boundary shows a real "try again"
// instead of a page that looks fine but lost its categories.
async function loadCategories(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
): Promise<CategoryRow[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await sb.raw
      .from("categories")
      .select("id, label, sort_order, workspace_id")
      // Curated rows (workspace_id null) OR this workspace's custom rows. The
      // service-role key bypasses RLS, so we filter explicitly here — same
      // belt-and-suspenders pattern as the rest of scopedSupabase.
      .or(`workspace_id.is.null,workspace_id.eq.${sb.workspaceId}`)
      // Tiebreak by label so two custom categories (both sort_order 1000) keep
      // a stable, alphabetical order in the rail.
      .order("sort_order")
      .order("label");
    if (!error && data) return data as CategoryRow[];
    // Tiny backoff before the one retry; covers a momentary connection reset
    // without adding meaningful latency to the happy path.
    if (attempt === 0) await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Failed to load creator categories");
}

async function loadAccounts(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
) {
  const visibility = `source.neq.manual,manual_owner_workspace_id.eq.${sb.workspaceId}`;
  const full = await sb.raw
    .from("accounts")
    .select(
      "id, name, linkedin_handle, profile_url, profile_pic_url, headline, recommendation_reason, discovery_tags, is_featured, manual_owner_workspace_id, synced_at, category_id, source, total_post_count, viral_post_count",
    )
    .is("archived_at", null)
    .or(visibility)
    .order("name");
  if (!full.error) return full;

  // Allows the new UI to deploy immediately before migration 089 reaches the
  // database. PostgREST query builders are single-use, so this is a fresh read.
  // Supabase installations can report a missing cached column with different
  // PostgREST codes. The fallback is narrower and read-only, so it is safe to
  // try for any failed discovery read; its own error is still surfaced below.
  return sb.raw
    .from("accounts")
    .select(
      "id, name, linkedin_handle, profile_url, profile_pic_url, headline, synced_at, category_id, source, total_post_count, viral_post_count",
    )
    .is("archived_at", null)
    .order("name");
}

export default async function AccountsPage() {
  const sb = await scopedSupabase();
  const trackedCreators = new TrackedCreators(
    createSupabaseTrackedCreatorsRepository(sb.raw, sb.workspaceId),
  );
  // Five reads, in parallel:
  //   1. Tracked account IDs for the current workspace.
  //   2. The full canonical category list (for the left rail) — retried, see above.
  //   3. Every account in the global catalog (so the user can browse + track).
  //   4. The single most-recent scrape run (workspace-scoped or the global cron),
  //      whose per-handle `progress` drives the "fetching / needs attention"
  //      source-health states. One scoped read — not per-creator.
  //   5. Narrow (account_id, reactions) for every post, capped — reduced in JS
  //      to each source's best-post reaction count (PostgREST has no per-group
  //      MAX; same idiom as lib/insights-query). One scoped read, not per-card.
  const [
    trackedRows,
    catRows,
    { data: accountRows, error: accountsError },
    { data: latestRun },
    { data: postRows },
  ] = await Promise.all([
    trackedCreators.trackedAccountIds(),
    loadCategories(sb),
    // The service role bypasses RLS. Show the shared app catalog plus only
    // manual rows owned by this workspace; never leak another workspace's
    // private creator into discovery.
    loadAccounts(sb),
    sb.raw
      .from("runs")
      .select("progress")
      .or(`workspace_id.is.null,workspace_id.eq.${sb.workspaceId}`)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb.raw
      .from("posts")
      .select("account_id, reactions")
      .order("reactions", { ascending: false })
      .limit(SOURCE_POSTS_FETCH_CAP),
  ]);

  if (accountsError) throw new Error("Failed to load the creator catalog");

  // Best-post reactions per account, reduced from the narrow rows above.
  const topReactionsByAccount = maxReactionsByAccount(
    (postRows as PostReactionRow[] | null) ?? null,
  );

  const trackedAccountIds = trackedRows;
  const trackedSet = new Set(trackedAccountIds);

  // Index the latest run's progress by handle once, so status derivation is a
  // Map lookup per creator instead of a scan.
  const runByHandle = indexRunProgressByHandle(
    (latestRun?.progress as RunProgressEntry[] | null) ?? null,
  );

  const categories: PickerCategory[] = catRows.map((c) => ({
    id: c.id,
    label: c.label,
    workspace_id: c.workspace_id,
  }));

  const visibleAccountRows = (accountRows ?? []).filter(
    (account) =>
      account.source !== "manual" || trackedSet.has(account.id as string),
  );
  const creators: PickerCreator[] = visibleAccountRows.map((a) => {
    const handle = a.linkedin_handle as string;
    const totalPostCount = (a.total_post_count as number | null) ?? 0;
    const tracked = trackedSet.has(a.id as string);
    const syncedAt = (a.synced_at as string | null) ?? null;
    return {
      id: a.id as string,
      name: a.name as string,
      linkedin_handle: handle,
      profile_url: a.profile_url as string,
      profile_pic_url: (a.profile_pic_url as string | null) ?? null,
      headline: (a.headline as string | null) ?? null,
      recommendation_reason:
        ((a as typeof a & { recommendation_reason?: string | null })
          .recommendation_reason as string | null | undefined) ?? null,
      discovery_tags:
        ((a as typeof a & { discovery_tags?: string[] | null })
          .discovery_tags as string[] | null | undefined) ?? [],
      is_featured: Boolean(
        (a as typeof a & { is_featured?: boolean }).is_featured,
      ),
      source: a.source as string,
      manual_owner_workspace_id:
        ((a as typeof a & { manual_owner_workspace_id?: string | null })
          .manual_owner_workspace_id as string | null | undefined) ??
        (a.source === "manual" ? sb.workspaceId : null),
      synced_at: syncedAt,
      category_id: (a.category_id as string | null) ?? null,
      is_manual: a.source === "manual",
      total_post_count: totalPostCount,
      viral_post_count: (a.viral_post_count as number | null) ?? 0,
      top_reactions: topReactionsByAccount.get(a.id as string) ?? null,
      source_status: deriveSourceStatus({
        tracked,
        totalPostCount,
        runEntry: runByHandle.get(handle.toLowerCase()) ?? null,
      }),
    };
  });

  const categoryOptions = categories.map((c) => ({ id: c.id, label: c.label }));
  const trackedCount = trackedAccountIds.length;
  const manualTrackedCount = creators.filter(
    (c) => c.is_manual && trackedSet.has(c.id),
  ).length;

  // "What happens next?" onboarding: shown only in the gap between adding the
  // first source and the first scraped post landing. Once ANY tracked source
  // has a saved post, the primer is done — so we gate on a cheap head-count of
  // posts from tracked accounts (limit 1, no rows fetched). Skip the query
  // entirely when nothing is tracked yet (the primer wouldn't show anyway).
  let hasTrackedPosts = false;
  if (trackedCount > 0) {
    const { count } = await sb.raw
      .from("posts")
      .select("id", { count: "exact", head: true })
      .in("account_id", trackedAccountIds);
    hasTrackedPosts = (count ?? 0) > 0;
  }
  const showWhatHappensNext = trackedCount > 0 && !hasTrackedPosts;

  return (
    <PageShell width="wide">
      <PageHeader
        title="Creators"
        description="SwipeIn watches these creators and saves their top posts into your Swipe File."
        meta={
          <>
            <StatusPill tone="success">
              {trackedCount} tracked creators
            </StatusPill>
            <StatusPill tone="neutral">
              {manualTrackedCount}/50 custom creators
            </StatusPill>
          </>
        }
        actions={
          <AddAccountButton
            categories={categoryOptions}
            manualCount={manualTrackedCount}
            manualLimit={50}
          />
        }
      />

      {showWhatHappensNext && <WhatHappensNext />}

      <CreatorPicker
        categories={categories}
        creators={creators}
        trackedAccountIds={trackedAccountIds}
      />
    </PageShell>
  );
}

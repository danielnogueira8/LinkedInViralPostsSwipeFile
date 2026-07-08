import { scopedSupabase } from "@/lib/supabase-scoped";
import { AddAccountButton } from "./account-actions";
import { CreatorPicker, type PickerCategory, type PickerCreator } from "./creator-picker";
import { PageHeader, PageShell, StatusPill } from "@/components/app-surface";
import {
  deriveSourceStatus,
  indexRunProgressByHandle,
  type RunProgressEntry,
} from "@/lib/source-status";

// Dropped `force-dynamic` — auth() already makes this dynamic, and removing
// it lets the client-side Router Cache snapshot the page so sidebar back-nav
// feels instant.

type CategoryRow = { id: string; label: string; sort_order: number };

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
      .select("id, label, sort_order")
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

export default async function AccountsPage() {
  const sb = await scopedSupabase();
  // Four reads, in parallel:
  //   1. Tracked account IDs for the current workspace.
  //   2. The full canonical category list (for the left rail) — retried, see above.
  //   3. Every account in the global catalog (so the user can browse + track).
  //   4. The single most-recent scrape run (workspace-scoped or the global cron),
  //      whose per-handle `progress` drives the "fetching / needs attention"
  //      source-health states. One scoped read — not per-creator.
  const [{ data: trackedRows }, catRows, { data: accountRows }, { data: latestRun }] =
    await Promise.all([
      sb.workspaceAccountsSelect("account_id"),
      loadCategories(sb),
      sb.raw
        .from("accounts")
        .select(
          "id, name, linkedin_handle, profile_url, profile_pic_url, synced_at, category_id, source, total_post_count",
        )
        .is("archived_at", null)
        .order("name"),
      sb.raw
        .from("runs")
        .select("progress")
        .or(`workspace_id.is.null,workspace_id.eq.${sb.workspaceId}`)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const trackedAccountIds = ((trackedRows ?? []) as unknown as Array<{ account_id: string }>).map(
    (r) => r.account_id,
  );
  const trackedSet = new Set(trackedAccountIds);

  // Index the latest run's progress by handle once, so status derivation is a
  // Map lookup per creator instead of a scan.
  const runByHandle = indexRunProgressByHandle(
    (latestRun?.progress as RunProgressEntry[] | null) ?? null,
  );

  const categories: PickerCategory[] = catRows.map((c) => ({
    id: c.id,
    label: c.label,
  }));

  const creators: PickerCreator[] = (accountRows ?? []).map((a) => {
    const handle = a.linkedin_handle as string;
    const totalPostCount = (a.total_post_count as number | null) ?? 0;
    const tracked = trackedSet.has(a.id as string);
    return {
      id: a.id as string,
      name: a.name as string,
      linkedin_handle: handle,
      profile_url: a.profile_url as string,
      profile_pic_url: (a.profile_pic_url as string | null) ?? null,
      synced_at: (a.synced_at as string | null) ?? null,
      category_id: (a.category_id as string | null) ?? null,
      is_manual: a.source === "manual",
      total_post_count: totalPostCount,
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

  return (
    <PageShell width="wide">
      <PageHeader
        title="Creators"
        description={
          <>
            Tracking{" "}
            <span className="font-medium text-foreground tabular-nums">{trackedCount}</span>{" "}
            of <span className="tabular-nums">{creators.length}</span> creators.
            Their latest posts are scraped automatically every day.
          </>
        }
        meta={
          <>
            <StatusPill tone="primary">{trackedCount} tracked</StatusPill>
            <StatusPill tone="neutral">{manualTrackedCount}/50 custom</StatusPill>
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

      <CreatorPicker
        categories={categories}
        creators={creators}
        trackedAccountIds={trackedAccountIds}
      />
    </PageShell>
  );
}

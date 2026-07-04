import { scopedSupabase } from "@/lib/supabase-scoped";
import { AddAccountButton } from "./account-actions";
import { CreatorPicker, type PickerCategory, type PickerCreator } from "./creator-picker";

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
  // Three reads, in parallel:
  //   1. Tracked account IDs for the current workspace.
  //   2. The full canonical category list (for the left rail) — retried, see above.
  //   3. Every account in the global catalog (so the user can browse + track).
  const [{ data: trackedRows }, catRows, { data: accountRows }] = await Promise.all([
    sb.workspaceAccountsSelect("account_id"),
    loadCategories(sb),
    sb.raw
      .from("accounts")
      .select("id, name, linkedin_handle, profile_url, profile_pic_url, synced_at, category_id, source")
      .is("archived_at", null)
      .order("name"),
  ]);

  const trackedAccountIds = ((trackedRows ?? []) as unknown as Array<{ account_id: string }>).map(
    (r) => r.account_id,
  );

  const categories: PickerCategory[] = catRows.map((c) => ({
    id: c.id,
    label: c.label,
  }));

  const creators: PickerCreator[] = (accountRows ?? []).map((a) => ({
    id: a.id as string,
    name: a.name as string,
    linkedin_handle: a.linkedin_handle as string,
    profile_url: a.profile_url as string,
    profile_pic_url: (a.profile_pic_url as string | null) ?? null,
    synced_at: (a.synced_at as string | null) ?? null,
    category_id: (a.category_id as string | null) ?? null,
    is_manual: a.source === "manual",
  }));

  const categoryOptions = categories.map((c) => ({ id: c.id, label: c.label }));
  const trackedCount = trackedAccountIds.length;
  const trackedIdSet = new Set(trackedAccountIds);
  const manualTrackedCount = creators.filter(
    (c) => c.is_manual && trackedIdSet.has(c.id),
  ).length;
  const flowSteps = [
    ["Track accounts", "Choose creators to monitor."],
    // Step 2 reads like a manual action, but the scrape is a daily cron
    // (/api/cron/daily, midnight UTC) — say so, so no one waits to "run" it.
    ["Scrape posts", "Runs automatically every day — we pull their latest posts for you."],
    ["Swipe File", "Find the strongest source posts."],
    ["Drafts", "Adapt winners into Posts."],
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display tracking-tight">
            Creators
            <span className="ml-3 align-middle text-base font-sans font-medium text-muted-foreground tabular-nums">
              {trackedCount}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Tracking{" "}
            <span className="font-medium text-foreground tabular-nums">{trackedCount}</span>{" "}
            of <span className="tabular-nums">{creators.length}</span> creators. Scraped
            automatically every day — no action needed.
          </p>
        </div>
        <AddAccountButton categories={categoryOptions} manualCount={manualTrackedCount} manualLimit={50} />
      </div>

      <div className="grid gap-2 rounded-xl border border-border/60 bg-muted/20 p-2 sm:grid-cols-4">
        {flowSteps.map(([label, detail], index) => (
          <div
            key={label}
            className="rounded-lg bg-background px-3 py-2.5"
          >
            <div className="text-[11px] font-semibold text-muted-foreground">
              Step {index + 1}
            </div>
            <div className="mt-1 text-sm font-medium">{label}</div>
            <div className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {detail}
            </div>
          </div>
        ))}
      </div>

      <CreatorPicker
        categories={categories}
        creators={creators}
        trackedAccountIds={trackedAccountIds}
      />
    </div>
  );
}

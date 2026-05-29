import { scopedSupabase } from "@/lib/supabase-scoped";
import { AddAccountButton } from "./account-actions";
import { CreatorPicker, type PickerCategory, type PickerCreator } from "./creator-picker";

// Dropped `force-dynamic` — auth() already makes this dynamic, and removing
// it lets the client-side Router Cache snapshot the page so sidebar back-nav
// feels instant.

type CategoryRow = { id: string; label: string; sort_order: number };

// The canonical category list backs the left rail. It's tiny, static, and
// service-role read (no RLS) — yet the rail intermittently rendered empty on
// refresh because a transient Supabase/network blip returned { data: null }
// and the page silently treated that as "zero categories" (`?? []`). A single
// retry papers over the blip; if it STILL fails we throw rather than render a
// misleadingly empty rail, so the error boundary shows a real "try again"
// instead of a page that looks fine but lost its categories.
async function loadCategories(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
): Promise<CategoryRow[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await sb.raw
      .from("categories")
      .select("id, label, sort_order")
      .order("sort_order");
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
            of <span className="tabular-nums">{creators.length}</span> creators. Pulled daily.
          </p>
        </div>
        <AddAccountButton categories={categoryOptions} manualCount={manualTrackedCount} manualLimit={50} />
      </div>


      <CreatorPicker
        categories={categories}
        creators={creators}
        trackedAccountIds={trackedAccountIds}
      />
    </div>
  );
}

import { scopedSupabase } from "@/lib/supabase-scoped";
import { AddAccountButton } from "./account-actions";
import { CreatorPicker, type PickerCategory, type PickerCreator } from "./creator-picker";

// Dropped `force-dynamic` — auth() already makes this dynamic, and removing
// it lets the client-side Router Cache snapshot the page so sidebar back-nav
// feels instant.

export default async function AccountsPage() {
  const sb = await scopedSupabase();
  // Three reads, in parallel:
  //   1. Tracked account IDs for the current workspace.
  //   2. The full canonical category list (for the left rail).
  //   3. Every account in the global catalog (so the user can browse + track).
  const [{ data: trackedRows }, { data: catRows }, { data: accountRows }] = await Promise.all([
    sb.workspaceAccountsSelect("account_id, accounts!inner(synced_at)"),
    sb.raw.from("categories").select("id, label, sort_order").order("sort_order"),
    sb.raw
      .from("accounts")
      .select("id, name, linkedin_handle, profile_url, synced_at, category_id, source")
      .is("archived_at", null)
      .order("name"),
  ]);

  const trackedAccountIds = ((trackedRows ?? []) as unknown as Array<{ account_id: string }>).map(
    (r) => r.account_id,
  );

  const categories: PickerCategory[] = (catRows ?? []).map((c) => ({
    id: c.id as string,
    label: c.label as string,
  }));

  const creators: PickerCreator[] = (accountRows ?? []).map((a) => ({
    id: a.id as string,
    name: a.name as string,
    linkedin_handle: a.linkedin_handle as string,
    profile_url: a.profile_url as string,
    synced_at: (a.synced_at as string | null) ?? null,
    category_id: (a.category_id as string | null) ?? null,
    is_manual: a.source === "manual",
  }));

  const lastSyncedAt = creators.reduce<string | null>((acc, c) => {
    if (!c.synced_at) return acc;
    return !acc || c.synced_at > acc ? c.synced_at : acc;
  }, null);

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

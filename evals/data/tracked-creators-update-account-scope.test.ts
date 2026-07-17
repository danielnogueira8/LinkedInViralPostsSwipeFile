import { describe, test, expect } from "vitest";
import { createSupabaseTrackedCreatorsRepository } from "@/lib/tracked-creators-supabase";

// ---------------------------------------------------------------------------
// updateAccount's UPDATE had no workspace scoping in the SQL itself — it was
// safe only because the single caller (TrackedCreators) always checks
// ownership first. Defense-in-depth: the query now filters server-side to
// rows this workspace may legitimately write — either an unowned global-
// baseline account (manual_owner_workspace_id is null, the shared catalog
// every workspace may sync fields on) or one it manually owns.
//
// This fake mimics PostgREST's .or("a.is.null,a.eq.X") against a fixed table
// so the test exercises the ACTUAL filter string the repository builds, not
// just app-layer intent.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  name: string;
  linkedin_handle: string;
  profile_url: string;
  niche: string | null;
  category_id: string | null;
  profile_pic_url: string | null;
  source: string;
  archived_at: string | null;
  manual_owner_workspace_id: string | null;
  synced_at: string;
};

function makeRow(overrides: Partial<Row>): Row {
  return {
    id: "acct-1",
    name: "Creator",
    linkedin_handle: "creator",
    profile_url: "https://linkedin.com/in/creator",
    niche: null,
    category_id: null,
    profile_pic_url: null,
    source: "manual",
    archived_at: null,
    manual_owner_workspace_id: null,
    synced_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeSupabase(table: Row[]) {
  return {
    from(name: string) {
      if (name !== "accounts") throw new Error(`unexpected table ${name}`);
      let patch: Record<string, unknown> = {};
      let idFilter: string | null = null;
      let orFilter: string | null = null;
      const builder = {
        update: (p: Record<string, unknown>) => {
          patch = p;
          return builder;
        },
        eq: (col: string, val: string) => {
          if (col === "id") idFilter = val;
          return builder;
        },
        or: (expr: string) => {
          orFilter = expr;
          return builder;
        },
        select: () => builder,
        single: async () => {
          const matchesOr = (row: Row) => {
            if (!orFilter) return true;
            // Parse "manual_owner_workspace_id.is.null,manual_owner_workspace_id.eq.<ws>"
            return orFilter.split(",").some((clause) => {
              if (clause.endsWith(".is.null")) return row.manual_owner_workspace_id === null;
              const eqMatch = clause.match(/\.eq\.(.+)$/);
              if (eqMatch) return row.manual_owner_workspace_id === decodeURIComponent(eqMatch[1]);
              return false;
            });
          };
          const row = table.find((r) => r.id === idFilter && matchesOr(r));
          if (!row) {
            // Mirrors PostgREST's real behavior: an UPDATE matching zero rows
            // with .single() errors (PGRST116), it doesn't silently succeed.
            return { data: null, error: { message: "no rows matched" } };
          }
          Object.assign(row, patch);
          return { data: { ...row }, error: null };
        },
      };
      return builder;
    },
  };
}

describe("updateAccount — server-side workspace scoping", () => {
  test("a workspace CAN update its own manually-owned account", async () => {
    const table = [makeRow({ id: "acct-1", manual_owner_workspace_id: "ws-a", name: "Old Name" })];
    const repo = createSupabaseTrackedCreatorsRepository(fakeSupabase(table) as never, "ws-a");
    const updated = await repo.updateAccount("acct-1", { name: "New Name" });
    expect(updated?.name).toBe("New Name");
  });

  test("a workspace CANNOT update an account manually owned by another workspace", async () => {
    const table = [makeRow({ id: "acct-1", manual_owner_workspace_id: "ws-b", name: "Old Name" })];
    const repo = createSupabaseTrackedCreatorsRepository(fakeSupabase(table) as never, "ws-a");
    await expect(repo.updateAccount("acct-1", { name: "Hijacked" })).rejects.toThrow();
    expect(table[0].name).toBe("Old Name");
  });

  test("any workspace CAN update an unowned global-baseline account (shared catalog sync)", async () => {
    const table = [makeRow({ id: "acct-1", manual_owner_workspace_id: null, source: "scraped" })];
    const repo = createSupabaseTrackedCreatorsRepository(fakeSupabase(table) as never, "ws-a");
    const updated = await repo.updateAccount("acct-1", { profilePicUrl: "https://x.com/pic.jpg" });
    expect(updated?.profilePicUrl).toBe("https://x.com/pic.jpg");
  });
});

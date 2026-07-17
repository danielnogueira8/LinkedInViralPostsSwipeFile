import type { SupabaseClient } from "@supabase/supabase-js";
import { visibleCategoriesOr } from "@/lib/categories";
import { encodePostgrestValue } from "@/lib/postgrest";
import type {
  TrackedCreatorAccount,
  TrackedCreatorIdentifier,
  TrackedCreatorListRow,
  TrackedCreatorsRepository,
} from "@/lib/tracked-creators";

type AccountRow = {
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

const ACCOUNT_COLUMNS =
  "id, name, linkedin_handle, profile_url, niche, category_id, profile_pic_url, source, archived_at, manual_owner_workspace_id, synced_at";

function accountFromRow(row: AccountRow): TrackedCreatorAccount {
  return {
    id: row.id,
    name: row.name,
    linkedinHandle: row.linkedin_handle,
    profileUrl: row.profile_url,
    niche: row.niche,
    categoryId: row.category_id,
    profilePicUrl: row.profile_pic_url,
    source: row.source,
    archivedAt: row.archived_at,
    manualOwnerWorkspaceId: row.manual_owner_workspace_id,
    syncedAt: row.synced_at,
  };
}

function accountPatch(
  patch: Partial<TrackedCreatorAccount>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.linkedinHandle !== undefined)
    row.linkedin_handle = patch.linkedinHandle;
  if (patch.profileUrl !== undefined) row.profile_url = patch.profileUrl;
  if (patch.niche !== undefined) row.niche = patch.niche;
  if (patch.categoryId !== undefined) row.category_id = patch.categoryId;
  if (patch.profilePicUrl !== undefined)
    row.profile_pic_url = patch.profilePicUrl;
  if (patch.source !== undefined) row.source = patch.source;
  if (patch.archivedAt !== undefined) row.archived_at = patch.archivedAt;
  if (patch.manualOwnerWorkspaceId !== undefined) {
    row.manual_owner_workspace_id = patch.manualOwnerWorkspaceId;
  }
  if (patch.syncedAt !== undefined) row.synced_at = patch.syncedAt;
  return row;
}

export function createSupabaseTrackedCreatorsRepository(
  db: SupabaseClient,
  workspaceId: string,
  overrides: {
    isTracked?: (accountId: string) => Promise<boolean>;
    track?: (accountId: string, niche: string | null) => Promise<void>;
    untrack?: (accountId: string) => Promise<boolean>;
  } = {},
): TrackedCreatorsRepository {
  if (!workspaceId.trim()) throw new Error("workspace identity required");

  const findAccountByUrl = async (profileUrl: string) => {
    const { data, error } = await db
      .from("accounts")
      .select(ACCOUNT_COLUMNS)
      .eq("profile_url", profileUrl)
      .maybeSingle();
    if (error) throw error;
    return data ? accountFromRow(data as unknown as AccountRow) : null;
  };

  return {
    workspaceId,

    async countManualTracked() {
      const { data, error } = await db
        .from("workspace_accounts")
        .select("accounts!inner(source)")
        .eq("workspace_id", workspaceId)
        .eq("accounts.source", "manual");
      if (error) throw error;
      return (data ?? []).length;
    },

    async findCategory(id) {
      const { data, error } = await db
        .from("categories")
        .select("id, label, workspace_id")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data
        ? {
            id: data.id as string,
            label: data.label as string,
            workspaceId: (data.workspace_id as string | null) ?? null,
          }
        : null;
    },

    findAccountByUrl,

    async findAccountById(id) {
      const { data, error } = await db
        .from("accounts")
        .select(ACCOUNT_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data ? accountFromRow(data as unknown as AccountRow) : null;
    },

    async findAccount(identifier: TrackedCreatorIdentifier) {
      let query = db.from("accounts").select(ACCOUNT_COLUMNS);
      if (identifier.id) query = query.eq("id", identifier.id);
      else if (identifier.handle) {
        query = query.eq("linkedin_handle", identifier.handle);
      } else if (identifier.profileUrl) {
        query = query.eq("profile_url", identifier.profileUrl);
      }
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return data ? accountFromRow(data as unknown as AccountRow) : null;
    },

    async isTracked(accountId) {
      if (overrides.isTracked) return overrides.isTracked(accountId);
      const { data, error } = await db
        .from("workspace_accounts")
        .select("account_id")
        .eq("workspace_id", workspaceId)
        .eq("account_id", accountId)
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },

    async createAccount(input) {
      const insert = {
        name: input.name,
        linkedin_handle: input.linkedinHandle,
        profile_url: input.profileUrl,
        niche: input.niche,
        category_id: input.categoryId,
        profile_pic_url: input.profilePicUrl,
        source: input.source,
        archived_at: input.archivedAt,
        manual_owner_workspace_id: input.manualOwnerWorkspaceId,
        synced_at: input.syncedAt,
      };
      const { data, error } = await db
        .from("accounts")
        .insert(insert)
        .select(ACCOUNT_COLUMNS)
        .single();
      if (error?.code === "23505") {
        const winner = await findAccountByUrl(input.profileUrl);
        if (!winner) throw error;
        return { account: winner, raced: true };
      }
      if (error || !data) throw error || new Error("insert failed");
      return {
        account: accountFromRow({
          ...insert,
          ...data,
        } as unknown as AccountRow),
        raced: false,
      };
    },

    async updateAccount(id, patch) {
      // Defense-in-depth: an account is writable by this workspace only if
      // it's an unowned global-baseline row (manual_owner_workspace_id is
      // null — the shared scraped catalog every workspace may sync fields
      // on) or it's manually owned BY this workspace. The one caller
      // (TrackedCreators in lib/tracked-creators.ts) already enforces this
      // in the app layer before calling here; this makes the SQL itself
      // correct rather than relying solely on that caller never regressing.
      const { data, error } = await db
        .from("accounts")
        .update(accountPatch(patch))
        .eq("id", id)
        .or(
          `manual_owner_workspace_id.is.null,manual_owner_workspace_id.eq.${encodePostgrestValue(workspaceId)}`,
        )
        .select(ACCOUNT_COLUMNS)
        .single();
      if (error) throw error;
      return data ? accountFromRow(data as unknown as AccountRow) : null;
    },

    async track(accountId, niche) {
      if (overrides.track) return overrides.track(accountId, niche);
      const { error } = await db
        .from("workspace_accounts")
        .upsert(
          { workspace_id: workspaceId, account_id: accountId, niche },
          { onConflict: "workspace_id,account_id" },
        );
      if (error) throw error;
    },

    async untrack(accountId) {
      if (overrides.untrack) return overrides.untrack(accountId);
      const { data, error } = await db
        .from("workspace_accounts")
        .delete()
        .eq("workspace_id", workspaceId)
        .eq("account_id", accountId)
        .select("account_id")
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },

    async updateWorkspaceNiche(accountId, niche) {
      const { data, error } = await db
        .from("workspace_accounts")
        .update({ niche })
        .eq("workspace_id", workspaceId)
        .eq("account_id", accountId)
        .select("account_id")
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },

    async visibleCategoryIds(categoryIds) {
      const { data, error } = await db
        .from("categories")
        .select("id")
        .or(visibleCategoriesOr(workspaceId))
        .in("id", categoryIds);
      if (error) throw error;
      return (data ?? []).map((row) => row.id as string);
    },

    async accountIdsByCategory(categoryIds, includeArchived) {
      let query = db
        .from("accounts")
        .select("id")
        .in("category_id", categoryIds);
      if (!includeArchived) query = query.is("archived_at", null);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map((row) => row.id as string);
    },

    async trackMany(accountIds) {
      const { error } = await db.from("workspace_accounts").upsert(
        accountIds.map((accountId) => ({
          workspace_id: workspaceId,
          account_id: accountId,
          niche: null,
        })),
        { onConflict: "workspace_id,account_id" },
      );
      if (error) throw error;
    },

    async untrackMany(accountIds) {
      const { error } = await db
        .from("workspace_accounts")
        .delete()
        .eq("workspace_id", workspaceId)
        .in("account_id", accountIds);
      if (error) throw error;
    },

    async trackedAccountIds() {
      const { data, error } = await db
        .from("workspace_accounts")
        .select("account_id")
        .eq("workspace_id", workspaceId);
      if (error) throw error;
      return (data ?? []).map((row) => row.account_id as string);
    },

    async list(input = {}) {
      let query = db
        .from("workspace_accounts")
        .select(`niche, added_at, accounts!inner(${ACCOUNT_COLUMNS})`)
        .eq("workspace_id", workspaceId)
        .order("name", { foreignTable: "accounts", ascending: true })
        .limit(input.limit ?? 50);
      if (!input.includeArchived)
        query = query.is("accounts.archived_at", null);
      if (input.niche) {
        query = query.or(
          `niche.eq.${input.niche},and(niche.is.null,accounts.niche.eq.${input.niche})`,
        );
      }
      if (input.search) {
        const search = input.search.replace(/[%_]/g, "");
        query = query.or(
          `name.ilike.%${search}%,linkedin_handle.ilike.%${search}%`,
          { foreignTable: "accounts" },
        );
      }
      const { data, error } = await query;
      if (error) throw error;
      return (
        (data ?? []) as unknown as Array<{
          niche: string | null;
          added_at: string;
          accounts: AccountRow | AccountRow[];
        }>
      ).flatMap((row): TrackedCreatorListRow[] => {
        const account = Array.isArray(row.accounts)
          ? row.accounts[0]
          : row.accounts;
        return account
          ? [
              {
                account: accountFromRow(account),
                workspaceNiche: row.niche,
                trackedAt: row.added_at,
              },
            ]
          : [];
      });
    },
  };
}

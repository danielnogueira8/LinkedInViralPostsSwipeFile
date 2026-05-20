import { supabaseAdmin } from "./supabase";
import { requireWorkspaceId } from "./workspace";

/**
 * Workspace-scoped Supabase client.
 *
 * Uses the service-role key under the hood (bypasses RLS) but enforces
 * workspace isolation at the app layer — every query/insert is filtered or
 * stamped with workspace_id. Belt-and-suspenders alongside RLS in
 * migration 011.
 *
 * For workspace-scoped tables (clients, image_prompts, settings,
 * workspace_accounts, runs): use the helpers below.
 *
 * For global tables (accounts, posts, templates): drop to `.raw` and filter
 * by `workspace_accounts.account_id` via `trackedAccountIds()`.
 *
 * Cron + background pipelines should use supabaseAdmin() directly.
 */

// Note: we intentionally type column-string args as `string` and let the
// underlying Supabase chain be typed loosely. Threading generic literal types
// through Supabase's typegen blew up type-checking (recursive depth). The
// belt-and-suspenders is the .eq("workspace_id", ...) on every chain, not
// type-level enforcement.

export async function scopedSupabase() {
  const workspaceId = await requireWorkspaceId();
  const sb = supabaseAdmin();

  return {
    workspaceId,
    raw: sb,

    /* ------------------- clients ------------------- */

    clientsSelect: (cols: string) =>
      sb.from("clients").select(cols as "*").eq("workspace_id", workspaceId),
    insertClient: (row: Record<string, unknown>) =>
      sb.from("clients").insert({ ...row, workspace_id: workspaceId }),
    deleteClient: (id: string) =>
      sb.from("clients").delete().eq("id", id).eq("workspace_id", workspaceId),

    /* ------------------- image_prompts ------------------- */

    imagePromptsSelect: (cols: string) =>
      sb
        .from("image_prompts")
        .select(cols as "*")
        .eq("workspace_id", workspaceId),
    upsertImagePrompt: (row: Record<string, unknown>) =>
      sb
        .from("image_prompts")
        .upsert(
          { ...row, workspace_id: workspaceId },
          { onConflict: "post_id,client_id" },
        ),

    /* ------------------- settings ------------------- */

    settings: () => sb.from("settings").select().eq("workspace_id", workspaceId),
    upsertSetting: (key: string, value: unknown) =>
      sb.from("settings").upsert(
        { workspace_id: workspaceId, key, value, updated_at: new Date().toISOString() },
        { onConflict: "workspace_id,key" },
      ),

    /* ------------------- workspace_accounts (the join) ------------------- */

    workspaceAccountsSelect: (cols: string) =>
      sb
        .from("workspace_accounts")
        .select(cols as "*")
        .eq("workspace_id", workspaceId),
    trackAccount: (account_id: string, niche?: string | null) =>
      sb.from("workspace_accounts").upsert(
        { workspace_id: workspaceId, account_id, niche: niche ?? null },
        { onConflict: "workspace_id,account_id" },
      ),
    untrackAccount: (account_id: string) =>
      sb
        .from("workspace_accounts")
        .delete()
        .eq("workspace_id", workspaceId)
        .eq("account_id", account_id),

    /* ------------------- runs (nullable workspace_id) ------------------- */

    runsSelect: (cols: string) =>
      sb
        .from("runs")
        .select(cols as "*")
        .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`),
  };
}

/**
 * For routes that need to query global tables (accounts/posts/templates) but
 * filtered to the workspace's tracked accounts.
 */
export async function trackedAccountIds(workspaceId: string): Promise<string[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("workspace_accounts")
    .select("account_id")
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return (data ?? []).map((r) => r.account_id as string);
}

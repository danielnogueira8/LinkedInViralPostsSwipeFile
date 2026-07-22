import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";
import { requireWorkspaceId } from "./workspace";
import { retryRead } from "./retry-read";
import { encodePostgrestValue } from "./postgrest";

/**
 * Workspace-scoped Supabase client.
 *
 * Uses the server-only service client and enforces workspace isolation at the
 * app layer by filtering or stamping every workspace-owned operation. The
 * Clerk-token/RLS request client remains available in lib/supabase.ts, but must
 * not be enabled until the production Clerk third-party provider is configured
 * and verified end-to-end against Supabase.
 *
 * For workspace-scoped tables (clients, image_prompts, settings,
 * workspace_accounts, runs): use the helpers below.
 *
 * For global tables (accounts, posts, templates), drop to `.raw` and filter by
 * `workspace_accounts.account_id` via `trackedAccountIds()`.
 *
 * Cron + background pipelines should use supabaseAdmin() directly.
 */

// Note: we intentionally type column-string args as `string` and let the
// underlying Supabase chain be typed loosely. Threading generic literal types
// through Supabase's typegen blew up type-checking (recursive depth). Runtime
// isolation comes from both the explicit .eq("workspace_id", ...) predicates
// and the server-only service client never being exposed to the browser.

export const scopedSupabase = cache(async function scopedSupabase() {
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

    // Workspace runs + cron (global) runs are both visible to the
    // workspace — cron runs surface as "your accounts were scraped at X"
    // in the dashboard. The workspaceId is interpolated into a PostgREST
    // .or() expression, so any special character in the id would break
    // the predicate. Clerk org ids are safe today (`org_<base62>`) but
    // we encode defensively in case that ever changes.
    runsSelect: (cols: string) => {
      const safe = encodePostgrestValue(workspaceId);
      return sb
        .from("runs")
        .select(cols as "*")
        .or(`workspace_id.is.null,workspace_id.eq.${safe}`);
    },
  };
});


/**
 * For routes that need to query global tables (accounts/posts/templates) but
 * filtered to the workspace's tracked accounts.
 *
 * Wrapped in React cache() so repeated calls within a single server render
 * (e.g. the swipe page shell + PostsSection both resolve tracked accounts,
 * and dashboard/templates each call it) hit the DB once. cache()
 * dedupes by argument (workspaceId) for the duration of one request.
 *
 * The read goes through retryRead() so a transient blip self-heals BEFORE it
 * can be cached. This matters more here than at most read sites: cache()
 * memoizes a thrown error for the whole request, so a single un-retried blip
 * here would not only trip the error boundary but also survive its "Try
 * again" (reset() re-renders within the same cached request and re-throws the
 * memoized error) — forcing a full page refresh to recover. Retrying first
 * keeps a one-off blip from ever being memoized.
 */
export const trackedAccountIds = cache(
  async (workspaceId: string): Promise<string[]> => {
    return trackedAccountIdsWithClient(supabaseAdmin(), workspaceId);
  },
);

async function trackedAccountIdsWithClient(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<string[]> {
  const { data, error } = await retryRead<{ account_id: string }[]>(() =>
    sb
      .from("workspace_accounts")
      .select("account_id")
      .eq("workspace_id", workspaceId),
  );
  if (error) throw error;
  const rows = data ?? [];
  // No .range() pagination here on purpose — MANUAL_ACCOUNT_LIMIT (50,
  // lib/account-tracking.ts) keeps every workspace far under PostgREST's
  // silent 1000-row cap, so paginating would be unreachable complexity.
  // This warns loudly instead if that ever stops being true (a raised cap,
  // a bug bypassing it) rather than silently truncating the roster.
  if (rows.length >= 1000) {
    console.error(
      `trackedAccountIds(${workspaceId}) returned ${rows.length} rows — hit PostgREST's 1000-row cap. MANUAL_ACCOUNT_LIMIT no longer bounds this; needs selectAllRows pagination.`,
    );
  }
  return rows.map((r) => r.account_id as string);
}

/** Service-authenticated equivalent for MCP requests, which authenticate with
 * their own bearer-token layer rather than a Clerk browser session. */
export function trackedAccountIdsForService(
  workspaceId: string,
): Promise<string[]> {
  return trackedAccountIdsWithClient(supabaseAdmin(), workspaceId);
}

/**
 * The most recent successful scrape run "relevant" to a workspace: either a
 * run that workspace itself triggered (runs.workspace_id = workspaceId), or
 * a global daily-cron run (runs.workspace_id IS NULL — see
 * db/migration-011-multi-tenancy.sql). Deliberately excludes OTHER
 * workspaces' triggered runs.
 *
 * Without this, "get the latest scrape" queries picked the single most
 * recent run across ALL workspaces with no filter at all — so workspace B
 * triggering a manual re-scrape would skew workspace A's "recent posts"
 * freshness window and displayed scrape date to B's run, even though A's own
 * posts/accounts stayed correctly scoped. Centralizing here so every caller
 * (Cowork's get_top_from_batch tool, modeled batches, the hosted MCP tool)
 * gets the fix once instead of re-implementing the same unscoped query.
 */
export async function latestRelevantScrape(
  workspaceId: string,
): Promise<{ started_at: string; finished_at: string | null } | null> {
  return latestRelevantScrapeWithClient(supabaseAdmin(), workspaceId);
}

async function latestRelevantScrapeWithClient(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<{ started_at: string; finished_at: string | null } | null> {
  const { data, error } = await retryRead<
    { started_at: string; finished_at: string | null }[]
  >(() =>
    sb
      .from("runs")
      .select("started_at, finished_at")
      .eq("status", "ok")
      .or(`workspace_id.eq.${encodePostgrestValue(workspaceId)},workspace_id.is.null`)
      .order("started_at", { ascending: false })
      .limit(1),
  );
  if (error) throw error;
  return data?.[0] ?? null;
}

export function latestRelevantScrapeForService(
  workspaceId: string,
): Promise<{ started_at: string; finished_at: string | null } | null> {
  return latestRelevantScrapeWithClient(supabaseAdmin(), workspaceId);
}

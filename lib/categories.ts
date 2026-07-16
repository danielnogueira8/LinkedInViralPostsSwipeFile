import type { SupabaseClient } from "@supabase/supabase-js";
import { encodePostgrestValue } from "./postgrest";

// A category is "visible" to a workspace when it's curated/global
// (workspace_id IS NULL) or it's that workspace's own custom category. The
// service-role key bypasses RLS, so every display/validation read must apply
// this filter explicitly — otherwise one workspace's custom categories would
// leak into another's rails. Keep this string in one place so all read sites
// filter identically.
//
// workspaceId is a Clerk user id (`user_<base62>`), which only contains
// characters safe to interpolate into a PostgREST `.or()` predicate. We still
// encode defensively via the shared encoder (same as supabase-scoped's
// runsSelect) so this `.or()` can't break if the id shape ever changes.
export function visibleCategoriesOr(workspaceId: string): string {
  return `workspace_id.is.null,workspace_id.eq.${encodePostgrestValue(workspaceId)}`;
}

// Load the categories a workspace can see (curated + its own custom), ordered
// for the rail: curated first by sort_order, then custom categories
// (sort_order 1000) alphabetically by label as a stable tiebreak.
//
// `sb` is the raw service-role client; pass the workspace id explicitly.
export async function loadVisibleCategories<T = { id: string; label: string }>(
  sb: SupabaseClient,
  workspaceId: string,
  cols: string = "id, label",
): Promise<{ data: T[] | null; error: unknown }> {
  const { data, error } = await sb
    .from("categories")
    .select(cols)
    .or(visibleCategoriesOr(workspaceId))
    .order("sort_order")
    .order("label");
  return { data: (data as T[] | null) ?? null, error };
}

// Validate a category id against the categories a workspace may use.
//
// Returns:
//   - { ok: true, categoryId: null }      — caller passed null/empty (no category)
//   - { ok: true, categoryId: <id> }      — id is visible to this workspace
//   - { ok: false }                       — id was provided but isn't usable here
//
// Accepts curated/global categories AND this workspace's own custom categories;
// rejects another workspace's custom id so a workspace can't file content under
// a category it can't see. A bogus id degrades gracefully on read (no chip
// label), but accepting it lets drift creep into the data, so we reject unknown
// ids at write time. Empty/whitespace coerces to null ("no category"), matching
// the column default and the `is null` filters used elsewhere.
export async function validateCategoryId(
  sb: SupabaseClient,
  raw: string | null | undefined,
  workspaceId: string,
): Promise<{ ok: true; categoryId: string | null } | { ok: false }> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, categoryId: null };

  const { data } = await sb
    .from("categories")
    .select("id, workspace_id")
    .eq("id", trimmed)
    .maybeSingle();
  if (!data) return { ok: false };
  const visible = data.workspace_id === null || data.workspace_id === workspaceId;
  if (!visible) return { ok: false };
  return { ok: true, categoryId: data.id as string };
}

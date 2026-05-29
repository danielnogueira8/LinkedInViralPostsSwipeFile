import type { SupabaseClient } from "@supabase/supabase-js";

// Validate a category id against the canonical `categories` taxonomy.
//
// Returns:
//   - { ok: true, categoryId: null }      — caller passed null/empty (no category)
//   - { ok: true, categoryId: <id> }      — id exists in the taxonomy
//   - { ok: false }                       — id was provided but doesn't exist
//
// The manual-add account route validates categories this way already; the
// bookmark save + override paths previously stored whatever string the caller
// sent. A bogus id degrades gracefully on read (no chip label), but accepting
// it lets drift creep into the data, so we reject unknown ids at write time.
// Empty/whitespace coerces to null ("no category"), matching the column
// default and the `is null` filters used elsewhere.
export async function validateCategoryId(
  sb: SupabaseClient,
  raw: string | null | undefined,
): Promise<{ ok: true; categoryId: string | null } | { ok: false }> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, categoryId: null };

  const { data } = await sb
    .from("categories")
    .select("id")
    .eq("id", trimmed)
    .maybeSingle();
  if (!data) return { ok: false };
  return { ok: true, categoryId: data.id as string };
}

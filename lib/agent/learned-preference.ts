import {
  PREFS_PER_WORKSPACE_MAX,
  isDuplicatePreference,
  normalizePreferenceRule,
  normalizePreferenceDetail,
} from "@/lib/preferences";
import { supabaseAdmin } from "@/lib/supabase";

export const PREFERENCE_TOOL_NAME = "remember_preference";

export async function persistLearnedPreference(
  workspaceId: string,
  rawRule: unknown,
  existing: ReadonlyArray<{ rule: string }>,
  rawDetail?: unknown,
): Promise<
  | { ok: true; saved: true; id: string; rule: string }
  | { ok: true; saved: false; reason: "duplicate" | "cap"; rule: string }
  | { ok: false; error: string }
> {
  const rule = normalizePreferenceRule(
    typeof rawRule === "string" ? rawRule : "",
  );
  if (!rule) {
    return {
      ok: false,
      error:
        'remember_preference requires a non-empty "rule" string — one short imperative line.',
    };
  }
  const detail = normalizePreferenceDetail(
    typeof rawDetail === "string" ? rawDetail : undefined,
  );
  if (isDuplicatePreference(rule, existing)) {
    return { ok: true, saved: false, reason: "duplicate", rule };
  }
  if (existing.length >= PREFS_PER_WORKSPACE_MAX) {
    return { ok: true, saved: false, reason: "cap", rule };
  }
  try {
    const { data, error } = await supabaseAdmin()
      .from("content_preferences")
      .insert({
        workspace_id: workspaceId,
        rule,
        detail: detail || null,
        source: "learned",
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true, saved: true, id: (data as { id: string }).id, rule };
  } catch {
    return {
      ok: false,
      error:
        "Could not save the preference right now (a storage error). Apply it to this draft and let the user know it wasn't saved.",
    };
  }
}

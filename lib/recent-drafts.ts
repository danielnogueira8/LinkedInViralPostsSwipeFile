// Fetch the workspace's recent post drafts. Used as context for the sameness
// detector so a NEW generation can be checked against what's already been
// written — the "you keep leaning on the same 5 identity anchors" problem.
//
// Deliberately SCOPED + BOUNDED:
//   - Workspace-scoped (multi-tenant safety).
//   - Only `kind='post'` — hooks/cites/lead-magnet drafts aren't the surface
//     the sameness problem manifests on (a hook is one line; the repetition
//     the user complained about is in the BODIES).
//   - Only `status IN ('ready','pending_review','draft')` — a rejected draft
//     is the user telling us "this shape was wrong", so echoing back to it
//     as "don't repeat this" would be perverse (the user already rejected
//     the shape; the model didn't take a second bite of that apple).
//   - Bounded to N most recent. The sameness pass reads all N as prompt
//     context; N > 20 blows the sameness call's cost per generation.
//   - Bounded body length per row so a long history doesn't stack into a
//     huge prompt. We only need the SHAPE of prior drafts, not the full text.
//
// Never throws. On any DB error returns [] so the sameness pass just skips.

import { supabaseAdmin } from "@/lib/supabase";

// How many recent drafts the sameness pass reads. 20 is enough to see
// repetition patterns (a marker used in 4-of-20 is a real pattern; 4-of-5 is
// noise) without blowing the sameness call's token budget.
export const RECENT_DRAFT_LIMIT = 20;

// Per-row truncation for the sameness prompt. A LinkedIn post is typically
// 800-1500 chars; capping at 400 keeps identity-marker density intact (the
// hook + first paragraph carry most identity references) while cutting the
// prompt size by ~2/3.
export const RECENT_DRAFT_BODY_CAP = 400;

export type RecentDraft = {
  id: string;
  body: string;
  createdAt: string;
};

export async function fetchRecentPostDrafts(opts: {
  workspaceId: string;
  limit?: number;
  // Exclude this artifact id from the result — used by the sameness pass so
  // a draft doesn't get compared against itself if it was already persisted
  // before the pass runs (defensive; the pass normally runs pre-persist).
  excludeId?: string;
}): Promise<RecentDraft[]> {
  const limit = opts.limit ?? RECENT_DRAFT_LIMIT;
  try {
    let q = supabaseAdmin()
      .from("chat_artifacts")
      .select("id, body, created_at")
      .eq("workspace_id", opts.workspaceId)
      .eq("kind", "post")
      .in("status", ["ready", "pending_review", "draft"])
      .order("created_at", { ascending: false })
      .limit(limit);
    if (opts.excludeId) q = q.neq("id", opts.excludeId);
    const { data, error } = await q;
    if (error || !data) return [];
    return data.map((r) => ({
      id: r.id as string,
      body: truncateForPrompt((r.body as string) ?? ""),
      createdAt: r.created_at as string,
    }));
  } catch {
    return [];
  }
}

// Truncate a body to keep the sameness prompt small. Cuts at a word boundary
// near the cap so a mid-word truncation doesn't confuse the model about the
// actual writing style. Exported for tests.
export function truncateForPrompt(
  body: string,
  cap: number = RECENT_DRAFT_BODY_CAP,
): string {
  if (body.length <= cap) return body;
  const slice = body.slice(0, cap);
  // Prefer a paragraph break, then a sentence end, then a word boundary.
  const paraIdx = slice.lastIndexOf("\n\n");
  if (paraIdx >= cap * 0.6) return slice.slice(0, paraIdx).trimEnd() + "…";
  const sentIdx = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("! "),
  );
  if (sentIdx >= cap * 0.6) return slice.slice(0, sentIdx + 1) + " …";
  const wordIdx = slice.lastIndexOf(" ");
  if (wordIdx >= cap * 0.8) return slice.slice(0, wordIdx) + "…";
  return slice + "…";
}

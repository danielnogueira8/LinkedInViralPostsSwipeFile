// ---------------------------------------------------------------------------
// Opportunity → source post type read path.
//
// `agent_opportunities` stores `source_post_id` but NOT the source post's
// type. `posts.post_type` ('regular' | 'lead_magnet', NOT NULL, stamped at
// scrape time by lib/post-type.ts) is the authoritative flag, and the agent
// loop already reads it at ACT time (lib/agent-loop/act.ts) to decide whether
// a modelling turn needs a lead magnet attached.
//
// The briefing read path dropped it, so the "Working now" cards could not tell
// the user that an opportunity models a lead-magnet post — which matters,
// because drafting from one produces a comment-gated CTA post rather than a
// regular one. This module rebuilds the link at the read boundary: same source
// of truth as act.ts, no new classifier, no heuristic.
//
// `source_post_id` is ON DELETE SET NULL, so opportunities whose source post
// has been purged fall back to `false` — absence of evidence is not a lead
// magnet, and a false negative here costs nothing but a missing hint.
// ---------------------------------------------------------------------------

/** Marks a source post as a lead magnet using the persisted `posts.post_type`. */
export function isLeadMagnetPostType(postType: unknown): boolean {
  return postType === "lead_magnet";
}

type PostTypeRow = { id?: unknown; post_type?: unknown };

/**
 * Build the set of lead-magnet post ids from a `posts` query returning
 * `id, post_type`. Rows with a non-string id are ignored.
 */
export function leadMagnetPostIds(
  rows: readonly PostTypeRow[] | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows ?? []) {
    if (typeof row?.id === "string" && isLeadMagnetPostType(row.post_type)) {
      ids.add(row.id);
    }
  }
  return ids;
}

/** Collect the distinct non-null `source_post_id`s from opportunity rows. */
export function opportunitySourcePostIds(
  rows: readonly { source_post_id?: unknown }[] | null | undefined,
): string[] {
  const ids = new Set<string>();
  for (const row of rows ?? []) {
    if (typeof row?.source_post_id === "string" && row.source_post_id) {
      ids.add(row.source_post_id);
    }
  }
  return [...ids];
}

/** True when this opportunity's source post is a lead magnet. */
export function opportunityIsLeadMagnet(
  row: { source_post_id?: unknown } | null | undefined,
  leadMagnetIds: ReadonlySet<string>,
): boolean {
  const id = row?.source_post_id;
  return typeof id === "string" && leadMagnetIds.has(id);
}

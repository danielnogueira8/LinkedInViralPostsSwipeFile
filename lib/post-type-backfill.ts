import { classifyPost, type PostType } from "./post-type";

// ---------------------------------------------------------------------------
// Re-run the lead-magnet classifier over posts already stored.
//
// post_type is stamped once at ingest, so widening the patterns only helps
// posts scraped afterwards. Everything already in the table keeps whatever the
// narrower rules decided — which for giveaway-first CTAs ("Get free access
// below 👇") means "regular", judged on likes instead of comments.
//
// Pure so the decision is testable without a database; the script owns the I/O.
// ---------------------------------------------------------------------------

export type ClassifiablePost = {
  id: string;
  text: string | null;
  post_type: string | null;
};

export type PostTypeBackfillPlan = {
  /** regular → lead_magnet: what the widened patterns now catch. */
  promote: string[];
  /**
   * lead_magnet → regular. Reported but NOT applied by default: the stored
   * value may be a deliberate human choice, and the patterns only ever widen,
   * so anything here is a signal that something else set it — not that the
   * classifier changed its mind.
   */
  demote: string[];
  unchanged: number;
};

export function planPostTypeBackfill(
  posts: readonly ClassifiablePost[],
): PostTypeBackfillPlan {
  const plan: PostTypeBackfillPlan = { promote: [], demote: [], unchanged: 0 };
  for (const post of posts) {
    const computed: PostType = classifyPost(post.text).post_type;
    const stored = post.post_type;
    if (stored === computed) {
      plan.unchanged += 1;
    } else if (computed === "lead_magnet") {
      plan.promote.push(post.id);
    } else if (stored === "lead_magnet") {
      plan.demote.push(post.id);
    } else {
      // Stored is null or a legacy value and the classifier agrees it is a
      // regular post. Nothing to correct: this backfill exists to catch posts
      // the widened patterns now recognise, not to normalise the column.
      plan.unchanged += 1;
    }
  }
  return plan;
}

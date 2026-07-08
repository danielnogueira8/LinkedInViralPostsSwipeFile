// Source health status derivation for the Content Sources page.
//
// A "source" is a creator SwipeIn watches. Its health tells the user whether
// the source is actually producing Swipe File material or needs a look. Status
// is DERIVED from existing signals — tracking membership, the denormalized
// per-creator post count, and the latest scrape run's per-handle progress.
// There is no new "status" column and no new pause feature: "Paused" simply
// means the source is currently untracked.

export type SourceStatus =
  | "active" // tracked and has saved posts
  | "fetching" // tracked; the latest scrape run shows this handle running
  | "no_posts" // tracked and checked, but no saved posts yet
  | "needs_attention" // the latest scrape run for this handle ended in error
  | "paused"; // not tracked

// The subset of a run's progress row we care about. Runs store progress as a
// JSONB array of these, keyed loosely by handle. `status` mirrors the pipeline:
// "scraping" | "scraped" | "skipped" | "error".
export type RunProgressEntry = {
  handle?: string | null;
  status?: string | null;
};

export type SourceStatusInput = {
  tracked: boolean;
  totalPostCount: number;
  // The latest run's progress entry for THIS creator's handle, if any. null when
  // the handle didn't appear in the most recent run (e.g. added after it ran).
  runEntry?: RunProgressEntry | null;
};

export function deriveSourceStatus({
  tracked,
  totalPostCount,
  runEntry,
}: SourceStatusInput): SourceStatus {
  // Untracked always reads as Paused, regardless of history — the source isn't
  // being watched right now, so nothing else about it is actionable.
  if (!tracked) return "paused";

  const runStatus = runEntry?.status ?? null;

  // An errored latest run is the one state that needs a human — surface it above
  // everything else so a broken handle doesn't hide behind a stale post count.
  if (runStatus === "error") return "needs_attention";

  // Mid-run: the latest scrape is actively pulling this handle.
  if (runStatus === "scraping") return "fetching";

  // Tracked with material → Active. Post count is the denormalized
  // accounts.total_post_count, refreshed each run.
  if (totalPostCount > 0) return "active";

  // Tracked, no posts. If the latest run touched this handle (scraped/skipped)
  // we've checked and found nothing yet. If the handle never appeared in a run,
  // it's freshly added and awaiting its first pull — still "no posts yet" from
  // the user's point of view, so we collapse both into one honest state.
  return "no_posts";
}

// Display metadata for each status: user-facing label + a StatusPill tone.
export const SOURCE_STATUS_META: Record<
  SourceStatus,
  { label: string; tone: "neutral" | "primary" | "success" | "warning" | "danger" }
> = {
  active: { label: "Active", tone: "success" },
  fetching: { label: "Fetching posts", tone: "primary" },
  no_posts: { label: "No posts found yet", tone: "neutral" },
  needs_attention: { label: "Needs attention", tone: "danger" },
  paused: { label: "Paused", tone: "neutral" },
};

// Index a run's progress array by handle for O(1) per-creator lookup. Handles
// are lowercased for a case-insensitive match against accounts.linkedin_handle.
// The LAST entry for a handle wins (a run lists each handle once, but be safe).
export function indexRunProgressByHandle(
  progress: RunProgressEntry[] | null | undefined,
): Map<string, RunProgressEntry> {
  const map = new Map<string, RunProgressEntry>();
  for (const entry of progress ?? []) {
    const h = entry?.handle;
    if (typeof h === "string" && h) map.set(h.toLowerCase(), entry);
  }
  return map;
}

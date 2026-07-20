import type { SupabaseClient } from "@supabase/supabase-js";

export const POST_PERFORMANCE_MIN_POSTS = 8;
export const POST_PERFORMANCE_MIN_BUCKET = 3;
export const POST_PERFORMANCE_BLOCK_CHARS_MAX = 1_500;

const POST_PERFORMANCE_FINDINGS_MAX = 4;
const LIFT_OUTPERFORM_MIN = 1.5;
const LIFT_UNDERPERFORM_MAX = 0.67;

export type PostPerformancePost = {
  body: string;
  hasMedia: boolean;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

type MeasuredPost = PostPerformancePost & { rate: number };

// A null reaction count means "not reported", which is indistinguishable from
// zero for this signal — the metric columns are daily snapshots, so an
// unreported reaction is safest read as no engagement rather than dropping the
// whole post (only impressions gate measurability).
function engagementCount(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function engagementRate(post: PostPerformancePost): number | null {
  const impressions = post.impressions;
  if (
    typeof impressions !== "number" ||
    !Number.isFinite(impressions) ||
    impressions <= 0
  ) {
    return null;
  }
  return (
    (engagementCount(post.likes) +
      engagementCount(post.comments) +
      engagementCount(post.shares)) /
    impressions
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function firstLine(body: string): string {
  return (body.split("\n")[0] ?? "").trim();
}

function listLineCount(body: string): number {
  return body
    .split("\n")
    .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).length;
}

function endsWithQuestion(body: string): boolean {
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1]?.trim() ?? "";
  return last.endsWith("?");
}

type PerformanceBucket = {
  label: string;
  matches: (post: MeasuredPost) => boolean;
};

// Every bucket is evaluated against the SAME overall median, so findings
// compare like-for-like even though buckets overlap (a post can be short AND
// have a short hook).
const PERFORMANCE_BUCKETS: PerformanceBucket[] = [
  {
    label: "Posts with a hook under 80 characters",
    matches: (post) => firstLine(post.body).length < 80,
  },
  {
    label: "Posts under 800 characters",
    matches: (post) => post.body.length < 800,
  },
  {
    label: "Posts between 800 and 1500 characters",
    matches: (post) => post.body.length >= 800 && post.body.length <= 1500,
  },
  {
    label: "Posts over 1500 characters",
    matches: (post) => post.body.length > 1500,
  },
  {
    label: "Posts with a 3+ item list",
    matches: (post) => listLineCount(post.body) >= 3,
  },
  {
    label: "Posts ending with a question CTA",
    matches: (post) => endsWithQuestion(post.body),
  },
  {
    label: "Posts with media attached",
    matches: (post) => post.hasMedia,
  },
];

function formatLift(lift: number): string {
  const rounded = Math.round(lift * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Deterministic "what works for YOUR posts" findings. Pure: given the latest
 * per-post metrics, emit at most four plain-language findings comparing each
 * body-derived bucket's median engagement rate to the workspace median. Small
 * samples and noisy middles are gated out instead of producing advice from
 * anecdote (min 8 measured posts overall, min 3 per bucket, |lift| beyond the
 * 1.5x / 0.67x band).
 */
export function computePostPerformanceLearnings(
  posts: PostPerformancePost[],
): string[] {
  const measured = posts
    .map((post) => ({ ...post, rate: engagementRate(post) }))
    .filter((post): post is MeasuredPost => post.rate !== null);
  if (measured.length < POST_PERFORMANCE_MIN_POSTS) return [];

  const overallMedian = median(measured.map((post) => post.rate));
  // A zero median makes every lift infinite or undefined; there is no honest
  // "2.8x your median" finding when the median post earned nothing.
  if (!(overallMedian > 0)) return [];

  const findings = PERFORMANCE_BUCKETS.flatMap((bucket) => {
    const bucketPosts = measured.filter(bucket.matches);
    if (bucketPosts.length < POST_PERFORMANCE_MIN_BUCKET) return [];
    const lift = median(bucketPosts.map((post) => post.rate)) / overallMedian;
    if (lift < LIFT_OUTPERFORM_MIN && lift > LIFT_UNDERPERFORM_MAX) return [];
    return [
      {
        text: `${bucket.label} earned ${lift < 1 ? "only " : ""}${formatLift(lift)}x your median engagement rate (${bucketPosts.length} posts)`,
        lift,
        count: bucketPosts.length,
      },
    ];
  });

  // Rank by effect size so the cap keeps the strongest signals, not whichever
  // bucket happened to be listed first.
  return findings
    .sort(
      (a, b) =>
        Math.abs(b.lift - 1) - Math.abs(a.lift - 1) ||
        b.count - a.count ||
        a.text.localeCompare(b.text),
    )
    .slice(0, POST_PERFORMANCE_FINDINGS_MAX)
    .map((finding) => finding.text);
}

/**
 * Soft-guidance block mirroring renderFeedbackMemoryBlock: findings advise,
 * they never outrank the current brief. Char-capped so the writer prompt stays
 * bounded regardless of how many buckets qualified.
 */
export function renderPostPerformanceBlock(learnings: string[]): string {
  if (learnings.length === 0) return "";

  const lines = [
    "Your own published posts' measured engagement (last 45 days) suggests:",
    "Treat this as soft guidance, below the user's current request and below hard writing preferences. Use it to adjust hooks, length, structure, CTAs, and media choices.",
    "",
  ];
  let chars = lines.join("\n").length;
  const bullets: string[] = [];
  for (const learning of learnings) {
    const line = `- ${learning}`;
    if (chars + line.length + 1 > POST_PERFORMANCE_BLOCK_CHARS_MAX) break;
    bullets.push(line);
    chars += line.length + 1;
  }
  if (bullets.length === 0) return "";
  return [...lines, ...bullets].join("\n").trim();
}

/**
 * Load the workspace's latest per-post analytics and render the learning
 * block. Fail-open like the feedback-memory read: any DB error, empty table,
 * or thin sample yields "" so the writer prompt is byte-identical to today.
 * The two queries mirror the analytics dashboard — snapshots date-ascending,
 * latest row per artifact wins, then one chat_artifacts join for body/media.
 */
export async function loadPostPerformanceBlock(
  sbRaw: SupabaseClient,
  workspaceId: string,
): Promise<string> {
  try {
    const { data: snapshots, error: snapshotsError } = await sbRaw
      .from("post_analytics")
      .select("artifact_id, snapshot_date, impressions, likes, comments, shares")
      .eq("workspace_id", workspaceId)
      .order("snapshot_date", { ascending: true })
      .limit(5_000);
    if (snapshotsError) return "";

    const latestByArtifact = new Map<
      string,
      NonNullable<typeof snapshots>[number]
    >();
    for (const snapshot of snapshots ?? []) {
      latestByArtifact.set(snapshot.artifact_id as string, snapshot);
    }
    const artifactIds = [...latestByArtifact.keys()];
    if (artifactIds.length === 0) return "";

    const { data: artifacts, error: artifactsError } = await sbRaw
      .from("chat_artifacts")
      .select("id, body, media_attachments")
      .eq("workspace_id", workspaceId)
      .in("id", artifactIds);
    if (artifactsError) return "";

    const posts = (artifacts ?? [])
      .map((artifact): PostPerformancePost | null => {
        const metrics = latestByArtifact.get(artifact.id as string);
        if (!metrics) return null;
        const media = artifact.media_attachments;
        return {
          body: typeof artifact.body === "string" ? artifact.body : "",
          hasMedia: Array.isArray(media) && media.length > 0,
          impressions: (metrics.impressions as number | null) ?? null,
          likes: (metrics.likes as number | null) ?? null,
          comments: (metrics.comments as number | null) ?? null,
          shares: (metrics.shares as number | null) ?? null,
        };
      })
      .filter((post): post is PostPerformancePost => post !== null);

    return renderPostPerformanceBlock(computePostPerformanceLearnings(posts));
  } catch {
    return "";
  }
}

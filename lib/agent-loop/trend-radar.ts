import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllRows, selectInChunks } from "@/lib/db-paginate";
import { EMBEDDING_MODEL } from "@/lib/openrouter";
import {
  classifyTopicTrend,
  clusterVectors,
  cosineSimilarity,
  normalizeEmbedding,
  topicClusterLabel,
  type TopicClusterVector,
  type TopicTrendState,
} from "@/lib/agent-loop/topic-clusters";

// Trend Radar is the local creator-conversation lane. It reads embeddings
// already produced by the scrape pipeline, so it does not introduce a paid
// model call or depend on the web search used by Newsjacking.
export const TREND_WINDOW_DAYS = 7;
export const TREND_BASELINE_DAYS = 14;
export const TREND_SIMILARITY_THRESHOLD = 0.72;
export const TREND_MIN_CREATORS = 2;
export const TREND_MIN_POSTS = 3;
const TREND_EXPIRE_AFTER_DAYS = 14;
const TREND_COOLDOWN_DAYS = 14;
const MAX_TREND_POSTS = 1500;
const MAX_TREND_OPPORTUNITIES_PER_RUN = 3;

export type TrendOpportunityPayload = {
  signal_type?: "trend_radar";
  headline?: string;
  summary?: string;
  source_name?: string;
  published_at?: string;
  signal_state?: "new" | "rising";
  trend_state?: TopicTrendState;
  creator_coverage?: "observed";
  creator_count?: number;
  post_count?: number;
  prior_creator_count?: number;
  terms?: string;
  why_now?: string;
  trend_key?: string;
  angle_prompt?: string;
  representative_posts?: Array<{
    post_id?: string;
    author?: string;
    text?: string;
    url?: string;
    posted_at?: string;
  }>;
};

export type TrendRadarPost = {
  id: string;
  account_id: string | null;
  text: string | null;
  post_url: string | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  posted_at: string | null;
  is_viral: boolean | null;
  accounts:
    | { name?: string | null }
    | Array<{ name?: string | null }>
    | null;
};

export type TrendRadarCluster = {
  members: number[];
  centroid: number[];
};

export type TrendRadarCandidate = {
  cluster: TrendRadarCluster;
  creators: number;
  posts: number;
  priorCreators: number;
  trend: Extract<TopicTrendState, "new" | "rising">;
  terms: string;
  score: number;
  trendKey: string;
  latestPostAt: string | null;
  representativePosts: TrendRadarPost[];
};

export type ScanTrendRadarResult = {
  scanned: number;
  eligible: number;
  embedded: number;
  clusters: number;
  inserted: number;
  expired: number;
  skipped: number;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function accountName(row: TrendRadarPost): string {
  const account = Array.isArray(row.accounts) ? row.accounts[0] : row.accounts;
  return account?.name?.trim() || "A tracked creator";
}

function parseVector(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "number")
      ? (value as number[])
      : null;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "number")
      ? (parsed as number[])
      : null;
  } catch {
    return null;
  }
}

function postScore(row: TrendRadarPost): number {
  return (
    Math.max(0, finiteNumber(row.reactions) ?? 0) +
    Math.max(0, finiteNumber(row.comments) ?? 0) * 3 +
    Math.max(0, finiteNumber(row.reposts) ?? 0) * 5
  );
}

function postTime(row: TrendRadarPost): number {
  const timestamp = row.posted_at ? Date.parse(row.posted_at) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function uniqueCreators(
  rows: readonly TrendRadarPost[],
  members: readonly number[],
): string[] {
  return [
    ...new Set(
      members
        .map((index) => rows[index]?.account_id ?? "")
        .filter(Boolean),
    ),
  ];
}

function stableTrendKey(terms: string, members: readonly number[]): string {
  const normalized = terms
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  if (normalized) return "cluster:" + normalized;
  return "cluster:members-" + [...members].sort((a, b) => a - b).join("-");
}

function candidateScore(
  creators: number,
  posts: number,
  priorCreators: number,
): number {
  const creatorDensity = Math.min(1, creators / 6);
  const postDensity = Math.min(1, posts / 8);
  const momentum =
    priorCreators === 0
      ? 1
      : Math.min(1, Math.max(0, (creators - priorCreators) / priorCreators));
  return Number(
    Math.min(
      1,
      creatorDensity * 0.45 + postDensity * 0.25 + momentum * 0.3,
    ).toFixed(4),
  );
}

/**
 * Turn a recent embedding corpus into quality-gated emerging conversations.
 * Density is counted per creator, while velocity compares the same centroid
 * with the prior window. This keeps one creator's repeated posts from looking
 * like a trend and excludes permanent flat topics from the feed.
 */
export function rankTrendClusters(
  recentPosts: readonly TrendRadarPost[],
  recentVectors: readonly (readonly number[])[],
  priorPosts: readonly TrendRadarPost[],
  priorVectors: readonly (readonly number[])[],
  similarity = TREND_SIMILARITY_THRESHOLD,
): TrendRadarCandidate[] {
  const clusters = clusterVectors(
    recentVectors,
    similarity,
  ) as TopicClusterVector[];
  const candidates: TrendRadarCandidate[] = [];
  for (const cluster of clusters) {
    const creators = uniqueCreators(recentPosts, cluster.members);
    if (cluster.members.length < TREND_MIN_POSTS) continue;
    if (creators.length < TREND_MIN_CREATORS) continue;

    const priorCreators = new Set<string>();
    for (let index = 0; index < priorVectors.length; index += 1) {
      if (cosineSimilarity(priorVectors[index], cluster.centroid) < similarity) {
        continue;
      }
      const creator = priorPosts[index]?.account_id;
      if (creator) priorCreators.add(creator);
    }
    const trend = classifyTopicTrend(creators.length, priorCreators.size);
    if (trend !== "new" && trend !== "rising") continue;

    const terms = topicClusterLabel(cluster.members, recentPosts);
    const members = [...cluster.members].sort(
      (left, right) =>
        postScore(recentPosts[right]) - postScore(recentPosts[left]) ||
        postTime(recentPosts[right]) - postTime(recentPosts[left]) ||
        recentPosts[left].id.localeCompare(recentPosts[right].id),
    );
    const representativePosts = members
      .slice(0, 3)
      .map((index) => recentPosts[index])
      .filter((row): row is TrendRadarPost => Boolean(row));
    const latestPostAt =
      representativePosts
        .map((row) => row.posted_at)
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;

    candidates.push({
      cluster: {
        members: [...cluster.members],
        centroid: [...cluster.centroid],
      },
      creators: creators.length,
      posts: cluster.members.length,
      priorCreators: priorCreators.size,
      trend,
      terms,
      score: candidateScore(
        creators.length,
        cluster.members.length,
        priorCreators.size,
      ),
      trendKey: stableTrendKey(terms, cluster.members),
      latestPostAt,
      representativePosts,
    });
  }
  return candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.creators - left.creators ||
      left.trendKey.localeCompare(right.trendKey),
  );
}

export function trendOpportunityPayload(
  candidate: TrendRadarCandidate,
  topics: readonly string[] = [],
): TrendOpportunityPayload {
  const terms = candidate.terms || topics.find(Boolean) || "this conversation";
  const whyNow =
    candidate.trend === "new"
      ? candidate.creators +
        " distinct tracked creators are converging on " +
        terms +
        " for the first time in the comparison window."
      : candidate.creators +
        " distinct tracked creators are discussing " +
        terms +
        ", up from " +
        candidate.priorCreators +
        " in the comparison window.";
  return {
    signal_type: "trend_radar",
    headline: terms + ": an emerging creator conversation",
    summary:
      candidate.creators +
      " tracked creators posted " +
      candidate.posts +
      " times about " +
      terms +
      " in the last " +
      TREND_WINDOW_DAYS +
      " days.",
    source_name: "Creator cluster",
    ...(candidate.latestPostAt
      ? { published_at: candidate.latestPostAt }
      : {}),
    signal_state: candidate.trend,
    trend_state: candidate.trend,
    creator_coverage: "observed",
    creator_count: candidate.creators,
    post_count: candidate.posts,
    prior_creator_count: candidate.priorCreators,
    terms,
    why_now: whyNow,
    trend_key: candidate.trendKey,
    angle_prompt:
      "Several creators are converging on " +
      terms +
      ". Explain what this conversation changes for your audience, then add one observation or practical implication that is yours.",
    representative_posts: candidate.representativePosts.map((post) => ({
      post_id: post.id,
      author: accountName(post),
      text: (post.text ?? "").trim().slice(0, 1200),
      ...(post.post_url ? { url: post.post_url } : {}),
      ...(post.posted_at ? { posted_at: post.posted_at } : {}),
    })),
  };
}

export function trendEvidenceText(
  payload: TrendOpportunityPayload | null | undefined,
): string {
  const value = payload ?? {};
  const representatives = (value.representative_posts ?? [])
    .map(
      (post) =>
        "- " +
        (post.author ?? "Tracked creator") +
        (post.posted_at ? " (" + post.posted_at + ")" : "") +
        ": " +
        (post.text ?? ""),
    )
    .join("\n");
  return [
    "TREND RADAR EVIDENCE",
    "Conversation: " + (value.terms ?? value.headline ?? "Untitled conversation"),
    "What is happening: " + (value.summary ?? "No summary was supplied."),
    "Signal: " + (value.trend_state ?? value.signal_state ?? "unknown"),
    "Why now: " +
      (value.why_now ?? "No comparison-window explanation was supplied."),
    representatives ? "Representative posts:\n" + representatives : "",
  ]
    .filter(Boolean)
    .join("\n");
}

type WorkspaceContext = { accountIds: string[]; topics: string[] };

async function workspaceContext(
  db: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceContext> {
  const { data, error } = await db
    .from("workspace_accounts")
    .select("account_id, niche")
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return {
    accountIds: [
      ...new Set(
        (data ?? [])
          .map((row) =>
            typeof row.account_id === "string" ? row.account_id : "",
          )
          .filter(Boolean),
      ),
    ],
    topics: [
      ...new Set(
        (data ?? [])
          .map((row) => (typeof row.niche === "string" ? row.niche.trim() : ""))
          .filter(Boolean),
      ),
    ],
  };
}

async function workspacePosts(
  db: SupabaseClient,
  accountIds: readonly string[],
  fullStart: string,
): Promise<TrendRadarPost[]> {
  const rows = await selectInChunks<TrendRadarPost>(accountIds, (ids) =>
    selectAllRows<TrendRadarPost>(() =>
      db
        .from("posts")
        .select(
          "id, account_id, text, post_url, reactions, comments, reposts, posted_at, is_viral, accounts(name)",
        )
        .in("account_id", ids)
        .gte("posted_at", fullStart)
        .not("text", "is", null)
        .order("posted_at", { ascending: false })
        .limit(MAX_TREND_POSTS) as never,
    ).then((data) => ({ data, error: null as unknown })),
  );
  const byId = new Map<string, TrendRadarPost>();
  for (const row of rows) {
    if (row.id && !byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()]
    .sort((left, right) => postTime(right) - postTime(left))
    .slice(0, MAX_TREND_POSTS);
}

async function embeddingMap(
  db: SupabaseClient,
  postIds: readonly string[],
): Promise<Map<string, number[]>> {
  const rows = await selectInChunks<{ post_id: string; embedding: unknown }>(
    postIds,
    (ids) =>
      db
        .from("post_embeddings")
        .select("post_id, embedding")
        .eq("model", EMBEDDING_MODEL)
        .in("post_id", ids) as never,
  );
  const vectors = new Map<string, number[]>();
  for (const row of rows) {
    const vector = parseVector(row.embedding);
    if (!vector) continue;
    const normalized = normalizeEmbedding(vector);
    if (normalized.length > 0) vectors.set(row.post_id, normalized);
  }
  return vectors;
}

function isSubthreshold(
  row: TrendRadarPost,
  thresholds: { reactions: number; comments: number },
): boolean {
  return (
    row.is_viral !== true &&
    (row.reactions ?? 0) < thresholds.reactions &&
    (row.comments ?? 0) < thresholds.comments
  );
}

export async function scanTrendOpportunities(
  db: SupabaseClient,
  workspaceId: string,
  now = new Date(),
): Promise<ScanTrendRadarResult> {
  const expireCutoff = new Date(
    now.getTime() - TREND_EXPIRE_AFTER_DAYS * 86_400_000,
  ).toISOString();
  const { data: expiredRows, error: expireError } = await db
    .from("agent_opportunities")
    .update({ status: "expired", acted_at: now.toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("kind", "trend")
    .in("status", ["proposed", "drafting", "snoozed"])
    .lt("created_at", expireCutoff)
    .select("id");
  if (expireError) throw expireError;
  const expired = (expiredRows ?? []).length;

  const context = await workspaceContext(db, workspaceId);
  if (context.accountIds.length === 0) {
    return {
      scanned: 0,
      eligible: 0,
      embedded: 0,
      clusters: 0,
      inserted: 0,
      expired,
      skipped: 0,
    };
  }

  const windowStart = new Date(
    now.getTime() - TREND_WINDOW_DAYS * 86_400_000,
  );
  const fullStart = new Date(
    now.getTime() - (TREND_WINDOW_DAYS + TREND_BASELINE_DAYS) * 86_400_000,
  );
  const rows = await workspacePosts(
    db,
    context.accountIds,
    fullStart.toISOString(),
  );
  const thresholds = {
    reactions: Number(process.env.VIRAL_MIN_REACTIONS ?? 500),
    comments: Number(process.env.VIRAL_MIN_COMMENTS ?? 50),
  };
  const recent = rows.filter(
    (row) =>
      postTime(row) >= windowStart.getTime() && isSubthreshold(row, thresholds),
  );
  const prior = rows.filter(
    (row) =>
      postTime(row) < windowStart.getTime() && isSubthreshold(row, thresholds),
  );
  const vectors = await embeddingMap(
    db,
    [...recent, ...prior].map((row) => row.id),
  );
  const recentWithVec = recent.filter((row) => vectors.has(row.id));
  const priorWithVec = prior.filter((row) => vectors.has(row.id));
  const recentVectors = recentWithVec.map((row) => vectors.get(row.id)!);
  const priorVectors = priorWithVec.map((row) => vectors.get(row.id)!);
  if (recentWithVec.length < TREND_MIN_POSTS) {
    return {
      scanned: rows.length,
      eligible: recent.length,
      embedded: recentWithVec.length,
      clusters: 0,
      inserted: 0,
      expired,
      skipped: 1,
    };
  }

  const candidates = rankTrendClusters(
    recentWithVec,
    recentVectors,
    priorWithVec,
    priorVectors,
  );
  const cooldownCutoff = new Date(
    now.getTime() - TREND_COOLDOWN_DAYS * 86_400_000,
  ).toISOString();
  const { data: recentOpportunities, error: recentError } = await db
    .from("agent_opportunities")
    .select("trend_key, payload")
    .eq("workspace_id", workspaceId)
    .eq("kind", "trend")
    .gte("created_at", cooldownCutoff);
  if (recentError) throw recentError;
  const recentKeys = new Set(
    (recentOpportunities ?? [])
      .map((row) => {
        if (typeof row.trend_key === "string") return row.trend_key;
        const payload = row.payload as TrendOpportunityPayload | null;
        return typeof payload?.trend_key === "string" ? payload.trend_key : null;
      })
      .filter((key): key is string => Boolean(key)),
  );
  const freshCandidates = candidates
    .filter((candidate) => !recentKeys.has(candidate.trendKey))
    .slice(0, MAX_TREND_OPPORTUNITIES_PER_RUN);

  let inserted = 0;
  let skipped = 0;
  for (const candidate of freshCandidates) {
    const payload = trendOpportunityPayload(candidate, context.topics);
    const { error } = await db.from("agent_opportunities").insert({
      workspace_id: workspaceId,
      kind: "trend",
      trend_key: candidate.trendKey,
      source_post_id: null,
      status: "proposed",
      score: candidate.score,
      payload,
    });
    if (error) {
      if (!String(error.message).includes("duplicate key")) {
        console.warn("scanTrendOpportunities insert failed:", error.message);
      }
      skipped += 1;
      continue;
    }
    inserted += 1;
  }
  return {
    scanned: rows.length,
    eligible: recent.length,
    embedded: recentWithVec.length,
    clusters: candidates.length,
    inserted,
    expired,
    skipped,
  };
}

export {
  classifyTopicTrend,
  clusterVectors,
  cosineSimilarity,
  normalizeEmbedding,
  topicClusterLabel,
};

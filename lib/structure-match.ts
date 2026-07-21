import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText, EMBEDDING_MODEL } from "@/lib/openrouter";
import { toVectorLiteral } from "@/lib/post-embeddings";
import { computeStructureSkeleton } from "@/lib/post-structure-skeleton";
import { BUILTIN_TEMPLATES } from "@/lib/templates-builtin";
import {
  isStructureContentType,
  type StructureContentType,
} from "@/lib/templates";
import type { IdeaBrief } from "@/lib/agent/idea-brief";
import type { RecentDraft } from "@/lib/recent-drafts";

// ---------------------------------------------------------------------------
// Structure matcher (PLAN-agent-loop Phase A3).
//
// Deterministic ranking that picks the best template / swipe post / built-in
// to model a user idea after. All ranking is pure math on fetched candidates;
// the only LLM call is the idea-brief compiler (Phase A1) and optional query
// embedding.
// ---------------------------------------------------------------------------

export type StructureCandidateKind = "template" | "swipe_post" | "builtin";

export type StructureCandidate = {
  kind: StructureCandidateKind;
  id: string;
  text: string;
  /** Required for candidates that will be compared by cosine similarity; may be omitted when precomputedSimilarity is supplied. */
  embedding?: number[];
  /** Similarity already computed by the vector search (e.g. match_post_embeddings). Used in place of cosineSimilarity when present. */
  precomputedSimilarity?: number;
  structureType: StructureContentType;
  provenanceScore: number;
  /** ISO timestamp or null for evergreen templates. */
  postedAt: string | null;
  /** Human-readable name for narration. */
  title: string;
  /** Optional URL for the source chip. */
  url?: string | null;
};

export type StructureMatchResult = {
  candidate: StructureCandidate;
  /** Ranked candidate pool, for debugging / narration. */
  considered: StructureCandidate[];
};

export type RankStructureCandidatesInput = {
  brief: IdeaBrief | null;
  /** Embedding of the user's idea; computed here if omitted. */
  ideaEmbedding?: number[];
  candidates: StructureCandidate[];
  /** IDs to exclude (cross-chat cooldown). */
  cooldownIds?: ReadonlySet<string>;
  /** Recent drafts whose skeletons should down-rank similar candidates. */
  recentSkeletons?: StructureSkeletonSnapshot[];
  /** Optional per-structure-type multiplier from analytics (default 1). */
  performanceWeights?: Record<StructureContentType, number>;
};

export type StructureSkeletonSnapshot = {
  id: string;
  /** `layout` from computeStructureSkeleton, serialized as prose/list sequence. */
  layoutKinds: Array<"prose" | "list">;
  hasList: boolean;
  totalChars: number;
};

const TYPE_MATCH_BOOST = 1.25;
const PROVENANCE_WEIGHTS: Record<StructureCandidateKind, number> = {
  template: 1.2,
  builtin: 1.0,
  swipe_post: 1.0,
};
// Outlier-derived swipe posts (we can detect these by provenanceScore > 1).
const OUTLIER_SWIPE_BONUS = 1.15;
const FRESHNESS_HALF_LIFE_DAYS = 14;
const MAX_FRESHNESS_AGE_DAYS = 90;
const SKELETON_SIMILARITY_PENALTY = 0.7;
const MIN_SKELETON_SIMILARITY_TO_PENALIZE = 0.75;

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

function magnitude(v: number[]): number {
  return Math.sqrt(dotProduct(v, v));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const denom = magnitude(a) * magnitude(b);
  if (denom === 0) return 0;
  return Math.max(0, Math.min(1, dotProduct(a, b) / denom));
}

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

function freshnessMultiplier(postedAt: string | null): number {
  const ageDays = daysAgo(postedAt);
  if (ageDays === null) return 1; // evergreen templates
  if (ageDays > MAX_FRESHNESS_AGE_DAYS) return 0.5;
  return 0.5 + 0.5 * Math.exp(-ageDays / FRESHNESS_HALF_LIFE_DAYS);
}

function collapseLayoutKinds(kinds: Array<"prose" | "list">): Array<"prose" | "list"> {
  const out: Array<"prose" | "list"> = [];
  for (const kind of kinds) {
    if (out[out.length - 1] !== kind) out.push(kind);
  }
  return out;
}

function skeletonSimilarity(
  left: StructureSkeletonSnapshot,
  right: StructureSkeletonSnapshot,
): number {
  const a = collapseLayoutKinds(left.layoutKinds);
  const b = collapseLayoutKinds(right.layoutKinds);
  if (a.length === 0 || b.length === 0) return 0;
  let matches = 0;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] === b[i]) matches += 1;
  }
  const layoutScore = matches / maxLen;
  const listMatch = Number(left.hasList) === Number(right.hasList) ? 1 : 0;
  const lengthRatio =
    right.totalChars === 0
      ? 0
      : Math.min(left.totalChars, right.totalChars) / Math.max(left.totalChars, right.totalChars);
  return (layoutScore * 0.5 + listMatch * 0.3 + lengthRatio * 0.2);
}

function candidateSkeletonSnapshot(candidate: StructureCandidate): StructureSkeletonSnapshot {
  const skeleton = computeStructureSkeleton(candidate.text);
  return {
    id: candidate.id,
    layoutKinds: skeleton.layout.map((beat) => beat.kind),
    hasList: skeleton.hasList,
    totalChars: skeleton.totalChars,
  };
}

export function rankStructureCandidates(
  input: RankStructureCandidatesInput,
): StructureCandidate[] {
  const ideaEmbedding = input.ideaEmbedding;
  if (!ideaEmbedding) return [];

  const briefType = input.brief?.contentType ?? null;
  const cooldownIds = input.cooldownIds ?? new Set<string>();
  const recentSkeletons = input.recentSkeletons ?? [];
  const performanceWeights = input.performanceWeights ??
    ({} as Record<StructureContentType, number>);

  const scored = input.candidates
    .filter((candidate) => !cooldownIds.has(candidate.id))
    .map((candidate) => {
      let score =
        candidate.precomputedSimilarity ??
        (candidate.embedding ? cosineSimilarity(ideaEmbedding, candidate.embedding) : 0);

      if (briefType && candidate.structureType === briefType) {
        score *= TYPE_MATCH_BOOST;
      }

      let provenanceWeight = PROVENANCE_WEIGHTS[candidate.kind];
      if (candidate.kind === "swipe_post" && candidate.provenanceScore > 1) {
        provenanceWeight *= OUTLIER_SWIPE_BONUS;
      }
      score *= provenanceWeight;

      score *= freshnessMultiplier(candidate.postedAt);

      const perfWeight = performanceWeights[candidate.structureType];
      if (perfWeight && perfWeight > 0) {
        score *= perfWeight;
      }

      const candidateSkeleton = candidateSkeletonSnapshot(candidate);
      for (const recent of recentSkeletons) {
        const sim = skeletonSimilarity(candidateSkeleton, recent);
        if (sim >= MIN_SKELETON_SIMILARITY_TO_PENALIZE) {
          score *= SKELETON_SIMILARITY_PENALTY;
        }
      }

      return { candidate, score };
    });

  return scored
    .sort((a, b) => b.score - a.score)
    .map((item) => item.candidate);
}

// ---------------------------------------------------------------------------
// Candidate loaders
// ---------------------------------------------------------------------------

export async function loadTemplateCandidates(
  sb: SupabaseClient,
  workspaceId: string,
  queryEmbedding: number[],
  opts: { signal?: AbortSignal; matchCount?: number } = {},
): Promise<StructureCandidate[]> {
  const rpcQuery = sb.rpc("match_content_template_embeddings", {
    p_workspace_id: workspaceId,
    p_query_embedding: toVectorLiteral(queryEmbedding),
    p_match_count: opts.matchCount ?? 20,
  });
  const { data, error } = await (opts.signal ? rpcQuery.abortSignal(opts.signal) : rpcQuery);
  if (error) throw error;

  const rows = (data ?? []) as Array<{
    id: string;
    title: string;
    body: string;
    source: string;
    origin_post_id: string | null;
    structure_type: string;
    similarity: number;
  }>;

  return rows
    .map((row) => {
      const structureType = isStructureContentType(row.structure_type)
        ? row.structure_type
        : "story";
      return {
        kind: "template" as const,
        id: row.id,
        text: row.body,
        precomputedSimilarity: Math.max(0, Math.min(1, row.similarity)),
        structureType,
        provenanceScore: row.source === "auto" ? 1.15 : 1,
        postedAt: null,
        title: row.title,
      };
    })
    .filter((c) => c !== null) as StructureCandidate[];
}

export async function loadSwipeCandidates(
  sb: SupabaseClient,
  workspaceId: string,
  queryEmbedding: number[],
  opts: { signal?: AbortSignal; matchCount?: number } = {},
): Promise<StructureCandidate[]> {
  const rpcQuery = sb.rpc("match_post_embeddings", {
    query_embedding: toVectorLiteral(queryEmbedding),
    want_viral: true,
    post_type_filter: null,
    exclude_ids: [],
    match_count: opts.matchCount ?? 20,
  });
  const { data, error } = await (opts.signal ? rpcQuery.abortSignal(opts.signal) : rpcQuery);
  if (error) throw error;

  const rows = (data ?? []) as Array<{
    post_id: string;
    similarity: number;
  }>;
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.post_id);
  const { data: posts, error: postsError } = await sb
    .from("posts")
    .select("id, text, post_url, posted_at, reactions, comments, reposts, is_viral")
    .in("id", ids);
  if (postsError) throw postsError;

  const postsById = new Map(
    (posts ?? []).map((p) => [
      p.id as string,
      p as {
        id: string;
        text: string | null;
        post_url: string | null;
        posted_at: string | null;
        reactions: number | null;
        comments: number | null;
        reposts: number | null;
        is_viral: boolean | null;
      },
    ]),
  );

  return rows
    .map((row) => {
      const post = postsById.get(row.post_id);
      if (!post || typeof post.text !== "string" || !post.text.trim()) return null;
      const text = post.text.trim();
      return {
        kind: "swipe_post" as const,
        id: post.id,
        text,
        precomputedSimilarity: Math.max(0, Math.min(1, row.similarity)),
        structureType: inferSwipeStructureType(text),
        provenanceScore: post.is_viral ? 1.15 : 1,
        postedAt: post.posted_at,
        title: "LinkedIn post",
        url: post.post_url,
      };
    })
    .filter((c) => c !== null) as StructureCandidate[];
}

// Built-ins are embedded once per process and cached. They are few (≈20) and
// stable, so this keeps them in the pool without adding DB state.
let builtinEmbeddingCache: Map<string, number[]> | null = null;

async function ensureBuiltinEmbeddings(signal?: AbortSignal): Promise<Map<string, number[]>> {
  if (builtinEmbeddingCache) return builtinEmbeddingCache;
  const texts = BUILTIN_TEMPLATES.map((t) => t.body);
  const { embeddings } = await embedText(texts, {
    model: EMBEDDING_MODEL,
    signal,
  });
  const map = new Map<string, number[]>();
  for (let i = 0; i < BUILTIN_TEMPLATES.length; i += 1) {
    map.set(BUILTIN_TEMPLATES[i].id, embeddings[i]);
  }
  builtinEmbeddingCache = map;
  return map;
}

export async function loadBuiltinCandidates(
  signal?: AbortSignal,
): Promise<StructureCandidate[]> {
  const embeddings = await ensureBuiltinEmbeddings(signal);
  return BUILTIN_TEMPLATES.map((t) => ({
    kind: "builtin" as const,
    id: t.id,
    text: t.body,
    embedding: embeddings.get(t.id) ?? [],
    structureType: inferSwipeStructureType(t.body), // built-ins share the same heuristic
    provenanceScore: 1,
    postedAt: null,
    title: t.title,
  })).filter((c) => c.embedding.length > 0);
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

export function inferSwipeStructureType(text: string): StructureContentType {
  const lower = text.toLowerCase();
  const firstLine = lower.split("\n")[0] ?? "";

  if (/^\d|％|%|\b\d+x\b|\b\d+\s*(k|m|b)\b/.test(firstLine)) return "metric";
  if (firstLine.includes("everyone") || firstLine.includes("most people") || firstLine.includes("wrong")) {
    return "contrarian";
  }
  if (/\b(announc|launch|built|released|shipped|new)\b/.test(firstLine)) return "announcement";
  if (/\b(analyzed|teardown|breakdown|vs\.|versus|why .* fails)\b/.test(lower)) return "teardown";
  if (/^\s*(\d+[.)]\s+|[-*•]\s+)/m.test(text) && /\b(how to|steps|things i|lessons|ways to)\b/.test(lower)) {
    return "how_to";
  }
  return "story";
}

// ---------------------------------------------------------------------------
// High-level entry point
// ---------------------------------------------------------------------------

export type FindBestStructureMatchInput = {
  sb: SupabaseClient;
  workspaceId: string;
  userText: string;
  brief: IdeaBrief | null;
  recentDrafts?: RecentDraft[];
  cooldownIds?: ReadonlySet<string>;
  includeBuiltins?: boolean;
  signal?: AbortSignal;
};

export async function findBestStructureMatch(
  input: FindBestStructureMatchInput,
): Promise<StructureMatchResult | null> {
  const { embeddings } = await embedText([input.userText], {
    model: EMBEDDING_MODEL,
    signal: input.signal,
    workspaceId: input.workspaceId,
  });
  const ideaEmbedding = embeddings[0];

  const [templates, swipes, builtins] = await Promise.all([
    loadTemplateCandidates(input.sb, input.workspaceId, ideaEmbedding, {
      signal: input.signal,
      matchCount: 20,
    }),
    loadSwipeCandidates(input.sb, input.workspaceId, ideaEmbedding, {
      signal: input.signal,
      matchCount: 20,
    }),
    input.includeBuiltins !== false ? loadBuiltinCandidates(input.signal) : [],
  ]);

  const candidates = [...templates, ...swipes, ...builtins];
  if (candidates.length === 0) return null;

  const recentSkeletons = (input.recentDrafts ?? [])
    .slice(0, 10)
    .map((draft) => {
      const skeleton = computeStructureSkeleton(draft.body);
      return {
        id: draft.id,
        layoutKinds: skeleton.layout.map((beat) => beat.kind),
        hasList: skeleton.hasList,
        totalChars: skeleton.totalChars,
      };
    });

  const ranked = rankStructureCandidates({
    brief: input.brief,
    ideaEmbedding,
    candidates,
    cooldownIds: input.cooldownIds,
    recentSkeletons,
  });

  if (ranked.length === 0) return null;
  return { candidate: ranked[0], considered: ranked };
}

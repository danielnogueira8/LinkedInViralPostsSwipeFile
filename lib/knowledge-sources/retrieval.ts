import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import {
  EMBEDDING_MODEL,
  embedText,
} from "@/lib/openrouter";
import { toVectorLiteral } from "@/lib/post-embeddings";
import {
  markJobDone,
  type BackgroundJob,
} from "@/lib/background-jobs";

type Db = SupabaseClient;

type Chunk = {
  id: string;
  source_revision_id: string;
  ordinal?: number;
  content: string;
  content_hash?: string;
};

export type RetrievedKnowledgeChunk = {
  chunkId: string;
  sourceId: string;
  sourceRevisionId: string;
  sourceTitle: string;
  content: string;
  score: number;
};

export type RetrievedKnowledgeSource = {
  sourceId: string;
  sourceRevisionId: string;
  title: string;
};

export const KNOWLEDGE_RETRIEVAL_MAX_CHUNKS = 6;
export const KNOWLEDGE_RETRIEVAL_MAX_CHARS = 12_000;
const KNOWLEDGE_SOURCE_PAGE_SIZE = 200;
const KNOWLEDGE_RETRIEVAL_CACHE_TTL_MS = 5 * 60 * 1_000;
const KNOWLEDGE_RETRIEVAL_CACHE_MAX_ENTRIES = 200;

type KnowledgeRetrievalResult = {
  chunks: RetrievedKnowledgeChunk[];
  sources: RetrievedKnowledgeSource[];
  mode: "semantic" | "lexical";
};

type KnowledgeRetrievalCacheEntry = {
  expiresAt: number;
  value: KnowledgeRetrievalResult;
};

const retrievalCache = new Map<string, KnowledgeRetrievalCacheEntry>();

export function knowledgeRetrievalCacheKey(input: {
  workspaceId: string;
  query: string;
  sources: RetrievedKnowledgeSource[];
  embeddingModel?: string;
}): string {
  const sourceVersion = input.sources
    .map((source) => [
      source.sourceId,
      source.sourceRevisionId,
      source.title,
    ])
    .sort((left, right) => left[0]!.localeCompare(right[0]!));
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        query: input.query,
        model: input.embeddingModel ?? EMBEDDING_MODEL,
        sourceVersion,
      }),
    )
    .digest("hex");
}

function cachedRetrieval(key: string): KnowledgeRetrievalResult | null {
  const cached = retrievalCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    retrievalCache.delete(key);
    return null;
  }
  retrievalCache.delete(key);
  retrievalCache.set(key, cached);
  return cached.value;
}

function storeCachedRetrieval(
  key: string,
  value: KnowledgeRetrievalResult,
): KnowledgeRetrievalResult {
  retrievalCache.set(key, {
    expiresAt: Date.now() + KNOWLEDGE_RETRIEVAL_CACHE_TTL_MS,
    value,
  });
  while (retrievalCache.size > KNOWLEDGE_RETRIEVAL_CACHE_MAX_ENTRIES) {
    const oldest = retrievalCache.keys().next().value as string | undefined;
    if (!oldest) break;
    retrievalCache.delete(oldest);
  }
  return value;
}

async function listReadyKnowledgeSources(input: {
  workspaceId: string;
  db: Db;
  signal?: AbortSignal;
}): Promise<RetrievedKnowledgeSource[]> {
  const sources: RetrievedKnowledgeSource[] = [];
  for (let offset = 0; ; offset += KNOWLEDGE_SOURCE_PAGE_SIZE) {
    input.signal?.throwIfAborted();
    let sourceQuery = input.db
      .from("knowledge_sources")
      .select("id,title,current_revision_id")
      .eq("workspace_id", input.workspaceId)
      .eq("status", "ready")
      .order("id", { ascending: true });
    if (input.signal) sourceQuery = sourceQuery.abortSignal(input.signal);
    const { data, error } = await sourceQuery.range(
      offset,
      offset + KNOWLEDGE_SOURCE_PAGE_SIZE - 1,
    );
    if (error) throw error;
    const rows = data ?? [];
    for (const source of rows) {
      if (
        typeof source.id === "string" &&
        typeof source.title === "string" &&
        typeof source.current_revision_id === "string"
      ) {
        sources.push({
          sourceId: source.id,
          sourceRevisionId: source.current_revision_id,
          title: source.title,
        });
      }
    }
    if (rows.length < KNOWLEDGE_SOURCE_PAGE_SIZE) break;
  }
  return sources;
}

function boundedResults(
  rows: RetrievedKnowledgeChunk[],
  maxChunks = KNOWLEDGE_RETRIEVAL_MAX_CHUNKS,
  maxChars = KNOWLEDGE_RETRIEVAL_MAX_CHARS,
): RetrievedKnowledgeChunk[] {
  const results: RetrievedKnowledgeChunk[] = [];
  const perSource = new Map<string, number>();
  let chars = 0;
  for (const row of rows) {
    if ((perSource.get(row.sourceId) ?? 0) >= 3) continue;
    if (results.length >= Math.min(maxChunks, KNOWLEDGE_RETRIEVAL_MAX_CHUNKS)) {
      break;
    }
    if (chars + row.content.length > Math.min(maxChars, KNOWLEDGE_RETRIEVAL_MAX_CHARS)) {
      continue;
    }
    results.push(row);
    chars += row.content.length;
    perSource.set(row.sourceId, (perSource.get(row.sourceId) ?? 0) + 1);
  }
  return results;
}

type AbortableThenable<T> = PromiseLike<T> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>;
};

async function abortable<T>(
  operation: AbortableThenable<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (signal && typeof operation.abortSignal === "function") {
    return await operation.abortSignal(signal);
  }
  return await operation;
}

function mappedRows(
  rows: Array<Record<string, unknown>>,
  scoreField: "similarity" | "relevance",
  minimumScore: number,
): RetrievedKnowledgeChunk[] {
  return rows
    .map((row) => ({
      chunkId: String(row.chunk_id ?? ""),
      sourceId: String(row.source_id ?? ""),
      sourceRevisionId: String(row.source_revision_id ?? ""),
      sourceTitle: String(row.source_title ?? ""),
      content: String(row.content ?? ""),
      score:
        typeof row[scoreField] === "number"
          ? (row[scoreField] as number)
          : 0,
    }))
    .filter(
      (row) =>
        row.chunkId &&
        row.sourceId &&
        row.content &&
        (minimumScore === 0
          ? row.score > 0
          : row.score >= minimumScore),
    )
    .sort((left, right) => right.score - left.score);
}

function mergeSemanticAndLexical(
  semantic: RetrievedKnowledgeChunk[],
  lexical: RetrievedKnowledgeChunk[],
): RetrievedKnowledgeChunk[] {
  const merged: RetrievedKnowledgeChunk[] = [];
  const seen = new Set<string>();
  const count = Math.max(semantic.length, lexical.length);
  for (let index = 0; index < count; index += 1) {
    for (const row of [semantic[index], lexical[index]]) {
      if (!row || seen.has(row.chunkId)) continue;
      seen.add(row.chunkId);
      merged.push(row);
    }
  }
  return boundedResults(merged);
}

export async function retrieveKnowledgeSourceContext(input: {
  workspaceId: string;
  query: string;
  db: Db;
  signal?: AbortSignal;
}): Promise<KnowledgeRetrievalResult> {
  input.signal?.throwIfAborted();
  const query = input.query.trim().slice(0, 12_000);
  if (!query) {
    return { chunks: [], sources: [], mode: "lexical" };
  }
  const sources = await listReadyKnowledgeSources(input);
  if (sources.length === 0) {
    return { chunks: [], sources: [], mode: "lexical" };
  }
  const key = knowledgeRetrievalCacheKey({
    workspaceId: input.workspaceId,
    query,
    sources,
  });
  input.signal?.throwIfAborted();
  const cached = cachedRetrieval(key);
  if (cached) return cached;

  let semantic: RetrievedKnowledgeChunk[] = [];
  try {
    const embedded = await embedText([query], {
      model: EMBEDDING_MODEL,
      workspaceId: input.workspaceId,
      signal: input.signal,
    });
    const vector = embedded.embeddings[0];
    if (!vector) throw new Error("missing_knowledge_query_embedding");
    const { data, error } = await abortable(
      input.db.rpc("match_workspace_knowledge_chunks", {
        p_workspace_id: input.workspaceId,
        p_query_embedding: toVectorLiteral(vector),
        p_embedding_model: EMBEDDING_MODEL,
        p_limit: 24,
      }) as AbortableThenable<{
        data: unknown;
        error: { message: string } | null;
      }>,
      input.signal,
    );
    if (error) throw error;
    semantic = mappedRows(
      (data ?? []) as Array<Record<string, unknown>>,
      "similarity",
      0.15,
    );
  } catch (error) {
    if (input.signal?.aborted) throw error;
    console.warn("knowledge_semantic_retrieval_fallback", {
      workspaceId: input.workspaceId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  let lexical: RetrievedKnowledgeChunk[] = [];
  let lexicalFailed = false;
  try {
    const { data, error } = await abortable(
      input.db.rpc("match_workspace_knowledge_chunks_lexical", {
        p_workspace_id: input.workspaceId,
        p_query: query,
        p_limit: 24,
      }) as AbortableThenable<{
        data: unknown;
        error: { message: string } | null;
      }>,
      input.signal,
    );
    if (error) throw error;
    lexical = mappedRows(
      (data ?? []) as Array<Record<string, unknown>>,
      "relevance",
      0,
    );
  } catch (error) {
    if (input.signal?.aborted) throw error;
    lexicalFailed = true;
    console.warn("knowledge_lexical_retrieval_skipped", {
      workspaceId: input.workspaceId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  input.signal?.throwIfAborted();
  const value: KnowledgeRetrievalResult = {
    chunks: mergeSemanticAndLexical(semantic, lexical),
    sources,
    mode: semantic.length > 0 ? "semantic" : "lexical",
  };
  return lexicalFailed ? value : storeCachedRetrieval(key, value);
}

export async function runKnowledgeEmbeddingJob(
  job: BackgroundJob,
  db: Db,
): Promise<{ completed: number; failed: number; requeued: number; unsupported: number }> {
  const sourceId =
    typeof job.payload.sourceId === "string" ? job.payload.sourceId : null;
  const revisionId =
    typeof job.payload.revisionId === "string" ? job.payload.revisionId : null;
  if (!sourceId || !revisionId) throw new Error("invalid_knowledge_embedding_payload");
  const { data: source, error: sourceError } = await db
    .from("knowledge_sources")
    .select("id,current_revision_id,status,embedding_job_id")
    .eq("workspace_id", job.workspace_id)
    .eq("id", sourceId)
    .maybeSingle();
  if (sourceError) throw sourceError;
  if (
    !source ||
    source.status !== "ready" ||
    source.current_revision_id !== revisionId ||
    source.embedding_job_id !== job.id
  ) {
    throw new Error("stale_knowledge_embedding");
  }
  const { data, error } = await db
    .from("knowledge_chunks")
    .select("id,source_revision_id,content,content_hash,ordinal")
    .eq("workspace_id", job.workspace_id)
    .eq("source_revision_id", revisionId)
    .order("ordinal", { ascending: true })
    .limit(1_000);
  if (error) throw error;
  const chunks = (data ?? []) as Chunk[];
  let stored = 0;
  for (let offset = 0; offset < chunks.length; offset += 128) {
    const batch = chunks.slice(offset, offset + 128);
    const embedded = await embedText(
      batch.map((chunk) => chunk.content),
      { model: EMBEDDING_MODEL, workspaceId: job.workspace_id },
    );
    for (let index = 0; index < batch.length; index += 1) {
      const chunk = batch[index]!;
      const vector = embedded.embeddings[index];
      if (!vector || !chunk.content_hash) throw new Error("invalid_knowledge_embedding");
      const { error: storeError } = await db.rpc(
        "store_knowledge_chunk_embedding",
        {
          p_workspace_id: job.workspace_id,
          p_revision_id: revisionId,
          p_chunk_id: chunk.id,
          p_embedding: toVectorLiteral(vector),
          p_model: EMBEDDING_MODEL,
          p_content_hash: chunk.content_hash,
        },
      );
      if (storeError) throw storeError;
      stored += 1;
    }
  }
  await markJobDone(job, { sourceId, revisionId, stored }, db);
  return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
}

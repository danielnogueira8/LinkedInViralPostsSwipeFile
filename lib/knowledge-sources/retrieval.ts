import type { SupabaseClient } from "@supabase/supabase-js";
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

export const KNOWLEDGE_RETRIEVAL_MAX_SOURCES = 20;
export const KNOWLEDGE_RETRIEVAL_MAX_CHUNKS = 6;
export const KNOWLEDGE_RETRIEVAL_MAX_CHARS = 12_000;

function uniqueSourceIds(sourceIds: string[]): string[] {
  return [
    ...new Set(
      sourceIds.filter((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          id,
        ),
      ),
    ),
  ].slice(0, KNOWLEDGE_RETRIEVAL_MAX_SOURCES);
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

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLocaleLowerCase("en-US")
        .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
    ),
  ].slice(0, 24);
}

export function lexicalKnowledgeScore(query: string, content: string): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const normalized = content.toLocaleLowerCase("en-US");
  const matches = terms.filter((term) => normalized.includes(term)).length;
  return matches / terms.length;
}

async function lexicalFallback(input: {
  workspaceId: string;
  sources: RetrievedKnowledgeSource[];
  query: string;
  db: Db;
}): Promise<RetrievedKnowledgeChunk[]> {
  const byRevision = new Map(
    input.sources.map((source) => [
      source.sourceRevisionId,
      { id: source.sourceId, title: source.title },
    ]),
  );
  if (byRevision.size === 0) return [];
  const { data: chunks, error: chunkError } = await input.db
    .from("knowledge_chunks")
    .select("id,source_revision_id,content")
    .eq("workspace_id", input.workspaceId)
    .in("source_revision_id", [...byRevision.keys()])
    .limit(200);
  if (chunkError) throw chunkError;
  const ranked = ((chunks ?? []) as Chunk[])
    .map((chunk) => {
      const source = byRevision.get(chunk.source_revision_id)!;
      return {
        chunkId: chunk.id,
        sourceId: source.id,
        sourceRevisionId: chunk.source_revision_id,
        sourceTitle: source.title,
        content: chunk.content,
        score: lexicalKnowledgeScore(input.query, chunk.content),
      };
    })
    .sort((left, right) => right.score - left.score);
  const relevant = ranked.filter((row) => row.score > 0);
  return boundedResults(relevant.length > 0 ? relevant : ranked);
}

export async function retrieveKnowledgeSourceContext(input: {
  workspaceId: string;
  sourceIds: string[];
  query: string;
  db: Db;
}): Promise<{
  chunks: RetrievedKnowledgeChunk[];
  sources: RetrievedKnowledgeSource[];
  mode: "semantic" | "lexical";
}> {
  const sourceIds = uniqueSourceIds(input.sourceIds);
  const query = input.query.trim().slice(0, 12_000);
  if (!query || sourceIds.length === 0) {
    return { chunks: [], sources: [], mode: "lexical" };
  }
  const { data: sourceRows, error: sourceError } = await input.db
    .from("knowledge_sources")
    .select("id,title,current_revision_id")
    .eq("workspace_id", input.workspaceId)
    .eq("status", "ready")
    .in("id", sourceIds)
    .limit(KNOWLEDGE_RETRIEVAL_MAX_SOURCES);
  if (sourceError) throw sourceError;
  const sources: RetrievedKnowledgeSource[] = (sourceRows ?? [])
    .filter(
      (source) =>
        typeof source.id === "string" &&
        typeof source.title === "string" &&
        typeof source.current_revision_id === "string",
    )
    .map((source) => ({
      sourceId: source.id as string,
      sourceRevisionId: source.current_revision_id as string,
      title: source.title as string,
    }));
  if (sources.length === 0) {
    return { chunks: [], sources: [], mode: "lexical" };
  }
  const resolvedSourceIds = sources.map((source) => source.sourceId);
  try {
    const embedded = await embedText([query], {
      model: EMBEDDING_MODEL,
      workspaceId: input.workspaceId,
    });
    const vector = embedded.embeddings[0];
    if (!vector) throw new Error("missing_knowledge_query_embedding");
    const { data, error } = await input.db.rpc("match_knowledge_chunks", {
      p_workspace_id: input.workspaceId,
      p_source_ids: resolvedSourceIds,
      p_query_embedding: toVectorLiteral(vector),
      p_limit: 24,
    });
    if (error) throw error;
    const semantic = boundedResults(
      ((data ?? []) as Array<Record<string, unknown>>)
        .map((row) => ({
          chunkId: String(row.chunk_id ?? ""),
          sourceId: String(row.source_id ?? ""),
          sourceRevisionId: String(row.source_revision_id ?? ""),
          sourceTitle: String(row.source_title ?? ""),
          content: String(row.content ?? ""),
          score:
            typeof row.similarity === "number" ? row.similarity : 0,
        }))
        .filter(
          (row) =>
            row.chunkId &&
            row.sourceId &&
            row.content &&
            row.score >= 0.15,
        ),
    );
    if (semantic.length > 0) {
      return { chunks: semantic, sources, mode: "semantic" };
    }
  } catch (error) {
    console.warn("knowledge_semantic_retrieval_fallback", {
      workspaceId: input.workspaceId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    chunks: await lexicalFallback({ ...input, sources, query }),
    sources,
    mode: "lexical",
  };
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
          p_model: embedded.model,
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

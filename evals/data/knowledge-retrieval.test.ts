import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFakeSupabase } from "@/evals/data/fake-supabase";

const embedding = vi.hoisted(() => ({
  calls: [] as string[][],
}));

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...original,
    EMBEDDING_MODEL: "test-embedding-model",
    embedText: async (texts: string[]) => {
      embedding.calls.push(texts);
      return {
        model: "test-embedding-model",
        embeddings: texts.map(() => [0.1, 0.2, 0.3]),
      };
    },
  };
});

import {
  knowledgeRetrievalCacheKey,
  retrieveKnowledgeSourceContext,
} from "@/lib/knowledge-sources/retrieval";

const source = (index: number, revision = index) => ({
  id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
  title: `Source ${index}`,
  current_revision_id: `${String(revision).padStart(8, "0")}-2222-4222-8222-222222222222`,
});

describe("automatic Workspace Knowledge retrieval", () => {
  beforeEach(() => {
    embedding.calls.length = 0;
  });

  test("searches every ready current source without client-selected ids", async () => {
    const sources = Array.from({ length: 21 }, (_, index) => source(index + 1));
    const db = makeFakeSupabase(
      { knowledge_sources: { rows: sources } },
      {
        match_workspace_knowledge_chunks: {
          data: [
            {
              chunk_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              source_id: sources[20]!.id,
              source_revision_id: sources[20]!.current_revision_id,
              source_title: sources[20]!.title,
              content: "Customers need a weekly reporting workflow.",
              similarity: 0.91,
            },
          ],
        },
      },
    );

    const retrieved = await retrieveKnowledgeSourceContext({
      workspaceId: "workspace-auto-all",
      query: "Write about weekly reporting",
      db: db.client as never,
    });

    expect(retrieved.sources).toHaveLength(21);
    expect(retrieved.chunks[0]?.sourceId).toBe(sources[20]!.id);
    expect(embedding.calls).toHaveLength(1);
    expect(db.rpcs).toHaveLength(2);
    expect(db.rpcs.map((rpc) => rpc.name)).toEqual([
      "match_workspace_knowledge_chunks",
      "match_workspace_knowledge_chunks_lexical",
    ]);
    expect(db.rpcs[0]?.args?.p_embedding_model).toBe(
      "test-embedding-model",
    );
    expect(
      db.queries
        .filter((query) => query.table === "knowledge_sources")
        .flatMap((query) => query.filters)
        .some((filter) => filter.method === "in" && filter.args[0] === "id"),
    ).toBe(false);
  });

  test("reuses a query only while the ready source revision set is unchanged", async () => {
    const firstDb = makeFakeSupabase(
      { knowledge_sources: { rows: [source(31)] } },
      {
        match_workspace_knowledge_chunks: { data: [] },
        match_workspace_knowledge_chunks_lexical: { data: [] },
      },
    );
    const input = {
      workspaceId: "workspace-cache-versioned",
      query: "Write about onboarding",
    };

    await retrieveKnowledgeSourceContext({
      ...input,
      db: firstDb.client as never,
    });
    await retrieveKnowledgeSourceContext({
      ...input,
      db: firstDb.client as never,
    });

    expect(embedding.calls).toHaveLength(1);
    expect(firstDb.rpcs).toHaveLength(2);

    const revisedDb = makeFakeSupabase(
      { knowledge_sources: { rows: [source(31, 32)] } },
      {
        match_workspace_knowledge_chunks: { data: [] },
        match_workspace_knowledge_chunks_lexical: { data: [] },
      },
    );
    await retrieveKnowledgeSourceContext({
      ...input,
      db: revisedDb.client as never,
    });

    expect(embedding.calls).toHaveLength(2);
    expect(revisedDb.rpcs).toHaveLength(2);
  });

  test("versions cache keys by the exact query and embedding model", () => {
    const sources = [
      {
        sourceId: source(35).id,
        sourceRevisionId: source(35).current_revision_id,
        title: source(35).title,
      },
    ];
    const key = (query: string, embeddingModel: string) =>
      knowledgeRetrievalCacheKey({
        workspaceId: "workspace-cache-key",
        query,
        sources,
        embeddingModel,
      });

    expect(key("Write about Onboarding", "embedding-v1")).not.toBe(
      key("write about onboarding", "embedding-v1"),
    );
    expect(key("Write about Onboarding", "embedding-v1")).not.toBe(
      key("Write about Onboarding", "embedding-v2"),
    );
  });

  test("blends relevant lexical evidence from a source whose embeddings are not ready", async () => {
    const sources = [source(41), source(42)];
    const db = makeFakeSupabase(
      { knowledge_sources: { rows: sources } },
      {
        match_workspace_knowledge_chunks: {
          data: [
            {
              chunk_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              source_id: sources[0]!.id,
              source_revision_id: sources[0]!.current_revision_id,
              source_title: sources[0]!.title,
              content: "Semantic evidence about onboarding.",
              similarity: 0.8,
            },
          ],
        },
        match_workspace_knowledge_chunks_lexical: {
          data: [
            {
              chunk_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              source_id: sources[1]!.id,
              source_revision_id: sources[1]!.current_revision_id,
              source_title: sources[1]!.title,
              content: "Weekly onboarding checklist evidence.",
              relevance: 0.5,
            },
            {
              chunk_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              source_id: sources[1]!.id,
              source_revision_id: sources[1]!.current_revision_id,
              source_title: sources[1]!.title,
              content: "Unrelated fallback row.",
              relevance: 0,
            },
          ],
        },
      },
    );

    const retrieved = await retrieveKnowledgeSourceContext({
      workspaceId: "workspace-hybrid",
      query: "Write about weekly onboarding",
      db: db.client as never,
    });

    expect(retrieved.chunks.map((chunk) => chunk.chunkId)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    expect(retrieved.chunks).not.toContainEqual(
      expect.objectContaining({
        chunkId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }),
    );
  });

  test("does no database or provider work after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const db = makeFakeSupabase({
      knowledge_sources: { rows: [source(51)] },
    });

    await expect(
      retrieveKnowledgeSourceContext({
        workspaceId: "workspace-cancelled",
        query: "Write about onboarding",
        db: db.client as never,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(db.queries).toHaveLength(0);
    expect(db.rpcs).toHaveLength(0);
    expect(embedding.calls).toHaveLength(0);
  });
});

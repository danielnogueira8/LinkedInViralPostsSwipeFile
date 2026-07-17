import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  embedText,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
} from "@/lib/openrouter";
import {
  toVectorLiteral,
  embeddingContentHash,
} from "@/lib/post-embeddings";

// A full-width vector of a constant value, for building fake embedding responses.
function vec(fill: number): number[] {
  return Array.from({ length: EMBEDDING_DIM }, () => fill);
}

function embeddingResponse(vectors: number[][], promptTokens = 42): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ embedding, index })),
      usage: { prompt_tokens: promptTokens },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("post-embeddings pure helpers", () => {
  test("toVectorLiteral formats a pgvector literal", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
    expect(toVectorLiteral([])).toBe("[]");
  });

  test("embeddingContentHash is stable and keyed by BOTH text and model", () => {
    const a = embeddingContentHash("hello", "model-x");
    expect(a).toBe(embeddingContentHash("hello", "model-x")); // stable
    expect(a).not.toBe(embeddingContentHash("hello", "model-y")); // model matters
    expect(a).not.toBe(embeddingContentHash("world", "model-x")); // text matters
  });
});

describe("embedText: OpenRouter embeddings client", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  });

  test("empty input short-circuits with no network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await embedText([]);
    expect(res.embeddings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a stalled /embeddings call is aborted by the timeout, not left to hang", async () => {
    // fetch that never resolves on its own but rejects when its signal aborts —
    // the real fetch abort contract. With a tiny timeoutMs, embedText must reject
    // (the deadline fires) rather than hang forever.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    await expect(embedText(["a"], { timeoutMs: 20 })).rejects.toThrow();
  });

  test("returns one full-width vector per input, in input order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => embeddingResponse([vec(0.1), vec(0.2)])),
    );
    const res = await embedText(["a", "b"]);
    expect(res.embeddings).toHaveLength(2);
    expect(res.embeddings[0][0]).toBe(0.1);
    expect(res.embeddings[1][0]).toBe(0.2);
    expect(res.model).toBe(EMBEDDING_MODEL);
    expect(res.promptTokens).toBe(42);
  });

  test("uses the provider-served model when the response echoes one, else falls back to the requested alias", async () => {
    // OpenRouter doesn't consistently document echoing a served-model field on
    // /embeddings — this proves both branches: when it IS present, embedText
    // reports it (and cost logging would attribute to it); when absent, the
    // requested model is used exactly as before this field was added.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = JSON.stringify({
          data: [{ embedding: vec(0.1), index: 0 }],
          usage: { prompt_tokens: 3 },
          model: "openai/text-embedding-3-small-served-variant",
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    const served = await embedText(["a"]);
    expect(served.model).toBe("openai/text-embedding-3-small-served-variant");

    vi.stubGlobal("fetch", vi.fn(async () => embeddingResponse([vec(0.1)])));
    const fallback = await embedText(["a"]);
    expect(fallback.model).toBe(EMBEDDING_MODEL);
  });

  test("reorders vectors by the provider's index field (never trusts array order)", async () => {
    // Provider returns them out of order; embedText must sort by `index`.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { embedding: vec(0.9), index: 1 },
                { embedding: vec(0.1), index: 0 },
              ],
              usage: { prompt_tokens: 3 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const res = await embedText(["first", "second"]);
    expect(res.embeddings[0][0]).toBe(0.1); // index 0
    expect(res.embeddings[1][0]).toBe(0.9); // index 1
  });

  test("throws on a duplicated/gapped index rather than silently mis-assigning a vector", async () => {
    // Correct COUNT (2 rows for 2 inputs) but index 0 twice and 1 missing —
    // a position-based zip would store the wrong vector for input 1; we reject.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { embedding: vec(0.1), index: 0 },
                { embedding: vec(0.2), index: 0 },
              ],
              usage: { prompt_tokens: 3 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    await expect(embedText(["a", "b"])).rejects.toThrow(/duplicate index|missing vector/);
  });

  test("throws when the provider returns the wrong number of vectors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => embeddingResponse([vec(0.1)])));
    await expect(embedText(["a", "b"])).rejects.toThrow(/1 vectors for 2 inputs/);
  });

  test("throws on a wrong-width vector (never persists a truncated embedding)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
              usage: { prompt_tokens: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    await expect(embedText(["a"])).rejects.toThrow(/width 3, expected 1536/);
  });

  test("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 400 })),
    );
    await expect(embedText(["a"])).rejects.toThrow(/OpenRouter embeddings 400/);
  });

  test("sends the configured model and the input array to the embeddings endpoint", async () => {
    const fetchMock = vi.fn(async () => embeddingResponse([vec(0.5)]));
    vi.stubGlobal("fetch", fetchMock);
    await embedText(["only"]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toMatch(/\/embeddings$/);
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe(EMBEDDING_MODEL);
    expect(body.input).toEqual(["only"]);
  });
});

describe("migration 088 SQL contract", () => {
  const sql = readFileSync(
    join(process.cwd(), "db", "migration-088-post-embeddings.sql"),
    "utf8",
  );

  test("enables pgvector and stores a 1536-wide vector keyed by post", () => {
    expect(sql).toMatch(/create extension if not exists vector/i);
    expect(sql).toMatch(/embedding\s+vector\(1536\)/i);
    expect(sql).toMatch(/post_id uuid primary key references posts\(id\) on delete cascade/i);
  });

  test("creates a cosine ivfflat index for ANN retrieval", () => {
    expect(sql).toMatch(/using ivfflat \(embedding vector_cosine_ops\)/i);
  });

  test("exposes the match_post_embeddings retrieval RPC filtering on virality", () => {
    expect(sql).toMatch(/create or replace function match_post_embeddings/i);
    expect(sql).toMatch(/p\.is_viral = want_viral/i);
    expect(sql).toMatch(/<=>/); // cosine distance operator
  });

  test("enables RLS mirroring the posts visibility model", () => {
    expect(sql).toMatch(/alter table post_embeddings enable row level security/i);
    expect(sql).toMatch(/post_embeddings_read_via_post/i);
    expect(sql).toMatch(/auth_workspace_id\(\)/i);
  });

  test("advances the deployment-readiness schema version to 88", () => {
    expect(sql).toMatch(/app_schema_version[\s\S]*values \(true, 88,/i);
  });
});

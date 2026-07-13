import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase, type FakeDb } from "./fake-supabase";
import { EMBEDDING_MODEL } from "@/lib/openrouter";

// Daily-pipeline embedding pass (db/migration-088, wired into runDailyPipeline).
// We test the scoped selector postsNeedingEmbeddingForAccounts directly: given
// the accounts just scraped, it must return exactly the posts that lack an
// up-to-date embedding — skipping ones already embedded at the same model+hash,
// re-including ones whose body changed, and dropping empty bodies.

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => dbRef.current.client }));

const { postsNeedingEmbeddingForAccounts, postsNeedingEmbedding, embeddingContentHash } =
  await import("@/lib/post-embeddings");

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
});

describe("postsNeedingEmbeddingForAccounts", () => {
  test("no accounts → no query, empty result", async () => {
    const out = await postsNeedingEmbeddingForAccounts([]);
    expect(out).toEqual([]);
    expect(dbRef.current.queries).toHaveLength(0);
  });

  test("returns only posts without an up-to-date embedding for the current model", async () => {
    const model = EMBEDDING_MODEL;
    dbRef.current = makeFakeSupabase({
      posts: {
        rows: [
          { id: "p-new", text: "A brand new viral post about onboarding." },
          { id: "p-embedded", text: "Already embedded, unchanged." },
          { id: "p-changed", text: "This body was edited since last embed." },
          { id: "p-empty", text: "   " }, // whitespace-only → skipped
          { id: "p-null", text: null }, // null → skipped
        ],
      },
      post_embeddings: {
        rows: [
          // up-to-date: model + hash both match the current body → skip
          {
            post_id: "p-embedded",
            content_hash: embeddingContentHash("Already embedded, unchanged.", model),
          },
          // stale: the stored hash is for an OLD body → re-embed
          {
            post_id: "p-changed",
            content_hash: embeddingContentHash("The OLD body.", model),
          },
        ],
      },
    });

    const out = await postsNeedingEmbeddingForAccounts(["acct-1"]);
    const ids = out.map((p) => p.id).sort();
    expect(ids).toEqual(["p-changed", "p-new"]);
    // never returns empty/null bodies
    expect(out.every((p) => p.text.trim().length > 0)).toBe(true);
  });

  test("scopes the posts read to the given accounts and filters the current model", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [] } });
    await postsNeedingEmbeddingForAccounts(["acct-1", "acct-2"]);

    const postsQuery = dbRef.current.queries.find((q) => q.table === "posts")!;
    const inFilter = postsQuery.filters.find((f) => f.method === "in")!;
    expect(inFilter.args[0]).toBe("account_id");
    expect(inFilter.args[1]).toEqual(["acct-1", "acct-2"]);
    // excludes null bodies at the query level
    expect(postsQuery.filters.some((f) => f.method === "not")).toBe(true);
  });

  test("all candidates already up-to-date → nothing to embed", async () => {
    const model = EMBEDDING_MODEL;
    dbRef.current = makeFakeSupabase({
      posts: { rows: [{ id: "p1", text: "Same body." }] },
      post_embeddings: {
        rows: [{ post_id: "p1", content_hash: embeddingContentHash("Same body.", model) }],
      },
    });
    const out = await postsNeedingEmbeddingForAccounts(["acct-1"]);
    expect(out).toEqual([]);
  });
});

describe("postsNeedingEmbedding pagination (the >1000 backfill-stall bug)", () => {
  test("reads the whole corpus past the PostgREST 1000-row cap", async () => {
    // 2500 unembedded posts. A non-paginated read would silently stop at 1000
    // and report the corpus 'done' — the exact bug that stalled the backfill.
    const posts = Array.from({ length: 2500 }, (_, i) => ({ id: `p${i}` }));
    dbRef.current = makeFakeSupabase({
      post_embeddings: { rows: [] }, // nothing embedded yet
      posts: { rows: posts },
    });

    // Ask for more than one page worth; must return all 2500, not 1000.
    const ids = await postsNeedingEmbedding(5000);
    expect(ids).toHaveLength(2500);
    expect(ids[0]).toBe("p0");
    expect(ids[2499]).toBe("p2499");
  });

  test("subtracts an already-embedded set that itself exceeds 1000 rows", async () => {
    const posts = Array.from({ length: 2000 }, (_, i) => ({ id: `p${i}` }));
    // First 1500 already embedded (spans two pages) → only the last 500 remain.
    const embedded = Array.from({ length: 1500 }, (_, i) => ({ post_id: `p${i}` }));
    dbRef.current = makeFakeSupabase({
      post_embeddings: { rows: embedded },
      posts: { rows: posts },
    });

    const ids = await postsNeedingEmbedding(5000);
    expect(ids).toHaveLength(500);
    expect(ids).toContain("p1999");
    expect(ids).not.toContain("p0");
  });
});

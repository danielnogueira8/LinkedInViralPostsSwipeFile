import { createHash } from "node:crypto";
import { supabaseAdmin } from "./supabase";
import { embedText, EMBEDDING_MODEL } from "./openrouter";
import type { PostType } from "./post-type";

// Store + retrieval seam for the viral-learning loop (db/migration-088). All
// callers are server-side (the daily pipeline embeds; the writer retrieves), so
// everything here uses the admin client and reads across the global posts
// corpus by design. Nothing here is exposed to a browser client.

// How many posts to embed per OpenRouter /embeddings call. text-embedding-3-small
// handles large batches; 128 keeps a single failure cheap to retry and the
// request body reasonable.
export const EMBED_BATCH_SIZE = 128;

// pgvector accepts a vector literal as the string "[f1,f2,...]". supabase-js
// sends it as a JSON string value, which Postgres casts to `vector` on the
// column. Keep this the single place that formats a vector for the wire.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// Stable content hash so the daily job can skip a post whose body is unchanged
// since it was last embedded (and re-embed when the body OR the model changes).
export function embeddingContentHash(text: string, model: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

export type PostToEmbed = { id: string; text: string | null };

// Embed a batch of posts and upsert them into post_embeddings. Posts with an
// empty body are skipped (nothing to embed). Returns how many were embedded.
// Idempotent at the row level via the primary-key upsert; the pipeline is
// responsible for only passing posts that actually need (re)embedding.
export async function embedAndStorePosts(
  posts: PostToEmbed[],
  opts: { model?: string; workspaceId?: string; signal?: AbortSignal } = {},
): Promise<number> {
  const model = opts.model || EMBEDDING_MODEL;
  const withText = posts.filter(
    (p): p is { id: string; text: string } =>
      typeof p.text === "string" && p.text.trim().length > 0,
  );
  if (withText.length === 0) return 0;

  const sb = supabaseAdmin();
  let embedded = 0;
  for (let i = 0; i < withText.length; i += EMBED_BATCH_SIZE) {
    const batch = withText.slice(i, i + EMBED_BATCH_SIZE);
    const { embeddings } = await embedText(
      batch.map((p) => p.text),
      { model, signal: opts.signal, workspaceId: opts.workspaceId },
    );
    const rows = batch.map((p, j) => ({
      post_id: p.id,
      embedding: toVectorLiteral(embeddings[j]),
      model,
      content_hash: embeddingContentHash(p.text, model),
      embedded_at: new Date().toISOString(),
    }));
    const { error } = await sb
      .from("post_embeddings")
      .upsert(rows, { onConflict: "post_id" });
    if (error) throw error;
    embedded += rows.length;
  }
  return embedded;
}

// Find post ids that still need an embedding for the current model: posts with
// a non-empty body that either have no embedding row or whose row was written
// for a different model. Returns ids only; the caller fetches bodies to embed.
// `limit` bounds a single backfill pass.
// PostgREST silently caps any select at 1000 rows regardless of `.limit()`, so
// every full-table scan here must paginate with `.range()` or it stops at 1000
// (the bug where the backfill reported "done" after exactly 1000 posts).
const PAGE = 1000;

export async function postsNeedingEmbedding(
  limit: number,
  model: string = EMBEDDING_MODEL,
): Promise<string[]> {
  const sb = supabaseAdmin();

  // The set already embedded at the current model. Paginated — a corpus larger
  // than 1000 would otherwise silently stop at the PostgREST row cap.
  const embeddedIds = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("post_embeddings")
      .select("post_id")
      .eq("model", model)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ post_id: string }>;
    for (const r of rows) embeddedIds.add(r.post_id);
    if (rows.length < PAGE) break;
  }

  // Candidate posts, also paginated, minus what's already embedded — until we
  // have `limit` ids to embed this pass.
  const need: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("posts")
      .select("id")
      .not("text", "is", null)
      .order("scraped_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string }>;
    for (const row of rows) {
      if (!embeddedIds.has(row.id)) need.push(row.id);
      if (need.length >= limit) return need;
    }
    if (rows.length < PAGE) break;
  }
  return need;
}

// The daily-pipeline variant of postsNeedingEmbedding: instead of scanning the
// whole corpus, find posts BELONGING TO the accounts just scraped that still
// need an embedding for the current model (no row, or a row from a different
// model). This keeps the daily embed pass proportional to what changed, not the
// full history. Returns { id, text } so the caller can embed without a second
// fetch. `content_hash` is compared so a re-scrape that changed a post's body
// re-embeds it, while an unchanged re-scrape is skipped.
export async function postsNeedingEmbeddingForAccounts(
  accountIds: string[],
  model: string = EMBEDDING_MODEL,
): Promise<Array<{ id: string; text: string }>> {
  if (accountIds.length === 0) return [];
  const sb = supabaseAdmin();

  // Paginated: a workspace tracking many high-volume accounts can have far more
  // than the PostgREST 1000-row cap, which would otherwise silently drop posts.
  const posts: Array<{ id: string; text: string | null }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: postsErr } = await sb
      .from("posts")
      .select("id, text")
      .in("account_id", accountIds)
      .not("text", "is", null)
      .range(from, from + PAGE - 1);
    if (postsErr) throw postsErr;
    const rows = (data ?? []) as Array<{ id: string; text: string | null }>;
    posts.push(...rows);
    if (rows.length < PAGE) break;
  }
  const candidates = posts.filter(
    (p): p is { id: string; text: string } =>
      typeof p.text === "string" && p.text.trim().length > 0,
  );
  if (candidates.length === 0) return [];

  // Which of these already have an up-to-date embedding (same model AND same
  // content hash)? Anything not in that set needs (re)embedding. Fetched in
  // chunks: a single `.in("post_id", [~thousands of uuids])` builds a query
  // string long enough for PostgREST to reject with 400 (URL too long).
  const ids = candidates.map((p) => p.id);
  const IN_CHUNK = 200;
  const upToDate = new Map<string, string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const slice = ids.slice(i, i + IN_CHUNK);
    const { data: existing, error: existErr } = await sb
      .from("post_embeddings")
      .select("post_id, content_hash")
      .eq("model", model)
      .in("post_id", slice);
    if (existErr) throw existErr;
    for (const r of existing ?? []) {
      upToDate.set(r.post_id as string, r.content_hash as string);
    }
  }

  return candidates.filter(
    (p) => upToDate.get(p.id) !== embeddingContentHash(p.text, model),
  );
}

export type ExemplarMatch = {
  postId: string;
  similarity: number;
};

// Retrieve the semantically-nearest posts to `queryText` from the corpus,
// filtered by virality (want_viral) and optional post type. `excludeIds` skips
// the source/topic post itself. Returns id + similarity; the caller joins back
// for bodies. Embeds the query with the SAME model the corpus was embedded with
// (mismatched models = meaningless distances), so pass the corpus model.
export async function retrieveExemplars(opts: {
  queryText: string;
  wantViral: boolean;
  postType?: PostType | null;
  excludeIds?: string[];
  matchCount?: number;
  model?: string;
  signal?: AbortSignal;
  workspaceId?: string;
}): Promise<ExemplarMatch[]> {
  const query = opts.queryText.trim();
  if (!query) return [];
  const model = opts.model || EMBEDDING_MODEL;
  const { embeddings } = await embedText([query], {
    model,
    signal: opts.signal,
    workspaceId: opts.workspaceId,
  });
  const queryEmbedding = embeddings[0];

  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc("match_post_embeddings", {
    query_embedding: toVectorLiteral(queryEmbedding),
    want_viral: opts.wantViral,
    post_type_filter: opts.postType ?? null,
    exclude_ids: opts.excludeIds ?? [],
    match_count: opts.matchCount ?? 5,
  });
  if (error) throw error;
  return ((data ?? []) as Array<{ post_id: string; similarity: number }>).map(
    (r) => ({ postId: r.post_id, similarity: r.similarity }),
  );
}

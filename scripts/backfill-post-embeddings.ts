// One-off / resumable: embed the historical `posts` corpus for the viral-
// learning retrieval loop (db/migration-088). Idempotent — re-running only
// embeds posts that don't yet have an embedding for the current model, so it's
// safe to run repeatedly (e.g. if it's interrupted, or after a model swap).
//
// Cost is tiny: text-embedding-3-small is $0.02 / 1M input tokens, and a
// LinkedIn post is a few hundred tokens, so the entire corpus is cents.
//
// Run: npx tsx --env-file=.env.local scripts/backfill-post-embeddings.ts
//   optional first arg = max posts to process this run (default: all)

import { supabaseAdmin } from "../lib/supabase";
import { EMBEDDING_MODEL } from "../lib/openrouter";
import {
  postsNeedingEmbedding,
  embedAndStorePosts,
  EMBED_BATCH_SIZE,
} from "../lib/post-embeddings";

async function main() {
  const model = EMBEDDING_MODEL;
  const cap = Number(process.argv[2]) || Number.POSITIVE_INFINITY;
  const sb = supabaseAdmin();

  console.log(`Backfilling post embeddings with ${model} (cap: ${cap === Infinity ? "all" : cap})...`);

  let totalEmbedded = 0;
  // Process in bounded passes: each pass finds the next chunk of posts still
  // needing an embedding, fetches their bodies, embeds + upserts. Loop until a
  // pass finds nothing (fully backfilled) or we hit the cap.
  for (;;) {
    const remaining = cap === Infinity ? 2000 : Math.min(2000, cap - totalEmbedded);
    if (remaining <= 0) break;

    const ids = await postsNeedingEmbedding(remaining, model);
    if (ids.length === 0) {
      console.log("No more posts need embedding.");
      break;
    }

    // Fetch bodies in chunks: a single `.in("id", [~2000 uuids])` builds a
    // multi-KB query string that PostgREST rejects with 400 (URL too long).
    const FETCH_CHUNK = 200;
    const posts: Array<{ id: string; text: string | null }> = [];
    for (let j = 0; j < ids.length; j += FETCH_CHUNK) {
      const slice = ids.slice(j, j + FETCH_CHUNK);
      const { data, error } = await sb
        .from("posts")
        .select("id, text")
        .in("id", slice);
      if (error) throw new Error(error.message);
      posts.push(...((data ?? []) as Array<{ id: string; text: string | null }>));
    }

    const embedded = await embedAndStorePosts(posts, { model });
    totalEmbedded += embedded;
    console.log(
      `  +${embedded} embedded (batch of ${ids.length}, ${EMBED_BATCH_SIZE}/call) — ${totalEmbedded} total`,
    );

    // A pass that resolves to zero embedded (all empty bodies) would loop
    // forever otherwise, since postsNeedingEmbedding keeps returning them.
    if (embedded === 0) {
      console.log("Remaining candidates have empty bodies; stopping.");
      break;
    }
  }

  console.log(`Done. Embedded ${totalEmbedded} posts.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

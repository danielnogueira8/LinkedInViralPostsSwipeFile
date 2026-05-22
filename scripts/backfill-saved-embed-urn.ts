// One-off: probe every saved_posts row's embed URL and update embed_urn to
// whichever URN type (share vs. activity) actually returns 200 from
// LinkedIn's embed endpoint.
//
// Why: we used to guess the URN type from URL shape (/posts/ → share,
// /feed/update/ → activity), but the embed endpoint accepts only one of
// the two per post, and which one is *not* derivable from the URL — it
// varies. Probing is the only reliable signal. New saves probe at write
// time; this script fixes existing rows that were saved before that.
//
// Skips rows where probing fails for both URN types — likely deleted or
// private posts. Their embed_urn is left as-is so the card still tries
// what we had.
//
// Run: npx tsx --env-file=.env.local scripts/backfill-saved-embed-urn.ts

import { supabaseAdmin } from "../lib/supabase";
import { probeEmbedUrn } from "../lib/linkedin-url";

async function main() {
  const sb = supabaseAdmin();

  const { data: rows, error } = await sb
    .from("saved_posts")
    .select("id, activity_id, embed_urn");
  if (error) throw new Error(error.message);

  const total = rows?.length ?? 0;
  console.log(`Probing ${total} saved posts...`);

  let fixed = 0;
  let skipped = 0;
  let alreadyCorrect = 0;
  let failed = 0;

  // Sequential rather than parallel — we're hitting LinkedIn, so being
  // polite avoids triggering rate limits and getting nothing back.
  for (let i = 0; i < total; i++) {
    const row = rows![i];
    const probed = await probeEmbedUrn(row.activity_id);
    if (!probed) {
      failed++;
      console.log(`  [${i + 1}/${total}] ${row.id}: both URNs 404'd (private/deleted?)`);
      continue;
    }
    if (probed === row.embed_urn) {
      alreadyCorrect++;
      continue;
    }
    const { error: upErr } = await sb
      .from("saved_posts")
      .update({ embed_urn: probed })
      .eq("id", row.id);
    if (upErr) {
      skipped++;
      console.log(`  [${i + 1}/${total}] ${row.id}: update failed — ${upErr.message}`);
      continue;
    }
    fixed++;
    console.log(`  [${i + 1}/${total}] ${row.id}: ${row.embed_urn ?? "<null>"} → ${probed}`);
  }

  console.log(
    `\nDone. fixed=${fixed} alreadyCorrect=${alreadyCorrect} failed=${failed} skipped=${skipped}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

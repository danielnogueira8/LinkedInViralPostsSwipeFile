// One-off / resumable: backfill embeddings + inferred structure_type for
// existing content_templates rows (migration 117). Safe to re-run: skips rows
// that already have an embedding and a valid structure_type.
//
// Run: PATH="$HOME/.nvm/versions/node/v22.21.0/bin:$PATH" npx tsx --env-file=.env.local scripts/backfill-template-embeddings.ts
//   --limit 200   process at most 200 rows this run (default: all)
//   --dry-run     print counts, perform no LLM calls or writes

import { supabaseAdmin } from "../lib/supabase";
import { backfillTemplateEmbeddings } from "../lib/template-embeddings";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(argValue("--limit")) || undefined;
  const sb = supabaseAdmin();

  console.log(
    `Backfilling template embeddings${dryRun ? " — DRY RUN" : ""}${limit ? ` — limit ${limit}` : ""}...`,
  );

  const { scanned, embedded, typed } = await backfillTemplateEmbeddings(sb, {
    limit,
    dryRun,
  });
  console.log(`Rows scanned: ${scanned}`);
  console.log(`Rows embedded: ${embedded}`);
  console.log(`Rows typed: ${typed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

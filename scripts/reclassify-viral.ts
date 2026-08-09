// Recompute posts.is_viral across the whole corpus using the CURRENT global
// rule, recovering posts a past global rule wrongly rejected.
//
// Why this exists: is_viral is stamped once at ingest and nothing recomputes
// it, so while VIRAL_REL_CUTOFF_PCT=30 was set in production every post outside
// its creator's top 30% was stamped false — permanently. Removing the variable
// only fixed classification going forward. This is the pass that gets the back
// catalogue back.
//
// DRY RUN BY DEFAULT. Nothing is written without --apply.
//
// Demotions (currently-viral posts that no longer qualify) are reported but NOT
// applied unless --include-demotions is passed: taking posts away from a feed
// is destructive in a way that giving them back is not, so it wants a separate,
// deliberate decision.
//
// Run:
//   npx tsx --env-file=.env.local scripts/reclassify-viral.ts
//   npx tsx --env-file=.env.local scripts/reclassify-viral.ts --limit 500
//   npx tsx --env-file=.env.local scripts/reclassify-viral.ts --apply
//   npx tsx --env-file=.env.local scripts/reclassify-viral.ts --apply --include-demotions

import { supabaseAdmin } from "../lib/supabase";
import { getRelativeConfig, getThresholds } from "../lib/viral";
import {
  assertFlatOnlyConfig,
  planReclassification,
  reclassifiedColumns,
  type ReclassifiablePost,
} from "../lib/viral-reclassify";

const READ_PAGE = 1000;
// A single `.in("id", [...])` builds the query string, so keep write chunks
// well under PostgREST's URL limit (same ceiling the other backfills use).
const WRITE_CHUNK = 200;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numericFlag(name: string): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return Number.POSITIVE_INFINITY;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

async function main() {
  const apply = flag("apply");
  const includeDemotions = flag("include-demotions");
  const cap = numericFlag("limit");
  const sb = supabaseAdmin();

  // The GLOBAL rule — no workspace context, exactly as the daily cron runs it.
  const thresholds = await getThresholds(null);
  const config = await getRelativeConfig(null);
  // Fail before reading a single row if the gate is on; the planner would be
  // answering a different question than the one it thinks it is.
  assertFlatOnlyConfig(config);

  console.log(apply ? "MODE: APPLY (writes)" : "MODE: dry run (no writes)");
  console.log(
    `Global rule: reactions >= ${thresholds.min_reactions} OR comments >= ${thresholds.min_comments}` +
      `; per-creator gate off (cutoffPct=${config.cutoffPct})`,
  );
  if (cap !== Number.POSITIVE_INFINITY) console.log(`Scanning at most ${cap} posts.`);
  console.log("");

  const recover: string[] = [];
  const demote: string[] = [];
  let unchanged = 0;
  let stale = 0;
  let scanned = 0;

  for (let from = 0; scanned < cap; from += READ_PAGE) {
    const remaining = cap === Number.POSITIVE_INFINITY ? READ_PAGE : Math.min(READ_PAGE, cap - scanned);
    const { data, error } = await sb
      .from("posts")
      .select("id, reactions, comments, reposts, viral_score, is_viral")
      .order("id", { ascending: true })
      .range(from, from + remaining - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ReclassifiablePost[];
    if (rows.length === 0) break;

    const plan = planReclassification(rows, thresholds, config);
    recover.push(...plan.recover);
    demote.push(...plan.demote);
    unchanged += plan.unchanged;
    stale += plan.staleScores.length;
    scanned += rows.length;

    if (rows.length < remaining) break;
  }

  console.log(`Scanned:            ${scanned}`);
  console.log(`Already correct:    ${unchanged}`);
  console.log(`To RECOVER (→true): ${recover.length}`);
  console.log(`To DEMOTE (→false): ${demote.length}${includeDemotions ? "" : "   [skipped — pass --include-demotions]"}`);
  if (stale > 0) {
    console.log("");
    console.log(
      `NOTE: ${stale} posts have a stored viral_score that disagrees with score() over their ` +
        "own engagement columns. Not touched here — viral_score drives sort order and the " +
        "relative baseline, so that is a separate fix.",
    );
  }

  if (!apply) {
    console.log("");
    console.log("Dry run — nothing written. Re-run with --apply to commit.");
    return;
  }

  const writes: Array<{ ids: string[]; isViral: boolean }> = [
    { ids: recover, isViral: true },
  ];
  if (includeDemotions) writes.push({ ids: demote, isViral: false });

  for (const { ids, isViral } of writes) {
    let written = 0;
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      const chunk = ids.slice(i, i + WRITE_CHUNK);
      const { error } = await sb
        .from("posts")
        .update(reclassifiedColumns(isViral))
        .in("id", chunk);
      if (error) throw new Error(error.message);
      written += chunk.length;
      console.log(`  is_viral=${isViral}: ${written}/${ids.length}`);
    }
  }

  console.log("");
  console.log(
    `Done. ${recover.length} recovered` +
      (includeDemotions ? `, ${demote.length} demoted.` : `, ${demote.length} demotions skipped.`),
  );
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

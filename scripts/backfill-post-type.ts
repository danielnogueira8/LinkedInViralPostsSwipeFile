// Re-run the lead-magnet classifier over posts already stored, so the widened
// giveaway-first patterns apply to the back catalogue and not just to new
// scrapes.
//
// Why it matters: post_type decides which discovery threshold a post is judged
// by — lead magnets on comments, regular posts on likes. A lead magnet stamped
// "regular" is measured on the axis it deliberately suppresses, so it drops out
// of the swipe file.
//
// DRY RUN BY DEFAULT. Nothing is written without --apply.
//
// Demotions (stored lead_magnet, now classified regular) are reported but NOT
// applied unless --include-demotions: the patterns only ever widened, so
// anything in that bucket was set by something other than this classifier and
// is not ours to overwrite.
//
// Run:
//   npx tsx --env-file=.env.local scripts/backfill-post-type.ts
//   npx tsx --env-file=.env.local scripts/backfill-post-type.ts --limit 500
//   npx tsx --env-file=.env.local scripts/backfill-post-type.ts --apply

import { supabaseAdmin } from "../lib/supabase";
import {
  planPostTypeBackfill,
  type ClassifiablePost,
} from "../lib/post-type-backfill";

const READ_PAGE = 1000;
// Keep write chunks well under PostgREST's URL limit, same as the other
// backfills in this directory.
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

  console.log(apply ? "MODE: APPLY (writes)" : "MODE: dry run (no writes)");
  if (cap !== Number.POSITIVE_INFINITY) console.log(`Scanning at most ${cap} posts.`);
  console.log("");

  const promote: string[] = [];
  const demote: string[] = [];
  let unchanged = 0;
  let scanned = 0;
  const samples: string[] = [];

  for (let from = 0; scanned < cap; from += READ_PAGE) {
    const remaining =
      cap === Number.POSITIVE_INFINITY ? READ_PAGE : Math.min(READ_PAGE, cap - scanned);
    const { data, error } = await sb
      .from("posts")
      .select("id, text, post_type")
      .order("id", { ascending: true })
      .range(from, from + remaining - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ClassifiablePost[];
    if (rows.length === 0) break;

    const plan = planPostTypeBackfill(rows);
    promote.push(...plan.promote);
    demote.push(...plan.demote);
    unchanged += plan.unchanged;
    scanned += rows.length;

    // A few real examples so the counts can be sanity-checked before writing —
    // a bad pattern shows up here as prose that obviously is not a lead magnet.
    for (const id of plan.promote) {
      if (samples.length >= 10) break;
      const row = rows.find((r) => r.id === id);
      if (row?.text) samples.push(row.text.replace(/\s+/g, " ").slice(0, 120));
    }

    if (rows.length < remaining) break;
  }

  console.log(`Scanned:              ${scanned}`);
  console.log(`Already correct:      ${unchanged}`);
  console.log(`To PROMOTE (→ lead_magnet): ${promote.length}`);
  console.log(
    `To DEMOTE (→ regular):      ${demote.length}${includeDemotions ? "" : "   [skipped — pass --include-demotions]"}`,
  );

  if (samples.length > 0) {
    console.log("");
    console.log("Sample of newly-detected lead magnets:");
    for (const sample of samples) console.log(`  • ${sample}`);
  }

  if (!apply) {
    console.log("");
    console.log("Dry run — nothing written. Re-run with --apply to commit.");
    return;
  }

  const writes: Array<{ ids: string[]; type: "lead_magnet" | "regular" }> = [
    { ids: promote, type: "lead_magnet" },
  ];
  if (includeDemotions) writes.push({ ids: demote, type: "regular" });

  for (const { ids, type } of writes) {
    let written = 0;
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      const chunk = ids.slice(i, i + WRITE_CHUNK);
      const { error } = await sb
        .from("posts")
        .update({ post_type: type, post_type_detected_via: "regex" })
        .in("id", chunk);
      if (error) throw new Error(error.message);
      written += chunk.length;
      console.log(`  ${type}: ${written}/${ids.length}`);
    }
  }

  console.log("");
  console.log(
    `Done. ${promote.length} promoted` +
      (includeDemotions ? `, ${demote.length} demoted.` : `, ${demote.length} demotions skipped.`),
  );
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

/**
 * Dry-run the new relative (per-creator) virality rule against the LAST run's
 * scraped posts, and compare it to the old flat threshold.
 *
 * Answers: "how many posts would the new rule have flagged as viral on the
 * last run vs how many the flat threshold actually flagged?" — without any
 * scraping or writes.
 *
 * It reconstructs each post's baseline from the posts that existed BEFORE the
 * run started (so the comparison mirrors what the live pipeline would have
 * computed), excluding the post itself.
 *
 * Uses Supabase REST directly (no SDK) to avoid Node realtime/ws issues, and
 * the shared decision logic from lib/viral so the dry-run can't drift from
 * production behavior.
 *
 * Run:  npx tsx scripts/dryrun-relative-viral.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  score,
  meetsThreshold,
  decideRelativeViral,
  getRelativeConfig,
  type ViralThresholds,
} from "../lib/viral";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Flat threshold the live pipeline uses for the global (no-workspace) run.
const FLAT: ViralThresholds = {
  min_reactions: Number(process.env.VIRAL_MIN_REACTIONS ?? 200),
  min_comments: Number(process.env.VIRAL_MIN_COMMENTS ?? 50),
};

async function rest<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const u = `${url}/rest/v1/${path}?${new URLSearchParams(params)}`;
    const res = await fetch(u, {
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        range: `${from}-${from + PAGE - 1}`,
        "range-unit": "items",
      },
    });
    if (!res.ok) throw new Error(`REST ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

type Post = {
  id: string;
  account_id: string;
  linkedin_post_id: string;
  reactions: number;
  comments: number;
  reposts: number;
  viral_score: number | null;
  is_viral: boolean;
  posted_at: string | null;
  scraped_at: string;
  text: string | null;
};

type Run = {
  id: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  posts_count: number | null;
  viral_count: number | null;
};

type Account = { id: string; name: string; linkedin_handle: string };

function scoreOf(p: { reactions: number; comments: number; reposts: number; viral_score: number | null }): number {
  // Prefer the stored viral_score; fall back to recomputing if it's null.
  return p.viral_score != null ? Number(p.viral_score) : score(p.reactions, p.comments, p.reposts);
}

async function main() {
  const cfg = getRelativeConfig();
  console.log("Relative-viral config:", cfg);
  console.log("Flat threshold:", FLAT);
  console.log("");

  // 1. Most recent finished run.
  const runs = await rest<Run>("runs", {
    select: "id,started_at,finished_at,status,posts_count,viral_count",
    order: "started_at.desc",
    limit: "5",
  });
  if (runs.length === 0) {
    console.log("No runs found.");
    return;
  }
  const run = runs.find((r) => r.finished_at) ?? runs[0];
  const runStart = run.started_at ?? new Date(0).toISOString();
  const runEnd = run.finished_at ?? new Date().toISOString();
  // Small buffer after finished_at to catch posts whose scraped_at landed just
  // after the run row was finalized.
  const endBuffer = new Date(new Date(runEnd).getTime() + 5 * 60 * 1000).toISOString();
  console.log(`Last run ${run.id}`);
  console.log(`  window: ${runStart} → ${runEnd}`);
  console.log(`  run reported: posts_count=${run.posts_count ?? "?"}, viral_count=${run.viral_count ?? "?"}`);
  console.log("");

  // 2. Posts scraped during that run.
  const runPosts = await rest<Post>("posts", {
    select:
      "id,account_id,linkedin_post_id,reactions,comments,reposts,viral_score,is_viral,posted_at,scraped_at,text",
    scraped_at: `gte.${runStart}`,
    and: `(scraped_at.lte.${endBuffer})`,
  });
  console.log(`Posts scraped in run window: ${runPosts.length}`);
  if (runPosts.length === 0) {
    console.log("Nothing to compare. (Run may predate scraped_at tracking, or window is off.)");
    return;
  }

  // 3. Prior history per account — posts that existed BEFORE the run started.
  //    We approximate "before the run" by scraped_at < runStart, which is the
  //    set of rows the live pipeline's batched history read would have seen.
  const accIds = Array.from(new Set(runPosts.map((p) => p.account_id)));
  const priorRows = await rest<Post>("posts", {
    select: "account_id,linkedin_post_id,viral_score,reactions,comments,reposts,posted_at,scraped_at",
    account_id: `in.(${accIds.join(",")})`,
    scraped_at: `lt.${runStart}`,
    order: "posted_at.desc.nullslast",
  });
  const priorByAccount = new Map<string, Post[]>();
  for (const p of priorRows) {
    const arr = priorByAccount.get(p.account_id) ?? [];
    arr.push(p);
    priorByAccount.set(p.account_id, arr);
  }

  // Account names for the report.
  const accounts = await rest<Account>("accounts", {
    select: "id,name,linkedin_handle",
    id: `in.(${accIds.join(",")})`,
  });
  const nameById = new Map(accounts.map((a) => [a.id, a.name] as const));

  // 4. Compare per post.
  let oldViral = 0;
  let newViral = 0;
  const byBasis = { relative: 0, flat_fallback: 0, below_floor: 0 };
  const newlyFlagged: Array<{ name: string; score: number; baseline: number | null; sample: number }> = [];
  const noLongerFlagged: Array<{ name: string; score: number; baseline: number | null; sample: number }> = [];

  for (const p of runPosts) {
    const s = scoreOf(p);
    const old = meetsThreshold(p.reactions, p.comments, FLAT);
    if (old) oldViral++;

    const priorScores = (priorByAccount.get(p.account_id) ?? [])
      .filter((q) => q.linkedin_post_id !== p.linkedin_post_id)
      .map(scoreOf);

    const decision = decideRelativeViral({
      score: s,
      reactions: p.reactions,
      comments: p.comments,
      priorScores,
      flatThresholds: FLAT,
      config: cfg,
    });
    if (decision.viral) newViral++;
    byBasis[decision.basis]++;

    const name = nameById.get(p.account_id) ?? p.account_id;
    if (decision.viral && !old) {
      newlyFlagged.push({ name, score: s, baseline: decision.baseline, sample: decision.sampleSize });
    } else if (!decision.viral && old) {
      noLongerFlagged.push({ name, score: s, baseline: decision.baseline, sample: decision.sampleSize });
    }
  }

  // Sensitivity sweep: how does the count move as we vary the multiplier?
  console.log("");
  console.log("======== MULTIPLIER SENSITIVITY ========");
  console.log("(new-viral count at each multiplier; flat baseline shown for reference)");
  for (const mult of [1.2, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0]) {
    let n = 0;
    for (const p of runPosts) {
      const s = scoreOf(p);
      const priorScores = (priorByAccount.get(p.account_id) ?? [])
        .filter((q) => q.linkedin_post_id !== p.linkedin_post_id)
        .map(scoreOf);
      const d = decideRelativeViral({
        score: s,
        reactions: p.reactions,
        comments: p.comments,
        priorScores,
        flatThresholds: FLAT,
        config: { ...cfg, multiplier: mult },
      });
      if (d.viral) n++;
    }
    console.log(`  ×${mult.toFixed(2)} → ${n} viral`);
  }

  console.log("");
  console.log("================ RESULT ================");
  console.log(`OLD (flat threshold)     viral: ${oldViral} / ${runPosts.length}`);
  console.log(`NEW (relative, option 4) viral: ${newViral} / ${runPosts.length}`);
  console.log(`  delta: ${newViral - oldViral >= 0 ? "+" : ""}${newViral - oldViral}`);
  console.log("");
  console.log("Decision basis (new rule):");
  console.log(`  relative (had baseline):     ${byBasis.relative}`);
  console.log(`  flat_fallback (cold start):  ${byBasis.flat_fallback}`);
  console.log(`  below_floor (rejected):      ${byBasis.below_floor}`);
  console.log("");
  console.log(`Newly flagged by new rule (missed by flat): ${newlyFlagged.length}`);
  for (const n of newlyFlagged.slice(0, 25)) {
    console.log(
      `  + ${n.name} — score ${n.score} vs baseline ${n.baseline?.toFixed(0) ?? "n/a"} (×${cfg.multiplier}=${n.baseline != null ? (n.baseline * cfg.multiplier).toFixed(0) : "n/a"}), n=${n.sample}`,
    );
  }
  if (newlyFlagged.length > 25) console.log(`  …and ${newlyFlagged.length - 25} more`);
  console.log("");
  console.log(`Dropped by new rule (flat said viral, relative said no): ${noLongerFlagged.length}`);
  for (const n of noLongerFlagged.slice(0, 25)) {
    console.log(
      `  - ${n.name} — score ${n.score} vs baseline ${n.baseline?.toFixed(0) ?? "n/a"} (×${cfg.multiplier}=${n.baseline != null ? (n.baseline * cfg.multiplier).toFixed(0) : "n/a"}), n=${n.sample}`,
    );
  }
  if (noLongerFlagged.length > 25) console.log(`  …and ${noLongerFlagged.length - 25} more`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

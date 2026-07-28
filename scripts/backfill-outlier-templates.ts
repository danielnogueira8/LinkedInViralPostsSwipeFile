// One-off / resumable: backfill content_templates from the historical `posts`
// corpus for creators whose genuine outliers predate the pipeline templating
// phase (migration-116). Idempotent — posts that already have a
// content_templates row pointing at them (origin_post_id) are skipped, so it's
// safe to re-run after an interruption or a config change.
//
// Qualification is exactly the live gate: decideTemplateOutlier (lib/viral.ts)
// — the creator needs ≥ TEMPLATE_OUTLIER_MIN_HISTORY (default 20) other stored
// posts and the post must score in their own top TEMPLATE_OUTLIER_CUTOFF_PCT
// (default 1) percent.
//
// Run: npx tsx --env-file=.env.local scripts/backfill-outlier-templates.ts
//   --limit 50   process at most 50 qualifying posts this run (default: all)
//   --dry-run    print what would be templatized; no LLM calls, no writes

import { supabaseAdmin } from "../lib/supabase";
import {
  decideTemplateOutlier,
  getTemplateOutlierConfig,
  score,
} from "../lib/viral";
import { templatizeOutlierPost, PLATFORM_WORKSPACE } from "../lib/claude";
import { TEMPLATES_PER_WORKSPACE_MAX } from "../lib/templates";
import { embedTemplateBody } from "../lib/template-embeddings";
import { selectAllRows, selectInChunks } from "../lib/db-paginate";

type PostRow = {
  id: string;
  account_id: string;
  text: string | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  viral_score: number | null;
  posted_at: string | null;
};

function scoreOf(p: PostRow): number {
  // Prefer the stored viral_score; fall back to recomputing for legacy rows.
  return p.viral_score != null
    ? Number(p.viral_score)
    : score(p.reactions ?? 0, p.comments ?? 0, p.reposts ?? 0);
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(argValue("--limit")) || Number.POSITIVE_INFINITY;
  const config = getTemplateOutlierConfig();
  const sb = supabaseAdmin();

  console.log(
    `Backfilling outlier templates (minHistory=${config.minHistory}, top ${config.cutoffPct}%, window=${config.window})` +
      `${dryRun ? " — DRY RUN" : ""}${limit === Infinity ? "" : ` — limit ${limit}`}...`,
  );

  // 1. The whole stored corpus, newest first. One paginated read (a bare
  //    select silently caps at 1000 rows).
  const posts = await selectAllRows<PostRow>(() =>
    sb
      .from("posts")
      .select(
        "id, account_id, text, reactions, comments, reposts, viral_score, posted_at",
      )
      .order("posted_at", { ascending: false, nullsFirst: false }),
  );
  console.log(`Loaded ${posts.length} posts.`);

  // 2. Group by account; an account needs at least minHistory + 1 rows for any
  //    post to have minHistory OTHER posts behind it. Archived accounts are
  //    excluded (mirrors the hook-library stage in the pipeline).
  const byAccount = new Map<string, PostRow[]>();
  for (const p of posts) {
    const arr = byAccount.get(p.account_id) ?? [];
    arr.push(p);
    byAccount.set(p.account_id, arr);
  }
  const accountIds = await selectAllRows<{ id: string }>(() =>
    sb.from("accounts").select("id").is("archived_at", null),
  );
  const liveAccounts = new Set(accountIds.map((a) => a.id));

  // 3. Qualify each post against the creator's own history.
  const qualifying: Array<{ post: PostRow; baseline: number | null }> = [];
  for (const [accountId, accountPosts] of byAccount) {
    if (!liveAccounts.has(accountId)) continue;
    if (accountPosts.length < config.minHistory + 1) continue;
    for (const p of accountPosts) {
      if (!p.text?.trim()) continue;
      const priorScores = accountPosts
        .filter((q) => q.id !== p.id)
        .map(scoreOf);
      const decision = decideTemplateOutlier({
        score: scoreOf(p),
        priorScores,
        config,
      });
      if (decision.qualifies) {
        qualifying.push({ post: p, baseline: decision.baseline });
      }
    }
  }
  console.log(`Qualifying outlier posts: ${qualifying.length}`);

  // 4. Skip posts that already produced a template (any workspace).
  const existing = await selectAllRows<{ origin_post_id: string }>(() =>
    sb.from("content_templates").select("origin_post_id").not("origin_post_id", "is", null),
  );
  const alreadyTemplatized = new Set(existing.map((r) => r.origin_post_id));
  const todo = qualifying.filter((q) => !alreadyTemplatized.has(q.post.id));
  console.log(`After idempotency skip: ${todo.length} to templatize.`);

  const capped = todo.slice(0, limit === Infinity ? todo.length : limit);
  if (dryRun) {
    for (const q of capped) {
      console.log(
        `  would templatize post ${q.post.id} (account ${q.post.account_id}, score ${scoreOf(q.post)}, baseline ${q.baseline?.toFixed(0) ?? "n/a"})`,
      );
    }
    console.log(`Dry run complete. ${capped.length} posts would be templatized.`);
    return;
  }

  // 5. Batch the tracker lookup once (workspace_accounts per account), then
  //    LLM + fan out per post. Fail-open per post: log and continue.
  const trackers = await selectInChunks<{ account_id: string; workspace_id: string }>(
    [...new Set(capped.map((q) => q.post.account_id))],
    (slice) =>
      sb.from("workspace_accounts").select("account_id, workspace_id").in("account_id", slice),
  );
  const workspacesByAccount = new Map<string, string[]>();
  for (const t of trackers) {
    const arr = workspacesByAccount.get(t.account_id) ?? [];
    if (!arr.includes(t.workspace_id)) arr.push(t.workspace_id);
    workspacesByAccount.set(t.account_id, arr);
  }

  let done = 0;
  let inserted = 0;
  let failed = 0;
  for (const q of capped) {
    const workspaceIds = workspacesByAccount.get(q.post.account_id) ?? [];
    if (workspaceIds.length === 0) continue;
    try {
      const templatized = await templatizeOutlierPost(q.post.text as string);
      const embedding = await embedTemplateBody(templatized.body, {
        workspaceId: PLATFORM_WORKSPACE,
      });
      for (const wsId of workspaceIds) {
        const { error: claimErr } = await sb.rpc("claim_content_template_slot", {
          p_workspace_id: wsId,
          p_max_templates: TEMPLATES_PER_WORKSPACE_MAX,
          p_title: templatized.title,
          p_category: templatized.category,
          p_body: templatized.body,
          p_source: "auto",
          p_origin_post_id: q.post.id,
          p_embedding: `[${embedding.join(",")}]`,
          p_structure_type: templatized.structureType,
        });
        // 23505 (unique_violation): a workspace already has this post's
        // template (a second workspace pass can't happen via the skip above,
        // but a concurrent run can) — expected, skip quietly.
        if (claimErr && claimErr.code !== "23505") {
          console.warn(
            `  insert failed for workspace ${wsId}, post ${q.post.id}: ${claimErr.message}`,
          );
        } else if (!claimErr) {
          inserted++;
        }
      }
      done++;
      console.log(`  + templatized ${q.post.id} → ${workspaceIds.length} workspace(s) (${done}/${capped.length})`);
    } catch (e) {
      failed++;
      console.error(`  templatize fail ${q.post.id}: ${(e as Error).message}`);
    }
  }

  console.log(`Done. Templatized ${done} posts (${inserted} template rows), ${failed} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import {
  extractHookWithClaude,
} from "@/lib/claude";
import {
  extractHookHeuristic,
  qualifiesForHookLibrary,
  normalizeHookForDedupe,
} from "@/lib/hooks";
import { errorResponse, requireWorkspaceId } from "@/lib/workspace";
import { selectAllRows, idChunks } from "@/lib/db-paginate";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const maxDuration = 800;

// Admin-only: pending posts that need the Claude fallback (no usable
// heuristic hook) trigger a Claude call each. Untrusted callers could rack
// up real bills.
//
// This route both (1) PURGES existing hooks whose post no longer qualifies
// under the post-type-aware gate (lib/hooks.ts) — the one-shot cleanup after
// the gate tightened — and (2) extracts hooks for newly-qualifying posts that
// don't have one yet. Both respect the same gate + near-duplicate dedupe the
// daily pipeline uses, so a manual run and a scrape converge on the same set.
export async function POST(req: Request) {
  await requireWorkspaceId();
  if (!(await isAdmin())) {
    return NextResponse.json({ ok: false, error: "Admin only." }, { status: 403 });
  }

  // Bounded batch per invocation (default 40, max 100) so a large hook backlog
  // can't run an unbounded Claude loop past maxDuration — which previously left
  // the platform to kill the run mid-loop with NO record, half the extractions
  // done and the caller blind. The response reports `remaining` so the operator
  // re-invokes until it hits 0. Mirrors backfill-saved-posts / -post-types.
  const batch = Math.min(
    100,
    Math.max(1, parseInt(new URL(req.url).searchParams.get("batch") ?? "40", 10) || 40),
  );

  const sb = supabaseAdmin();

  // All viral posts with text from non-archived creators. Hooks live
  // globally on posts (not per workspace), so we backfill across the
  // table — workspace-scoping happens at read time on the page. We skip
  // archived creators here to avoid burning Claude calls on inventory
  // no workspace tracks anymore.
  // Paginated: reads the WHOLE global viral corpus, which caps at 1000 rows on
  // a bare select once the corpus grows — the backfill would silently ignore
  // everything past row 1000.
  let viral: Array<{
    id: string;
    text: string | null;
    post_type: string;
    reactions: number;
    comments: number;
    viral_score: number | null;
    viral_basis: string | null;
    baseline_score: number | null;
    accounts: unknown;
  }>;
  try {
    viral = await selectAllRows(() =>
      sb
        .from("posts")
        .select(
          "id, text, post_type, reactions, comments, viral_score, viral_basis, baseline_score, accounts!inner(archived_at)",
        )
        .eq("is_viral", true)
        .is("accounts.archived_at", null)
        .not("text", "is", null),
    );
  } catch (e) {
    return errorResponse(e);
  }
  const withText = viral.filter((p) => !!p.text);

  // Partition by the qualification gate. Qualifying posts are extraction
  // candidates; the rest define which existing hooks to purge.
  const qualifying = withText.filter((p) => qualifiesForHookLibrary(p));
  const qualifyingIds = new Set(qualifying.map((p) => p.id));

  // Purge: delete any existing hook whose post is no longer a qualifier.
  // We only consider hooks for posts in our (non-archived, viral, has-text)
  // working set — archived/non-viral posts' hooks are left alone here.
  // Paginated: the hook library also exceeds 1000 rows, which would leave
  // stale hooks un-purged and un-deduped.
  const allHooks = await selectAllRows<{ post_id: string; hook_text: string }>(() =>
    sb.from("hooks").select("post_id, hook_text"),
  );
  const withTextIds = new Set(withText.map((p) => p.id));
  const purgeIds = allHooks
    .map((h) => h.post_id)
    .filter((pid) => withTextIds.has(pid) && !qualifyingIds.has(pid));

  let purged = 0;
  if (purgeIds.length) {
    // Chunk the DELETE `.in()`: purgeIds can be thousands (URL too long → 400).
    try {
      for (const slice of idChunks(purgeIds)) {
        const { error: delErr } = await sb.from("hooks").delete().in("post_id", slice);
        if (delErr) throw new Error(delErr.message);
      }
    } catch (e) {
      return errorResponse(e);
    }
    purged = purgeIds.length;
  }

  // Seed the dedupe set from hooks that SURVIVE the purge, so newly-extracted
  // openers don't duplicate ones already in the library.
  const purgeSet = new Set(purgeIds);
  const seenHooks = new Set(
    allHooks
      .filter((h) => !purgeSet.has(h.post_id as string))
      .map((h) => normalizeHookForDedupe(h.hook_text as string)),
  );

  // Extraction candidates: qualifying posts that don't already have a hook.
  const have = new Set(
    allHooks
      .filter((h) => !purgeSet.has(h.post_id as string))
      .map((h) => h.post_id as string),
  );
  const todoAll = qualifying.filter((p) => !have.has(p.id));
  // Process at most `batch` this invocation; the rest are `remaining`.
  const todo = todoAll.slice(0, batch);

  let extracted = 0;
  let viaHeuristic = 0;
  let viaClaude = 0;
  let deduped = 0;
  let errors = 0;

  for (const p of todo) {
    try {
      const heuristic = extractHookHeuristic(p.text as string);
      if (heuristic) {
        const key = normalizeHookForDedupe(heuristic);
        if (seenHooks.has(key)) {
          deduped++;
          continue;
        }
        await sb.from("hooks").insert({
          post_id: p.id,
          hook_text: heuristic,
          extracted_via: "heuristic",
          post_type: p.post_type ?? "regular",
        });
        seenHooks.add(key);
        viaHeuristic++;
      } else {
        const { hook } = await extractHookWithClaude(p.text as string);
        const key = normalizeHookForDedupe(hook);
        if (seenHooks.has(key)) {
          deduped++;
          continue;
        }
        await sb.from("hooks").insert({
          post_id: p.id,
          hook_text: hook,
          extracted_via: "claude",
          post_type: p.post_type ?? "regular",
        });
        seenHooks.add(key);
        viaClaude++;
      }
      extracted++;
    } catch (e) {
      console.error("backfill hook fail", p.id, (e as Error).message);
      errors++;
    }
  }

  // How many qualifying-but-hookless posts remain after this batch, so the
  // operator knows whether to re-invoke. (extracted + deduped were handled this
  // run; the rest of todoAll are still pending.)
  const remaining = Math.max(0, todoAll.length - todo.length);

  return NextResponse.json({
    ok: true,
    processed: todo.length,
    pending: todoAll.length,
    remaining,
    extracted,
    viaHeuristic,
    viaClaude,
    deduped,
    purged,
    errors,
  });
}

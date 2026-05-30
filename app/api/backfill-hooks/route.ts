import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import {
  setAnthropicKey,
  extractHookWithClaude,
} from "@/lib/claude";
import {
  extractHookHeuristic,
  qualifiesForHookLibrary,
  normalizeHookForDedupe,
} from "@/lib/hooks";
import { requireWorkspaceId } from "@/lib/workspace";
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
export async function POST() {
  await requireWorkspaceId();
  if (!(await isAdmin())) {
    return NextResponse.json({ ok: false, error: "Admin only." }, { status: 403 });
  }
  setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);

  const sb = supabaseAdmin();

  // All viral posts with text from non-archived creators. Hooks live
  // globally on posts (not per workspace), so we backfill across the
  // table — workspace-scoping happens at read time on the page. We skip
  // archived creators here to avoid burning Claude calls on inventory
  // no workspace tracks anymore.
  const { data: viral, error } = await sb
    .from("posts")
    .select(
      "id, text, post_type, reactions, comments, viral_score, viral_basis, baseline_score, accounts!inner(archived_at)",
    )
    .eq("is_viral", true)
    .is("accounts.archived_at", null)
    .not("text", "is", null);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  const withText = (viral ?? []).filter((p) => !!p.text);

  // Partition by the qualification gate. Qualifying posts are extraction
  // candidates; the rest define which existing hooks to purge.
  const qualifying = withText.filter((p) => qualifiesForHookLibrary(p));
  const qualifyingIds = new Set(qualifying.map((p) => p.id));

  // Purge: delete any existing hook whose post is no longer a qualifier.
  // We only consider hooks for posts in our (non-archived, viral, has-text)
  // working set — archived/non-viral posts' hooks are left alone here.
  const { data: existingHooks } = await sb
    .from("hooks")
    .select("post_id, hook_text");
  const allHooks = existingHooks ?? [];
  const purgeIds = allHooks
    .map((h) => h.post_id as string)
    .filter((pid) => withText.some((p) => p.id === pid) && !qualifyingIds.has(pid));

  let purged = 0;
  if (purgeIds.length) {
    const { error: delErr } = await sb.from("hooks").delete().in("post_id", purgeIds);
    if (delErr) {
      return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 });
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
  const todo = qualifying.filter((p) => !have.has(p.id));

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

  return NextResponse.json({
    ok: true,
    total: todo.length,
    extracted,
    viaHeuristic,
    viaClaude,
    deduped,
    purged,
    errors,
  });
}

import { supabaseAdmin } from "./supabase";
import { templatizePost } from "./claude";
import { getTemplateThresholds, meetsThreshold } from "./viral";

// Stuck-run sweep window. A backfill should never legitimately run
// longer than this — if it does, the lambda was killed before the
// finally clause could mark it failed, leaving status='running' forever.
const STUCK_MS = 30 * 60 * 1000;

export async function startBackfill(): Promise<{ runId: string; alreadyRunning: boolean; total: number }> {
  const sb = supabaseAdmin();

  // DB-gated dedupe. The old globalThis singleton was unreliable on
  // serverless — each lambda container had its own variable, so
  // concurrent invocations would silently kick off duplicate backfills
  // (each running the full Anthropic batch). The DB row is authoritative.
  //
  // First: sweep any "running" row older than the stuck window so we
  // don't get blocked by a dead lambda forever. Then look for a fresh
  // running row.
  const cutoff = new Date(Date.now() - STUCK_MS).toISOString();
  await sb
    .from("backfill_runs")
    .update({
      status: "error",
      finished_at: new Date().toISOString(),
      error: "stuck: marked failed by sweep (exceeded inflight window)",
    })
    .eq("status", "running")
    .lt("started_at", cutoff);

  const { data: inflight } = await sb
    .from("backfill_runs")
    .select("id, total")
    .eq("status", "running")
    .gte("started_at", cutoff)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (inflight) {
    return { runId: inflight.id as string, alreadyRunning: true, total: inflight.total ?? 0 };
  }

  // figure out the work upfront. Only auto-template posts that clear the
  // template threshold (higher than the swipe-file threshold).
  const tplThresholds = await getTemplateThresholds();
  // Skip archived creators (no workspace tracks them) so we don't burn
  // Claude calls templatizing posts nobody will read.
  const { data: viral } = await sb
    .from("posts")
    .select("id, text, reactions, comments, media_type, media_urls, visual_kind, accounts!inner(name, archived_at)")
    .eq("is_viral", true)
    .is("accounts.archived_at", null)
    .not("text", "is", null);
  const candidates = (viral ?? []).filter(
    (p) => p.text && meetsThreshold(p.reactions, p.comments, tplThresholds),
  );
  const ids = candidates.map((p) => p.id);
  const { data: existing } = ids.length
    ? await sb.from("templates").select("post_id").in("post_id", ids)
    : { data: [] as { post_id: string }[] };
  const have = new Set((existing ?? []).map((e) => e.post_id));
  const todo = candidates.filter((p) => !have.has(p.id));

  const { data: run, error } = await sb
    .from("backfill_runs")
    .insert({ status: "running", total: todo.length })
    .select()
    .single();
  if (error || !run) throw error || new Error("Could not create backfill run");

  const runId = run.id as string;

  let templated = 0;
  // Always 0 — proactive classification was dropped to save Anthropic spend.
  // Column stays in the schema for historical runs.
  const classified = 0;
  let errors = 0;

  const interval = setInterval(() => {
    sb.from("backfill_runs").update({ templated, classified, errors }).eq("id", runId).then(() => {}, () => {});
  }, 600);

  void (async () => {
    try {
      for (let i = 0; i < todo.length; i++) {
        const p = todo[i];
        const name = (p.accounts as unknown as { name?: string })?.name ?? "?";
        await sb.from("backfill_runs").update({
          current_index: i,
          current_name: name,
          current_kind: "templating",
          templated, classified, errors,
        }).eq("id", runId);

        try {
          const tpl = await templatizePost(p.text as string);
          // Upsert with ignoreDuplicates: between the pre-filter against
          // `existing` and this insert, a scrape (or a second backfill)
          // could have templated the same post — bare insert would throw
          // 23505 here and inflate the errors counter for a no-op.
          await sb.from("templates").upsert(
            { post_id: p.id, template_text: tpl, model: "claude-haiku-4-5-20251001" },
            { onConflict: "post_id", ignoreDuplicates: true },
          );
          templated++;
        } catch (e) { console.error("templatize fail", p.id, (e as Error).message); errors++; }
      }

      clearInterval(interval);
      await sb.from("backfill_runs").update({
        status: "ok",
        finished_at: new Date().toISOString(),
        templated, classified, errors,
        current_index: null, current_name: null, current_kind: null,
      }).eq("id", runId);
    } catch (e) {
      clearInterval(interval);
      await sb.from("backfill_runs").update({
        status: "error",
        finished_at: new Date().toISOString(),
        error: (e as Error).message,
        templated, classified, errors,
      }).eq("id", runId);
    }
  })();

  return { runId, alreadyRunning: false, total: todo.length };
}

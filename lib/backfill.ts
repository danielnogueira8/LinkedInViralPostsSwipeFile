import { supabaseAdmin } from "./supabase";
import { templatizePost, classifyVisual } from "./claude";
import { getTemplateThresholds, meetsThreshold } from "./viral";

declare global {
  var __activeBackfillId: string | undefined;
  var __activeBackfillPromise: Promise<unknown> | undefined;
}

export async function startBackfill(): Promise<{ runId: string; alreadyRunning: boolean; total: number }> {
  if (globalThis.__activeBackfillPromise && globalThis.__activeBackfillId) {
    const sb = supabaseAdmin();
    const { data } = await sb.from("backfill_runs").select("total").eq("id", globalThis.__activeBackfillId).maybeSingle();
    return { runId: globalThis.__activeBackfillId, alreadyRunning: true, total: data?.total ?? 0 };
  }

  const sb = supabaseAdmin();

  // figure out the work upfront. Only auto-template posts that clear the
  // template threshold (higher than the swipe-file threshold).
  const tplThresholds = await getTemplateThresholds();
  const { data: viral } = await sb
    .from("posts")
    .select("id, text, reactions, comments, media_type, media_urls, visual_kind, accounts(name)")
    .eq("is_viral", true)
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
  globalThis.__activeBackfillId = runId;

  let templated = 0;
  let classified = 0;
  let errors = 0;

  const interval = setInterval(() => {
    sb.from("backfill_runs").update({ templated, classified, errors }).eq("id", runId).then(() => {}, () => {});
  }, 600);

  const promise = (async () => {
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
          await sb.from("templates").insert({ post_id: p.id, template_text: tpl, model: "claude-haiku-4-5-20251001" });
          templated++;
        } catch (e) { console.error("templatize fail", p.id, (e as Error).message); errors++; }

        if (p.media_type === "image" && !p.visual_kind && Array.isArray(p.media_urls) && p.media_urls.length > 0) {
          await sb.from("backfill_runs").update({
            current_index: i,
            current_name: name,
            current_kind: "classifying",
            templated, classified, errors,
          }).eq("id", runId);
          try {
            const kind = await classifyVisual(p.media_urls[0] as string);
            await sb.from("posts").update({ visual_kind: kind }).eq("id", p.id);
            classified++;
          } catch (e) { console.error("classify fail", p.id, (e as Error).message); errors++; }
        }
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
    } finally {
      globalThis.__activeBackfillId = undefined;
      globalThis.__activeBackfillPromise = undefined;
    }
  })();
  globalThis.__activeBackfillPromise = promise;

  return { runId, alreadyRunning: false, total: todo.length };
}

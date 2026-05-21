import { supabaseAdmin } from "./supabase";
import { runOneProfile, normalizePost } from "./apify";
import { getThresholds, getTemplateThresholds, isViral, meetsThreshold, score } from "./viral";
import { classifyPost } from "./post-type";
import { templatizePost } from "./claude";

export type AccountProgress = {
  index: number;
  name: string;
  handle: string;
  status: "scraping" | "scraped" | "skipped" | "error";
  reactions?: number;
  comments?: number;
  viral?: boolean;
  error?: string;
  started_at: number;
  ended_at?: number;
};

export type Phase = "scraping" | "templating" | "classifying" | "done" | "error";

async function pool<T>(items: T[], size: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export async function runDailyPipeline(
  workspaceId?: string,
): Promise<{ runId: string; postsCount: number; viralCount: number }> {
  const sb = supabaseAdmin();
  const { data: run, error: runErr } = await sb
    .from("runs")
    .insert({
      workspace_id: workspaceId ?? null,
      status: "running",
      phase: "scraping",
      phase_msg: "Starting…",
      progress: [],
    })
    .select()
    .single();
  if (runErr || !run) throw runErr || new Error("Could not create run");

  const runId: string = run.id;
  const progress: Map<string, AccountProgress> = new Map();
  let postsCount = 0;
  let viralCount = 0;
  let dirty = false;

  // batched writer: only push to DB if state changed since last write
  async function persist(extra?: { phase?: Phase; phase_msg?: string; finished?: boolean; error?: string; total?: number }) {
    if (!dirty && !extra) return;
    dirty = false;
    const update: Record<string, unknown> = {
      progress: Array.from(progress.values()),
      posts_count: postsCount,
      viral_count: viralCount,
    };
    if (extra?.phase) update.phase = extra.phase;
    if (extra?.phase_msg !== undefined) update.phase_msg = extra.phase_msg;
    if (extra?.total !== undefined) update.accounts_count = extra.total;
    if (extra?.finished) {
      update.finished_at = new Date().toISOString();
      update.status = extra.error ? "error" : "ok";
      if (extra.error) update.error = extra.error;
    }
    await sb.from("runs").update(update).eq("id", runId);
  }

  const interval = setInterval(() => { persist().catch(() => {}); }, 800);

  try {
    const { data: accounts, error: accErr } = await sb
      .from("accounts")
      .select("id, profile_url, linkedin_handle, name")
      .is("archived_at", null)
      .order("name");
    if (accErr) throw accErr;
    if (!accounts || accounts.length === 0) {
      clearInterval(interval);
      await persist({ phase: "done", phase_msg: "No accounts to scrape", finished: true, total: 0 });
      return { runId, postsCount: 0, viralCount: 0 };
    }

    await persist({ phase: "scraping", phase_msg: `Scraping ${accounts.length} accounts`, total: accounts.length });
    const thresholds = await getThresholds();

    await pool(accounts, 6, async (acc, idx) => {
      const startedAt = Date.now();
      progress.set(acc.linkedin_handle, {
        index: idx, name: acc.name, handle: acc.linkedin_handle,
        status: "scraping", started_at: startedAt,
      });
      dirty = true;
      try {
        const items = await runOneProfile(acc.linkedin_handle);
        if (items.length === 0) {
          progress.set(acc.linkedin_handle, {
            ...progress.get(acc.linkedin_handle)!,
            status: "skipped", ended_at: Date.now(),
          });
          dirty = true;
          return;
        }
        const norm = normalizePost(items[0] as Record<string, unknown>);
        if (!norm) {
          progress.set(acc.linkedin_handle, {
            ...progress.get(acc.linkedin_handle)!,
            status: "skipped", ended_at: Date.now(),
          });
          dirty = true;
          return;
        }
        const viral = isViral(norm.reactions, norm.comments, thresholds);
        const vScore = score(norm.reactions, norm.comments, norm.reposts);
        const { post_type, detected_via } = classifyPost(norm.text, norm.reactions, norm.comments);

        // Cheap side-effect: keep accounts.profile_pic_url / headline fresh.
        // No need to await before/around the post upsert — fire-and-forget is fine
        // since failures shouldn't block ingest.
        if (norm.author_profile_pic_url || norm.author_headline) {
          const patch: Record<string, unknown> = {};
          if (norm.author_profile_pic_url) patch.profile_pic_url = norm.author_profile_pic_url;
          if (norm.author_headline) patch.headline = norm.author_headline;
          sb.from("accounts").update(patch).eq("id", acc.id).then(({ error }) => {
            if (error) console.warn(`account meta update failed for ${acc.linkedin_handle}: ${error.message}`);
          });
        }

        const { data: upserted, error: upErr } = await sb
          .from("posts")
          .upsert(
            {
              account_id: acc.id,
              linkedin_post_id: norm.linkedin_post_id,
              post_url: norm.post_url,
              posted_at: norm.posted_at,
              scraped_at: new Date().toISOString(),
              text: norm.text,
              reactions: norm.reactions,
              comments: norm.comments,
              reposts: norm.reposts,
              media_type: norm.media_type,
              media_urls: norm.media_urls,
              is_viral: viral,
              viral_score: vScore,
              post_type,
              post_type_detected_via: detected_via,
            },
            { onConflict: "linkedin_post_id" },
          )
          .select("id, is_viral")
          .single();
        if (upErr || !upserted) {
          progress.set(acc.linkedin_handle, {
            ...progress.get(acc.linkedin_handle)!,
            status: "error", error: upErr?.message, ended_at: Date.now(),
          });
          dirty = true;
          return;
        }

        postsCount++;
        if (upserted.is_viral) viralCount++;
        progress.set(acc.linkedin_handle, {
          ...progress.get(acc.linkedin_handle)!,
          status: "scraped",
          reactions: norm.reactions,
          comments: norm.comments,
          viral,
          ended_at: Date.now(),
        });
        dirty = true;
      } catch (e) {
        progress.set(acc.linkedin_handle, {
          ...progress.get(acc.linkedin_handle)!,
          status: "error", error: (e as Error).message, ended_at: Date.now(),
        });
        dirty = true;
      }
    });

    // Template viral posts that clear the (higher) template threshold and don't
    // yet have a template. Posts between swipe-file and template thresholds
    // stay in the swipe file but skip auto-templating to save Anthropic spend.
    const tplThresholds = await getTemplateThresholds();
    const { data: viralNeedingTpl } = await sb
      .from("posts")
      .select("id, text, reactions, comments, media_type, media_urls, visual_kind, accounts(name)")
      .eq("is_viral", true)
      .not("text", "is", null);
    const pending = (viralNeedingTpl ?? []).filter(
      (p) => p.text && meetsThreshold(p.reactions, p.comments, tplThresholds),
    );

    // Filter to those without a template
    const ids = pending.map((p) => p.id);
    const { data: existing } = ids.length
      ? await sb.from("templates").select("post_id").in("post_id", ids)
      : { data: [] as { post_id: string }[] };
    const have = new Set((existing ?? []).map((e) => e.post_id));
    const todo = pending.filter((p) => !have.has(p.id));

    for (let i = 0; i < todo.length; i++) {
      const p = todo[i];
      const name = (p.accounts as unknown as { name?: string })?.name ?? "?";
      await persist({ phase: "templating", phase_msg: `Templating ${i + 1}/${todo.length} — ${name}` });
      try {
        const tpl = await templatizePost(p.text as string);
        await sb.from("templates").insert({ post_id: p.id, template_text: tpl, model: "claude-haiku-4-5-20251001" });
      } catch (e) { console.error("templatize fail", p.id, (e as Error).message); }
    }

    clearInterval(interval);
    await persist({ phase: "done", phase_msg: "Done", finished: true });
    return { runId, postsCount, viralCount };
  } catch (e) {
    clearInterval(interval);
    await persist({ phase: "error", phase_msg: (e as Error).message, finished: true, error: (e as Error).message });
    throw e;
  }
}

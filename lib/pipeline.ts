import { supabaseAdmin } from "./supabase";
import { runOneProfile, normalizePost } from "./apify";
import { getThresholds, getTemplateThresholds, isViral, meetsThreshold, score } from "./viral";
import { classifyPost } from "./post-type";
import { templatizePost, extractHookWithClaude, classifyHookPattern } from "./claude";
import { extractHookHeuristic } from "./hooks";
import { decideScrapeGates } from "./scrape-gating";

export type AccountProgress = {
  index: number;
  name: string;
  handle: string;
  // "skipped" historically meant "Apify returned nothing." We now also use it
  // for cadence-gated skips, distinguished by `skip_reason`.
  status: "scraping" | "scraped" | "skipped" | "error";
  skip_reason?: "recently_scraped" | "no_data";
  reactions?: number;
  comments?: number;
  viral?: boolean;
  error?: string;
  started_at: number;
  ended_at?: number;
};

export type Phase = "scraping" | "templating" | "classifying" | "hooks" | "done" | "error";

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

    // Cadence gating: skip creators we scraped recently (unless they're daily
    // posters). Decisions are made once, up front, against usage_events so
    // upsert-overwrites don't hide the last scrape time.
    const gates = await decideScrapeGates(accounts);
    const gateByAccount = new Map(gates.map((g) => [g.account_id, g] as const));
    const toScrape = accounts.filter((a) => gateByAccount.get(a.id)?.scrape !== false);
    const skipped = accounts.filter((a) => gateByAccount.get(a.id)?.scrape === false);

    // Record skipped creators in progress so the dashboard reflects them.
    for (let i = 0; i < skipped.length; i++) {
      const acc = skipped[i];
      const now = Date.now();
      progress.set(acc.linkedin_handle, {
        index: toScrape.length + i,
        name: acc.name,
        handle: acc.linkedin_handle,
        status: "skipped",
        skip_reason: "recently_scraped",
        started_at: now,
        ended_at: now,
      });
    }
    dirty = skipped.length > 0;

    await persist({
      phase: "scraping",
      phase_msg:
        skipped.length > 0
          ? `Scraping ${toScrape.length} of ${accounts.length} (skipped ${skipped.length} scraped recently)`
          : `Scraping ${accounts.length} accounts`,
      total: accounts.length,
    });
    const thresholds = await getThresholds();

    await pool(toScrape, 6, async (acc, idx) => {
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
            status: "skipped", skip_reason: "no_data", ended_at: Date.now(),
          });
          dirty = true;
          return;
        }
        const norm = normalizePost(items[0] as Record<string, unknown>);
        if (!norm) {
          progress.set(acc.linkedin_handle, {
            ...progress.get(acc.linkedin_handle)!,
            status: "skipped", skip_reason: "no_data", ended_at: Date.now(),
          });
          dirty = true;
          return;
        }
        const viral = isViral(norm.reactions, norm.comments, thresholds);
        const vScore = score(norm.reactions, norm.comments, norm.reposts);
        const { post_type, detected_via } = classifyPost(norm.text);

        // Cheap side-effect: keep accounts.profile_pic_url / headline fresh.
        // We await this now — previously it was fire-and-forget, but under
        // cold-start max-duration cutoffs on Vercel the function can return
        // before Supabase finishes, losing the update silently. The patch is
        // tiny (1-2 columns by primary key) so the latency cost is minimal
        // and a failure here still doesn't block ingest (we log + continue).
        if (norm.author_profile_pic_url || norm.author_headline) {
          const patch: Record<string, unknown> = {};
          if (norm.author_profile_pic_url) patch.profile_pic_url = norm.author_profile_pic_url;
          if (norm.author_headline) patch.headline = norm.author_headline;
          const { error: metaErr } = await sb.from("accounts").update(patch).eq("id", acc.id);
          if (metaErr) {
            console.warn(`account meta update failed for ${acc.linkedin_handle}: ${metaErr.message}`);
          }
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
              document_manifest_url: norm.document_manifest_url,
              document_page_count: norm.document_page_count,
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
    // !inner + .is("accounts.archived_at", null) skips posts from archived
    // creators (no workspace tracks them anymore) so we don't burn Claude
    // calls on dead inventory.
    const { data: viralNeedingTpl } = await sb
      .from("posts")
      .select("id, text, reactions, comments, media_type, media_urls, visual_kind, accounts!inner(name, archived_at)")
      .eq("is_viral", true)
      .is("accounts.archived_at", null)
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

    // Hook extraction for every viral post that doesn't already have one.
    // Heuristic first (free, instant); Claude Haiku fallback for the
    // posts where the heuristic returns null. Pattern tagging happens in
    // the same call for fallbacks, and lazily otherwise (kept cheap by
    // batching with the fallback when possible).
    const { data: viralForHooks } = await sb
      .from("posts")
      .select("id, text, accounts!inner(name, archived_at)")
      .eq("is_viral", true)
      .is("accounts.archived_at", null)
      .not("text", "is", null);
    const hookCandidates = (viralForHooks ?? []).filter((p) => !!p.text);
    const hookIds = hookCandidates.map((p) => p.id);
    const { data: existingHooks } = hookIds.length
      ? await sb.from("hooks").select("post_id").in("post_id", hookIds)
      : { data: [] as { post_id: string }[] };
    const haveHooks = new Set((existingHooks ?? []).map((e) => e.post_id));
    const hookTodo = hookCandidates.filter((p) => !haveHooks.has(p.id));

    for (let i = 0; i < hookTodo.length; i++) {
      const p = hookTodo[i];
      const name = (p.accounts as unknown as { name?: string })?.name ?? "?";
      await persist({ phase: "hooks", phase_msg: `Hook ${i + 1}/${hookTodo.length} — ${name}` });
      try {
        const heuristic = extractHookHeuristic(p.text as string);
        if (heuristic) {
          // Got a clean heuristic hook — classify pattern with a cheap Haiku call
          let pattern: string | null = null;
          try {
            pattern = await classifyHookPattern(heuristic);
          } catch (e) {
            console.warn("hook pattern classify fail", p.id, (e as Error).message);
          }
          await sb.from("hooks").insert({
            post_id: p.id,
            hook_text: heuristic,
            pattern_tag: pattern,
            extracted_via: "heuristic",
          });
        } else {
          // Heuristic produced nothing usable — Claude fallback
          const { hook, pattern } = await extractHookWithClaude(p.text as string);
          await sb.from("hooks").insert({
            post_id: p.id,
            hook_text: hook,
            pattern_tag: pattern,
            extracted_via: "claude",
          });
        }
      } catch (e) {
        console.error("hook extract fail", p.id, (e as Error).message);
      }
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

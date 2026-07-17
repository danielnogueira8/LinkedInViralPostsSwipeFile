import { supabaseAdmin } from "./supabase";
import { runOneProfile, normalizePost } from "./apify";
import {
  getThresholds,
  score,
  getRelativeConfig,
  decideRelativeViral,
  classifyPostForAllWorkspaces,
} from "./viral";
import { classifyPost } from "./post-type";
import { extractHookWithClaude } from "./claude";
import {
  extractHookHeuristic,
  qualifiesForHookLibrary,
  normalizeHookForDedupe,
} from "./hooks";
import { decideScrapeGates, excludeRecentlyScrapedInResume } from "./scrape-gating";
import { SCRAPE_RUN_REPLACED_ERROR } from "./scrape-jobs";
import {
  postsNeedingEmbeddingForAccounts,
  embedAndStorePosts,
} from "./post-embeddings";
import { selectAllRows, selectInChunks, idChunks } from "./db-paginate";

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

async function pool<T>(
  items: T[],
  size: number,
  fn: (item: T, idx: number) => Promise<void>,
  // Checked before claiming each new item. Once true, in-flight work finishes
  // but no new item is started — lets a caller yield cleanly before a hard
  // platform timeout instead of being killed mid-write.
  shouldStop?: () => boolean,
): Promise<{ stoppedEarly: boolean }> {
  let i = 0;
  let stoppedEarly = false;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      if (shouldStop?.()) {
        stoppedEarly = true;
        return;
      }
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return { stoppedEarly };
}

// The route's maxDuration (app/api/cron/jobs/route.ts, 300s Vercel Pro max).
// This module has no way to read that config directly, so it's duplicated
// here as the wall-clock budget the scrape pool self-stops against — mirrors
// the identical pattern in lib/batch/pattern-brief.ts.
const CRON_BUDGET_MS = 300_000;
// Stop starting new account scrapes once this much of the budget remains.
// Generous margin: one in-flight Apify call can itself take real time, and
// downstream stages (viral stats, embeddings, hooks) still need to run after
// the scrape pool returns.
const CRON_DEADLINE_MARGIN_MS = 90_000;

export async function runDailyPipeline(
  workspaceId?: string,
  opts?: {
    runId?: string;
    // Testing seam: override the wall-clock start the deadline check measures
    // against. Defaults to now.
    startedAt?: number;
  },
): Promise<{ runId: string; postsCount: number; viralCount: number }> {
  const sb = supabaseAdmin();
  const pipelineStartedAt = opts?.startedAt ?? Date.now();
  let runId: string;
  if (opts?.runId) {
    runId = opts.runId;
    // Don't resurrect a run that claim_scrape_run stale-replaced: a newer
    // claim owns a fresh run + job, so resetting this one back to "running"
    // would execute the scrape twice (double Apify spend).
    const { data: existing, error: readErr } = await sb
      .from("runs")
      .select("status, error")
      .eq("id", runId)
      .maybeSingle();
    if (readErr) throw readErr;
    if (
      existing &&
      (existing as { error: string | null }).error === SCRAPE_RUN_REPLACED_ERROR
    ) {
      throw new Error(`Run ${runId} was superseded by a newer scrape claim; skipping duplicate scrape.`);
    }
    const { error: runErr } = await sb
      .from("runs")
      .update({
        workspace_id: workspaceId ?? null,
        status: "running",
        phase: "scraping",
        phase_msg: "Starting…",
        progress: [],
        posts_count: 0,
        viral_count: 0,
        error: null,
        started_at: new Date().toISOString(),
        finished_at: null,
      })
      .eq("id", runId);
    if (runErr) throw runErr;
  } else {
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
    runId = run.id;
  }

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
    const { error: persistError } = await sb.from("runs").update(update).eq("id", runId);
    if (persistError) {
      // Restore the dirty bit so the interval writer can retry a failed
      // progress-only update. Explicit phase/terminal callers still receive
      // the error and must not report a successful run.
      dirty = true;
      throw persistError;
    }
  }

  const interval = setInterval(() => { persist().catch(() => {}); }, 800);

  try {
    let trackedIds: string[] | null = null;
    if (workspaceId) {
      const { data: memberships, error: membershipError } = await sb
        .from("workspace_accounts")
        .select("account_id")
        .eq("workspace_id", workspaceId);
      if (membershipError) throw membershipError;
      trackedIds = (memberships ?? []).map((row) => row.account_id as string);
      if (trackedIds.length === 0) {
        clearInterval(interval);
        await persist({
          phase: "done",
          phase_msg: "No tracked accounts to scrape",
          finished: true,
          total: 0,
        });
        return { runId, postsCount: 0, viralCount: 0 };
      }
    }

    let accountQuery = sb
      .from("accounts")
      .select("id, profile_url, linkedin_handle, name")
      .is("archived_at", null);
    if (trackedIds) accountQuery = accountQuery.in("id", trackedIds);
    const { data: accounts, error: accErr } = await accountQuery.order("name");
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
    let toScrape = accounts.filter((a) => gateByAccount.get(a.id)?.scrape !== false);
    const skipped = accounts.filter((a) => gateByAccount.get(a.id)?.scrape === false);

    // A run resuming after a mid-flight kill (background-job stale sweep
    // reclaims + re-executes with the same runId) already paid Apify for
    // whatever it scraped before dying — GATE_HOURS's 36h cadence window is
    // too coarse to catch a same-run resume minutes later. Only applies when
    // this call carries a runId (a retry-capable invocation), never a fresh
    // ad-hoc/cron start.
    if (opts?.runId) {
      toScrape = await excludeRecentlyScrapedInResume(toScrape);
    }

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
    const thresholds = await getThresholds(workspaceId ?? null);
    const relConfig = getRelativeConfig();

    // Per-creator score history for relative virality (option 4). One batched
    // read up front instead of a query per creator: pull each scraped
    // account's stored posts (newest first), keyed by account_id. We carry the
    // linkedin_post_id so that, in-loop, we can exclude the post we're about to
    // (re)scrape from its own baseline — re-scraping an unchanged post would
    // otherwise let it count toward the median it's compared against.
    const priorByAccount = new Map<
      string,
      Array<{ linkedin_post_id: string; viral_score: number }>
    >();
    {
      const scrapeIds = toScrape.map((a) => a.id);
      if (scrapeIds.length > 0) {
        // We only need the most recent `window` posts per creator, so we group
        // and cap per-account in-memory (PostgREST has no per-group LIMIT).
        // Two size guards: CHUNK the account `.in()` (the global daily scrape
        // passes every account across all workspaces — a large `.in([...])`
        // 400s "URL too long"), and PAGE within each chunk (a single response
        // silently caps at 1000 rows).
        const PAGE = 1000;
        for (const accChunk of idChunks(scrapeIds)) {
          let from = 0;
          for (;;) {
            const { data: history, error: histErr } = await sb
              .from("posts")
              .select("account_id, linkedin_post_id, viral_score, posted_at")
              .in("account_id", accChunk)
              .order("posted_at", { ascending: false, nullsFirst: false })
              .range(from, from + PAGE - 1);
            if (histErr) {
              console.warn(`relative-viral history load failed: ${histErr.message}`);
              break;
            }
            const rows = history ?? [];
            for (const row of rows) {
              const accId = row.account_id as string;
              const arr = priorByAccount.get(accId) ?? [];
              // Keep a little more than `window` (window + 1) so that excluding
              // the current post (a re-scrape of an existing row) still leaves a
              // full window behind it.
              if (arr.length <= relConfig.window) {
                arr.push({
                  linkedin_post_id: row.linkedin_post_id as string,
                  viral_score: Number(row.viral_score ?? 0),
                });
                priorByAccount.set(accId, arr);
              }
            }
            if (rows.length < PAGE) break;
            from += PAGE;
            // Stop paging this chunk once every account IN THIS CHUNK already has
            // more than a full window of history — further pages can't change
            // any baseline for these accounts.
            if (
              accChunk.every(
                (id) => (priorByAccount.get(id)?.length ?? 0) > relConfig.window,
              )
            ) {
              break;
            }
          }
        }
      }
    }

    const { stoppedEarly } = await pool(
      toScrape,
      6,
      async (acc, idx) => {
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
        const vScore = score(norm.reactions, norm.comments, norm.reposts);
        // Relative virality: judge this post against the creator's own recent
        // baseline (median of prior scores), with a flat-threshold fallback
        // for creators without enough history and an absolute floor. Exclude
        // this post's own prior row (if it's a re-scrape) from the baseline.
        const priorScores = (priorByAccount.get(acc.id) ?? [])
          .filter((p) => p.linkedin_post_id !== norm.linkedin_post_id)
          .map((p) => p.viral_score);
        const decision = decideRelativeViral({
          score: vScore,
          reactions: norm.reactions,
          comments: norm.comments,
          priorScores,
          flatThresholds: thresholds,
          config: relConfig,
        });
        const viral = decision.viral;
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
              // Persist the relative-virality reasoning (migration 028) so the
              // UI can surface "Nx this creator's norm" without recomputing.
              viral_basis: decision.basis,
              baseline_score: decision.baseline,
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
        // Foundation for per-workspace classification (migration-075): dual-
        // write alongside the global is_viral column above. We await this —
        // previously it was fire-and-forget, but on Vercel the function can be
        // frozen/killed once the pipeline resolves, silently dropping pending
        // workspace_post_classification writes (same failure mode as the
        // account-meta patch above). Awaiting inside this pool worker keeps
        // the 6-wide scrape concurrency intact, and a failure still never
        // fails the scrape (classifyPostForAllWorkspaces never throws — it
        // logs a console.warn and returns).
        await classifyPostForAllWorkspaces(
          upserted.id as string,
          acc.id,
          norm.reactions,
          norm.comments,
        );
      } catch (e) {
        progress.set(acc.linkedin_handle, {
          ...progress.get(acc.linkedin_handle)!,
          status: "error", error: (e as Error).message, ended_at: Date.now(),
        });
        dirty = true;
      }
      },
      () => Date.now() - pipelineStartedAt > CRON_BUDGET_MS - CRON_DEADLINE_MARGIN_MS,
    );
    if (stoppedEarly) {
      console.warn(
        JSON.stringify({
          scrape_pipeline_deadline_hit: { runId, accountsAttempted: toScrape.length },
        }),
      );
    }

    // Refresh per-creator viral track record (migration 029) for the accounts
    // we just scraped, so the swipe card can show "viral N/M (X%)" without a
    // per-card or per-request aggregate. We tally is_viral over each scraped
    // account's posts in JS (PostgREST has no per-group COUNT) and write the
    // two counters back. Best-effort: a failure here never blocks the run.
    try {
      const scrapeIds = toScrape.map((a) => a.id);
      if (scrapeIds.length > 0) {
        const tally = new Map<string, { viral: number; total: number }>();
        const STATS_PAGE = 1000;
        // CHUNK the account `.in()` (unbounded on the global scrape) + PAGE each
        // chunk (1000-row cap).
        for (const accChunk of idChunks(scrapeIds)) {
          let sFrom = 0;
          for (;;) {
            const { data: statRows, error: statErr } = await sb
              .from("posts")
              .select("account_id, is_viral")
              .in("account_id", accChunk)
              .range(sFrom, sFrom + STATS_PAGE - 1);
            if (statErr) {
              console.warn(`account viral-stats load failed: ${statErr.message}`);
              break;
            }
            const rows = statRows ?? [];
            for (const r of rows) {
              const accId = r.account_id as string;
              const t = tally.get(accId) ?? { viral: 0, total: 0 };
              t.total += 1;
              if (r.is_viral) t.viral += 1;
              tally.set(accId, t);
            }
            if (rows.length < STATS_PAGE) break;
            sFrom += STATS_PAGE;
          }
        }
        // One UPDATE per account (small + keyed by PK). Run with bounded
        // concurrency so a large tracked set doesn't open hundreds of
        // connections at once.
        await pool([...tally.entries()], 8, async ([accId, t]) => {
          const { error: upErr } = await sb
            .from("accounts")
            .update({ viral_post_count: t.viral, total_post_count: t.total })
            .eq("id", accId);
          if (upErr) {
            console.warn(`account viral-stats update failed for ${accId}: ${upErr.message}`);
          }
        });
      }
    } catch (e) {
      console.warn(`account viral-stats refresh skipped: ${(e as Error).message}`);
    }

    // Embed newly-scraped/changed posts for the viral-learning retrieval loop
    // (migration-088). Batched once per run (not per-post) since embedding is
    // far cheaper batched. Only posts belonging to the accounts we just scraped
    // that lack an up-to-date embedding are embedded, so a re-scrape re-embeds
    // only bodies that actually changed. Best-effort: a failure here NEVER fails
    // the scrape — retrieval degrades to whatever's already embedded, and the
    // next run (or the backfill script) picks up the stragglers.
    try {
      const scrapeIds = toScrape.map((a) => a.id);
      const toEmbed = await postsNeedingEmbeddingForAccounts(scrapeIds);
      if (toEmbed.length > 0) {
        const embedded = await embedAndStorePosts(toEmbed);
        console.log(
          JSON.stringify({ pipeline_embed: { candidates: toEmbed.length, embedded } }),
        );
      }
    } catch (e) {
      console.warn(`post embedding skipped: ${(e as Error).message}`);
    }

    // NOTE: the daily auto-TEMPLATIZE step was removed here. It ran a paid
    // Haiku call on every viral post to write the old post-derived `templates`
    // table (a {placeholder} skeleton of one specific post). Nothing reads that
    // table anymore — the Templates page moved to the generic, workspace-owned
    // `content_templates` library (built-ins + user-authored), and users model a
    // real post via "Model in Chat" on the swipe file / Posts instead. The old
    // `templates` table is left in place (the landing-page "templates generated"
    // stat still counts its historical rows), but we no longer GENERATE into it.

    // Hook extraction for viral posts that QUALIFY for the library and don't
    // already have a hook. Heuristic first (free, instant); Claude Haiku
    // fallback for the posts where the heuristic returns null. Pattern tagging
    // happens in the same call for fallbacks, and lazily otherwise.
    //
    // The qualification gate (lib/hooks.ts) is post-type-aware: regular posts
    // need a high reaction floor AND must beat the creator's own norm; lead
    // magnets need a high comment floor. Gating BEFORE extraction means we
    // never burn a Claude call on a post that won't make the library.
    // Paginate: this reads the WHOLE global viral corpus. A bare select caps at
    // 1000 rows, which would silently freeze the hook library once the corpus
    // grows past 1000 viral posts.
    const viralForHooks = await selectAllRows<{
      id: string;
      text: string | null;
      post_type: string;
      reactions: number;
      comments: number;
      viral_score: number | null;
      viral_basis: string | null;
      baseline_score: number | null;
      accounts: unknown;
    }>(() =>
      sb
        .from("posts")
        .select(
          "id, text, post_type, reactions, comments, viral_score, viral_basis, baseline_score, accounts!inner(name, archived_at)",
        )
        .eq("is_viral", true)
        .is("accounts.archived_at", null)
        .not("text", "is", null),
    );
    const hookCandidates = viralForHooks
      .filter((p) => !!p.text)
      .filter((p) => qualifiesForHookLibrary(p));
    const hookIds = hookCandidates.map((p) => p.id);
    // Chunk the `.in()`: hookIds can be thousands, which would 400 (URL too long).
    const existingHooks = await selectInChunks<{ post_id: string }>(hookIds, (slice) =>
      sb.from("hooks").select("post_id").in("post_id", slice),
    );
    const haveHooks = new Set(existingHooks.map((e) => e.post_id));
    const hookTodo = hookCandidates.filter((p) => !haveHooks.has(p.id));

    // Dedupe near-identical hooks: seed the set with every hook already in the
    // library (normalized), then skip any candidate whose extracted opener
    // collapses to one we've already accepted — same creator reusing an
    // opener, or many creators copying the same template. Paginated — the hook
    // library also exceeds 1000 rows, which would leak duplicates otherwise.
    const allHookTexts = await selectAllRows<{ hook_text: string }>(() =>
      sb.from("hooks").select("hook_text"),
    );
    const seenHooks = new Set(
      allHookTexts.map((h) => normalizeHookForDedupe(h.hook_text)),
    );

    for (let i = 0; i < hookTodo.length; i++) {
      const p = hookTodo[i];
      const name = (p.accounts as unknown as { name?: string })?.name ?? "?";
      await persist({ phase: "hooks", phase_msg: `Hook ${i + 1}/${hookTodo.length} — ${name}` });
      try {
        const heuristic = extractHookHeuristic(p.text as string);
        if (heuristic) {
          // Dedupe: skip if a near-identical opener is already in the library.
          const key = normalizeHookForDedupe(heuristic);
          if (seenHooks.has(key)) continue;
          // Got a clean heuristic hook — no pattern classification (dropped:
          // the pattern tag wasn't useful, and skipping it saves a Haiku call).
          await sb.from("hooks").insert({
            post_id: p.id,
            hook_text: heuristic,
            extracted_via: "heuristic",
            post_type: p.post_type ?? "regular",
          });
          seenHooks.add(key);
        } else {
          // Heuristic produced nothing usable — Claude fallback (we still use
          // it to extract the opener, but ignore the pattern it returns).
          const { hook } = await extractHookWithClaude(p.text as string);
          const key = normalizeHookForDedupe(hook);
          if (seenHooks.has(key)) continue;
          await sb.from("hooks").insert({
            post_id: p.id,
            hook_text: hook,
            extracted_via: "claude",
            post_type: p.post_type ?? "regular",
          });
          seenHooks.add(key);
        }
      } catch (e) {
        console.error("hook extract fail", p.id, (e as Error).message);
      }
    }

    clearInterval(interval);
    // A run that attempted at least one account but scraped zero posts (every
    // account errored or came back with no data) is a failure, not a success —
    // otherwise latestRelevantScrape() treats a wasted Apify call as fresh data.
    const allFailed = toScrape.length > 0 && postsCount === 0;
    await persist({
      phase: allFailed ? "error" : "done",
      phase_msg: allFailed ? "All accounts failed or returned no data" : "Done",
      finished: true,
      error: allFailed ? "all accounts failed or returned no data" : undefined,
    });
    return { runId, postsCount, viralCount };
  } catch (e) {
    clearInterval(interval);
    await persist({ phase: "error", phase_msg: (e as Error).message, finished: true, error: (e as Error).message });
    throw e;
  }
}

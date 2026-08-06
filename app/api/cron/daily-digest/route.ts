import { NextResponse } from "next/server";
import { cronAuthorizationResponse, isCronAuthorized } from "../_auth";
import { supabaseAdmin } from "@/lib/supabase";
import { selectAllRows, selectInChunks } from "@/lib/db-paginate";
import {
  CHAT_MODEL,
  completeChat,
  logOpenRouterUsage,
  openRouterUsageCost,
} from "@/lib/openrouter";
import {
  DIGEST_MAX_OUTPUT_TOKENS,
  DIGEST_SYSTEM_PROMPT,
  digestWindow,
  planDigest,
  type DigestPost,
} from "@/lib/daily-digest";

// ---------------------------------------------------------------------------
// Daily swipe-file digest: one LLM call per workspace over today's posts.
//
// Runs after the daily scrape (00:00 UTC) so it analyses a complete day rather
// than a partial one.
//
// Cost is the point of this build, so the guards are cost guards:
//   - MIN_POSTS_FOR_DIGEST skips quiet days entirely (no call, no charge)
//   - MAX_POSTS_PER_DIGEST bounds the worst case per workspace
//   - the unique (workspace_id, digest_date) key makes a retry an upsert
//     instead of a second paid call
//   - every call logs to usage_events AND denormalizes cost onto the row
//
// Measured: ~173 input tokens per post. The first production run billed
// ~$0.0034 per workspace at ~4k input tokens — and returned nothing, because
// reasoning consumed the whole output budget (see DIGEST_MAX_OUTPUT_TOKENS).
// Expect real cost to land ABOVE the original $0.005/100-post estimate now that
// the budget fits both the reasoning pass and the answer; the log line reports
// reasoning_tokens so the split is visible.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Per-tick workspace cap.
 *
 * A 300s function budget against a call that takes a few seconds; this leaves
 * generous headroom and bounds the spend of any single tick while the feature
 * is being cost-tested. Workspaces beyond the cap are picked up by the next
 * run (see the already-digested filter below, which makes that safe).
 */
const MAX_WORKSPACES_PER_TICK = 40;

type PostRow = {
  id: string;
  account_id: string;
  text: string | null;
  reactions: number | null;
  comments: number | null;
  posted_at: string | null;
};

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) return cronAuthorizationResponse();

  const db = supabaseAdmin();
  const now = new Date();
  const { scrapedFrom, scrapedTo, postedFrom, digestDate } = digestWindow(now);
  const url = new URL(request.url);
  const requested = url.searchParams.get("workspace");
  // Dry run: plan and report WITHOUT calling the model. The whole point of
  // shipping this is to measure cost, and being able to see the post counts a
  // real run would have used — before paying for it — is the cheapest way to
  // sanity-check the estimate against production data.
  const dryRun = url.searchParams.get("dry") === "1";

  // Which workspaces already have today's digest. Read up front so a re-run
  // (recovery, manual trigger, double fire) never pays twice — the unique key
  // would catch the write, but only after the model call was already billed.
  const existing = new Set(
    (
      await selectAllRows<{ workspace_id: string }>(() =>
        db
          .from("daily_digests")
          .select("workspace_id")
          .eq("digest_date", digestDate) as never,
      ).catch(() => [])
    ).map((row) => row.workspace_id),
  );

  const workspaceIds = requested
    ? [requested]
    : [
        ...new Set(
          (
            await selectAllRows<{ workspace_id: string }>(() =>
              db
                .from("workspace_accounts")
                .select("workspace_id") as never,
            )
          ).map((row) => row.workspace_id),
        ),
      ]
        .filter((id) => !existing.has(id))
        .sort()
        .slice(0, MAX_WORKSPACES_PER_TICK);

  const results: Array<Record<string, unknown>> = [];
  let totalCost = 0;
  let totalReasoningTokens = 0;

  for (const workspaceId of workspaceIds) {
    try {
      const accountIds = (
        await selectAllRows<{ account_id: string }>(() =>
          db
            .from("workspace_accounts")
            .select("account_id")
            .eq("workspace_id", workspaceId) as never,
        )
      ).map((row) => row.account_id);
      if (accountIds.length === 0) {
        results.push({ workspaceId, skipped: "no_accounts" });
        continue;
      }

      // Posts that ARRIVED today for this workspace's tracked creators.
      //
      // Anchored on scraped_at, not posted_at: the scrape pulls each creator's
      // most recent post whatever its age, so filtering on publish date found
      // almost nothing and skipped every workspace. posted_at still bounds the
      // other side, because the pipeline refreshes scraped_at on every upsert —
      // without it, a re-scraped week-old post would read as today's news.
      //
      // Chunked because the account `.in()` can otherwise exceed PostgREST's
      // URL limit, and paged because a busy day across 50 creators can pass the
      // 1000-row cap.
      const rows = await selectInChunks<PostRow>(accountIds, (ids) =>
        db
          .from("posts")
          .select("id, account_id, text, reactions, comments, posted_at")
          .in("account_id", ids)
          .gte("scraped_at", scrapedFrom)
          .lt("scraped_at", scrapedTo)
          .gte("posted_at", postedFrom) as never,
      );

      const posts: DigestPost[] = rows.map((row) => ({
        id: row.id,
        author: null,
        niche: null,
        text: row.text,
        reactions: row.reactions,
        comments: row.comments,
      }));

      const plan = planDigest(posts);
      if (!plan.run) {
        results.push({
          workspaceId,
          skipped: plan.reason,
          postCount: plan.postCount,
        });
        continue;
      }
      if (dryRun) {
        results.push({
          workspaceId,
          wouldRun: true,
          postCount: plan.posts.length,
          promptChars: plan.prompt.length,
        });
        continue;
      }

      const completion = await completeChat({
        model: CHAT_MODEL,
        maxTokens: DIGEST_MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: DIGEST_SYSTEM_PROMPT },
          { role: "user", content: plan.prompt },
        ],
      });

      const content = completion.text?.trim() ?? "";
      // Log the spend even when the model returned nothing usable: the call was
      // billed either way, and a digest run that quietly costs money without
      // producing a row is exactly the kind of thing that hides.
      await logOpenRouterUsage(
        "daily_digest",
        completion.model || CHAT_MODEL,
        completion.usage,
        workspaceId,
        { digest_date: digestDate, post_count: plan.posts.length },
      );
      // usage.cost is NEVER set on the OpenAI path (openrouter.ts:1218), and
      // Luna routes there — reading it directly reported $0 for a run that had
      // really been billed. openRouterUsageCost computes from tokens when the
      // provider omits an exact cost, which is the same helper
      // logOpenRouterUsage uses internally, so the row and usage_events agree.
      const { inputTokens, outputTokens, costUsd } = openRouterUsageCost(
        completion.model || CHAT_MODEL,
        completion.usage,
      );
      totalCost += costUsd;
      totalReasoningTokens +=
        completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

      if (!content) {
        // Report the reasoning split, not just "empty". The first empty run
        // billed real money and the log said only `empty_completion`, which
        // does not distinguish a refusal from a budget starved by reasoning —
        // and reasoning was the cause. With these numbers the same failure
        // names itself: reasoning ≈ output means the cap was consumed before
        // any visible text.
        const reasoningTokens =
          completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        console.error(
          "[daily-digest:empty]",
          workspaceId,
          JSON.stringify({
            finish_reason: completion.finishReason,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            reasoning_tokens: reasoningTokens,
            max_output_tokens: DIGEST_MAX_OUTPUT_TOKENS,
          }),
        );
        results.push({
          workspaceId,
          error: "empty_completion",
          inputTokens,
          outputTokens,
          reasoningTokens,
          finishReason: completion.finishReason,
        });
        continue;
      }

      const { error: writeError } = await db.from("daily_digests").upsert(
        {
          workspace_id: workspaceId,
          digest_date: digestDate,
          content,
          post_count: plan.posts.length,
          model: completion.model || CHAT_MODEL,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: costUsd,
        },
        { onConflict: "workspace_id,digest_date" },
      );
      if (writeError) {
        console.error("[daily-digest:write]", workspaceId, writeError.message);
        results.push({ workspaceId, error: "write_failed" });
        continue;
      }

      results.push({
        workspaceId,
        written: true,
        postCount: plan.posts.length,
        inputTokens,
        outputTokens,
        costUsd,
      });
    } catch (error) {
      // One workspace's failure must not abort the sweep for the rest.
      console.error("[daily-digest:workspace]", workspaceId, error);
      results.push({ workspaceId, error: "failed" });
    }
  }

  // Logged as one line so a single Vercel log entry answers "what did today's
  // digests cost", which is the question this feature was built to test.
  console.log(
    JSON.stringify({
      daily_digest: {
        digest_date: digestDate,
        dry_run: dryRun,
        workspaces: workspaceIds.length,
        // Count the explicit written flag, NOT "has a postCount". Skipped
        // results carry postCount too, so the old predicate reported 9 skips as
        // 9 successful digests — a run that wrote nothing and cost nothing
        // looked healthy in the log.
        written: results.filter((r) => r.written === true).length,
        // Why the rest were skipped, so a silent all-skip run explains itself
        // in the same line instead of needing an investigation.
        skipped: results.reduce<Record<string, number>>((acc, r) => {
          const reason =
            typeof r.skipped === "string"
              ? r.skipped
              : r.error
                ? `error:${String(r.error)}`
                : null;
          if (reason) acc[reason] = (acc[reason] ?? 0) + 1;
          return acc;
        }, {}),
        // Reasoning is the dominant output cost on Luna (effort is forced to
        // "high" for gpt-5* models), so it belongs in the one line that
        // answers "what did digests cost today".
        reasoning_tokens: totalReasoningTokens,
        total_cost_usd: Number(totalCost.toFixed(6)),
      },
    }),
  );

  return NextResponse.json({
    ok: true,
    digestDate,
    dryRun,
    totalCostUsd: Number(totalCost.toFixed(6)),
    results,
  });
}

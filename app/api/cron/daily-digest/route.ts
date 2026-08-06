import { NextResponse } from "next/server";
import { cronAuthorizationResponse, isCronAuthorized } from "../_auth";
import { supabaseAdmin } from "@/lib/supabase";
import { selectAllRows, selectInChunks } from "@/lib/db-paginate";
import { CHAT_MODEL, completeChat, logOpenRouterUsage } from "@/lib/openrouter";
import {
  DIGEST_MAX_OUTPUT_TOKENS,
  DIGEST_SYSTEM_PROMPT,
  planDigest,
  utcDayBounds,
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
// Measured: ~173 input tokens per post, ~$0.005 for a 100-post day on Luna.
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
  const { from, to } = utcDayBounds(now);
  const digestDate = from.slice(0, 10);
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

      // Today's posts for this workspace's tracked creators. Chunked because
      // the account `.in()` can otherwise exceed PostgREST's URL limit, and
      // paged because a busy day across 50 creators can pass the 1000-row cap.
      const rows = await selectInChunks<PostRow>(accountIds, (ids) =>
        db
          .from("posts")
          .select("id, account_id, text, reactions, comments, posted_at")
          .in("account_id", ids)
          .gte("posted_at", from)
          .lt("posted_at", to) as never,
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
      const inputTokens = completion.usage?.prompt_tokens ?? null;
      const outputTokens = completion.usage?.completion_tokens ?? null;
      const costUsd = completion.usage?.cost ?? null;
      if (typeof costUsd === "number") totalCost += costUsd;

      if (!content) {
        results.push({ workspaceId, error: "empty_completion", inputTokens, outputTokens });
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
        written: results.filter((r) => typeof r.postCount === "number" && !r.error && !r.wouldRun)
          .length,
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

import { NextResponse } from "next/server";
import { NotAdminError, requireAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { errorResponse } from "@/lib/workspace";
import {
  planPostTypeBackfill,
  type ClassifiablePost,
} from "@/lib/post-type-backfill";

// -----------------------------------------------------------------------------
// Re-run the lead-magnet classifier over stored posts, from production.
//
// The same job as scripts/backfill-post-type.ts, reachable where the Supabase
// service-role key actually lives. The script needs a local .env.local; this
// needs nothing but the secret you already have.
//
// DELIBERATELY NOT IN vercel.json. A backfill is a one-time correction, not a
// schedule — wiring it to a cron would re-scan the whole table forever to find
// nothing, and would keep a bulk-write endpoint firing unattended. Trigger it
// by hand:
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "https://<host>/api/internal/backfill-post-type"            # dry run
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
//     "https://<host>/api/internal/backfill-post-type?apply=1"    # writes
//
// GET can only ever plan. Writing requires POST *and* apply=1, so no URL
// pasted into a browser can change data.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const READ_PAGE = 1000;
const WRITE_CHUNK = 200;
// Leave room under the 300s ceiling for the writes and the response. A run that
// hits this stops cleanly and reports where it stopped, so the next call can
// resume with ?from=.
const TIME_BUDGET_MS = 240_000;

function authorizedBySecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

async function run(req: Request, canWrite: boolean) {
  const startedAt = Date.now();
  try {
    if (!authorizedBySecret(req)) {
      await requireAdmin();
    }
    const url = new URL(req.url);
    const apply = canWrite && url.searchParams.get("apply") === "1";
    const includeDemotions = url.searchParams.get("demotions") === "1";
    const from = Math.max(0, Number(url.searchParams.get("from") ?? 0) || 0);
    const limitParam = Number(url.searchParams.get("limit"));
    const cap =
      Number.isFinite(limitParam) && limitParam > 0
        ? limitParam
        : Number.POSITIVE_INFINITY;

    const sb = supabaseAdmin();
    const promote: string[] = [];
    const demote: string[] = [];
    const samples: string[] = [];
    let unchanged = 0;
    let scanned = 0;
    let offset = from;
    let exhausted = false;

    for (;;) {
      if (scanned >= cap || Date.now() - startedAt > TIME_BUDGET_MS) break;
      const remaining =
        cap === Number.POSITIVE_INFINITY
          ? READ_PAGE
          : Math.min(READ_PAGE, cap - scanned);
      const { data, error } = await sb
        .from("posts")
        .select("id, text, post_type")
        .order("id", { ascending: true })
        .range(offset, offset + remaining - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as ClassifiablePost[];
      if (rows.length === 0) {
        exhausted = true;
        break;
      }

      const plan = planPostTypeBackfill(rows);
      promote.push(...plan.promote);
      demote.push(...plan.demote);
      unchanged += plan.unchanged;
      scanned += rows.length;
      offset += rows.length;

      // Real examples so the counts can be judged before anything is written:
      // a pattern that is too loose shows up here as ordinary prose.
      for (const id of plan.promote) {
        if (samples.length >= 15) break;
        const row = rows.find((r) => r.id === id);
        if (row?.text) samples.push(row.text.replace(/\s+/g, " ").slice(0, 140));
      }

      if (rows.length < remaining) {
        exhausted = true;
        break;
      }
    }

    let promoted = 0;
    let demoted = 0;
    if (apply) {
      const writes: Array<{ ids: string[]; type: "lead_magnet" | "regular" }> = [
        { ids: promote, type: "lead_magnet" },
      ];
      if (includeDemotions) writes.push({ ids: demote, type: "regular" });
      for (const { ids, type } of writes) {
        for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
          const chunk = ids.slice(i, i + WRITE_CHUNK);
          const { error } = await sb
            .from("posts")
            .update({ post_type: type, post_type_detected_via: "regex" })
            .in("id", chunk);
          if (error) throw new Error(error.message);
          if (type === "lead_magnet") promoted += chunk.length;
          else demoted += chunk.length;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      mode: apply ? "applied" : "dry_run",
      scanned,
      unchanged,
      wouldPromote: promote.length,
      wouldDemote: demote.length,
      demotionsIncluded: includeDemotions,
      promoted,
      demoted,
      // Where to resume from when a run runs out of time mid-corpus.
      exhausted,
      nextFrom: exhausted ? null : offset,
      durationMs: Date.now() - startedAt,
      samples,
    });
  } catch (e) {
    if (e instanceof NotAdminError) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    return errorResponse(e);
  }
}

/** Plan only. A GET can never write, whatever query string it carries. */
export async function GET(req: Request) {
  return run(req, false);
}

/** The only path that can write, and only with ?apply=1. */
export async function POST(req: Request) {
  return run(req, true);
}

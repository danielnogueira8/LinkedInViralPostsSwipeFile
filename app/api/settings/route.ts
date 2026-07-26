import { NextResponse } from "next/server";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { selectAllRows } from "@/lib/db-paginate";
import { z } from "zod";
import {
  DEFAULT_DISCOVERY_THRESHOLDS,
  normalizeDiscoveryThresholds,
} from "@/lib/discovery-thresholds";

export const runtime = "nodejs";

const pairSchema = z.object({
  min_reactions: z.number().int().min(0),
  min_comments: z.number().int().min(0),
});

const bodySchema = z.object({
  viral: pairSchema,
  template: pairSchema,
  discovery: z
    .object({
      regular: z.object({
        enabled: z.boolean(),
        minLikes: z.number().int().min(0),
      }),
      leadMagnet: z.object({
        enabled: z.boolean(),
        minComments: z.number().int().min(0),
      }),
    })
    .default(DEFAULT_DISCOVERY_THRESHOLDS),
});

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data } = await sb
      .settings()
      .in("key", ["viral_thresholds", "template_thresholds", "discovery_thresholds"]);
    const byKey = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
    // Fallbacks must match DEFAULT_VIRAL / DEFAULT_TEMPLATE in lib/viral.ts so
    // a workspace that never changed its settings sees the SAME numbers here
    // (settings page) and in the pipeline (is_viral evaluation).
    return NextResponse.json({
      ok: true,
      viral: byKey.viral_thresholds ?? { min_reactions: 50, min_comments: 50 },
      template: byKey.template_thresholds ?? { min_reactions: 500, min_comments: 100 },
      discovery: normalizeDiscoveryThresholds(
        byKey.discovery_thresholds ?? DEFAULT_DISCOVERY_THRESHOLDS,
      ),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    const sb = await scopedSupabase();

    const [r1, r2, r3] = await Promise.all([
      sb.upsertSetting("viral_thresholds", parsed.data.viral),
      sb.upsertSetting("template_thresholds", parsed.data.template),
      sb.upsertSetting("discovery_thresholds", parsed.data.discovery),
    ]);
    if (r1.error || r2.error || r3.error) {
      return errorResponse(r1.error || r2.error || r3.error);
    }

    // Finding #9 fix — DO NOT bulk-UPDATE the global posts.is_viral here.
    //
    // posts.is_viral is a SHARED, GLOBAL column: it is stamped once at ingest
    // by the pipeline classifier (lib/viral.ts / lib/pipeline.ts) and is the
    // Swipe File's contract (#1447 — the Swipe File is DEFINED by the global
    // gate). Two workspaces commonly track the same creator, so a per-workspace
    // threshold change that wrote the global column would overwrite the is_viral
    // flag every OTHER workspace (and the Swipe File) reads for those posts —
    // the cross-workspace contamination. Worse, a stricter workspace flipping
    // global is_viral=false starved the resilient agent/MCP readers of another
    // workspace (they gate on global is_viral=true first).
    //
    // The correct scope for a per-workspace threshold decision is this
    // workspace's own rows in workspace_post_classification (written below),
    // which the resilient #1447 readers (lib/agent/tools.ts, lib/mcp/register.ts,
    // lib/insights-query.ts) honor as an override: global base, minus the posts
    // THIS workspace demoted. Ingest keeps stamping the global column as before,
    // so the Swipe File's global-gate contract is untouched.
    const accountIds = await trackedAccountIds(sb.workspaceId);
    if (accountIds.length > 0) {
      const { min_reactions, min_comments } = parsed.data.viral;

      // Reclassify workspace_post_classification for THIS workspace's own
      // tracked posts. Scoped strictly to sb.workspaceId, so it can NEVER
      // affect another workspace's rows — that isolation is the entire point
      // of this table, and now the ONLY thing a threshold change writes (the
      // global posts.is_viral bulk update that used to sit above this block was
      // the contamination and has been removed). Best-effort: nothing here
      // should block the settings save the user is actually waiting on.
      // Paginated: a workspace with more than 1000 tracked posts would
      // otherwise only get the first 1000 reclassified on a threshold change
      // (the silent 1000-row cap). accountIds is a single workspace's ~50
      // tracked accounts, so the `.in()` itself is well under the URL limit.
      let ownPosts: Array<{ id: string; reactions: number | null; comments: number | null }>;
      try {
        ownPosts = await selectAllRows(() =>
          sb.raw.from("posts").select("id, reactions, comments").in("account_id", accountIds),
        );
      } catch (e) {
        console.warn(
          `workspace_post_classification read failed for ${sb.workspaceId}: ${(e as Error).message}`,
        );
        ownPosts = [];
      }
      if (ownPosts.length) {
        const rows = ownPosts.map((p) => ({
          workspace_id: sb.workspaceId,
          post_id: p.id,
          is_viral:
            (p.reactions ?? 0) >= min_reactions || (p.comments ?? 0) >= min_comments,
          viral_basis: "flat_threshold",
          computed_at: new Date().toISOString(),
        }));
        const { error: classifyErr } = await sb.raw
          .from("workspace_post_classification")
          .upsert(rows, { onConflict: "workspace_id,post_id" });
        if (classifyErr) {
          console.warn(
            `workspace_post_classification bulk reclassify failed for ${sb.workspaceId}: ${classifyErr.message}`,
          );
        }
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

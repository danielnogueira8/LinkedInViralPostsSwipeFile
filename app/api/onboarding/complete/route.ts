import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { z } from "zod";
import { errorResponse } from "@/lib/workspace";
import { enqueueScrapeJob } from "@/lib/scrape-jobs";
import { timeZoneSchema } from "@/lib/schedule-local-date";
import { TrackedCreatorError, TrackedCreators } from "@/lib/tracked-creators";
import { createSupabaseTrackedCreatorsRepository } from "@/lib/tracked-creators-supabase";

export const runtime = "nodejs";

const bodySchema = z.object({
  category_ids: z.array(z.string()).optional().default([]),
  timezone: timeZoneSchema.optional().default("UTC"),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const { category_ids, timezone } = parsed.data;
    const sb = await scopedSupabase();

    let tracked = 0;
    let scrape: { runId: string; alreadyRunning: boolean } | null = null;
    if (category_ids.length > 0) {
      const creators = new TrackedCreators(
        createSupabaseTrackedCreatorsRepository(sb.raw, sb.workspaceId),
      );
      tracked = await creators.setCategoriesTracked({
        categoryIds: category_ids,
        tracked: true,
      });
      if (tracked > 0) {
        // Tracking is only the ownership association. Queue the workspace
        // scrape immediately so the same scoped Swipefile used by modeling and
        // weekly planning receives posts without waiting for the daily cron.
        const queued = await enqueueScrapeJob({ workspaceId: sb.workspaceId, sb: sb.raw });
        scrape = { runId: queued.runId, alreadyRunning: queued.alreadyRunning };
      }
    }

    // Provision the recurring queue at the durable workspace-completion
    // boundary. The posting-slots GET and queue endpoints retain the same RPC
    // as a repair path for existing or partially onboarded workspaces.
    const { error: slotsError } = await sb.raw.rpc("ensure_posting_slots", {
      p_workspace_id: sb.workspaceId,
      p_timezone: timezone,
    });
    if (slotsError) throw slotsError;

    const { error: setErr } = await sb.upsertSetting("onboarded_at", {
      at: new Date().toISOString(),
    });
    if (setErr) throw setErr;

    return NextResponse.json({ ok: true, tracked, scrape });
  } catch (e) {
    if (e instanceof TrackedCreatorError) {
      return NextResponse.json(
        { ok: false, error: e.message, code: e.code },
        { status: e.status },
      );
    }
    return errorResponse(e);
  }
}

import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { z } from "zod";
import { errorResponse } from "@/lib/workspace";
import { enqueueScrapeJob } from "@/lib/scrape-jobs";
import { timeZoneSchema } from "@/lib/schedule-local-date";

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
      const { data: rows, error: selErr } = await sb.raw
        .from("accounts")
        .select("id")
        .in("category_id", category_ids)
        // Skip soft-deleted creators — tracking an archived account would
        // create a dangling membership that renders nowhere (every read path
        // filters `archived_at is null`).
        .is("archived_at", null);
      if (selErr) throw selErr;
      const accountIds = (rows ?? []).map((r) => r.id as string);
      if (accountIds.length > 0) {
        const upserts = accountIds.map((account_id) => ({
          workspace_id: sb.workspaceId,
          account_id,
          niche: null,
        }));
        const { error: trackErr } = await sb.raw
          .from("workspace_accounts")
          .upsert(upserts, { onConflict: "workspace_id,account_id" });
        if (trackErr) throw trackErr;
        tracked = accountIds.length;
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
    return errorResponse(e);
  }
}

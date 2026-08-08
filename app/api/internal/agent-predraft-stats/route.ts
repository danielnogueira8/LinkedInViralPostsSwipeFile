import { NextResponse } from "next/server";
import { NotAdminError, requireAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { errorResponse } from "@/lib/workspace";
import { AGENT_SUGGESTED_BY } from "@/lib/agent-loop/constants";
import {
  PREDRAFT_SETTLE_MS,
  summarizeAgentDraftOutcomes,
  type AgentDraftOutcomeRow,
} from "@/lib/agent-loop/predraft-metrics";
import type { ScheduleStatus } from "@/lib/draft-view";

// -----------------------------------------------------------------------------
// Read side of pre-drafting (step 3 of autonomous daily posts).
//
// Answers the two questions that decide whether AGENT_PREDRAFT_DAILY_CAP goes
// up: are people scheduling these drafts, and are they scheduling them
// unedited. usage_events can say what the drafts COST but not whether anyone
// wanted them, which is the thing actually in question.
//
// Fleet-wide by design — the decision is a product one, not per workspace — so
// it is admin-or-CRON_SECRET like /api/internal/cron-stats, never user-facing.
// Read only.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_WINDOW_DAYS = 30;
const MAX_ROWS = 5000;

function authorizedBySecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return (
    !!secret && req.headers.get("authorization") === `Bearer ${secret}`
  );
}

export async function GET(req: Request) {
  try {
    if (!authorizedBySecret(req)) {
      await requireAdmin();
    }
    const url = new URL(req.url);
    const days = Math.min(
      Math.max(Number(url.searchParams.get("days")) || DEFAULT_WINDOW_DAYS, 1),
      365,
    );
    const workspace = url.searchParams.get("workspace");
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const db = supabaseAdmin();

    let query = db
      .from("chat_artifacts")
      .select("id, created_at, schedule_status")
      .eq("meta->>suggested_by", AGENT_SUGGESTED_BY)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS);
    if (workspace) query = query.eq("workspace_id", workspace);
    const { data: drafts, error } = await query;
    if (error) throw error;

    const rows = (drafts ?? []) as Array<{
      id: string;
      created_at: string;
      schedule_status: ScheduleStatus;
    }>;

    // Edits are counted per draft rather than joined: draft_edit_events holds
    // full before/after bodies, and pulling those back to compute a count
    // would move megabytes to answer a boolean-ish question.
    const editCounts = new Map<string, number>();
    if (rows.length > 0) {
      const { data: edits, error: editError } = await db
        .from("draft_edit_events")
        .select("artifact_id")
        .in(
          "artifact_id",
          rows.map((row) => row.id),
        );
      if (editError) throw editError;
      for (const edit of (edits ?? []) as Array<{ artifact_id: string }>) {
        editCounts.set(
          edit.artifact_id,
          (editCounts.get(edit.artifact_id) ?? 0) + 1,
        );
      }
    }

    const outcomes: AgentDraftOutcomeRow[] = rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      scheduleStatus: row.schedule_status,
      editCount: editCounts.get(row.id) ?? 0,
    }));

    return NextResponse.json({
      ok: true,
      windowDays: days,
      settleHours: PREDRAFT_SETTLE_MS / 3_600_000,
      truncated: rows.length >= MAX_ROWS,
      ...summarizeAgentDraftOutcomes(outcomes),
    });
  } catch (e) {
    if (e instanceof NotAdminError) {
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      );
    }
    return errorResponse(e);
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { AGENT_SUGGESTED_BY } from "@/lib/agent-loop/constants";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// POST /api/agent/briefing/reviewed — mark one agent-suggested draft as
// reviewed so it drops off the "Drafts ready for review" list and STAYS gone
// across reloads (the review click otherwise only hid it for the session).
//
// The flag lives in the artifact's existing `meta` JSONB (meta.reviewed_at), so
// there is no migration: the briefing GET filters `meta->>reviewed_at IS NULL`.
// Scoped + guarded so this can only stamp the workspace's own agent drafts.
// -----------------------------------------------------------------------------
const bodySchema = z.object({
  draftId: z.string().uuid(),
});

export async function POST(req: Request) {
  try {
    const { draftId } = bodySchema.parse(await req.json());
    const sb = await scopedSupabase();

    // Read the current meta so we merge (never clobber suggested_by et al.).
    // Guard on workspace + agent-authorship: a non-agent or foreign draft is a
    // no-op 404, not an update.
    const { data: draft, error: readError } = await sb.raw
      .from("chat_artifacts")
      .select("id, meta")
      .eq("id", draftId)
      .eq("workspace_id", sb.workspaceId)
      .eq("meta->>suggested_by", AGENT_SUGGESTED_BY)
      .maybeSingle();
    if (readError) throw readError;
    if (!draft) {
      return NextResponse.json(
        { ok: false, error: "Draft not found" },
        { status: 404 },
      );
    }

    // Idempotent: if it already carries a reviewed_at, keep the original stamp.
    const meta = (draft.meta ?? {}) as Record<string, unknown>;
    if (typeof meta.reviewed_at === "string" && meta.reviewed_at) {
      return NextResponse.json({ ok: true, reviewed_at: meta.reviewed_at });
    }

    const reviewedAt = new Date().toISOString();
    const { error: updateError } = await sb.raw
      .from("chat_artifacts")
      .update({ meta: { ...meta, reviewed_at: reviewedAt } })
      .eq("id", draftId)
      .eq("workspace_id", sb.workspaceId);
    if (updateError) throw updateError;

    return NextResponse.json({ ok: true, reviewed_at: reviewedAt });
  } catch (e) {
    return errorResponse(e);
  }
}

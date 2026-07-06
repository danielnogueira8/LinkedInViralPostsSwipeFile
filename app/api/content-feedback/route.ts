import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  contentFeedbackInputSchema,
  type ContentFeedback,
} from "@/lib/content-feedback";

export const runtime = "nodejs";

const FEEDBACK_COLS =
  "id, workspace_id, chat_id, artifact_id, draft_id, rating, reasons, note, body_snapshot, created_at";

export async function POST(req: Request) {
  try {
    const parsed = contentFeedbackInputSchema.safeParse(
      await req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: parsed.error.issues[0]?.message ?? "Invalid feedback",
        },
        { status: 400 },
      );
    }

    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("content_feedback")
      .insert({
        workspace_id: sb.workspaceId,
        ...parsed.data,
      })
      .select(FEEDBACK_COLS)
      .single();
    if (error) throw error;

    return NextResponse.json({
      ok: true,
      feedback: data as ContentFeedback,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

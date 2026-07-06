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
const FEEDBACK_LIST_DEFAULT_LIMIT = 20;
const FEEDBACK_LIST_MAX_LIMIT = 50;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rating = url.searchParams.get("rating");
    if (rating && rating !== "up" && rating !== "down") {
      return NextResponse.json(
        { ok: false, error: "rating must be up or down" },
        { status: 400 },
      );
    }

    const limitRaw = url.searchParams.get("limit");
    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : FEEDBACK_LIST_DEFAULT_LIMIT;
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), FEEDBACK_LIST_MAX_LIMIT)
      : FEEDBACK_LIST_DEFAULT_LIMIT;

    const sb = await scopedSupabase();
    let query = sb.raw
      .from("content_feedback")
      .select(FEEDBACK_COLS)
      .eq("workspace_id", sb.workspaceId);

    if (rating) query = query.eq("rating", rating);

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    return NextResponse.json({
      ok: true,
      feedback: (data ?? []) as ContentFeedback[],
    });
  } catch (e) {
    return errorResponse(e);
  }
}

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

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

type ScopedSupabase = Awaited<ReturnType<typeof scopedSupabase>>;
type ParsedFeedbackInput = ReturnType<typeof contentFeedbackInputSchema.parse>;
type StoredArtifact = { id?: string } & Record<string, unknown>;

async function validateFeedbackSubject(
  sb: ScopedSupabase,
  input: ParsedFeedbackInput,
): Promise<
  | { ok: true; input: ParsedFeedbackInput }
  | { ok: false; response: NextResponse }
> {
  if (!input.draft_id && !input.chat_id && !input.artifact_id) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Feedback must reference a draft or chat." },
        { status: 400 },
      ),
    };
  }

  let trustedChatId = input.chat_id;
  if (input.draft_id) {
    const { data: draft, error } = await sb.raw
      .from("chat_artifacts")
      .select("id, chat_id")
      .eq("id", input.draft_id)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (error) throw error;
    if (!draft) {
      return {
        ok: false,
        response: NextResponse.json(
          { ok: false, error: "Draft not found" },
          { status: 404 },
        ),
      };
    }
    trustedChatId = (draft.chat_id as string | null) ?? trustedChatId;
  }

  if (trustedChatId) {
    const { data: chat, error } = await sb.raw
      .from("chats")
      .select("id")
      .eq("id", trustedChatId)
      .eq("workspace_id", sb.workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!chat) {
      return {
        ok: false,
        response: NextResponse.json(
          { ok: false, error: "Chat not found" },
          { status: 404 },
        ),
      };
    }
  }

  if (input.artifact_id && !trustedChatId && !input.draft_id) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Artifact feedback must reference a chat." },
        { status: 400 },
      ),
    };
  }

  if (input.artifact_id && trustedChatId) {
    const { data: rows, error } = await sb.raw
      .from("chat_messages")
      .select("id, artifacts")
      .eq("chat_id", trustedChatId)
      .eq("workspace_id", sb.workspaceId)
      .eq("role", "assistant")
      .not("artifacts", "is", null);
    if (error) throw error;
    const found = (rows ?? []).some((row) =>
      Array.isArray(row.artifacts) &&
      (row.artifacts as StoredArtifact[]).some((artifact) => artifact?.id === input.artifact_id),
    );
    if (!found) {
      return {
        ok: false,
        response: NextResponse.json(
          { ok: false, error: "Artifact not found" },
          { status: 404 },
        ),
      };
    }
  }

  return {
    ok: true,
    input: {
      ...input,
      chat_id: trustedChatId,
    },
  };
}

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
    const subject = await validateFeedbackSubject(sb, parsed.data);
    if (!subject.ok) return subject.response;

    const { data, error } = await sb.raw
      .from("content_feedback")
      .insert({
        workspace_id: sb.workspaceId,
        ...subject.input,
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

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// POST /api/chats/[id]/artifacts — save a generated post out of a chat into
// chat_artifacts (the artifact panel's "Save" action). Returns the saved row.
// -----------------------------------------------------------------------------
const saveSchema = z.object({
  body: z.string().trim().min(1).max(20000),
  title: z.string().trim().max(200).optional(),
  kind: z.enum(["post", "hook"]).default("post"),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: chatId } = await params;
    const sb = await scopedSupabase();
    const { userId } = await auth();
    const input = saveSchema.parse(await req.json());

    // Confirm the chat belongs to this workspace and isn't archived before
    // attaching the artifact (consistent with the GET/stream routes).
    const { data: chat, error: chatErr } = await sb.raw
      .from("chats")
      .select("id")
      .eq("id", chatId)
      .eq("workspace_id", sb.workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    if (chatErr) throw chatErr;
    if (!chat) {
      return NextResponse.json({ ok: false, error: "Chat not found" }, { status: 404 });
    }

    const { data, error } = await sb.raw
      .from("chat_artifacts")
      .insert({
        workspace_id: sb.workspaceId,
        chat_id: chatId,
        kind: input.kind,
        title: input.title ?? null,
        body: input.body,
        meta: input.meta ?? null,
        saved_by: userId ?? null,
      })
      .select("id, title, body, meta, created_at")
      .single();
    if (error) throw error;

    return NextResponse.json({ ok: true, artifact: data });
  } catch (e) {
    return errorResponse(e);
  }
}

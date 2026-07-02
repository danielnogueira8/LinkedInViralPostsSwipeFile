import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/chats — list this workspace's non-archived chats, most recent first.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("chats")
      .select("id, title, created_at, updated_at")
      .eq("workspace_id", sb.workspaceId)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return NextResponse.json({ ok: true, chats: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}

// -----------------------------------------------------------------------------
// POST /api/chats — create a new chat. Optional title; defaults to "New chat".
// -----------------------------------------------------------------------------
const createSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const body = createSchema.parse(await req.json().catch(() => ({})));
    const { data, error } = await sb.raw
      .from("chats")
      .insert({
        workspace_id: sb.workspaceId,
        title: body.title ?? "New chat",
      })
      .select("id, title, created_at, updated_at")
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, chat: data });
  } catch (e) {
    return errorResponse(e);
  }
}

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
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
        // Pipeline start (migration 047): a hook is an "idea", a full post lands
        // in "drafting". The DB default is 'drafting'; we set 'idea' explicitly
        // for hooks so the board groups them correctly from the moment they save.
        status: input.kind === "hook" ? "idea" : "drafting",
      })
      .select("id, title, body, meta, created_at")
      .single();
    if (error) throw error;

    // The saved-drafts page lists chat_artifacts; invalidate its cache so the
    // new draft shows on the next navigation without a manual refresh.
    revalidatePath("/dashboard/posts");

    return NextResponse.json({ ok: true, artifact: data });
  } catch (e) {
    return errorResponse(e);
  }
}

// -----------------------------------------------------------------------------
// DELETE /api/chats/[id]/artifacts — remove ONE draft/hook/cite card from the
// chat transcript by its artifact id. These cards live in chat_messages.artifacts
// (a jsonb array per assistant message), NOT in chat_artifacts (the Posts board).
// So "delete a chat draft" = rewrite the owning message's artifacts array without
// that entry. Idempotent: deleting an id that isn't present succeeds (no-op),
// so a double-click or a stale client can't error.
// -----------------------------------------------------------------------------
const deleteSchema = z.object({
  artifactId: z.string().trim().min(1).max(100),
});

type StoredArtifact = { id?: string } & Record<string, unknown>;

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: chatId } = await params;
    const sb = await scopedSupabase();
    const { artifactId } = deleteSchema.parse(await req.json());

    // Confirm the chat belongs to this workspace (consistent with POST/GET).
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

    // Find the assistant message that carries this artifact. We can't index into
    // a jsonb array by element id in a simple filter, so fetch the chat's
    // assistant messages that HAVE artifacts and locate the owner in JS. A chat
    // has few assistant turns, so this is cheap and avoids a fragile jsonb query.
    const { data: rows, error: rowsErr } = await sb.raw
      .from("chat_messages")
      .select("id, artifacts")
      .eq("chat_id", chatId)
      .eq("workspace_id", sb.workspaceId)
      .eq("role", "assistant")
      .not("artifacts", "is", null);
    if (rowsErr) throw rowsErr;

    const owner = (rows ?? []).find((m) =>
      Array.isArray(m.artifacts) &&
      (m.artifacts as StoredArtifact[]).some((a) => a?.id === artifactId),
    );

    // Not found anywhere → idempotent success (already gone).
    if (!owner) {
      return NextResponse.json({ ok: true, removed: false });
    }

    const next = (owner.artifacts as StoredArtifact[]).filter(
      (a) => a?.id !== artifactId,
    );
    const { error: updErr } = await sb.raw
      .from("chat_messages")
      .update({ artifacts: next.length ? next : null })
      .eq("id", owner.id)
      .eq("workspace_id", sb.workspaceId);
    if (updErr) throw updErr;

    return NextResponse.json({ ok: true, removed: true });
  } catch (e) {
    return errorResponse(e);
  }
}

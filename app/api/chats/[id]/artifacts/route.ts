import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { resolveDraftKind } from "@/lib/post-type";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// POST /api/chats/[id]/artifacts — save a generated post out of a chat into
// chat_artifacts (the artifact panel's "Save" action). Returns the saved row.
// -----------------------------------------------------------------------------
const saveSchema = z.object({
  body: z.string().trim().min(1).max(20000),
  title: z.string().trim().max(200).optional(),
  // Content type. Optional → auto-classified (regular vs lead-magnet) from the
  // body below; an explicit value (a hook artifact, or a user's manual choice)
  // wins and is never re-classified.
  kind: z.enum(["post", "hook", "lead_magnet"]).optional(),
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

    // Resolve the content kind: explicit wins (a hook artifact, or a user pick);
    // otherwise auto-classify the body so a lead magnet written in Cowork is
    // tagged 'lead_magnet' without the user doing anything.
    const kind = resolveDraftKind(input.kind, input.body);
    const { data, error } = await sb.raw
      .from("chat_artifacts")
      .insert({
        workspace_id: sb.workspaceId,
        chat_id: chatId,
        kind,
        title: input.title ?? null,
        body: input.body,
        meta: input.meta ?? null,
        saved_by: userId ?? null,
        // Pipeline start (migration 047): a hook is an "idea", a full post
        // (regular or lead-magnet) lands in "drafting", so the board groups it
        // correctly from the moment it saves.
        status: kind === "hook" ? "idea" : "drafting",
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

// -----------------------------------------------------------------------------
// PATCH /api/chats/[id]/artifacts — replace a draft card's body/title/meta IN
// PLACE (used by AI refine: "update the current draft instead of a new card").
//
// A refine sends a chat message, the agent re-renders the draft, and the route
// persists that as a NEW artifact. To make refine UPDATE the existing card
// instead of stacking a second one, the client calls this after the turn:
//   - targetId   → the card the user refined; its body/title/meta are replaced
//                  in place (meta carries the version history the client built).
//   - supersedeId→ the agent's freshly-rendered refined artifact; removed so a
//                  reload shows ONE evolved card, not the original + the new one.
// Both edits happen across the chat's assistant messages (each id may live in a
// different message), in one rewrite per owner message. Idempotent-ish: a
// missing targetId is a no-op success; a missing supersedeId is fine.
// -----------------------------------------------------------------------------
const patchSchema = z.object({
  targetId: z.string().trim().min(1).max(100),
  // NOT trimmed — the user's leading/trailing whitespace is intentional in a
  // LinkedIn post (paragraph spacing, blank-line beats). Server-side trim would
  // silently strip those, then the next reload would show different text than
  // what the user typed. min(1) still requires SOME content.
  body: z.string().min(1).max(20000),
  title: z.string().trim().max(200).optional(),
  // Version history (prior bodies) the client tracks, persisted on the target's
  // meta so stepping back survives a reload.
  meta: z.record(z.string(), z.unknown()).optional(),
  // The agent's newly-rendered refined artifact to drop (it was superseded into
  // the target). Optional — if the client couldn't identify it, we just update.
  supersedeId: z.string().trim().min(1).max(100).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: chatId } = await params;
    const sb = await scopedSupabase();
    const input = patchSchema.parse(await req.json());

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

    const { data: rows, error: rowsErr } = await sb.raw
      .from("chat_messages")
      .select("id, artifacts")
      .eq("chat_id", chatId)
      .eq("workspace_id", sb.workspaceId)
      .eq("role", "assistant")
      .not("artifacts", "is", null);
    if (rowsErr) throw rowsErr;

    const targetExists = (rows ?? []).some((m) => {
      const arts = m.artifacts as StoredArtifact[];
      return Array.isArray(arts) && arts.some((a) => a?.id === input.targetId);
    });

    let updated = false;
    let superseded = false;
    for (const m of rows ?? []) {
      const arts = m.artifacts as StoredArtifact[];
      if (!Array.isArray(arts)) continue;
      const res = rewriteArtifactsForRefine(arts, { ...input, targetExists });
      if (!res.changed) continue;
      updated = updated || res.updated;
      superseded = superseded || res.superseded;
      const { error: updErr } = await sb.raw
        .from("chat_messages")
        .update({ artifacts: res.next.length ? res.next : null })
        .eq("id", m.id)
        .eq("workspace_id", sb.workspaceId);
      if (updErr) throw updErr;
    }

    // If the caller wasn't asking for a supersede (no supersedeId — i.e. this
    // is an edit/Done save, not the refine swap) AND no row matched, surface
    // it as not-found instead of silently succeeding. The streaming race —
    // user clicks Done before the assistant row has been inserted — was
    // returning `ok:true, updated:false` here and the client treated that as
    // success, so the edit silently never reached the DB. Refine supersede
    // stays idempotent (supersedeId not found = already gone = success).
    if (!input.supersedeId && !updated) {
      return NextResponse.json(
        { ok: false, error: "Draft not found yet — try again in a moment.", updated: false },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, updated, superseded });
  } catch (e) {
    return errorResponse(e);
  }
}

// Pure jsonb-array rewrite for an in-place refine (exported for unit tests):
// drop the superseding artifact, replace the target's body/title/meta in place.
// `changed` tells the caller whether to write this message back at all.
export function rewriteArtifactsForRefine(
  arts: StoredArtifact[],
  input: { targetId: string; body: string; title?: string; meta?: Record<string, unknown>; supersedeId?: string; targetExists?: boolean },
): { next: StoredArtifact[]; changed: boolean; updated: boolean; superseded: boolean } {
  let updated = false;
  let superseded = false;
  const hasTarget = input.targetExists ?? arts.some((a) => a?.id === input.targetId);
  const next = arts
    .filter((a) => {
      if (input.supersedeId && a?.id === input.supersedeId) {
        if (!hasTarget) return true;
        superseded = true;
        return false;
      }
      return true;
    })
    .map((a) => {
      if (input.supersedeId && !hasTarget && a?.id === input.supersedeId) {
        updated = true;
        superseded = true;
        return {
          ...a,
          id: input.targetId,
          body: input.body,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.meta !== undefined ? { meta: input.meta } : {}),
        };
      }
      if (a?.id !== input.targetId) return a;
      updated = true;
      return {
        ...a,
        body: input.body,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.meta !== undefined ? { meta: input.meta } : {}),
      };
    });
  return { next, changed: updated || superseded, updated, superseded };
}

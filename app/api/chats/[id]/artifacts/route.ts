import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { postMediaAttachmentsSchema } from "@/lib/post-media";
import { DraftLifecycle, draftRecordToApi } from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";

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
  media_attachments: postMediaAttachmentsSchema.optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: chatId } = await params;
    const sb = await scopedSupabase();
    const { userId } = await auth();
    const input = saveSchema.parse(await req.json());
    const outcome = await new DraftLifecycle(
      createSupabaseDraftLifecycleRepository(sb.raw, sb.workspaceId),
    ).saveFromChat({
      chatId,
      body: input.body,
      title: input.title,
      kind: input.kind,
      meta: input.meta,
      mediaAttachments: input.media_attachments,
      savedBy: userId,
    });
    if (!outcome.ok) {
      return NextResponse.json(
        { ok: false, error: outcome.message, reason: outcome.reason },
        { status: outcome.status },
      );
    }

    // The saved-drafts page lists chat_artifacts; invalidate its cache so the
    // new draft shows on the next navigation without a manual refresh.
    revalidatePath("/dashboard/posts");

    const response = {
      ok: true,
      artifact: draftRecordToApi(outcome.value.draft),
      ...(outcome.value.deduped ? { deduped: true } : {}),
    };
    return NextResponse.json(response);
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
      .select("id, artifacts, artifacts_version")
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
    // CAS: only write if artifacts_version still matches what we just read.
    // Two concurrent requests touching cards on the SAME message (delete card
    // A while another tab edits card B) would otherwise silently clobber each
    // other — the later plain UPDATE overwrites the array state the earlier
    // one wrote, with no error to either caller. A 0-row result means someone
    // else wrote first; the client re-fetches and retries against fresh state
    // instead of the delete silently reverting.
    const { data: written, error: updErr } = await sb.raw
      .from("chat_messages")
      .update({
        artifacts: next.length ? next : null,
        artifacts_version: (owner.artifacts_version as number) + 1,
      })
      .eq("id", owner.id)
      .eq("workspace_id", sb.workspaceId)
      .eq("artifacts_version", owner.artifacts_version as number)
      .select("id")
      .maybeSingle();
    if (updErr) throw updErr;
    if (!written) {
      return NextResponse.json(
        { ok: false, error: "This card changed elsewhere — reload and try again." },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, removed: true });
  } catch (e) {
    return errorResponse(e);
  }
}

// -----------------------------------------------------------------------------
// PATCH /api/chats/[id]/artifacts — replace a draft card's body/title/meta IN
// PLACE. Used by Done-edit (the user edits a draft inline) and by
// updateArtifactMeta (e.g. re-checking a lead-magnet). Targeted at ONE artifact
// id — the target's meta is fully overwritten with what the client sends.
// -----------------------------------------------------------------------------
const patchSchema = z.object({
  targetId: z.string().trim().min(1).max(100),
  // NOT trimmed — the user's leading/trailing whitespace is intentional in a
  // LinkedIn post (paragraph spacing, blank-line beats). Server-side trim would
  // silently strip those, then the next reload would show different text than
  // what the user typed. min(1) still requires SOME content.
  body: z.string().min(1).max(20000),
  title: z.string().trim().max(200).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
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
      .select("id, artifacts, artifacts_version")
      .eq("chat_id", chatId)
      .eq("workspace_id", sb.workspaceId)
      .eq("role", "assistant")
      .not("artifacts", "is", null);
    if (rowsErr) throw rowsErr;

    let updated = false;
    let conflict = false;
    for (const m of rows ?? []) {
      const arts = m.artifacts as StoredArtifact[];
      if (!Array.isArray(arts)) continue;
      const res = rewriteArtifactInPlace(arts, input);
      if (!res.changed) continue;
      // CAS: same guard as DELETE — a 0-row result means another write (a
      // concurrent delete of a sibling card, or another edit) landed on this
      // message between our read and write. Surface it as a conflict rather
      // than silently discarding this edit.
      const { data: written, error: updErr } = await sb.raw
        .from("chat_messages")
        .update({
          artifacts: res.next,
          artifacts_version: (m.artifacts_version as number) + 1,
        })
        .eq("id", m.id)
        .eq("workspace_id", sb.workspaceId)
        .eq("artifacts_version", m.artifacts_version as number)
        .select("id")
        .maybeSingle();
      if (updErr) throw updErr;
      if (!written) {
        conflict = true;
        continue;
      }
      updated = true;
    }

    if (conflict && !updated) {
      return NextResponse.json(
        { ok: false, error: "This card changed elsewhere — reload and try again." },
        { status: 409 },
      );
    }
    // If no row matched, surface it as not-found instead of silently
    // succeeding. The streaming race — user clicks Done before the assistant
    // row has been inserted — was returning `ok:true, updated:false` here and
    // the client treated that as success, so the edit silently never reached
    // the DB.
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: "Draft not found yet — try again in a moment.", updated: false },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    return errorResponse(e);
  }
}

// Pure jsonb-array rewrite for an in-place artifact update (exported for unit
// tests): replace the target's body/title/meta in place. `changed` tells the
// caller whether to write this message back at all.
export function rewriteArtifactInPlace(
  arts: StoredArtifact[],
  input: { targetId: string; body: string; title?: string; meta?: Record<string, unknown> },
): { next: StoredArtifact[]; changed: boolean } {
  let changed = false;
  const next = arts.map((a) => {
    if (a?.id !== input.targetId) return a;
    changed = true;
    return {
      ...a,
      body: input.body,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
    };
  });
  return { next, changed };
}

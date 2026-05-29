import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import {
  resolveActiveLibrary,
  SharedBookmarkAccessError,
} from "@/lib/shared-bookmarks";
import { validateCategoryId } from "@/lib/categories";

export const runtime = "nodejs";

type Body = {
  note?: string | null;
  category?: string | null;
};

// -----------------------------------------------------------------------------
// PUT /api/saved-posts/:id/override?share=<shareId>
//
// Lets a recipient set per-recipient note + category for an owner-
// created save in a shared library. The owner's row stays untouched;
// the override is layered on at render time for this recipient only.
//
// Only valid when the caller is acting through an accepted share. If
// the caller is acting on their own library (no ?share=), the right
// thing is to PATCH the saved_posts row directly — not implemented here
// since the existing save path already covers note+category at create
// time, and edits on own-library notes/categories aren't in scope yet.
//
// Passing null for either field clears it (falls back to the owner's value).
// -----------------------------------------------------------------------------
export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id: savedPostId } = await ctx.params;
    const shareId = new URL(req.url).searchParams.get("share");
    if (!shareId) {
      return NextResponse.json(
        { ok: false, error: "Overrides are only valid in a shared library — pass ?share=<id>." },
        { status: 400 },
      );
    }

    let active;
    try {
      active = await resolveActiveLibrary(shareId);
    } catch (e) {
      if (e instanceof SharedBookmarkAccessError) {
        return NextResponse.json({ ok: false, error: e.message }, { status: 404 });
      }
      throw e;
    }
    if (active.kind !== "shared") {
      // resolveActiveLibrary returns "shared" when shareId is set; this
      // guard is for the type narrowing below.
      return NextResponse.json({ ok: false, error: "Share required" }, { status: 400 });
    }

    const sb = await scopedSupabase();

    // Verify the target save belongs to this shared library.
    const { data: row } = await sb.raw
      .from("saved_posts")
      .select("id, workspace_id")
      .eq("id", savedPostId)
      .eq("workspace_id", active.workspaceId)
      .maybeSingle();
    if (!row) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    // Distinguish "field not in body" from "field is null". Sending
    // { note: null } clears the override; omitting note leaves it alone.
    const noteProvided = "note" in body;
    const categoryProvided = "category" in body;
    if (!noteProvided && !categoryProvided) {
      return NextResponse.json({ ok: false, error: "Nothing to update." }, { status: 400 });
    }

    const update: Record<string, unknown> = {
      saved_post_id: savedPostId,
      recipient_user_id: active.userId,
      updated_at: new Date().toISOString(),
    };
    if (noteProvided) {
      const trimmed = typeof body.note === "string" ? body.note.trim() : null;
      update.note = trimmed && trimmed.length > 0 ? trimmed : null;
    }
    if (categoryProvided) {
      // Validate against the canonical taxonomy (same as the save path). A
      // null/empty value clears the override category; a non-empty value must
      // exist in `categories` or we reject rather than store drift.
      const catResult = await validateCategoryId(sb.raw, body.category);
      if (!catResult.ok) {
        return NextResponse.json(
          { ok: false, error: `Unknown category: ${body.category}` },
          { status: 400 },
        );
      }
      update.category_id = catResult.categoryId;
    }

    // If the resulting override is fully empty (both fields null), drop
    // the row instead of keeping a zombie. Otherwise upsert by
    // (saved_post_id, recipient_user_id).
    const wouldBeEmpty =
      (noteProvided ? update.note === null : true) &&
      (categoryProvided ? update.category_id === null : true);
    if (wouldBeEmpty) {
      // Only delete if both clears are explicit OR if the existing row
      // is already fully empty after this update — we don't want a
      // partial clear to drop the other field's stored override.
      const { data: existing } = await sb.raw
        .from("saved_post_overrides")
        .select("id, note, category_id")
        .eq("saved_post_id", savedPostId)
        .eq("recipient_user_id", active.userId)
        .maybeSingle();
      const finalNote = noteProvided ? null : existing?.note ?? null;
      const finalCat = categoryProvided ? null : existing?.category_id ?? null;
      if (finalNote === null && finalCat === null) {
        if (existing) {
          await sb.raw.from("saved_post_overrides").delete().eq("id", existing.id);
        }
        return NextResponse.json({ ok: true, cleared: true });
      }
    }

    const { error } = await sb.raw
      .from("saved_post_overrides")
      .upsert(update, { onConflict: "saved_post_id,recipient_user_id" });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

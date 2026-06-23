import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { z } from "zod";

export const runtime = "nodejs";

// Per-workspace cap on custom categories. Generous enough that no real user
// hits it, low enough that a runaway client can't spam the shared table.
const CUSTOM_CATEGORY_LIMIT = 50;

const bodySchema = z.object({
  // Display label. The id is generated server-side (a UUID) so two workspaces
  // can both create "Crypto" without colliding on the text PK.
  label: z.string().trim().min(1, "Category name is required").max(40, "Keep it under 40 characters"),
});

// Create a custom, workspace-private creator category.
//
// Curated categories (workspace_id IS NULL) are seeded by migration and are
// never created here. Everything this route writes is stamped with the
// caller's workspace_id, so it's invisible to other workspaces (RLS +
// app-layer filter both enforce that).
export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request" },
        { status: 400 },
      );
    }
    const label = parsed.data.label;
    const sb = await scopedSupabase();

    // Cap check — count only this workspace's custom rows.
    const { data: existing, error: countErr } = await sb.raw
      .from("categories")
      .select("id, label")
      .eq("workspace_id", sb.workspaceId);
    if (countErr) throw countErr;
    const rows = existing ?? [];
    if (rows.length >= CUSTOM_CATEGORY_LIMIT) {
      return NextResponse.json(
        { ok: false, error: `You've reached the ${CUSTOM_CATEGORY_LIMIT} custom category limit.` },
        { status: 400 },
      );
    }

    // Case-insensitive dedupe against this workspace's own custom categories.
    // Mirrors the partial unique index in migration-040 so the user gets a
    // clean message instead of a raw constraint violation, and so re-typing an
    // existing custom category just selects it. (We don't block reusing a
    // curated label like "AI" — a workspace may legitimately want its own.)
    const lower = label.toLowerCase();
    const dupe = rows.find((r) => (r.label as string).toLowerCase() === lower);
    if (dupe) {
      return NextResponse.json(
        { ok: true, category: { id: dupe.id as string, label: dupe.label as string }, existed: true },
        { status: 200 },
      );
    }

    // Place custom categories after the curated 9 (sort_order 10–90). Curated
    // rows top out at 90; 1000+ keeps customs grouped below them in the rail.
    const id = crypto.randomUUID();
    const { data: created, error } = await sb.raw
      .from("categories")
      .insert({
        id,
        label,
        sort_order: 1000,
        is_curated: false,
        workspace_id: sb.workspaceId,
      })
      .select("id, label")
      .single();
    if (error || !created) throw error || new Error("insert failed");

    return NextResponse.json({
      ok: true,
      category: { id: created.id as string, label: created.label as string },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

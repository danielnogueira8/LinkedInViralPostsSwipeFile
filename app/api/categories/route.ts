import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { z } from "zod";
import { createCategoryResource } from "@/lib/content-resource-operations";

export const runtime = "nodejs";

// Per-workspace cap on custom categories. Generous enough that no real user
// hits it, low enough that a runaway client can't spam the shared table.
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
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request" },
        { status: 400 },
      );
    }
    const label = parsed.data.label;
    const sb = await scopedSupabase();

    const result = await createCategoryResource({
      db: sb.raw,
      workspaceId: sb.workspaceId,
      label,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, category: result.value, existed: result.existed });
  } catch (e) {
    return errorResponse(e);
  }
}

import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { preferenceInputSchema } from "@/lib/preferences";
import {
  createPreferenceResource,
  listPreferenceResources,
} from "@/lib/content-resource-operations";
import { listReviewablePreferences } from "@/lib/preference-evidence";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// /api/preferences — list + create the workspace's standing writing rules.
// Workspace-scoped via scopedSupabase (RLS also enforces it). Stored rules are
// unbounded; the agent's prompt-loading path independently bounds injection.
// -----------------------------------------------------------------------------

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const stored = await listPreferenceResources({
      db: sb.raw,
      workspaceId: sb.workspaceId,
    });
    const preferences = await listReviewablePreferences({
      db: sb.raw,
      workspaceId: sb.workspaceId,
      preferences: stored,
    });
    return NextResponse.json({
      ok: true,
      preferences,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const parsed = preferenceInputSchema.safeParse(
      await req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: parsed.error.issues[0]?.message ?? "Invalid input",
        },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();

    const result = await createPreferenceResource({
      db: sb.raw,
      workspaceId: sb.workspaceId,
      data: parsed.data,
    });
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: result.status },
      );
    }
    return NextResponse.json({ ok: true, preference: result.value });
  } catch (e) {
    return errorResponse(e);
  }
}

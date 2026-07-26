import { NextResponse } from "next/server";
import { createWorkspaceLearningStore } from "@/lib/content-learning/workspace-learning";
import { presentWorkspaceLearning } from "@/lib/content-learning/workspace-learning-presentation";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const store = createWorkspaceLearningStore(sb.raw);
    const model = await store.refresh(sb.workspaceId, {
      mode: "active",
    });
    const summary =
      model?.status === "active"
        ? presentWorkspaceLearning(model)
        : null;
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    return errorResponse(error);
  }
}

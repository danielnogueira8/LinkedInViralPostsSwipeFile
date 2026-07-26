import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { createWorkspaceKnowledgeStore } from "@/lib/content-learning/workspace-knowledge";

export const runtime = "nodejs";

const bodySchema = z.object({
  action: z.enum(["approve", "reject", "archive"]),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});
const itemIdSchema = z.string().uuid();

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const paramResult = itemIdSchema.safeParse((await params).id);
    if (!paramResult.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid knowledge item." },
        { status: 400 },
      );
    }
    const id = paramResult.data;
    const parsed = bodySchema.safeParse(
      await req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: parsed.error.issues[0]?.message ?? "Invalid review",
        },
        { status: 400 },
      );
    }

    const sb = await scopedSupabase();
    const store = createWorkspaceKnowledgeStore(sb.raw);
    const item =
      parsed.data.action === "archive"
        ? await store.archive(
            sb.workspaceId,
            id,
            parsed.data.expectedUpdatedAt,
          )
        : await store.review(sb.workspaceId, {
            itemId: id,
            expectedUpdatedAt: parsed.data.expectedUpdatedAt,
            decision: parsed.data.action,
            replacement: null,
          });

    if (!item) {
      return NextResponse.json(
        {
          ok: false,
          error: "This knowledge item changed. Refresh and try again.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return errorResponse(error);
  }
}

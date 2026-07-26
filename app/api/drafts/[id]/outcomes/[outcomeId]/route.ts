import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  createContentOutcomesStore,
  manualOutcomeCorrectionInputSchema,
} from "@/lib/content-learning/content-outcomes";

export const runtime = "nodejs";

const idSchema = z.string().uuid();

export async function PATCH(
  req: Request,
  {
    params,
  }: {
    params: Promise<{ id: string; outcomeId: string }>;
  },
) {
  try {
    const route = await params;
    const draftId = idSchema.safeParse(route.id);
    const outcomeId = idSchema.safeParse(route.outcomeId);
    const parsed = manualOutcomeCorrectionInputSchema.safeParse({
      ...(await req.json().catch(() => ({}))),
      outcomeId: route.outcomeId,
    });
    if (!draftId.success || !outcomeId.success || !parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error:
            parsed.success
              ? "Invalid outcome."
              : parsed.error.issues[0]?.message ?? "Invalid correction.",
        },
        { status: 400 },
      );
    }

    const sb = await scopedSupabase();
    const { data: subject, error: subjectError } = await sb.raw
      .from("content_outcomes")
      .select("id")
      .eq("workspace_id", sb.workspaceId)
      .eq("draft_id", draftId.data)
      .eq("id", outcomeId.data)
      .maybeSingle();
    if (subjectError) throw subjectError;
    if (!subject) {
      return NextResponse.json(
        { ok: false, error: "Outcome not found." },
        { status: 404 },
      );
    }

    const replacement = await createContentOutcomesStore(sb.raw).correct(
      sb.workspaceId,
      {
        outcomeId: outcomeId.data,
        expectedUpdatedAt: parsed.data.expectedUpdatedAt,
        reason: parsed.data.reason,
        idempotencyKey: `manual-correction:${outcomeId.data}:${parsed.data.requestId}`,
        replacement: {
          kind: parsed.data.kind,
          confidence: 1,
          quantity: parsed.data.quantity,
          amountMinor: parsed.data.amountMinor,
          currency: parsed.data.currency,
          occurredAt: parsed.data.occurredAt,
        },
      },
    );
    if (!replacement) {
      return NextResponse.json(
        {
          ok: false,
          error: "This outcome changed or couldn't be corrected. Refresh and try again.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, outcome: replacement });
  } catch (error) {
    return errorResponse(error);
  }
}

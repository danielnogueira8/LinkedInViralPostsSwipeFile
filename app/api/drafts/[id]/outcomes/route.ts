import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  buildManualOutcome,
  createContentOutcomesStore,
  manualOutcomeInputSchema,
} from "@/lib/content-learning/content-outcomes";

export const runtime = "nodejs";

const idSchema = z.string().uuid();

async function outcomeSubject(
  draftId: string,
): Promise<
  | {
      ok: true;
      sb: Awaited<ReturnType<typeof scopedSupabase>>;
      lineageId: string | null;
    }
  | { ok: false; response: NextResponse }
> {
  const sb = await scopedSupabase();
  const { data: draft, error: draftError } = await sb.raw
    .from("chat_artifacts")
    .select("id, status, schedule_status")
    .eq("workspace_id", sb.workspaceId)
    .eq("id", draftId)
    .maybeSingle();
  if (draftError) throw draftError;
  if (!draft) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Post not found." },
        { status: 404 },
      ),
    };
  }
  if (draft.status !== "posted" && draft.schedule_status !== "published") {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Publish this post before reporting outcomes." },
        { status: 409 },
      ),
    };
  }
  const { data: lineage, error: lineageError } = await sb.raw
    .from("artifact_lineage")
    .select("id")
    .eq("workspace_id", sb.workspaceId)
    .eq("artifact_id", draftId)
    .maybeSingle();
  if (lineageError) throw lineageError;
  return {
    ok: true,
    sb,
    lineageId: (lineage?.id as string | undefined) ?? null,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const parsedId = idSchema.safeParse((await params).id);
    if (!parsedId.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid post." },
        { status: 400 },
      );
    }
    const subject = await outcomeSubject(parsedId.data);
    if (!subject.ok) return subject.response;
    const outcomes = await createContentOutcomesStore(
      subject.sb.raw,
    ).listByDraft(subject.sb.workspaceId, parsedId.data);
    return NextResponse.json({ ok: true, outcomes });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const parsedId = idSchema.safeParse((await params).id);
    const parsed = manualOutcomeInputSchema.safeParse(
      await req.json().catch(() => ({})),
    );
    if (!parsedId.success || !parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: !parsedId.success
            ? "Invalid post."
            : !parsed.success
              ? parsed.error.issues[0]?.message ?? "Invalid outcome."
              : "Invalid outcome.",
        },
        { status: 400 },
      );
    }
    const subject = await outcomeSubject(parsedId.data);
    if (!subject.ok) return subject.response;
    const now = new Date().toISOString();
    const outcome = await createContentOutcomesStore(subject.sb.raw).ingest(
      buildManualOutcome({
        id: randomUUID(),
        workspaceId: subject.sb.workspaceId,
        draftId: parsedId.data,
        lineageId: subject.lineageId,
        requestId: parsed.data.requestId,
        kind: parsed.data.kind,
        quantity: parsed.data.quantity,
        amountMinor: parsed.data.amountMinor,
        currency: parsed.data.currency,
        occurredAt: parsed.data.occurredAt,
        now,
      }),
    );
    if (!outcome) {
      return NextResponse.json(
        { ok: false, error: "Couldn't save this outcome. Try again." },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    return errorResponse(error);
  }
}

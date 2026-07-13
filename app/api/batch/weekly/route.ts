import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { weeklyBatch } from "@/lib/batch/weekly-batch";
import {
  ApiErrorSchema,
  WeeklyBatchPollResponseSchema,
  WeeklyBatchStartResponseSchema,
} from "@/lib/transport/contracts";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  try {
    const workspaceId = await requireWorkspaceId();
    const { run } = await weeklyBatch.status({ workspaceId });
    return NextResponse.json(WeeklyBatchPollResponseSchema.parse({ ok: true, run }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST() {
  try {
    const workspaceId = await requireWorkspaceId();
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        ApiErrorSchema.parse({ ok: false, error: "Sign in required", code: "auth_expired" }),
        { status: 401 },
      );
    }
    const outcome = await weeklyBatch.start({ workspaceId, userId });
    if (!outcome.ok) {
      return NextResponse.json(
        ApiErrorSchema.parse({ ok: false, error: outcome.message, reason: outcome.reason }),
        { status: outcome.status },
      );
    }
    return NextResponse.json(WeeklyBatchStartResponseSchema.parse(outcome));
  } catch (error) {
    return errorResponse(error);
  }
}

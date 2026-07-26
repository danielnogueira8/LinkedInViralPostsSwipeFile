import { NextResponse } from "next/server";
import { runWeeklyUserWorkingSummaries } from "@/lib/agent-loop/user-working-summary-cron";
import { postCronAlert } from "@/lib/cron-alert";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  try {
    const summary = await runWeeklyUserWorkingSummaries();
    console.log(JSON.stringify({ user_working_summaries_cron: summary }));
    if (summary.failed > 0) {
      const detail = summary.failures
        .map(
          (failure) =>
            `${failure.workspaceId}: ${failure.message}`,
        )
        .join("; ");
      await postCronAlert(
        { cron: "user-working-summaries" },
        new Error(
          `${summary.failed} Workspace Learning refreshes failed: ${detail}`,
        ),
      );
    }
    return NextResponse.json({
      ok: true,
      ...summary,
      failures: undefined,
    });
  } catch (error) {
    console.error(
      "user working summaries cron failed",
      error instanceof Error ? error.message : "unknown",
    );
    await postCronAlert({ cron: "user-working-summaries" }, error);
    return errorResponse(error);
  }
}

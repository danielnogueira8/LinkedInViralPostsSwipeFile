import { NextResponse } from "next/server";
import { drainBackgroundJobs } from "@/lib/background-job-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const limit = Number(process.env.JOB_DRAIN_LIMIT ?? 5);
    const result = await drainBackgroundJobs({
      limit: Number.isFinite(limit) ? limit : 5,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error)?.message ?? "Unexpected error" },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { setAnthropicKey } from "@/lib/claude";
import { startBackfill } from "@/lib/backfill";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST() {
  setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);
  try {
    const { runId, alreadyRunning, total } = await startBackfill();
    return NextResponse.json({ ok: true, runId, alreadyRunning, total });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

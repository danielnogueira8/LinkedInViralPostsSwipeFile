import { NextResponse } from "next/server";
import { startBackgroundRun } from "@/lib/run-tracker";
import { setAnthropicKey } from "@/lib/claude";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST() {
  try {
    // Snapshot env at request time — Next.js dev may not propagate process.env
    // to detached background promises
    setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);
    const { runId, alreadyRunning } = await startBackgroundRun();
    return NextResponse.json({ ok: true, runId, alreadyRunning });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { startBackgroundRun } from "@/lib/run-tracker";
import { setAnthropicKey } from "@/lib/claude";
import { latestAccountsSyncAt, syncAccountsFromSheet } from "@/lib/sheets";

export const runtime = "nodejs";
export const maxDuration = 800;

// Auto-sync the sheet if no sync has happened in the last 24h.
const SYNC_TTL_MS = 24 * 60 * 60 * 1000;

export async function POST() {
  try {
    // Snapshot env at request time — Next.js dev may not propagate process.env
    // to detached background promises
    setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);

    let synced: { count: number; at: string } | null = null;
    try {
      const last = await latestAccountsSyncAt();
      const stale = !last || Date.now() - new Date(last).getTime() > SYNC_TTL_MS;
      if (stale) synced = await syncAccountsFromSheet();
    } catch (e) {
      // Don't block the scrape if the sheet is temporarily unreachable — the
      // existing accounts in the DB are still scrapable.
      console.warn("auto-sync skipped:", (e as Error).message);
    }

    const { runId, alreadyRunning } = await startBackgroundRun();
    return NextResponse.json({ ok: true, runId, alreadyRunning, synced });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { getMonthlyUsage } from "@/lib/agent/rate-limit";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/usage — the current workspace's monthly chat-message usage, for the
// 🪙 credits pill. Returns { ok, used, limit } where `used` is messages sent
// this calendar month and `limit` is the enforced monthly allowance (the same
// cap claim_chat_turn rejects against, so the pill never disagrees with the
// limit that actually bites).
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { used, limit } = await getMonthlyUsage(sb.workspaceId);
    return NextResponse.json({ ok: true, used, limit });
  } catch (e) {
    return errorResponse(e);
  }
}

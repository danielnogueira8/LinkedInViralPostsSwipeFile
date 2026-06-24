import { supabaseAdmin } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Per-turn cancellation, polled by the agent loop.
//
// WHY a DB flag (not just an in-memory ref): the Stop request from the client
// is a SEPARATE HTTP call that may not land on the same serverless instance
// running the agent. Vercel doesn't guarantee instance affinity. An in-memory
// "is cancelled?" map would miss cross-instance cancellations. A DB flag is
// durable, cross-instance, and cheap to poll once per round.
//
// The agent loop calls isCancelRequested(chatId, turnStartedAt) between rounds
// and on each text/tool delta. The flag fires only when cancel_requested_at >
// turnStartedAt, so a stale flag from a prior turn never accidentally cancels
// the new one. The stream route also clears the flag at turn-start as a belt
// (see route.ts) — but the timestamp check is the suspenders.
// ---------------------------------------------------------------------------

// Returns true when a cancel was requested AFTER this turn started. Never
// throws — on DB error returns false so a transient blip never spuriously
// cancels a healthy turn.
export async function isCancelRequested(
  chatId: string,
  turnStartedAt: number,
): Promise<boolean> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("chats")
      .select("cancel_requested_at")
      .eq("id", chatId)
      .maybeSingle();
    if (error || !data) return false;
    const ts = data.cancel_requested_at as string | null;
    if (!ts) return false;
    const requestedAtMs = Date.parse(ts);
    return Number.isFinite(requestedAtMs) && requestedAtMs >= turnStartedAt;
  } catch {
    return false;
  }
}

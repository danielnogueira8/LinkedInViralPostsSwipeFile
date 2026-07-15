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
// Per-turn scoping comes from two atomic writes: the stream route clears
// cancel_requested_at when it claims a turn, and the stop route only sets it
// when chats.turn_started_at still matches the turn token sent by the client.
// That compare-and-set prevents a delayed stop for an old turn from cancelling
// a replacement turn.
//
// We DO NOT compare cancel_requested_at against turnStartedAt: the stop
// endpoint and the stream endpoint are different serverless invocations and
// their Date.now() / new Date() values come from different machines. Vercel
// doesn't guarantee clock alignment across instances — a 50-200ms skew is
// normal — so a strict `requested >= turnStarted` comparison silently fails
// closed (the cancel timestamp can read as "before" turn start by a few ms,
// the comparison returns false, and the Stop button does nothing). The 10s
// skew window below is belt-and-suspenders against a stale flag that somehow
// survived the clear (e.g., the clear UPDATE silently affected 0 rows).
// ---------------------------------------------------------------------------

const CLOCK_SKEW_MS = 10_000;

// Returns true when a cancel was requested during this turn. Never throws —
// on DB error returns false so a transient blip never spuriously cancels a
// healthy turn.
export async function isCancelRequested(
  chatId: string,
  turnStartedAt: number,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const sb = supabaseAdmin();
    let query = sb
      .from("chats")
      .select("cancel_requested_at")
      .eq("id", chatId);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error || !data) return false;
    const ts = data.cancel_requested_at as string | null;
    if (!ts) return false;
    const requestedAtMs = Date.parse(ts);
    if (!Number.isFinite(requestedAtMs)) return false;
    // Generous skew window — see header comment. The per-turn scoping comes
    // from the turn-start clear, not from this comparison.
    return requestedAtMs >= turnStartedAt - CLOCK_SKEW_MS;
  } catch {
    return false;
  }
}

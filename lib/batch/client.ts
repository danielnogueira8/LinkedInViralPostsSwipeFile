import { AuthExpiredError, fetchApiContract } from "@/lib/api-fetch";
import { WeeklyBatchStartResponseSchema } from "@/lib/transport/contracts";

// Client-side helpers for triggering the weekly content batch. Shared by every
// surface that can start a batch (the Posts board button, the chat-home card,
// and any future entry like the command palette) so the START behavior — the
// POST, the friendly-error handling, the shape of the result — is identical
// everywhere and can't drift between surfaces.

// How many drafts a batch produces. Single source of truth for BOTH the server
// pipeline (lib/batch/weekly re-exports this) and the UI (so the card's count +
// preview slots always match what a run actually makes — no hardcoded numbers).
// This file is client-safe (no server-only imports), so both sides can read it.
// 7 total = 5 regular + 2 lead-magnet (BATCH_LEAD_MAGNET_COUNT in lib/batch/weekly).
export const BATCH_DRAFT_COUNT = 7;

export type StartBatchResult =
  // chatId: the Cowork chat the batch runs in — navigate here to watch it. Null
  // if chat creation failed (the batch still runs headless).
  | { ok: true; runId: string | null; chatId: string | null }
  // A friendly, user-facing reason the batch didn't start (cooldown / cost cap /
  // transient). `message` is safe to show verbatim. `reason` distinguishes a
  // cooldown from other failures; `retryAt` (cooldown only) is when it unlocks,
  // so the card can flip to its persistent cooldown panel instead of a toast.
  | { ok: false; message: string; reason?: string; retryAt?: string };

// POST /api/batch/weekly to kick off a run. Returns a typed result; never
// throws. Callers decide how to surface it (inline progress on Posts, a toast +
// navigate elsewhere).
export async function startWeeklyBatch(): Promise<StartBatchResult> {
  try {
    const data = await fetchApiContract(
      WeeklyBatchStartResponseSchema,
      "/api/batch/weekly",
      { method: "POST" },
    );
    if (!data.ok) {
      return {
        ok: false,
        message: data.error,
        reason: data.reason,
        retryAt: data.retryAt,
      };
    }
    return { ok: true, runId: data.runId, chatId: data.chatId };
  } catch (error) {
    if (error instanceof AuthExpiredError) {
      return { ok: false, message: error.message, reason: "auth_expired" };
    }
    return {
      ok: false,
      message: "Couldn't start your batch. Please try again shortly.",
    };
  }
}

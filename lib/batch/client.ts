// Client-side helpers for triggering the weekly content batch. Shared by every
// surface that can start a batch (the Posts board button, the chat-home card,
// and any future entry like the command palette) so the START behavior — the
// POST, the friendly-error handling, the shape of the result — is identical
// everywhere and can't drift between surfaces.

export type StartBatchResult =
  | { ok: true; runId: string | null }
  // A friendly, user-facing reason the batch didn't start (cooldown / cost cap /
  // transient). `message` is safe to show in a toast verbatim.
  | { ok: false; message: string; reason?: string };

// POST /api/batch/weekly to kick off a run. Returns a typed result; never
// throws. Callers decide how to surface it (inline progress on Posts, a toast +
// navigate elsewhere).
export async function startWeeklyBatch(): Promise<StartBatchResult> {
  try {
    const res = await fetch("/api/batch/weekly", { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      reason?: string;
      runId?: string | null;
    };
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        message:
          data.error || "Couldn't start your batch. Please try again shortly.",
        reason: data.reason,
      };
    }
    return { ok: true, runId: data.runId ?? null };
  } catch {
    return {
      ok: false,
      message: "Couldn't start your batch. Please try again shortly.",
    };
  }
}

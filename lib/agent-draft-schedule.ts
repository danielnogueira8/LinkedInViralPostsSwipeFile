import { createDraftOperationsClient } from "@/lib/draft-operations-client";
import { formatScheduleToast } from "@/lib/posting-queue";

// ---------------------------------------------------------------------------
// One-click "schedule this agent draft into the next open slot".
//
// Shared because two surfaces offer it — the Daily Brief and the agent
// briefing — and the failure handling is the part worth not duplicating: a
// second copy that forgot to surface "no LinkedIn account connected" would
// look like a button that silently does nothing.
//
// POST /queue with no slot already picks the earliest opening, creates default
// slots for a workspace that never configured a queue, and is concurrency-safe
// against the unique occurrence index. Nothing here publishes; the click is
// the human decision.
// ---------------------------------------------------------------------------

const draftOperations = createDraftOperationsClient();

export type ScheduleAgentDraftResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export async function scheduleAgentDraftToNextSlot(
  draftId: string,
): Promise<ScheduleAgentDraftResult> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    const queued = await draftOperations.queue(draftId, {
      firstComment: null,
      timezone,
    });
    return {
      ok: true,
      message: formatScheduleToast({
        scheduledAt: queued.scheduledAt,
        accountTimezone: queued.timezone || timezone,
        browserTimezone: timezone,
      }),
    };
  } catch (error) {
    // The two real failures are "no LinkedIn account connected" and "the queue
    // changed underneath you". Both need to reach the user rather than leaving
    // a button that appears to do nothing.
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Couldn't add this post to the queue.",
    };
  }
}

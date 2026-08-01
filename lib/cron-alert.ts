// ---------------------------------------------------------------------------
// Cron failure alerting. Vercel Cron does NOT notify on a failed invocation —
// a cron that throws just returns a 500 into per-invocation logs nobody
// watches. For the crons that keep the product running (publishing scheduled
// LinkedIn posts, draining the background-job queue, media GC), a silent
// failure means the feature quietly stops working and the first signal is
// churn.
//
// This posts a short alert to the SAME HEALTH_DIGEST_WEBHOOK the daily digest
// already uses (Slack/Discord compatible). Best-effort by design: it must
// NEVER throw, so a webhook outage can't turn a recoverable cron error into an
// unhandled rejection. No-ops when no webhook is configured (local/dev).
// ---------------------------------------------------------------------------

export type CronAlertContext = {
  // The cron's name, e.g. "publish-scheduled". Prefixed into the message so
  // an alert is immediately attributable.
  cron: string;
  // Optional extra detail (counts, ids) to include on a line below the error.
  detail?: string;
};

// Format the alert body. Pure + exported so the wording is unit-tested without
// a network call.
export function formatCronAlert(ctx: CronAlertContext, message: string): string {
  const lines = [`🔴 SwipeIn cron failed — ${ctx.cron}`, message.slice(0, 500)];
  if (ctx.detail) lines.push(ctx.detail.slice(0, 500));
  return lines.join("\n");
}

// Post a failure alert to the health webhook. Swallows every error (including a
// non-2xx response) so callers can `await postCronAlert(...)` inside a catch
// block without risk. Returns true only when the webhook accepts the POST,
// false otherwise — surfaced only for tests.
export async function postCronAlert(
  ctx: CronAlertContext,
  error: unknown,
): Promise<boolean> {
  const webhook = process.env.HEALTH_DIGEST_WEBHOOK;
  if (!webhook) return false;
  const message = error instanceof Error ? error.message : String(error);
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: formatCronAlert(ctx, message) }),
    });
    if (!response.ok) {
      console.error(`cron-alert post rejected (${ctx.cron})`, response.status);
      return false;
    }
    return true;
  } catch (e) {
    // The alert itself failed — log locally and give up. Never rethrow.
    console.error(`cron-alert post failed (${ctx.cron})`, (e as Error).message);
    return false;
  }
}

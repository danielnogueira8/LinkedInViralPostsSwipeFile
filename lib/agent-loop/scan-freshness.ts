// Is today's scrape actually in, so the opportunity scan has fresh posts?
//
// The daily pipeline is TIME-COUPLED, not event-coupled:
//   00:00  /api/cron/daily        enqueues a scrape job (it does not fetch)
//   * * *  /api/cron/jobs         drains the queue whenever the worker gets to it
//   06:00  /api/cron/agent-loop   scans for "recently viral" opportunities
//
// The six-hour gap is a hope, not a guarantee. If the scrape is slow, retried,
// or failed, the scan still runs on schedule and rebuilds "Model recently viral
// posts" from YESTERDAY's pool — silently, with no error anywhere, because
// nothing in the scan ever asked whether new posts had landed.
//
// This module answers that question from the `runs` table (status='ok' +
// finished_at), which the scraper already writes. Pure + exported so the
// decision is unit-tested without a database.

export type ScrapeRun = {
  started_at: string;
  finished_at: string | null;
};

export type ScanFreshness =
  | { fresh: true; reason: "scrape_complete" }
  | { fresh: false; reason: "no_scrape_yet" | "scrape_in_flight" | "scrape_stale" };

// How far back a completed run still counts as "today's". Generous on purpose:
// the daily scrape starts at 00:00 and the scan runs at 06:00, but a retry or a
// slow provider can push completion later, and a workspace added mid-day may
// have a run from a few hours prior. Anything older than this is genuinely a
// previous day's data.
export const FRESH_WINDOW_HOURS = 20;

/**
 * Decide whether the scan should proceed for a workspace.
 *
 * `now` is injected rather than read from the clock so the boundary cases are
 * deterministic in tests.
 */
export function scanFreshness(
  run: ScrapeRun | null,
  now: Date,
): ScanFreshness {
  if (!run) return { fresh: false, reason: "no_scrape_yet" };
  // A run that started but never finished is still in flight — scanning now
  // would read a half-populated pool and, worse, burn the 30-day per-source
  // cooldown on whatever happened to have landed first.
  if (!run.finished_at) return { fresh: false, reason: "scrape_in_flight" };

  const finished = Date.parse(run.finished_at);
  if (!Number.isFinite(finished)) return { fresh: false, reason: "no_scrape_yet" };

  const ageHours = (now.getTime() - finished) / (1000 * 60 * 60);
  // Guard against a clock-skew future timestamp: treat it as fresh rather than
  // as impossibly stale. (Cross-instance skew is a known hazard here — see the
  // Vercel timestamp notes; never compare instances' clocks strictly.)
  if (ageHours < 0) return { fresh: true, reason: "scrape_complete" };
  return ageHours <= FRESH_WINDOW_HOURS
    ? { fresh: true, reason: "scrape_complete" }
    : { fresh: false, reason: "scrape_stale" };
}

/** Human-readable line for the cron's structured log. */
export function freshnessMessage(f: ScanFreshness): string {
  switch (f.reason) {
    case "scrape_complete":
      return "today's scrape is in — scanning fresh posts";
    case "no_scrape_yet":
      return "no completed scrape found — skipping so the pool isn't rebuilt from stale posts";
    case "scrape_in_flight":
      return "scrape still running — skipping so the scan doesn't read a half-filled pool";
    case "scrape_stale":
      return `newest completed scrape is older than ${FRESH_WINDOW_HOURS}h — skipping rather than re-pitching yesterday's posts`;
  }
}

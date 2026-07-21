// ---------------------------------------------------------------------------
// Opportunity headline read path.
//
// `agent_opportunities.payload.headline` is a STRING PERSISTED AT SCAN TIME.
// Changing the generator (PR #1323) therefore only affects rows written after
// the deploy — rows already in the table keep whatever copy was current when
// they were inserted, and they stay visible for EXPIRE_AFTER_DAYS. That is why
// the "Working now" panel kept rendering the pre-#1323 wording:
//
//     "Ilan Asseo went 2530× — "..." — draft it?"
//
// Two things are wrong with that legacy string:
//
//  1. It attributes the number to the PERSON. A creator does not "go 2530×";
//     a POST out-performs. #1323 already made this product call — name the
//     metric that actually broke out.
//  2. The number is not a multiplier at all. It was `posts.viral_score`, which
//     is `reactions + comments*3 + reposts*5` (lib/viral.ts) — a raw weighted
//     engagement score. Suffixing it with "×" was a unit error, which is why
//     the values look absurd (2530 ≈ ~2k reactions plus change, not 2530-fold).
//
// So this normalises at the READ boundary instead of trusting the stored copy.
// Every consumer of the payload goes through `readOpportunityHeadline`, which
// means (a) legacy rows are repaired on display, and (b) any future writer
// regression cannot leak the bogus "went N×" phrasing to the user or into the
// model prompt. `payload.metrics` already carries reactions/comments, so the
// repair needs no extra query.
// ---------------------------------------------------------------------------

import { outlierMetricLabel } from "@/lib/outlier-metric";

export type OpportunityPayload = {
  headline?: unknown;
  author?: unknown;
  metrics?: unknown;
} | null | undefined;

/** Fallback when a row has no usable headline at all. */
export const OPPORTUNITY_HEADLINE_FALLBACK = "New opportunity";

// Legacy shape: `${author} went ${N}× — ${rest}` or `${author} went viral — ${rest}`.
// The em-dash separator is the one the generator has always emitted.
// Capture 1 = author, capture 2 = the rest of the headline. `[\s\S]` rather
// than the `s` flag, and positional rather than named groups, because the
// tsconfig target predates ES2018.
const LEGACY_HEADLINE_RE =
  /^(.+?) went (?:\d+(?:\.\d+)?\s*[×x]|viral) — ([\s\S]+)$/;

/** True for pre-#1323 headlines that attribute a multiplier to the creator. */
export function isLegacyOpportunityHeadline(headline: string): boolean {
  return LEGACY_HEADLINE_RE.test(headline);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Rewrite a legacy headline into the current shape, using the metrics stored
 * alongside it. Non-legacy headlines are returned untouched.
 *
 * There is no per-creator baseline in the payload, so `outlierMetricLabel` is
 * called with a null baseline — its documented thin-history behaviour, which
 * names the larger raw metric ("2.3k likes"). That is a true statement about
 * the post; the old "2530×" was not a true statement about anything.
 *
 * When the payload carries no usable engagement counts we drop the metric
 * segment rather than inventing one.
 */
export function repairOpportunityHeadline(
  headline: string,
  payload?: OpportunityPayload,
): string {
  const match = LEGACY_HEADLINE_RE.exec(headline);
  if (!match) return headline;

  const storedAuthor =
    typeof payload?.author === "string" && payload.author.trim().length > 0
      ? payload.author.trim()
      : null;
  const author = storedAuthor ?? match[1].trim();
  const rest = match[2];

  const metrics = (payload?.metrics ?? null) as {
    reactions?: unknown;
    comments?: unknown;
  } | null;
  const reactions = finiteNumber(metrics?.reactions);
  const comments = finiteNumber(metrics?.comments);

  // Nothing truthful to say about magnitude — say nothing.
  if ((reactions ?? 0) <= 0 && (comments ?? 0) <= 0) {
    return `${author} — ${rest}`;
  }

  const label = outlierMetricLabel({ reactions, comments }, null);
  return `${author} — ${label} — ${rest}`;
}

/**
 * The single accessor every consumer of `agent_opportunities.payload` should
 * use. Returns display-safe, correctly-attributed copy.
 */
export function readOpportunityHeadline(payload?: OpportunityPayload): string {
  const raw = typeof payload?.headline === "string" ? payload.headline.trim() : "";
  if (raw.length === 0) return OPPORTUNITY_HEADLINE_FALLBACK;
  return repairOpportunityHeadline(raw, payload);
}

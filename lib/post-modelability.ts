// Post modelability — a deterministic measurement of whether a source post's
// FORMAT is worth imitating, independent of how well it performed.
//
// The gap this closes: auto-selection (search_viral_posts mimic path,
// get_top_from_batch) ranks purely by engagement (lib/agent/tools.ts
// rankIdeaPosts/rotateFreshBand). A post can top that ranking because of a
// video, a milestone announcement, or a big-follower author, while its TEXT
// has no repeatable structure to model. This never happens on an explicit
// analytical query ("show me my top 10 by reactions") — only on the default
// "find me a post to model" shape, where the caller is trusting us to pick a
// good TEMPLATE, not just a big number.
//
// Pure, synchronous, no model call — same "measure, don't ask" pattern as
// lib/post-structure-skeleton.ts (which this reuses) and lib/voice-mechanics.ts.
// Scoped to SELECTION only: it is never used to gate/reject a user-attached or
// explicitly-named source, only to rank candidates the system is choosing on
// the user's behalf.

import { computeStructureSkeleton } from "./post-structure-skeleton";
import type { PostType } from "./post-type";

export type ModelabilityReject =
  | "empty_or_caption"
  | "media_dependent"
  | "repost_stub"
  | "poll_stub";

export type ModelabilityPenalty =
  | "announcement_or_milestone"
  | "no_discernible_hook"
  | "mostly_social_proof";

export type ModelabilityBonus =
  | "strong_structure"
  | "sweet_spot_length"
  | "clear_lead_magnet_offer";

export type ModelabilityResult = {
  // 0 when a fatal reject fires; otherwise a blend of penalties/bonuses,
  // clamped to [0.05, 1]. Never exactly 0 for a non-rejected post — a merely
  // mediocre post should still be selectable if nothing better exists
  // (fail-open is a selection-layer concern, but the score itself never
  // fully zeroes out a post that cleared the fatal-reject bar).
  score: number;
  // Set when a fatal reject fires. A rejected post's score is always 0.
  reject: ModelabilityReject | null;
  penalties: ModelabilityPenalty[];
  bonuses: ModelabilityBonus[];
};

// Below this, a body reads as a caption/announcement stub, not a post with
// modelable structure — there's no hook-then-body-then-close to extract.
// Calibrated against real data: "reminder" (8 chars), "Agree?" (6 chars),
// "We're hiring an AE to free me from this hell" (75 chars) all sit well
// under this, while the shortest legitimately modelable posts in a manual
// sample started around 150-180 chars.
const CAPTION_TIER_MAX_CHARS = 150;

// Sweet spot for a source worth modeling: long enough to have real beats
// (hook, body, close), short enough that the structure is still legible as
// a single unit rather than a sprawling essay. Bonus-only band, not a gate —
// posts outside it are still scoreable, just without the bonus.
const SWEET_SPOT_MIN_CHARS = 400;
const SWEET_SPOT_MAX_CHARS = 2500;

// Phrases that signal the post's real content lives OFF the page (a video,
// carousel, PDF, or external link) — the text itself is a caption, and
// modeling its "structure" would just reproduce a caption, not a post. Only
// a fatal reject when it appears in the LEADING portion of the body (see
// isMediaDependentCaption below) — a post can be a complete, modelable
// text piece that happens to mention a video in passing near the end (e.g.
// "PS: watch the video for the live walkthrough"). What matters is whether
// the media IS the payload, not whether media is mentioned anywhere at all.
const MEDIA_DEPENDENT_RE =
  /\b(?:watch\s+(?:the\s+)?video|full\s+(?:breakdown|video|episode)\s+(?:below|above|in\s+the\s+video)|swipe\s+(?:the\s+)?carousel|swipe\s+(?:left|right)|link\s+in\s+(?:the\s+)?(?:bio|comments?)|see\s+(?:the\s+)?attached|listen\s+to\s+the\s+(?:podcast|episode))\b/i;

// How far into the body a media-dependency phrase has to appear to count as
// "this post's payload IS the media" rather than an incidental mention.
// Calibrated so a post that's otherwise a complete, structured piece (hook +
// body + list) with a trailing "watch the video for more" doesn't get
// fatally rejected over one aside near the sign-off.
const MEDIA_DEPENDENT_LEADING_FRACTION = 0.3;

function isMediaDependentCaption(text: string): boolean {
  const match = text.match(MEDIA_DEPENDENT_RE);
  if (!match || match.index === undefined) return false;
  return match.index < text.length * MEDIA_DEPENDENT_LEADING_FRACTION;
}

// A repost/quote-post stub: the body is just a one-line intro pointing at
// someone else's content, not a self-contained post to model.
const REPOST_STUB_RE =
  /^(?:reposted?\s+from|via|h\/t|credit:?)\b/i;

// Poll stub: LinkedIn polls carry almost no body text of their own.
const POLL_STUB_RE = /\b(?:vote\s+(?:below|above)|cast\s+your\s+vote|poll:?)\b/i;

// Announcement/milestone/hiring/event posts: engagement here is occasion-
// driven (a wedding, an anniversary, a job opening, a launch date), not
// craft-driven — modeling "structure" from a birthday announcement produces
// nothing repeatable. Soft penalty, not a reject: some announcement posts do
// have real structure worth borrowing (e.g. a numbered "lessons from N years"
// post), so this only nudges the score down, it doesn't zero it.
const ANNOUNCEMENT_RE =
  /\b(?:we['’]?re\s+hiring|now\s+hiring|job\s+opening|open\s+role)\b|\b(?:getting\s+married|just\s+got\s+married|our\s+wedding)\b|\b(?:completed|celebrating|celebrated)\s+\d+\s+years?\b|\bproud(?:est)?\s+(?:moment|achievement)\b|\bwe['’]?ve\s+(?:raised|closed)\s+(?:our|a)\b|\bexcited\s+to\s+announce\b|\bthrilled\s+to\s+(?:announce|share)\b/i;

// Mostly-social-proof: a wall of "look how many followers/students/clients I
// have" with no teachable mechanic underneath. Distinct from ANNOUNCEMENT_RE
// (which catches a single-event trigger) — this catches a body that's
// substantially just credential-stacking.
const SOCIAL_PROOF_RE =
  /\b\d[\d,]*\+?\s+(?:followers|students|clients|customers|people)\b/i;

function isMostlySocialProof(text: string): boolean {
  const matches = text.match(new RegExp(SOCIAL_PROOF_RE, "gi")) ?? [];
  if (matches.length === 0) return false;
  // Two or more social-proof stat-drops in a body under the sweet-spot floor
  // is a strong signal the post IS the stat-drop, not a structured piece
  // that happens to cite a number once.
  return matches.length >= 2 && text.length < SWEET_SPOT_MIN_CHARS;
}

// Comment-CTA mechanic ("comment 'GUIDE' and I'll send it") — required
// scaffolding for a lead magnet, not something to penalize. Reuses the same
// shape of signal as lib/post-type.ts's classifyPost, kept separate because
// that function classifies TYPE (is this a lead magnet at all) while this
// judges QUALITY (is the offer clearly stated) for a post already typed
// lead_magnet.
const CLEAR_OFFER_RE =
  /\b(?:comment|drop|type|dm\s+me|reply\s+with)\b[^.?!\n]{0,60}\b(?:below|and\s+i|for\s+(?:the|my|a))\b/i;

function hasClearOffer(text: string): boolean {
  return CLEAR_OFFER_RE.test(text);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export type ModelabilityInput = {
  text: string;
  postType: PostType | null | undefined;
  mediaType?: string | null;
};

// Score a single candidate source post's modelability. Never throws.
export function scorePostModelability(input: ModelabilityInput): ModelabilityResult {
  const text = (input.text ?? "").trim();
  const postType: PostType = input.postType === "lead_magnet" ? "lead_magnet" : "regular";

  // --- Fatal rejects -------------------------------------------------------
  if (text.length < CAPTION_TIER_MAX_CHARS) {
    return { score: 0, reject: "empty_or_caption", penalties: [], bonuses: [] };
  }
  if (REPOST_STUB_RE.test(text)) {
    return { score: 0, reject: "repost_stub", penalties: [], bonuses: [] };
  }
  if (POLL_STUB_RE.test(text)) {
    return { score: 0, reject: "poll_stub", penalties: [], bonuses: [] };
  }
  if (isMediaDependentCaption(text)) {
    return { score: 0, reject: "media_dependent", penalties: [], bonuses: [] };
  }

  // --- Structure measurement (reuse the modeling-fidelity skeleton) --------
  const skeleton = computeStructureSkeleton(text);
  const penalties: ModelabilityPenalty[] = [];
  const bonuses: ModelabilityBonus[] = [];
  let score = 0.5;

  if (ANNOUNCEMENT_RE.test(text)) {
    penalties.push("announcement_or_milestone");
    score -= 0.25;
  }
  if (isMostlySocialProof(text)) {
    penalties.push("mostly_social_proof");
    score -= 0.15;
  }
  // A post-check on hook quality mirrors lib/hooks.ts's isUsableHook bar
  // (>=12 chars, >=8 letters) without importing it directly — that function
  // is tuned for the hook LIBRARY's exact extraction output, not a
  // presence/absence check on a raw skeleton measurement.
  const hasDiscernibleHook = skeleton.hookChars >= 12;
  if (!hasDiscernibleHook) {
    penalties.push("no_discernible_hook");
    score -= 0.2;
  }

  if (postType === "lead_magnet") {
    // Lead magnets are judged on offer clarity, not penalized for the
    // comment-CTA mechanic that regular posts would lose points for.
    if (hasClearOffer(text)) {
      bonuses.push("clear_lead_magnet_offer");
      score += 0.15;
    }
  } else if (skeleton.hasList || skeleton.paragraphCount >= 3) {
    bonuses.push("strong_structure");
    score += 0.2;
  }

  if (text.length >= SWEET_SPOT_MIN_CHARS && text.length <= SWEET_SPOT_MAX_CHARS) {
    bonuses.push("sweet_spot_length");
    score += 0.1;
  }

  return { score: clamp(score, 0.05, 1), reject: null, penalties, bonuses };
}

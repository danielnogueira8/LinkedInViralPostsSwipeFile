// Where LinkedIn cuts a post's hook with "…see more".
//
// Two limits apply and the cut happens at whichever comes FIRST:
//
//   1. a character budget — ~140 on mobile, ~210 on desktop
//   2. a line budget — ~2 visible lines on mobile, ~3 on desktop
//
// The line budget is the one people get wrong. A hook-first draft written as
// three short lines is cut long before it reaches 140 characters, because each
// hard return consumes a line of the allowance. Counting characters alone would
// draw the marker in the wrong place on exactly the drafts that care most about
// it, so both budgets are modelled here.
//
// These are approximations of a renderer we don't control: LinkedIn wraps on
// pixel width, not character count, so a line of wide characters wraps sooner
// than a narrow one. Treat the result as "about here", which is all a writing
// aid needs to be — it exists to stop someone burying the hook, not to promise
// the exact glyph.

export type HookViewport = "mobile" | "desktop";

export const HOOK_LIMITS: Record<
  HookViewport,
  { chars: number; lines: number; label: string }
> = {
  // Optimise for mobile first: most of the feed is read on a phone, and it is
  // the tighter of the two limits.
  mobile: { chars: 140, lines: 2, label: "Mobile" },
  desktop: { chars: 210, lines: 3, label: "Desktop" },
};

export type HookCutoff = {
  /** The text LinkedIn shows before "…see more". */
  visible: string;
  /** The remainder, hidden behind the link. */
  hidden: string;
  /** Index in `body` where the cut falls. */
  index: number;
  /** Which budget ran out first — drives the explanation we show. */
  reason: "chars" | "lines" | "none";
};

/**
 * Split `body` at LinkedIn's "…see more" boundary for a viewport.
 *
 * Line accounting: a paragraph break renders as a blank line, so "a\n\nb" uses
 * up two of the allowance before "b" is reached — which is why drafts with
 * generous spacing get truncated so early.
 */
export function hookCutoff(
  body: string,
  viewport: HookViewport = "mobile",
): HookCutoff {
  const { chars, lines } = HOOK_LIMITS[viewport];
  if (!body) return { visible: "", hidden: "", index: 0, reason: "none" };

  // --- line budget --------------------------------------------------------
  // Walk the raw lines (including empty ones, which occupy a rendered line)
  // and find the offset at which the allowance is used up.
  let lineIndex: number | null = null;
  let consumed = 0;
  let offset = 0;
  const parts = body.split("\n");
  for (let i = 0; i < parts.length; i += 1) {
    consumed += 1;
    if (consumed > lines) {
      // The cut lands at the END of the previous line, i.e. just before this
      // line's leading newline.
      lineIndex = Math.max(0, offset - 1);
      break;
    }
    offset += parts[i].length + 1; // +1 for the newline itself
  }

  // --- character budget ---------------------------------------------------
  const charIndex = body.length > chars ? chars : null;

  // Whichever runs out first wins.
  const candidates = [
    { index: charIndex, reason: "chars" as const },
    { index: lineIndex, reason: "lines" as const },
  ].filter((c): c is { index: number; reason: "chars" | "lines" } => c.index !== null);

  if (candidates.length === 0) {
    return { visible: body, hidden: "", index: body.length, reason: "none" };
  }
  const cut = candidates.reduce((a, b) => (a.index <= b.index ? a : b));
  return {
    visible: body.slice(0, cut.index),
    hidden: body.slice(cut.index),
    index: cut.index,
    reason: cut.reason,
  };
}

/** True when the post is short enough that nothing is hidden. */
export function fitsInHook(body: string, viewport: HookViewport = "mobile"): boolean {
  return hookCutoff(body, viewport).reason === "none";
}

/**
 * A short human explanation of the cut, for the hint beside the marker.
 * Returns null when nothing is truncated.
 */
export function hookCutoffHint(
  body: string,
  viewport: HookViewport = "mobile",
): string | null {
  const { reason } = hookCutoff(body, viewport);
  const { chars, lines, label } = HOOK_LIMITS[viewport];
  if (reason === "none") return null;
  return reason === "lines"
    ? `${label}: cut after ${lines} lines — line breaks count toward the limit`
    : `${label}: cut at ${chars} characters`;
}

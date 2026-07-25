// Where LinkedIn cuts a post's hook with "…see more".
//
// LinkedIn shows roughly the first 140 characters on mobile and 210 on desktop,
// but the real cutoff is reported anywhere between ~120 and 210 depending on how
// the opening is broken up. The reason is that the snippet is a fixed number of
// RENDERED LINES: a hard return early in the post leaves the rest of that line
// unused, so less text fits. A blank line costs a whole rendered line for no
// text at all.
//
// So this models a character budget where a line break is charged a PENALTY
// rather than a hard stop, then backs the cut up to a word boundary — LinkedIn
// truncates mid-sentence with an ellipsis, it does not stop tidily at a
// paragraph edge.
//
// It is an approximation of a renderer we don't control: LinkedIn wraps on pixel
// width, not character count, so the true cut depends on the glyphs and the
// device. Treat it as "about here", which is all a writing aid needs to be — it
// exists to stop someone burying their hook, not to promise an exact character.
// This is also why the marker belongs on a fixed-width POST PREVIEW rather than
// inside a resizable editor, where a line model cannot know the width.

export type HookViewport = "mobile" | "desktop";

export const HOOK_LIMITS: Record<
  HookViewport,
  { chars: number; label: string }
> = {
  // Optimise for mobile first: most of the feed is read on a phone, and it is
  // the tighter of the two limits.
  mobile: { chars: 140, label: "Mobile" },
  desktop: { chars: 210, label: "Desktop" },
};

// A hard return costs more than its one character, because LinkedIn's snippet
// is a fixed number of RENDERED lines: breaking early leaves the rest of that
// line unused, so the visible text shrinks. Reported cutoffs land anywhere
// between ~120 and 210 characters depending on how the opening is broken up,
// and this penalty is what models that spread. A blank line (paragraph break)
// costs double, since it burns a whole rendered line for no text.
//
// It is an approximation of a renderer we don't control — LinkedIn wraps on
// pixel width, not characters — but it captures the behaviour that actually
// changes a writer's decision: front-load the hook, don't break early.
const NEWLINE_PENALTY = 30;
const BLANK_LINE_PENALTY = 60;

export type HookCutoff = {
  /** The text LinkedIn shows before "…see more". */
  visible: string;
  /** The remainder, hidden behind the link. */
  hidden: string;
  /** Index in `body` where the cut falls. */
  index: number;
  /** Why it was cut — drives the explanation shown to the writer. */
  reason: "chars" | "breaks" | "none";
};

/**
 * Split `body` at LinkedIn's "…see more" boundary.
 *
 * Walks the text spending a character budget, charging extra for line breaks,
 * then backs up to the nearest word boundary so the cut reads like the real
 * thing — mid-sentence, never mid-word.
 */
export function hookCutoff(
  body: string,
  viewport: HookViewport = "mobile",
): HookCutoff {
  if (!body) return { visible: "", hidden: "", index: 0, reason: "none" };
  const budget = HOOK_LIMITS[viewport].chars;

  let spent = 0;
  let cut = -1;
  let sawBreak = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\n") {
      sawBreak = true;
      // A newline immediately followed by another is a paragraph break.
      const blank = body[i + 1] === "\n";
      spent += blank ? BLANK_LINE_PENALTY : NEWLINE_PENALTY;
    } else {
      spent += 1;
    }
    if (spent >= budget) {
      cut = i + 1;
      break;
    }
  }
  if (cut === -1 || cut >= body.length) {
    return { visible: body, hidden: "", index: body.length, reason: "none" };
  }

  // Back up to a word boundary — LinkedIn cuts mid-sentence, not mid-word.
  // Only search a short way back so a very long token can still be split.
  let boundary = cut;
  const floor = Math.max(0, cut - 15);
  while (boundary > floor && !/\s/.test(body[boundary - 1])) boundary -= 1;
  if (boundary <= floor) boundary = cut; // no boundary nearby; hard cut

  const visible = body.slice(0, boundary).replace(/\s+$/, "");
  return {
    visible,
    hidden: body.slice(boundary),
    index: boundary,
    // Attribute to line breaks only when they actually shortened the snippet,
    // i.e. the raw text up to the cut is well under the plain character budget.
    reason: sawBreak && boundary < budget ? "breaks" : "chars",
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
  const { chars, label } = HOOK_LIMITS[viewport];
  if (reason === "none") return null;
  return reason === "breaks"
    ? `${label}: cut early — line breaks in the opening shorten the preview`
    : `${label}: cut at ~${chars} characters`;
}

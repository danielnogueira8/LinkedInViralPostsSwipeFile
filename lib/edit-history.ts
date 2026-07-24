// Undo/redo for the draft editor.
//
// Why this exists rather than leaning on the browser: the textarea is a
// CONTROLLED React input, and every toolbar action (bold, bullet list, emoji,
// an AI rewrite) replaces its value programmatically. That wipes the native
// undo stack, so without this a mis-aimed "bold" on a 2,000-character draft is
// unrecoverable. Keeping the stack ourselves also means an AI rewrite is
// undoable, which is the case users actually reach for.
//
// Pure + exported so the coalescing rules are unit-tested without a DOM.

export type EditHistory = {
  past: string[];
  future: string[];
  // When the last entry was pushed, so fast consecutive typing collapses into
  // one undo step instead of one step per keystroke.
  lastPushAt: number;
};

export const emptyHistory = (): EditHistory => ({
  past: [],
  future: [],
  lastPushAt: 0,
});

// Cap the stack so a long editing session can't grow memory without bound. 100
// steps is far more than anyone undoes in practice.
const MAX_DEPTH = 100;

// Consecutive edits closer together than this collapse into a single undo step
// — the standard "typing a word is one undo, not six" behaviour.
const COALESCE_MS = 600;

// A change big enough to deserve its own undo step no matter how fast it
// arrived: a toolbar transform or an AI rewrite, never a keystroke.
const SIGNIFICANT_DELTA = 12;

/**
 * Record `previous` as an undoable state. `now` is injected rather than read
 * from the clock so tests are deterministic.
 *
 * Coalescing: a small edit that lands within COALESCE_MS of the last one
 * replaces nothing — we simply don't push it, leaving the earlier snapshot as
 * the undo target. A large edit always pushes, so formatting and AI rewrites
 * are individually undoable even mid-burst.
 */
export function pushHistory(
  history: EditHistory,
  previous: string,
  next: string,
  // Defaulted so callers (React event handlers) never invoke an impure clock
  // themselves; tests pass an explicit value for determinism.
  now: number = Date.now(),
): EditHistory {
  if (previous === next) return history;
  const significant =
    Math.abs(next.length - previous.length) >= SIGNIFICANT_DELTA;
  const withinBurst = now - history.lastPushAt < COALESCE_MS;
  // Mid-burst small edits ride on the snapshot already at the top of the stack.
  if (!significant && withinBurst && history.past.length > 0) {
    // A new edit invalidates any redo branch, even when coalesced.
    return { ...history, future: [], lastPushAt: now };
  }
  const past = [...history.past, previous].slice(-MAX_DEPTH);
  return { past, future: [], lastPushAt: now };
}

/**
 * Force `value` onto the stack as an undo point, ignoring coalescing.
 *
 * For edits that arrive as a STREAM rather than a single change — the AI
 * rewrite streams dozens of updates as tokens land. Recording each one would
 * bury the pre-rewrite text under dozens of undo steps, so instead we snapshot
 * once before the stream starts and let the intermediate updates pass through
 * unrecorded. One undo then returns to exactly the text before the rewrite.
 */
export function snapshot(
  history: EditHistory,
  value: string,
  now: number = Date.now(),
): EditHistory {
  // Don't stack duplicates if a snapshot is requested twice for the same text.
  if (history.past[history.past.length - 1] === value) {
    return { ...history, future: [], lastPushAt: now };
  }
  return {
    past: [...history.past, value].slice(-MAX_DEPTH),
    future: [],
    lastPushAt: now,
  };
}

/** Step back one state. Returns null when there's nothing to undo. */
export function undo(
  history: EditHistory,
  current: string,
): { history: EditHistory; value: string } | null {
  if (history.past.length === 0) return null;
  const past = [...history.past];
  const value = past.pop() as string;
  return {
    value,
    history: {
      past,
      future: [...history.future, current].slice(-MAX_DEPTH),
      // Reset the burst window so the next keystroke starts a fresh step
      // instead of coalescing into the state we just restored.
      lastPushAt: 0,
    },
  };
}

/** Step forward one state. Returns null when there's nothing to redo. */
export function redo(
  history: EditHistory,
  current: string,
): { history: EditHistory; value: string } | null {
  if (history.future.length === 0) return null;
  const future = [...history.future];
  const value = future.pop() as string;
  return {
    value,
    history: {
      past: [...history.past, current].slice(-MAX_DEPTH),
      future,
      lastPushAt: 0,
    },
  };
}

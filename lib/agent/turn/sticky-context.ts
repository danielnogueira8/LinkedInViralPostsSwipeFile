import { isNoModelFormatId, type NoModelFormatId } from "@/lib/agent/no-model-format-catalog";

// Sticky chat context: recover a context selection (custom skill, creator style,
// forced post format) a user applied earlier in the chat so it keeps applying on
// later turns, mirroring how the model source and a manual lead magnet already
// persist. Pure + exported so the newest-first / first-valid-wins / stop-at-a-
// changed-selection walk is unit-testable in isolation from setupChatTurn.
//
// The recovery reuses the SAME marker parsers the Retry path uses, so it inherits
// the fully-resolved, already-validated payloads persisted per turn (skill bodies
// / the creator-style resolvedBlock) — no DB re-fetch.

// A parsed selection marker (the shape returned by
// customSkillSelectionMarkerFromToolCalls / creatorStyleSelectionMarkerFromToolCalls).
type SelectionMarker<TContext> =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "unfrozen" }
  | { kind: "valid"; context: TContext };

// Only `role` is read (to skip non-user rows); kept as a plain string so the
// helper stays decoupled from the exact ChatRole union the caller carries.
type MinimalRow = { role: string };

// Walk rows newest-first (the array is oldest→…→newest) and return the first
// USER row's parsed marker context — the user's most recent selection. Stops at
// the first user row that CARRIED a selection, even if that selection is in a
// non-reusable shape (invalid/unfrozen): a later turn that changed or cleared the
// selection must supersede an older frozen one, so we never reach past it. Returns
// null when no user row carries a reusable selection.
export function recoverLatestSelection<
  TRow extends MinimalRow,
  TContext,
>(
  rows: readonly TRow[],
  parse: (row: TRow) => SelectionMarker<TContext>,
): TContext | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.role !== "user") continue;
    const marker = parse(row);
    if (marker.kind === "valid") return marker.context;
    if (marker.kind === "invalid" || marker.kind === "unfrozen") return null;
    // kind === "none": this row carried no selection — keep looking further back.
  }
  return null;
}

// Recover the latest FORCED no-model post format id from history. Only forced
// formats are persisted to the no_model_format_id column (auto-selected ones are
// re-derived from the message text each turn), so a stored id is always an
// explicit user choice — safe to make sticky. Newest-first; stops at the first
// user row that stored an id (a later blank turn does not clear it, but a later
// turn with a different stored id — the newest — wins because we scan from the
// newest end). Returns null when none is found or the stored id is unknown.
export function recoverLatestForcedNoModelFormatId(
  rows: readonly (MinimalRow & { no_model_format_id?: string | null })[],
): NoModelFormatId | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.role !== "user") continue;
    const stored = row.no_model_format_id?.trim();
    if (!stored) continue;
    return isNoModelFormatId(stored) ? stored : null;
  }
  return null;
}

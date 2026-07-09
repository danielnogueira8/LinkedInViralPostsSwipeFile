// ---------------------------------------------------------------------------
// Optimistic-list helpers — the "reconcile, don't restore" convention.
//
// The bug pattern (shipped twice, e.g. PR #408): an optimistic list mutation
// captures a SNAPSHOT, mutates, awaits a network call, and on failure restores
// the snapshot:
//
//     const prev = list;                       // snapshot
//     setList(list.filter(x => x.id !== id));  // optimistic remove
//     try { await del(id); }
//     catch { setList(prev); }                 // ⚠️ restores STALE snapshot
//
// If ANYTHING else mutated the list during the await (a streamed-in item, a
// concurrent action), `setList(prev)` discards it. The fix is to RECONCILE
// against CURRENT state instead of restoring the snapshot: on failure, re-insert
// only the removed item back into whatever the list is NOW.
//
//     const removed = byId(list, id);          // capture the item + index
//     setList(removeById(list, id));           // optimistic remove
//     try { await del(id); }
//     catch { setList(cur => reinsertById(cur, removed)); }  // ✅ reconciles
//
// These helpers are pure + generic over any { id: string } item, so the same
// safe pattern is one import away everywhere (chat artifacts, drafts board,
// bookmarks, accounts…). Fully unit-tested.
// ---------------------------------------------------------------------------

export type Identified = { id: string };

// The item removed from a list plus the index it sat at — the minimal state a
// reconciling rollback needs. `null` when the id wasn't present.
export type RemovedItem<T> = { item: T; index: number } | null;

// Capture an item (and its index) by id, for a possible rollback later.
export function byId<T extends Identified>(list: T[], id: string): RemovedItem<T> {
  const index = list.findIndex((x) => x.id === id);
  return index >= 0 ? { item: list[index], index } : null;
}

// Optimistic removal: a NEW list without the id. (Thin, but pairs with
// reinsertById so call sites read as a matched remove/rollback.)
export function removeById<T extends Identified>(list: T[], id: string): T[] {
  return list.filter((x) => x.id !== id);
}

// Reconciling rollback: re-insert a previously-removed item into the CURRENT
// list at its original index — NOT by restoring a stale snapshot. Keeps anything
// that changed during the await; no-ops if the item is somehow already back
// (no duplicate); clamps the index to the current bounds. Pure; returns a NEW
// list (or the same ref when there's nothing to do).
export function reinsertById<T extends Identified>(
  current: T[],
  removed: RemovedItem<T>,
): T[] {
  if (!removed) return current;
  if (current.some((x) => x.id === removed.item.id)) return current;
  const next = [...current];
  next.splice(Math.min(Math.max(removed.index, 0), next.length), 0, removed.item);
  return next;
}

// The same "reconcile, don't restore" fix, but for an item whose SINGLE FIELD
// was optimistically changed (not removed). The bug pattern:
//
//     const prev = list;                                  // snapshot
//     setList(list.map(x => x.id === id ? {...x, status} : x)); // optimistic
//     try { await patch(id, status); }
//     catch { setList(prev); }                            // ⚠️ restores STALE snapshot
//
// If another card was deleted/moved during the await, `setList(prev)` brings it
// back / clobbers it. Instead capture only the ONE field's prior value, and on
// failure revert just that field on the CURRENT list:
//
//     const priorStatus = card.status;
//     setList(patchById(list, id, { status }));
//     try { await patch(id, status); }
//     catch { setList(cur => restoreFieldById(cur, id, "status", priorStatus)); }
//
// restoreFieldById no-ops if the item is gone (it was deleted during the await —
// don't resurrect it) and leaves every other card, and every other field on the
// target card, exactly as it is now. Pure; returns a NEW list (or the same ref).

// Optimistic field patch: a NEW list with `patch` merged onto the matching item.
// Pairs with restoreFieldById so call sites read as a matched change/rollback.
export function patchById<T extends Identified>(
  list: T[],
  id: string,
  patch: Partial<T>,
): T[] {
  return list.map((x) => (x.id === id ? { ...x, ...patch } : x));
}

// Reconciling field rollback: set ONE field back to its prior value on the
// CURRENT list, only if the item is still present. Does not touch other items
// or other fields (so a concurrent change elsewhere survives), and never
// re-adds a removed item.
export function restoreFieldById<T extends Identified, K extends keyof T>(
  current: T[],
  id: string,
  field: K,
  priorValue: T[K],
): T[] {
  if (!current.some((x) => x.id === id)) return current;
  return current.map((x) => (x.id === id ? { ...x, [field]: priorValue } : x));
}

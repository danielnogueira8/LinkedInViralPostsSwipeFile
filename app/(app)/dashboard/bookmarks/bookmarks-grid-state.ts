import type { BookmarkCard } from "@/lib/bookmarks-query";

export type BookmarkGridState = {
  cards: BookmarkCard[];
  nextOffset: number | null;
};

export type BookmarkGridReconciliationInput = {
  currentCards: BookmarkCard[];
  serverCards: readonly BookmarkCard[];
  serverNextOffset: number | null;
};

// Reconcile a refreshed SSR first page into the client grid while preserving
// optimistic removals and rows already loaded by infinite scroll. The server
// page is authoritative for newly discovered first-page ids; existing local
// rows remain untouched so a refresh cannot clobber an optimistic mutation.
export function reconcileBookmarkGridPage({
  currentCards,
  serverCards,
  serverNextOffset,
}: BookmarkGridReconciliationInput): BookmarkGridState {
  const known = new Set(currentCards.map((card) => card.row.id));
  const fresh = serverCards.filter((card) => !known.has(card.row.id));
  return {
    cards: fresh.length === 0 ? currentCards : [...fresh, ...currentCards],
    // The refreshed server page knows whether the current first page still
    // has another page. Keeping the old cursor made a deleted final row leave
    // a dead sentinel that retried an already-exhausted offset forever.
    nextOffset: serverNextOffset,
  };
}

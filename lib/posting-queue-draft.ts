import { normalizeDraft, type Draft, type DraftViewRow } from "@/lib/draft-view";

/**
 * Resolve a filled posting-queue occurrence without assuming its draft is in
 * the board's bounded initial page. Local state wins so optimistic edits are
 * never replaced by a background fetch.
 */
export async function loadPostingQueueDraft(
  current: readonly Draft[],
  draftId: string,
  find: (draftId: string) => Promise<DraftViewRow>,
): Promise<Draft> {
  const local = current.find((draft) => draft.id === draftId);
  if (local) return local;
  return normalizeDraft(await find(draftId));
}

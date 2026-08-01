import type { PostingQueueDraft, PostingQueueSlot } from "@/lib/posting-queue";

export type PostingQueueSnapshot = {
  collapsed: boolean;
  timeVariationEnabled: boolean;
  slots: PostingQueueSlot[];
  drafts: PostingQueueDraft[];
};

type PostingQueueResponse = PostingQueueSnapshot & { ok: true };
type FetchPostingQueueSnapshotOptions = { forceRefresh?: boolean };

// The queue widget and calendar can mount together. Keep only the request that
// is currently in flight, so both surfaces share one fresh server response
// without introducing a stale client cache.
const inFlightSnapshots = new Map<string, Promise<PostingQueueSnapshot>>();

export function fetchPostingQueueSnapshot(
  timezone: string,
  options: FetchPostingQueueSnapshotOptions = {},
): Promise<PostingQueueSnapshot> {
  if (!options.forceRefresh) {
    const existing = inFlightSnapshots.get(timezone);
    if (existing) return existing;
  }

  const request = fetch(
    `/api/posting-slots?timezone=${encodeURIComponent(timezone)}`,
    { cache: "no-store" },
  ).then(async (response) => {
    const data = (await response.json()) as PostingQueueResponse & {
      error?: string;
    };
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Couldn't load the posting queue.");
    }
    return {
      collapsed: data.collapsed,
      timeVariationEnabled: data.timeVariationEnabled === true,
      slots: data.slots,
      drafts: data.drafts,
    };
  });

  inFlightSnapshots.set(timezone, request);
  const clearRequest = () => {
    if (inFlightSnapshots.get(timezone) === request) {
      inFlightSnapshots.delete(timezone);
    }
  };
  request.then(clearRequest, clearRequest);
  return request;
}

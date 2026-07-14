export type AdvancedSwipeFilterState = {
  from?: string;
  to?: string;
  type?: string;
  minR?: string;
  minC?: string;
};

export const DEFAULT_SWIPE_SORT = "recent";
export const DEFAULT_SWIPE_RECENCY = "new";

export const SWIPE_SORT_OPTIONS = [
  { value: "recent", label: "Most recent", urlSort: "recent", urlDir: null, allowsDirection: false },
  { value: "recent-viral", label: "Recent & viral", urlSort: "recent-viral", urlDir: null, allowsDirection: false },
  { value: "relative", label: "Biggest breakout", urlSort: "relative", urlDir: null, allowsDirection: false },
  { value: "reactions", label: "Reactions", urlSort: "reactions", urlDir: "preserve", allowsDirection: true },
  { value: "comments", label: "Comments", urlSort: "comments", urlDir: "preserve", allowsDirection: true },
  { value: "posted-asc", label: "Oldest first", urlSort: "posted", urlDir: "asc", allowsDirection: false },
] as const;

export type SwipeSortSelection = (typeof SWIPE_SORT_OPTIONS)[number]["value"];

export function countAdvancedSwipeFilters(filters: AdvancedSwipeFilterState) {
  let count = 0;
  if (filters.from || filters.to) count += 1;
  if (filters.type && filters.type !== "all") count += 1;
  if (filters.minR) count += 1;
  if (filters.minC) count += 1;
  return count;
}

export function normalizeSwipeSortSelection(
  sort: string,
  dir: string,
): SwipeSortSelection {
  if (sort !== "posted") {
    return SWIPE_SORT_OPTIONS.find((option) => option.value === sort)?.value
      ?? DEFAULT_SWIPE_SORT;
  }
  return dir === "asc" ? "posted-asc" : "recent";
}

export function isDefaultSwipeSort(sort?: string, dir?: string) {
  const resolvedSort = sort || DEFAULT_SWIPE_SORT;
  const resolvedDir = dir || "desc";
  return resolvedDir === "desc" && (
    normalizeSwipeSortSelection(resolvedSort, resolvedDir) === DEFAULT_SWIPE_SORT
  );
}

export function getSwipeSortUrlPatch(
  selection: SwipeSortSelection,
): Record<string, string | null> {
  const option = SWIPE_SORT_OPTIONS.find((candidate) => candidate.value === selection);
  if (!option || option.urlDir === "preserve") {
    return { sort: option?.urlSort ?? DEFAULT_SWIPE_SORT };
  }
  return { sort: option.urlSort, dir: option.urlDir };
}

export function swipeSortAllowsDirection(selection: SwipeSortSelection) {
  return SWIPE_SORT_OPTIONS.find((option) => option.value === selection)?.allowsDirection
    ?? false;
}

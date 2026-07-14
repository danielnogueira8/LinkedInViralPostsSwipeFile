const RETIRED_CATEGORY_REPLACEMENTS: Readonly<Record<string, string>> = {
  // migration-090 merged this workspace-private UGC bucket into the curated
  // creator-economy category. Old tabs can still restore the retired UUID
  // from sessionStorage, so canonicalize it before querying the Swipe File.
  "e8628bed-0f09-46d3-9f4d-37ea76303d42": "creator-economy",
};

/**
 * Return the category that the Swipe File should query.
 *
 * Persisted filters can outlive a category rename or deletion. Treating an
 * unknown id as a real filter makes a healthy workspace look as if every post
 * was deleted, so retired ids are migrated and other unknown ids are cleared.
 */
export function canonicalSwipeCategory(
  requestedCategory: string | null | undefined,
  availableCategoryIds: Iterable<string>,
): string | null {
  if (!requestedCategory) return null;

  const available = new Set(availableCategoryIds);
  if (available.has(requestedCategory)) return requestedCategory;

  const replacement = RETIRED_CATEGORY_REPLACEMENTS[requestedCategory];
  return replacement && available.has(replacement) ? replacement : null;
}

export type DiscoverySort =
  | "best-match"
  | "most-saved"
  | "highest-engagement"
  | "name";

export type DiscoveryCreator = {
  id: string;
  name: string;
  linkedinHandle: string;
  headline: string | null;
  recommendationReason: string | null;
  discoveryTags: string[];
  categoryId: string | null;
  source: string;
  manualOwnerWorkspaceId: string | null;
  isFeatured: boolean;
  totalPostCount: number;
  topReactions: number | null;
};

export function normalizeCreatorHandle(raw: string): string {
  const value = raw.trim();
  const profileMatch = value.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return (profileMatch?.[1] ?? value.replace(/^@/, ""))
    .trim()
    .toLowerCase();
}

export function isGlobalBaselineCreator(
  creator: Pick<DiscoveryCreator, "source" | "manualOwnerWorkspaceId">,
): boolean {
  return creator.manualOwnerWorkspaceId === null && creator.source !== "manual";
}

function normalizeDisplayTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function selectDisplayDiscoveryTags(
  tags: string[],
  categoryLabel: string | null,
  limit: number,
): string[] {
  const categoryKey = categoryLabel ? normalizeDisplayTag(categoryLabel) : null;
  const seen = new Set<string>();
  const selected: string[] = [];

  for (const rawTag of tags) {
    const tag = rawTag.trim();
    const key = normalizeDisplayTag(tag);
    if (!key || key === categoryKey || seen.has(key)) continue;
    seen.add(key);
    selected.push(tag);
    if (selected.length === limit) break;
  }

  return selected;
}

function searchableText(creator: DiscoveryCreator): string {
  return [
    creator.name,
    creator.linkedinHandle,
    creator.headline,
    creator.recommendationReason,
    ...creator.discoveryTags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function bestMatchScore(creator: DiscoveryCreator, query: string): number {
  let score = creator.isFeatured ? 1_000_000 : 0;
  if (query) {
    const normalizedName = creator.name.toLowerCase();
    const normalizedHandle = creator.linkedinHandle.toLowerCase();
    if (normalizedName === query || normalizedHandle === query) score += 500_000;
    else if (normalizedName.startsWith(query) || normalizedHandle.startsWith(query)) {
      score += 250_000;
    }
  }
  score += Math.min(creator.totalPostCount, 10_000) * 10;
  score += Math.min(creator.topReactions ?? 0, 100_000);
  return score;
}

export function rankDiscoveryCreators(
  creators: DiscoveryCreator[],
  input: {
    query?: string;
    categoryIds?: string[];
    sort?: DiscoverySort;
  } = {},
): DiscoveryCreator[] {
  const query = input.query?.trim().toLowerCase() ?? "";
  const categoryIds = new Set(input.categoryIds ?? []);
  const sort = input.sort ?? "best-match";

  return creators
    .filter((creator) =>
      categoryIds.size === 0
        ? true
        : creator.categoryId !== null && categoryIds.has(creator.categoryId),
    )
    .filter((creator) => !query || searchableText(creator).includes(query))
    .sort((a, b) => {
      if (sort === "most-saved") {
        return b.totalPostCount - a.totalPostCount || a.name.localeCompare(b.name);
      }
      if (sort === "highest-engagement") {
        return (
          (b.topReactions ?? 0) - (a.topReactions ?? 0) ||
          a.name.localeCompare(b.name)
        );
      }
      if (sort === "name") return a.name.localeCompare(b.name);
      return (
        bestMatchScore(b, query) - bestMatchScore(a, query) ||
        a.name.localeCompare(b.name)
      );
    });
}

export function selectStarterPack(
  creators: DiscoveryCreator[],
  input: { categoryIds: string[]; limit?: number },
): DiscoveryCreator[] {
  const limit = Math.max(0, Math.min(input.limit ?? 8, 24));
  if (limit === 0) return [];

  const globalCreators = rankDiscoveryCreators(
    creators.filter(isGlobalBaselineCreator),
    { categoryIds: input.categoryIds, sort: "best-match" },
  );
  if (input.categoryIds.length === 0) return globalCreators.slice(0, limit);

  const byCategory = new Map<string, DiscoveryCreator[]>();
  for (const categoryId of input.categoryIds) byCategory.set(categoryId, []);
  for (const creator of globalCreators) {
    if (creator.categoryId) byCategory.get(creator.categoryId)?.push(creator);
  }

  const pack: DiscoveryCreator[] = [];
  let index = 0;
  while (pack.length < limit) {
    let added = false;
    for (const categoryId of input.categoryIds) {
      const next = byCategory.get(categoryId)?.[index];
      if (!next) continue;
      pack.push(next);
      added = true;
      if (pack.length === limit) break;
    }
    if (!added) break;
    index += 1;
  }
  return pack;
}

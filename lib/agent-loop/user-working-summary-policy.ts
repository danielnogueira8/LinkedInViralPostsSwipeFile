export const MIN_PUBLISHED_POSTS_FOR_WORKING_SUMMARY = 5;
export const WORKING_SUMMARY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const USER_WORKING_SUMMARY_KEY = "user_working_summary_v1";

const SUMMARY_TEXT_CHARS_MAX = 220;
export const WORKING_SUMMARY_CATEGORIES = [
  "Topics",
  "Formats",
  "Hooks",
] as const;

export type UserWorkingSummarySource = "voice_profile" | "published_posts";
export type UserWorkingSummaryCategory =
  (typeof WORKING_SUMMARY_CATEGORIES)[number];

export type UserWorkingSummaryInsight = {
  label: UserWorkingSummaryCategory;
  finding: string;
  evidence: string;
};

export type UserWorkingSummary = {
  version: 2;
  source: UserWorkingSummarySource;
  /** Total posts in the source corpus (Voice scrape or published history). */
  sourcePostCount: number;
  /** Posts directly inspected for this summary. */
  analyzedPostCount: number;
  /** Total posts published through or marked posted in SwipeIn. */
  publishedPostCount: number;
  analyzedAt: string;
  /** Voice generation timestamp, or a stable published-analysis sentinel. */
  sourceRevision: string;
  insights: UserWorkingSummaryInsight[];
};

const ALLOWED_INSIGHT_LABELS = new Set<UserWorkingSummaryCategory>(
  WORKING_SUMMARY_CATEGORIES,
);

function cleanText(value: unknown, max = SUMMARY_TEXT_CHARS_MAX): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max).trim()
    : "";
}

export function chooseWorkingSummarySource(input: {
  publishedPostCount: number;
  hasReadyVoiceProfile: boolean;
}): UserWorkingSummarySource | null {
  if (
    input.publishedPostCount >=
    MIN_PUBLISHED_POSTS_FOR_WORKING_SUMMARY
  ) {
    return "published_posts";
  }
  return input.hasReadyVoiceProfile ? "voice_profile" : null;
}

function parseJsonObject(text: string): unknown {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function coerceWorkingSummaryInsights(
  value: unknown,
): UserWorkingSummaryInsight[] {
  const parsed =
    typeof value === "string" ? parseJsonObject(value) : value;
  const raw =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).insights
      : null;
  if (!Array.isArray(raw)) return [];

  const insights = new Map<
    UserWorkingSummaryCategory,
    UserWorkingSummaryInsight
  >();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    const label = cleanText(candidate.label, 40) as
      | UserWorkingSummaryCategory
      | "";
    const finding = cleanText(candidate.finding);
    const evidence = cleanText(candidate.evidence);
    if (
      !label ||
      !ALLOWED_INSIGHT_LABELS.has(label) ||
      finding.length < 12 ||
      evidence.length < 12
    ) {
      continue;
    }
    if (insights.has(label)) continue;
    insights.set(label, { label, finding, evidence });
  }
  if (insights.size !== WORKING_SUMMARY_CATEGORIES.length) return [];
  return WORKING_SUMMARY_CATEGORIES.map((label) => insights.get(label)!);
}

export function coerceStoredWorkingSummary(
  value: unknown,
): UserWorkingSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source =
    record.source === "voice_profile" || record.source === "published_posts"
      ? record.source
      : null;
  const insights = coerceWorkingSummaryInsights({
    insights: record.insights,
  });
  if (
    (record.version !== 1 && record.version !== 2) ||
    !source ||
    typeof record.sourcePostCount !== "number" ||
    typeof record.analyzedPostCount !== "number" ||
    typeof record.publishedPostCount !== "number" ||
    typeof record.analyzedAt !== "string" ||
    typeof record.sourceRevision !== "string" ||
    insights.length === 0
  ) {
    return null;
  }
  return {
    version: 2,
    source,
    sourcePostCount: Math.max(0, Math.floor(record.sourcePostCount)),
    analyzedPostCount: Math.max(0, Math.floor(record.analyzedPostCount)),
    publishedPostCount: Math.max(0, Math.floor(record.publishedPostCount)),
    analyzedAt: record.analyzedAt,
    sourceRevision: record.sourceRevision,
    insights,
  };
}

export function shouldRefreshWorkingSummary(
  cached: UserWorkingSummary | null,
  desiredSource: UserWorkingSummarySource,
  sourceRevision: string,
  now: Date,
): boolean {
  if (!cached || cached.source !== desiredSource) return true;
  if (
    desiredSource === "voice_profile" &&
    cached.sourceRevision !== sourceRevision
  ) {
    return true;
  }
  const analyzedAt = Date.parse(cached.analyzedAt);
  if (!Number.isFinite(analyzedAt)) return true;
  return now.getTime() - analyzedAt > WORKING_SUMMARY_TTL_MS;
}

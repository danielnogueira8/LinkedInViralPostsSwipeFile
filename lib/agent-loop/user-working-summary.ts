import type { SupabaseClient } from "@supabase/supabase-js";
import { sanitizeVoiceProfile, type VoiceProfile } from "@/lib/claude";
import {
  BACKGROUND_MODEL,
  completeChat,
  logOpenRouterUsage,
} from "@/lib/openrouter";
import { INJECTION_GUARD, wrapUntrustedXml } from "@/lib/agent/untrusted";
import {
  chooseWorkingSummarySource,
  coerceStoredWorkingSummary,
  coerceWorkingSummaryInsights,
  MIN_PUBLISHED_POSTS_FOR_WORKING_SUMMARY,
  shouldRefreshWorkingSummary,
  USER_WORKING_SUMMARY_KEY,
  type UserWorkingSummary,
  type UserWorkingSummarySource,
} from "./user-working-summary-policy";

const PUBLISHED_POSTS_ANALYZED_MAX = 12;
const PUBLISHED_POST_BODY_CHARS_MAX = 1_600;
const SUMMARY_TIMEOUT_MS = 30_000;

type PublishedPostRow = {
  id: string;
  body: string;
  published_at: string | null;
  created_at: string;
};

type AnalyticsRow = {
  artifact_id: string;
  snapshot_date: string;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

type PublishedPostForAnalysis = PublishedPostRow & {
  metrics: Omit<AnalyticsRow, "artifact_id"> | null;
};

type VoiceProfileRow = {
  profile: VoiceProfile;
  source_post_count: number;
  generated_at: string | null;
};

async function readStoredSummary(
  db: SupabaseClient,
  workspaceId: string,
): Promise<UserWorkingSummary | null> {
  const { data, error } = await db
    .from("settings")
    .select("value")
    .eq("workspace_id", workspaceId)
    .eq("key", USER_WORKING_SUMMARY_KEY)
    .maybeSingle();
  if (error || !data) return null;
  return coerceStoredWorkingSummary(data.value);
}

async function storeSummary(
  db: SupabaseClient,
  workspaceId: string,
  summary: UserWorkingSummary,
): Promise<void> {
  const { error } = await db.from("settings").upsert(
    {
      workspace_id: workspaceId,
      key: USER_WORKING_SUMMARY_KEY,
      value: summary,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,key" },
  );
  if (error) throw error;
}

async function loadPublishedPosts(
  db: SupabaseClient,
  workspaceId: string,
): Promise<{
  count: number;
  posts: PublishedPostRow[];
}> {
  const publishedFilter = "status.eq.posted,schedule_status.eq.published";
  const postColumns = "id, body, published_at, created_at";
  const [countResult, scheduledResult, postedResult] = await Promise.all([
    db
      .from("chat_artifacts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .or(publishedFilter),
    db
      .from("chat_artifacts")
      .select(postColumns)
      .eq("workspace_id", workspaceId)
      .eq("schedule_status", "published")
      .order("published_at", { ascending: false })
      .limit(PUBLISHED_POSTS_ANALYZED_MAX),
    db
      .from("chat_artifacts")
      .select(postColumns)
      .eq("workspace_id", workspaceId)
      .eq("status", "posted")
      .order("created_at", { ascending: false })
      .limit(PUBLISHED_POSTS_ANALYZED_MAX),
  ]);
  if (countResult.error) throw countResult.error;
  if (scheduledResult.error) throw scheduledResult.error;
  if (postedResult.error) throw postedResult.error;

  const uniquePosts = new Map<string, PublishedPostRow>();
  for (const row of [
    ...(scheduledResult.data ?? []),
    ...(postedResult.data ?? []),
  ]) {
    if (
      typeof row.id === "string" &&
      typeof row.body === "string" &&
      typeof row.created_at === "string"
    ) {
      uniquePosts.set(row.id, row as PublishedPostRow);
    }
  }
  const posts = [...uniquePosts.values()]
    .sort((left, right) => {
      const leftDate = Date.parse(left.published_at ?? left.created_at);
      const rightDate = Date.parse(right.published_at ?? right.created_at);
      return rightDate - leftDate;
    })
    .slice(0, PUBLISHED_POSTS_ANALYZED_MAX);
  return {
    count:
      typeof countResult.count === "number"
        ? countResult.count
        : posts.length,
    posts,
  };
}

async function loadReadyVoiceProfile(
  db: SupabaseClient,
  workspaceId: string,
): Promise<VoiceProfileRow | null> {
  const { data, error } = await db
    .from("voice_profiles")
    .select("profile, source_post_count, generated_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "ready")
    .maybeSingle();
  if (error) throw error;
  if (
    !data ||
    !data.profile ||
    typeof data.profile !== "object" ||
    typeof data.source_post_count !== "number"
  ) {
    return null;
  }
  return {
    profile: sanitizeVoiceProfile(data.profile),
    source_post_count: data.source_post_count,
    generated_at:
      typeof data.generated_at === "string" ? data.generated_at : null,
  };
}

async function attachLatestAnalytics(
  db: SupabaseClient,
  workspaceId: string,
  posts: PublishedPostRow[],
): Promise<PublishedPostForAnalysis[]> {
  if (posts.length === 0) return [];
  const { data, error } = await db
    .from("post_analytics")
    .select(
      "artifact_id, snapshot_date, impressions, likes, comments, shares",
    )
    .eq("workspace_id", workspaceId)
    .in(
      "artifact_id",
      posts.map((post) => post.id),
    )
    .order("snapshot_date", { ascending: false })
    .limit(posts.length * 45);
  if (error) throw error;

  const latest = new Map<string, AnalyticsRow>();
  for (const row of (data ?? []) as AnalyticsRow[]) {
    if (!latest.has(row.artifact_id)) latest.set(row.artifact_id, row);
  }
  return posts.map((post) => {
    const metrics = latest.get(post.id);
    return {
      ...post,
      metrics: metrics
        ? {
            snapshot_date: metrics.snapshot_date,
            impressions: metrics.impressions,
            likes: metrics.likes,
            comments: metrics.comments,
            shares: metrics.shares,
          }
        : null,
    };
  });
}

const PUBLISHED_SUMMARY_SYSTEM = [
  "You analyze one LinkedIn creator's OWN latest published posts and explain what is working for that creator.",
  "Use engagement metrics when available. Compare posts before claiming something outperforms. If metrics are missing, describe a repeated recent pattern instead of claiming performance.",
  'Return strict JSON only: {"insights":[{"label":"Topics|Angles|Hooks|Formats|Audience response","finding":"specific useful conclusion","evidence":"short concrete reason from this sample"}]}.',
  "Return 3-4 non-overlapping insights. Make every finding specific enough that it would not apply to every creator. Do not give generic advice and do not copy private post text verbatim.",
  INJECTION_GUARD,
].join("\n\n");

const VOICE_SUMMARY_SYSTEM = [
  "You analyze the saved source-post exemplars that were copied from a LinkedIn creator's Voice-generation scrape.",
  "Explain repeatable writing signals visible in those source posts. The Voice profile is supporting context only: every finding and its evidence must be directly corroborated by the source exemplars.",
  "Do not claim a pattern performs better than another because engagement metrics are unavailable. Describe what the engagement-ranked Voice exemplars repeatedly do instead.",
  'Return strict JSON only: {"insights":[{"label":"Topics|Angles|Hooks|Formats|Audience","finding":"specific useful conclusion","evidence":"short concrete reason visible in the source posts"}]}.',
  "Return 3-4 non-overlapping insights. Make every finding specific enough that it would not apply to every creator. Do not give generic advice and do not copy private post text verbatim.",
  INJECTION_GUARD,
].join("\n\n");

async function generateSummary(input: {
  workspaceId: string;
  systemPrompt: string;
  userPrompt: string;
  source: UserWorkingSummarySource;
  sourcePostCount: number;
  analyzedPostCount: number;
  publishedPostCount: number;
  sourceRevision: string;
  now: Date;
  signal?: AbortSignal;
}): Promise<UserWorkingSummary | null> {
  const response = await completeChat({
    model: BACKGROUND_MODEL,
    maxTokens: 900,
    glmReasoning: "none",
    timeoutMs: SUMMARY_TIMEOUT_MS,
    signal: input.signal,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
  });
  await logOpenRouterUsage(
    "user_working_summary",
    response.model,
    response.usage,
    input.workspaceId,
    {
      source: input.source,
      sample_size: input.analyzedPostCount,
    },
  ).catch(() => {});
  const insights = coerceWorkingSummaryInsights(response.text);
  if (insights.length === 0) return null;
  return {
    version: 1,
    source: input.source,
    sourcePostCount: input.sourcePostCount,
    analyzedPostCount: input.analyzedPostCount,
    publishedPostCount: input.publishedPostCount,
    analyzedAt: input.now.toISOString(),
    sourceRevision: input.sourceRevision,
    insights,
  };
}

async function generateVoiceSummary(
  workspaceId: string,
  voice: VoiceProfileRow,
  publishedPostCount: number,
  now: Date,
  signal?: AbortSignal,
): Promise<UserWorkingSummary | null> {
  const exemplars = voice.profile.exemplars
    .filter((post) => post.trim().length > 0)
    .slice(0, 3);
  if (exemplars.length === 0) return null;
  const profileContext = {
    audience: voice.profile.audience.primary,
    topics: voice.profile.topics,
    positioning: voice.profile.positioning,
    hookStyles: voice.profile.format_patterns.hook_styles,
    signatureMoves: voice.profile.signature_moves,
  };
  const source = exemplars
    .map((post, index) =>
      wrapUntrustedXml(
        `voice_source_post_${index + 1}`,
        post.slice(0, PUBLISHED_POST_BODY_CHARS_MAX),
      ),
    )
    .join("\n\n");
  return generateSummary({
    workspaceId,
    systemPrompt: VOICE_SUMMARY_SYSTEM,
    userPrompt:
      `The Voice profile was built from ${voice.source_post_count} fetched posts. ` +
      `Analyze its ${exemplars.length} saved, engagement-ranked source exemplars.\n\n` +
      `VOICE CONTEXT (supporting context, not evidence):\n${JSON.stringify(profileContext)}\n\n` +
      `SOURCE EXEMPLARS (required evidence):\n${source}`,
    source: "voice_profile",
    sourcePostCount: voice.source_post_count,
    analyzedPostCount: exemplars.length,
    publishedPostCount,
    sourceRevision: voice.generated_at ?? "voice-profile",
    now,
    signal,
  });
}

async function generatePublishedSummary(
  workspaceId: string,
  posts: PublishedPostForAnalysis[],
  publishedPostCount: number,
  now: Date,
  signal?: AbortSignal,
): Promise<UserWorkingSummary | null> {
  const source = posts
    .map((post, index) => {
      const metrics = post.metrics
        ? `snapshot=${post.metrics.snapshot_date}; impressions=${post.metrics.impressions ?? "n/a"}; likes=${post.metrics.likes ?? "n/a"}; comments=${post.metrics.comments ?? "n/a"}; shares=${post.metrics.shares ?? "n/a"}`
        : "metrics unavailable";
      return wrapUntrustedXml(
        `published_post_${index + 1}`,
        `published_at=${post.published_at ?? post.created_at}\n${metrics}\n${post.body.slice(0, PUBLISHED_POST_BODY_CHARS_MAX)}`,
      );
    })
    .join("\n\n");
  return generateSummary({
    workspaceId,
    systemPrompt: PUBLISHED_SUMMARY_SYSTEM,
    userPrompt: `Analyze these ${posts.length} latest published posts. The workspace has ${publishedPostCount} published posts total.\n\n${source}`,
    source: "published_posts",
    sourcePostCount: publishedPostCount,
    analyzedPostCount: posts.length,
    publishedPostCount,
    sourceRevision: "published",
    now,
    signal,
  });
}

export async function getUserWorkingSummary(
  db: SupabaseClient,
  workspaceId: string,
  opts: {
    forceRefresh?: boolean;
    now?: Date;
    signal?: AbortSignal;
  } = {},
): Promise<UserWorkingSummary | null> {
  const now = opts.now ?? new Date();
  try {
    const published = await loadPublishedPosts(db, workspaceId);
    const voice =
      published.count < MIN_PUBLISHED_POSTS_FOR_WORKING_SUMMARY
        ? await loadReadyVoiceProfile(db, workspaceId)
        : null;
    const source = chooseWorkingSummarySource({
      publishedPostCount: published.count,
      hasReadyVoiceProfile: voice !== null,
    });
    if (!source) return null;

    const sourceRevision =
      source === "voice_profile"
        ? voice?.generated_at ?? "voice-profile"
        : "published";
    const cached = await readStoredSummary(db, workspaceId);
    if (
      !opts.forceRefresh &&
      !shouldRefreshWorkingSummary(cached, source, sourceRevision, now)
    ) {
      return cached;
    }

    let summary: UserWorkingSummary | null;
    if (source === "voice_profile" && voice) {
      try {
        summary = await generateVoiceSummary(
          workspaceId,
          voice,
          published.count,
          now,
          opts.signal,
        );
      } catch (error) {
        console.warn("voice working summary refresh failed", {
          reason: error instanceof Error ? error.message : "unknown",
        });
        return cached?.source === source ? cached : null;
      }
    } else {
      const posts = await attachLatestAnalytics(
        db,
        workspaceId,
        published.posts,
      );
      try {
        summary = await generatePublishedSummary(
          workspaceId,
          posts,
          published.count,
          now,
          opts.signal,
        );
      } catch (error) {
        console.warn("published working summary refresh failed", {
          reason: error instanceof Error ? error.message : "unknown",
        });
        return cached?.source === source ? cached : null;
      }
    }
    if (!summary) return cached?.source === source ? cached : null;
    try {
      await storeSummary(db, workspaceId, summary);
    } catch (error) {
      console.warn("user working summary cache write failed", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
    return summary;
  } catch (error) {
    console.warn("user working summary unavailable", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

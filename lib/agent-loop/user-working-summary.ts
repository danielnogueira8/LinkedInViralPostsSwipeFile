import type { SupabaseClient } from "@supabase/supabase-js";
import { sanitizeVoiceProfile, type VoiceProfile } from "@/lib/claude";
import {
  BACKGROUND_MODEL,
  completeChat,
  logOpenRouterUsage,
} from "@/lib/openrouter";
import { INJECTION_GUARD, wrapUntrustedXml } from "@/lib/agent/untrusted";
import type { PostMediaAttachment } from "@/lib/post-media";
import {
  chooseWorkingSummarySource,
  coerceStoredWorkingSummary,
  coerceWorkingSummaryInsights,
  MIN_PUBLISHED_POSTS_FOR_WORKING_SUMMARY,
  shouldRefreshWorkingSummary,
  USER_WORKING_SUMMARY_KEY,
  type UserWorkingSummary,
  type UserWorkingSummaryExampleKind,
  type UserWorkingSummarySource,
} from "./user-working-summary-policy";

const PUBLISHED_POSTS_ANALYZED_MAX = 12;
const PUBLISHED_POST_BODY_CHARS_MAX = 1_600;
const SUMMARY_TIMEOUT_MS = 30_000;

type WorkingSummaryHookExample = {
  text: string;
  kind: UserWorkingSummaryExampleKind;
};

type PublishedPostRow = {
  id: string;
  body: string;
  published_at: string | null;
  created_at: string;
  media_attachments: PostMediaAttachment[] | null;
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

export async function readStoredUserWorkingSummary(
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
  const postColumns =
    "id, body, published_at, created_at, media_attachments";
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
  "You analyze the user's own latest published LinkedIn posts and explain what is working directly to them.",
  'Address the user as "you" and "your." Never call them "the creator," "this creator," or use third-person language about them.',
  "Use engagement metrics when available. Compare posts before claiming something outperforms. If metrics are missing, describe a repeated recent pattern instead of claiming performance.",
  'Return strict JSON only: {"insights":[{"label":"Topics","finding":"specific topic pattern addressed as you/your","evidence":"short concrete reason from this sample","example":"short concrete topic or angle, or null","exampleKind":"representative or null"},{"label":"Formats","finding":"specific structure or post format pattern addressed as you/your","evidence":"short concrete reason from this sample","example":"compact example structure, or null","exampleKind":"representative or null"},{"label":"Hooks","finding":"specific opening pattern addressed as you/your","evidence":"short concrete reason from this sample","example":"exact opening supplied in the analysis input","exampleKind":"best_performing or representative as supplied"}]}.',
  "Return exactly one Topics insight, one Formats insight, and one Hooks insight. The Hooks example is required and must be the exact opening (maximum 180 characters) from the strongest post supported by the available metrics. If metrics cannot distinguish a winner, use a representative opening and say that in the evidence. Topic and format examples are optional but should be concrete when the source supports them. Make every finding concise and specific. Evidence must say what in this sample supports the finding. Only the example may quote a short excerpt; do not copy other private post text verbatim.",
  INJECTION_GUARD,
].join("\n\n");

const VOICE_SUMMARY_SYSTEM = [
  "You analyze the user's saved source-post exemplars from their Voice-generation scrape.",
  'Address the user as "you" and "your." Never call them "the creator," "this creator," or use third-person language about them.',
  "Explain repeatable writing signals visible in those source posts. The Voice profile is supporting context only: every finding and its evidence must be directly corroborated by the source exemplars.",
  "Do not claim a pattern performs better than another because engagement metrics are unavailable. Describe what the engagement-ranked Voice exemplars repeatedly do instead.",
  'Return strict JSON only: {"insights":[{"label":"Topics","finding":"specific recurring topic addressed as you/your","evidence":"short concrete reason visible in the source posts","example":"short concrete topic or angle, or null","exampleKind":"representative or null"},{"label":"Formats","finding":"specific recurring structure addressed as you/your","evidence":"short concrete reason visible in the source posts","example":"compact example structure, or null","exampleKind":"representative or null"},{"label":"Hooks","finding":"specific recurring opening pattern addressed as you/your","evidence":"short concrete reason visible in the source posts","example":"exact opening supplied in the analysis input","exampleKind":"representative"}]}.',
  "Return exactly one Topics insight, one Formats insight, and one Hooks insight. The Hooks example is required and must be an exact opening (maximum 180 characters) from a representative engagement-ranked source exemplar. Do not claim it performed best because comparable metrics are unavailable. Topic and format examples are optional but should be concrete when the exemplars support them. Make every finding concise and specific. Evidence must say what in the exemplars supports the finding. Only the example may quote a short excerpt; do not copy other private post text verbatim.",
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
  hookExample: WorkingSummaryHookExample | null;
  now: Date;
  signal?: AbortSignal;
}): Promise<UserWorkingSummary | null> {
  if (!input.hookExample || input.hookExample.text.length < 4) {
    return null;
  }
  const hookExample = input.hookExample;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await completeChat({
      // No prompt caching: measured 0 reads across the window.
      cachePrompt: false,
      model: BACKGROUND_MODEL,
      maxTokens: 900,
      glmReasoning: "none",
      timeoutMs: SUMMARY_TIMEOUT_MS,
      signal: input.signal,
      messages: [
        { role: "system", content: input.systemPrompt },
        {
          role: "user",
          content:
            attempt === 1
              ? input.userPrompt
              : `${input.userPrompt}\n\nYour previous response was incomplete. Return exactly one valid Topics insight, one Formats insight, and one Hooks insight in the requested JSON shape. Address the user only as "you/your" and include the required Hooks example.`,
        },
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
        attempt,
      },
    ).catch(() => {});
    const insights = coerceWorkingSummaryInsights(response.text, {
      requireHookExample: false,
    });
    if (insights.length > 0) {
      const groundedInsights = insights.map((insight) =>
        insight.label === "Hooks"
          ? {
              ...insight,
              example: hookExample.text,
              exampleKind: hookExample.kind,
            }
          : insight,
      );
      return {
        version: 3,
        source: input.source,
        sourcePostCount: input.sourcePostCount,
        analyzedPostCount: input.analyzedPostCount,
        publishedPostCount: input.publishedPostCount,
        analyzedAt: input.now.toISOString(),
        sourceRevision: input.sourceRevision,
        insights: groundedInsights,
      };
    }
  }
  return null;
}

function extractHookExample(body: string): string {
  const opening = body
    .trim()
    .split(/\n\s*\n/, 1)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  return opening?.slice(0, 180).trim() ?? "";
}

function publishedHookExample(
  posts: PublishedPostForAnalysis[],
): WorkingSummaryHookExample | null {
  const withImpressions = posts
    .filter(
      (post) =>
        typeof post.metrics?.impressions === "number" &&
        extractHookExample(post.body),
    )
    .sort(
      (left, right) =>
        (right.metrics?.impressions ?? 0) -
        (left.metrics?.impressions ?? 0),
    );
  if (
    withImpressions.length >= 2 &&
    withImpressions[0]!.metrics!.impressions! >
      withImpressions[1]!.metrics!.impressions!
  ) {
    return {
      text: extractHookExample(withImpressions[0]!.body),
      kind: "best_performing",
    };
  }

  const representative = posts.find((post) =>
    Boolean(extractHookExample(post.body)),
  );
  return representative
    ? {
        text: extractHookExample(representative.body),
        kind: "representative",
      }
    : null;
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
    hookExample: {
      text: extractHookExample(exemplars[0]!),
      kind: "representative",
    },
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
      const attachments = Array.isArray(post.media_attachments)
        ? post.media_attachments
        : [];
      const format =
        attachments.length === 0
          ? "format=text-only"
          : `format=${attachments[0]?.type ?? "media"}; attachment_count=${attachments.length}`;
      return wrapUntrustedXml(
        `published_post_${index + 1}`,
        `published_at=${post.published_at ?? post.created_at}\n${metrics}\n${format}\n${post.body.slice(0, PUBLISHED_POST_BODY_CHARS_MAX)}`,
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
    hookExample: publishedHookExample(posts),
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
    const cached = await readStoredUserWorkingSummary(db, workspaceId);
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

import {
  completeChat,
  logOpenRouterUsage,
  REASONING_MODEL,
  type ToolDef,
} from "@/lib/openrouter";
import { supabaseAdmin } from "@/lib/supabase";
import { trackedAccountIds } from "@/lib/supabase-scoped";
import { runProfileHistory } from "@/lib/apify";
import { INJECTION_GUARD, wrapUntrustedXml } from "@/lib/agent/untrusted";
import { providerModelAttribution } from "@/lib/agent/cowork-adapter-attempt";
import {
  sanitizeCreatorStyleProfile,
  isUsableCreatorStyleProfile,
  buildStylePromptBlock,
  type CreatorStyleProfile,
  STYLE_SOURCE_MAX,
  STYLE_SAVED_PICK_MAX,
} from "@/lib/creator-styles";

// We pull the creator's latest STYLE_SOURCE_MAX (30) posts live from Apify when
// building a style from a tracked account — a deeper, more current read of how
// they write than whatever we happen to have scraped in the DB. At ~$0.002/post
// that's ~$0.06 per style. Using the SAME constant as the analyze cap means we
// analyze every post we fetch (and pay for) — no silent truncation.
// Only trust the live fetch if it returns at least this many usable posts;
// below it we fall back to DB posts (a thin Apify return is worse than a decent
// DB history, and this keeps a scraper blip from producing a weak style).
const STYLE_APIFY_MIN_POSTS = 8;

// ---------------------------------------------------------------------------
// Creator style generation — distills the WRITING MECHANICS of a creator's
// posts into a structured CreatorStyleProfile, headlessly. Mirrors
// lib/claude.ts synthesizeVoice: a forced structured tool call (so the profile
// comes back as parsed args, not a JSON string to slice), defensive
// sanitization, a truncation retry, and per-workspace usage logging.
//
// The posts are UNTRUSTED input (scraped third-party content), so they're
// wrapped + guarded against prompt injection. We extract STYLE ONLY — never the
// creator's topics, stories, claims, examples, identity, or exact wording.
// ---------------------------------------------------------------------------

// A source post, the fields we feed the analyzer. Same core shape whether it
// came from the swipe file (posts) or a saved post (saved_posts).
export type StyleSourcePost = {
  // The DB row id for "post"/"saved_post" sources; empty for "scraped" (an
  // Apify-fetched post that we never persisted — see fetchStyleSourcePosts).
  id: string;
  text: string;
  post_url: string | null;
  reactions: number | null;
  // Where this post came from — drives which id column the source-reference row
  // gets. "scraped" = fetched live from Apify for this generation only; it has
  // no DB id, so both post_id and saved_post_id are left null on its ref row.
  kind: "post" | "saved_post" | "scraped";
};

export const CREATOR_STYLE_SYSTEM =
  "You are a writing-style analyst. You will be given a batch of a single LinkedIn creator's own posts, each wrapped in <post>...</post> tags. Study them as a set and extract ONLY the creator's WRITING MECHANICS — how they write, not what they write about.\n\n" +
  "EXTRACT (mechanics only):\n" +
  "- hook patterns (how they open a post to stop the scroll)\n" +
  "- cadence and sentence length (short/punchy vs long/flowing; one-line paragraphs; rhythm)\n" +
  "- formatting habits (line breaks, whitespace, lists, emojis, capitalization tics)\n" +
  "- paragraph breaks and pacing\n" +
  "- common post STRUCTURES (the recurring skeletons they build posts on, as a sequence of beats)\n" +
  "- rhetorical moves (rhetorical questions, contrast, pattern interrupts, callbacks, the 'but here's the thing' turn)\n" +
  "- CTA habits (how they close and ask for engagement)\n" +
  "- post-format preferences (story, listicle, contrarian take, single insight, etc.)\n\n" +
  "PROHIBITED — you must NOT extract, quote, or reproduce ANY of the following, and you must list them under avoid_copying so a downstream writer never reuses them:\n" +
  "- personal stories, anecdotes, and unique examples\n" +
  "- specific claims, results, metrics, and case studies\n" +
  "- exact phrases, signature lines, catchphrases, and wording\n" +
  "- the creator's identity, name, company, and biographical details\n\n" +
  "Do NOT copy any post verbatim and do NOT include example post bodies in your output. The profile is a reusable STYLE GUIDE for writing ORIGINAL content in a similar style — describe the mechanics abstractly so they transfer to any topic. Keep arrays to 3-6 items each. Infer only from evidence in the posts.";

export const CREATOR_STYLE_TOOL_NAME = "emit_creator_style";

const strItems = { type: "array" as const, items: { type: "string" as const } };

const CREATOR_STYLE_TOOL: ToolDef = {
  type: "function",
  function: {
    name: CREATOR_STYLE_TOOL_NAME,
    description:
      "Emit the distilled writing-STYLE profile for the creator as structured data. Mechanics only — no copied content, stories, claims, examples, identity, or exact wording.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "2-3 sentence brief of the writing MECHANICS (cadence, formatting, hook style) — not the topics.",
        },
        voice_traits: {
          ...strItems,
          description: "Short mechanics descriptors, e.g. 'punchy', 'one-line paragraphs', 'rhetorical-question opener'.",
        },
        hook_patterns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
            },
          },
          description: "Recurring ways they OPEN a post (abstract patterns, not copied hooks).",
        },
        structure_patterns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              sequence: { ...strItems, description: "The beats of the structure in order." },
              when_to_use: { type: "string" },
            },
          },
          description: "The recurring post SKELETONS they build on, as sequences of beats.",
        },
        formatting_rules: { ...strItems, description: "Line breaks, whitespace, lists, emoji, capitalization habits." },
        rhythm_rules: { ...strItems, description: "Cadence + sentence-length + pacing habits." },
        cta_patterns: { ...strItems, description: "How they close + ask for engagement (abstract, not copied)." },
        post_format_preferences: { ...strItems, description: "Formats they favor: story, listicle, contrarian, single insight, etc." },
        avoid_copying: {
          ...strItems,
          description:
            "The creator-specific things a downstream writer must NEVER copy: their stories, claims, exact phrases, signature lines, unique examples, identity details.",
        },
      },
      required: ["summary", "voice_traits", "avoid_copying"],
    },
  },
};

function wrapPost(text: string, reactions: number | null): string {
  const meta = reactions != null ? `[reactions=${reactions}]` : undefined;
  return wrapUntrustedXml("post", text, { meta });
}

// Build the user content: the posts, best-first by engagement, wrapped + tagged.
function buildUserContent(posts: StyleSourcePost[]): string {
  return posts.map((p) => wrapPost(p.text, p.reactions)).join("\n\n");
}

// ---------------------------------------------------------------------------
// Source-post selection — the posts we analyze. Two paths, both workspace-safe:
//   1. sourceAccountId → a tracked creator's posts (verified to belong to the
//      workspace via trackedAccountIds; never trust the client id).
//   2. savedPostIds → a hand-picked set of the workspace's saved posts.
// Ranked by engagement, capped at STYLE_SOURCE_MAX, non-empty text only.
// ---------------------------------------------------------------------------

export async function fetchStyleSourcePosts(opts: {
  workspaceId: string;
  sourceAccountId?: string | null;
  savedPostIds?: string[] | null;
}): Promise<StyleSourcePost[]> {
  const sb = supabaseAdmin();
  if (opts.sourceAccountId) {
    // Verify the account is tracked by THIS workspace (IDOR guard).
    const tracked = await trackedAccountIds(opts.workspaceId);
    if (!tracked.includes(opts.sourceAccountId)) return [];

    // The DB fallback: whatever posts we've already scraped for this creator,
    // ranked by engagement. Used when the live Apify fetch fails or is thin.
    const fetchDbPosts = async (): Promise<StyleSourcePost[]> => {
      const { data } = await sb
        .from("posts")
        .select("id, text, post_url, reactions")
        .eq("account_id", opts.sourceAccountId as string)
        .order("reactions", { ascending: false, nullsFirst: false })
        .limit(STYLE_SOURCE_MAX);
      return ((data ?? []) as Array<Record<string, unknown>>)
        .map((r) => ({
          id: String(r.id),
          text: typeof r.text === "string" ? r.text : "",
          post_url: (r.post_url as string | null) ?? null,
          reactions: (r.reactions as number | null) ?? null,
          kind: "post" as const,
        }))
        .filter((p) => p.text.trim().length > 0);
    };

    // Prefer a LIVE Apify fetch of the creator's latest ~30 posts — a deeper,
    // more current sample than the DB usually holds, for a stronger style. We
    // use these only for THIS generation (not persisted). Best-effort: any
    // error, or a thin return (< MIN), falls back to the DB posts so a scraper
    // blip never produces a weak style or a hard failure.
    const { data: acct } = await sb
      .from("accounts")
      .select("linkedin_handle")
      .eq("id", opts.sourceAccountId)
      .maybeSingle();
    const handle =
      typeof acct?.linkedin_handle === "string" ? acct.linkedin_handle.trim() : "";
    if (handle) {
      try {
        const scraped = await runProfileHistory(handle, STYLE_SOURCE_MAX);
        const usable = scraped
          .map((p) => ({
            id: "",
            text: typeof p.text === "string" ? p.text : "",
            post_url: p.post_url,
            reactions: p.reactions,
            kind: "scraped" as const,
          }))
          .filter((p) => p.text.trim().length > 0)
          // Best-first by engagement, matching the DB path's ordering.
          .sort((a, b) => (b.reactions ?? 0) - (a.reactions ?? 0))
          .slice(0, STYLE_SOURCE_MAX);
        if (usable.length >= STYLE_APIFY_MIN_POSTS) return usable;
      } catch (e) {
        // Fall through to the DB path — logged, not fatal.
        console.error(
          "creator_style_apify_fetch_failed",
          handle,
          (e as Error).message,
        );
      }
    }
    return fetchDbPosts();
  }
  if (opts.savedPostIds?.length) {
    const { data } = await sb
      .from("saved_posts")
      .select("id, text, text_snippet, post_url, reactions")
      .eq("workspace_id", opts.workspaceId)
      .in("id", opts.savedPostIds.slice(0, STYLE_SAVED_PICK_MAX))
      .order("reactions", { ascending: false, nullsFirst: false });
    return ((data ?? []) as Array<Record<string, unknown>>)
      .map((r) => ({
        id: String(r.id),
        text:
          (typeof r.text === "string" && r.text.trim()) ||
          (typeof r.text_snippet === "string" ? r.text_snippet : "") ||
          "",
        post_url: (r.post_url as string | null) ?? null,
        reactions: (r.reactions as number | null) ?? null,
        kind: "saved_post" as const,
      }))
      .filter((p) => p.text.trim().length > 0);
  }
  return [];
}

// ---------------------------------------------------------------------------
// The model call — a forced structured tool call, with one truncation retry.
// Returns the sanitized profile; throws on an unrecoverable failure (the route
// catches it and marks the row 'failed').
// ---------------------------------------------------------------------------

const MAX_TOKENS = 6_000;

export async function generateCreatorStyleProfile(opts: {
  workspaceId: string;
  posts: StyleSourcePost[];
}): Promise<CreatorStyleProfile> {
  const userContent = buildUserContent(opts.posts);
  const system = CREATOR_STYLE_SYSTEM + INJECTION_GUARD;

  const attempt = async (): Promise<CreatorStyleProfile> => {
    const res = await completeChat({
      // No prompt caching: one-shot per creator — nothing follows to read the entry.
      cachePrompt: false,
      model: REASONING_MODEL,
      maxTokens: MAX_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      tools: [CREATOR_STYLE_TOOL],
      forceTool: CREATOR_STYLE_TOOL_NAME,
    });
    const attribution = providerModelAttribution(REASONING_MODEL, res.model);
    await logOpenRouterUsage(
      "synthesize_creator_style",
      attribution.model,
      res.usage,
      opts.workspaceId,
      attribution.metadata,
    );
    if (res.finishReason === "length") {
      throw new Error("Creator style synthesis was truncated (hit the output limit).");
    }
    if (!res.toolArgs) {
      throw new Error("Creator style synthesis returned no usable result.");
    }
    const profile = sanitizeCreatorStyleProfile(res.toolArgs);
    // sanitizeCreatorStyleProfile is a pure coercion — it happily turns an
    // empty/near-empty tool payload ({}) into a fully-shaped-but-blank
    // profile instead of throwing. Gate on SEMANTIC usability here so a blank
    // profile doesn't sail through and get persisted as a ready style with
    // nothing for buildStylePromptBlock to inject beyond the fixed
    // anti-copying footer.
    if (!isUsableCreatorStyleProfile(profile)) {
      throw new Error("Creator style synthesis returned no usable result.");
    }
    return profile;
  };

  try {
    return await attempt();
  } catch (e) {
    // One bounded retry — a truncated/empty/unusable forced-tool call is
    // usually transient. A second unusable result is treated as a genuine
    // failure (runCreatorStyleGeneration's caller marks the row 'failed'),
    // not retried again.
    if (/truncated|no usable/i.test((e as Error).message)) {
      return await attempt();
    }
    throw e;
  }
}

// First non-empty line of a post, clamped — the source-reference preview.
function firstLine(text: string, max = 120): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ---------------------------------------------------------------------------
// Orchestrate one generation run for an existing (status='generating') row:
// fetch source posts → synthesize → persist profile + prompt_block + source
// references → flip to 'ready' (or 'failed' with a message). Best-effort +
// self-contained: designed to run in the route's after(). Never throws to the
// caller — it records the outcome on the row. Uses supabaseAdmin (service role)
// but scopes every write by the workspace id captured at request time.
// ---------------------------------------------------------------------------
export async function runCreatorStyleGeneration(opts: {
  workspaceId: string;
  profileId: string;
  sourceAccountId?: string | null;
  savedPostIds?: string[] | null;
  // The generating_started_at value stamped when THIS run was claimed. Every
  // write below is conditioned on it (mirrors runVoiceGeneration's runToken
  // pattern) so a run that stale-recovery already declared dead can't clobber
  // a newer run's result if it finishes late. null only for jobs enqueued
  // before this field existed (no guard, best-effort during rollout).
  runToken?: string | null;
}): Promise<void> {
  const sb = supabaseAdmin();
  const patchRow = async (patch: Record<string, unknown>) => {
    let query = sb
      .from("creator_style_profiles")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", opts.profileId)
      .eq("workspace_id", opts.workspaceId);
    if (opts.runToken) query = query.eq("generating_started_at", opts.runToken);
    const { data, error } = await query.select("id");
    if (error) {
      console.warn(
        `creator-style patchRow failed for ${opts.profileId}: ${error.message}`,
      );
    } else if (opts.runToken && (!data || data.length === 0)) {
      console.warn(
        `creator-style stale run result dropped (superseded) for ${opts.profileId}`,
      );
    }
  };
  // A failed run clears generating_started_at so stale-recovery doesn't later
  // re-flip an already-failed row, and leaves generated_at untouched (a failure
  // doesn't reset the regenerate cooldown — only a SUCCESS does).
  const fail = (message: string) =>
    patchRow({ status: "failed", error: message, generating_started_at: null });
  try {
    // Both entry points (create + regenerate) already stamp
    // generating_started_at with opts.runToken when they claim the row —
    // re-stamping it here would break the CAS guard on every write below by
    // changing the value they're conditioned on.
    const posts = await fetchStyleSourcePosts({
      workspaceId: opts.workspaceId,
      sourceAccountId: opts.sourceAccountId,
      savedPostIds: opts.savedPostIds,
    });
    if (posts.length === 0) {
      await fail(
        "No usable source posts found for this creator. Make sure they're tracked and have scraped posts, then try again.",
      );
      return;
    }
    const profile = await generateCreatorStyleProfile({
      workspaceId: opts.workspaceId,
      posts,
    });
    const promptBlock = buildStylePromptBlock(profile);

    // Persist source references (distilled — first line + url, NOT full bodies).
    // Clear any prior references first (a regenerate re-runs this), best-effort.
    await sb
      .from("creator_style_profile_sources")
      .delete()
      .eq("profile_id", opts.profileId)
      .eq("workspace_id", opts.workspaceId);
    if (posts.length) {
      await sb.from("creator_style_profile_sources").insert(
        posts.map((p) => ({
          profile_id: opts.profileId,
          workspace_id: opts.workspaceId,
          // "scraped" posts (live Apify) have no DB row, so both id columns stay
          // null — the first-line + url still record what the style was built on.
          post_id: p.kind === "post" ? p.id : null,
          saved_post_id: p.kind === "saved_post" ? p.id : null,
          source_first_line: firstLine(p.text),
          source_url: p.post_url,
        })),
      );
    }

    // description is a user-owned field (see creatorStyleUpdateSchema) —
    // generation must never write into it. The low-sample warning is derived
    // from sample_count at read time (creatorStyleQualityWarning) instead, so
    // it never clobbers the user's own description and clears itself
    // automatically once a regenerate crosses STYLE_LOW_SAMPLE_THRESHOLD.
    await patchRow({
      status: "ready",
      error: null,
      profile_json: profile,
      prompt_block: promptBlock,
      sample_count: posts.length,
      // Anchor the 30-day regenerate cooldown to this successful run, and clear
      // the in-flight marker so stale-recovery leaves the finished row alone.
      generated_at: new Date().toISOString(),
      generating_started_at: null,
    });
  } catch (e) {
    await fail(
      "We hit a snag generating this style. Please try again in a bit.",
    );
    console.error("creator_style_generation_failed", (e as Error).message);
  }
}

import type {
  McpServer,
  ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { DraftLifecycle, draftRecordToApi } from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";
import { postMediaAttachmentsSchema } from "@/lib/post-media";
import { templateInputSchema } from "@/lib/templates";
import { skillInputSchema } from "@/lib/custom-skills";
import { loadVisibleCategories } from "@/lib/categories";
import { leadMagnetInputSchema } from "@/lib/lead-magnets";
import { creatorStyleCreateSchema } from "@/lib/creator-styles";
import {
  CREATOR_STYLE_COLS,
  startCreatorStyleGeneration,
} from "@/lib/creator-style-operations";
import { startVoiceGeneration } from "@/lib/voice-profile-operations";
import { preferenceInputSchema } from "@/lib/preferences";
import {
  createCategoryResource,
  createLeadMagnetResource,
  createPreferenceResource,
  createSkillResource,
  createTemplateResource,
  getLeadMagnetResource,
  getSkillResource,
  getTemplateResource,
  listLeadMagnetResources,
  listPreferenceResources,
  listSkillResources,
  listTemplateResources,
} from "@/lib/content-resource-operations";
import {
  buildPerformanceRows,
  performanceTotals,
  sortPerformanceRows,
} from "@/lib/post-performance";
import { analyzePostPatterns } from "@/lib/post-pattern-analysis";
import { buildWritingRules, WRITING_RULE_SECTIONS } from "@/lib/writing-rules";
import { trackedAccountIdsForService } from "@/lib/supabase-scoped";
import { selectAllRows, selectInChunks } from "@/lib/db-paginate";
import { dbErrorContent, errorContent, jsonContent, notFoundContent } from "./util";
import { mcpAuthInfo } from "./context";

/**
 * Cap on analyze_posts input. The analysis itself is cheap (pure functions over
 * text), so this bounds the DB read and the response size rather than compute —
 * and keeps a client from passing an unbounded id list.
 */
const ANALYZE_POSTS_MAX = 50;

/** Lookback windows for get_post_performance, in days. */
const SINCE_DAYS: Record<"7d" | "30d" | "90d" | "365d", number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
};

type Extra = ServerContext;
type WorkspaceResolver = (extra: Extra) => string | null;

const NO_WORKSPACE_MSG = "No workspace bound to this session. Join a workspace before using MCP tools.";
const STYLE_COLS = CREATOR_STYLE_COLS;

function ids(extra: Extra, workspaceFromExtra: WorkspaceResolver) {
  const workspaceId = workspaceFromExtra(extra);
  const rawUserId = mcpAuthInfo(extra)?.extra?.userId;
  return {
    workspaceId,
    userId: typeof rawUserId === "string" && rawUserId ? rawUserId : null,
  };
}

function drafts(workspaceId: string) {
  const db = supabaseAdmin();
  return new DraftLifecycle(createSupabaseDraftLifecycleRepository(db, workspaceId));
}

function exactlyOne(args: { id?: string; name?: string }) {
  return Number(Boolean(args.id)) + Number(Boolean(args.name)) === 1;
}

// The meta stamped on every MCP-created draft. `created_via` drives the
// board's "MCP" indicator; a modeled draft ALSO carries the swipe-file source
// (same meta.source_url contract as chat/batch drafts, so the existing
// "Source" pill and sourceUrlFromMeta pick it up unchanged). Pure + exported
// for tests.
export function buildMcpDraftMeta(input: {
  sourceUrl?: string | null;
  sourcePostId?: string | null;
}): Record<string, unknown> {
  const url = input.sourceUrl?.trim();
  return {
    created_via: "mcp",
    ...(input.sourcePostId ? { source_post_id: input.sourcePostId } : {}),
    ...(url ? { source: "model_source", source_url: url } : {}),
  };
}

// Resolve the source_url for a modeled draft when the caller only passed the
// swipe-file post id — reads the tracked post's URL so the board can render
// the Source link without the caller round-tripping it.
async function sourceUrlForPostId(
  db: ReturnType<typeof supabaseAdmin>,
  sourcePostId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("posts")
    .select("post_url")
    .eq("id", sourcePostId)
    .maybeSingle();
  if (error) throw error;
  const url = data?.post_url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

export function registerPublicResourceTools(
  server: McpServer,
  workspaceFromExtra: WorkspaceResolver,
) {
  server.registerTool("get_draft", {
    title: "Get a complete draft",
    description: "Read a workspace draft including its complete body, board state, schedule, and media references.",
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const draft = await drafts(workspaceId).find(id);
      return draft ? jsonContent({ ok: true, draft: draftRecordToApi(draft) }) : notFoundContent("Draft", id);
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("create_draft", {
    title: "Create a post draft",
    description:
      "Create a post, hook, or lead-magnet draft on the workspace Posts board. " +
      "When the draft is modeled on a swipe-file post, pass that post's id as source_post_id " +
      "(or its LinkedIn URL as source_url) so the board can link the source.",
    inputSchema: {
      title: z.string().trim().max(200).optional(),
      body: z.string().trim().max(20_000).optional().default(""),
      kind: z.enum(["post", "hook", "lead_magnet"]).optional(),
      status: z.enum(["idea", "drafting", "ready", "posted"]).optional(),
      plan_to_post_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      media_attachments: postMediaAttachmentsSchema.optional(),
      source_post_id: z.string().uuid().optional(),
      source_url: z.string().url().optional(),
    },
  }, async (args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      if (!args.title?.trim() && !args.body?.trim()) return errorContent("Give the post a name or some content.");
      const sourceUrl =
        args.source_url ??
        (args.source_post_id
          ? await sourceUrlForPostId(supabaseAdmin(), args.source_post_id)
          : null);
      const result = await drafts(workspaceId).create({
        title: args.title,
        body: args.body ?? "",
        kind: args.kind,
        status: args.status,
        planToPostOn: args.plan_to_post_on,
        mediaAttachments: args.media_attachments,
        meta: buildMcpDraftMeta({
          sourceUrl,
          sourcePostId: args.source_post_id ?? null,
        }),
      });
      // A retried call (timeout, an LLM calling the tool twice) with the same
      // body returns the existing draft instead of inserting a duplicate —
      // deduped tells the caller which happened.
      return jsonContent({
        ok: true,
        deduped: result.outcome === "deduped",
        draft: draftRecordToApi(result.draft),
      });
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("list_categories", {
    title: "List content categories",
    description: "List curated categories and private custom categories visible to this workspace.",
    inputSchema: {},
  }, async (_args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const { data, error } = await loadVisibleCategories(supabaseAdmin(), workspaceId, "id, label, is_curated, workspace_id");
      if (error) return dbErrorContent("list_categories", error);
      return jsonContent({ ok: true, count: data?.length ?? 0, categories: data ?? [] });
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("create_category", {
    title: "Create a private category",
    description: "Create an idempotent workspace-private content category.",
    inputSchema: { label: z.string().trim().min(1).max(40) },
  }, async ({ label }, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const result = await createCategoryResource({
        db: supabaseAdmin(),
        workspaceId,
        label,
      });
      return result.ok
        ? jsonContent({ ok: true, category: result.value, existed: result.existed ?? false })
        : errorContent(result.error);
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("list_templates", {
    title: "List writing templates",
    description: "List built-in templates and custom templates created by this workspace.",
    inputSchema: {},
  }, async (_args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const templates = await listTemplateResources({
        db: supabaseAdmin(),
        workspaceId,
      });
      return jsonContent({ ok: true, count: templates.length, templates });
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("get_template", {
    title: "Get a writing template",
    description: "Read one built-in or workspace-created writing template by id.",
    inputSchema: { id: z.string().min(1) },
  }, async ({ id }, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const template = await getTemplateResource({
        db: supabaseAdmin(),
        workspaceId,
        id,
      });
      return template
        ? jsonContent({ ok: true, template })
        : notFoundContent("Template", id);
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("create_template", {
    title: "Create a writing template",
    description: "Create a reusable custom writing template in this workspace.",
    inputSchema: templateInputSchema.shape,
  }, async (args, extra) => {
    try {
      const parsed = templateInputSchema.safeParse(args);
      if (!parsed.success) return errorContent(parsed.error.issues[0]?.message ?? "Invalid template.");
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const result = await createTemplateResource({
        db: supabaseAdmin(),
        workspaceId,
        data: parsed.data,
      });
      return result.ok
        ? jsonContent({ ok: true, template: result.value })
        : errorContent(result.error);
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("list_skills", {
    title: "List custom skills",
    description: "List the workspace's custom Cowork skills with their complete instruction bodies.",
    inputSchema: {},
  }, async (_args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const skills = await listSkillResources({
        db: supabaseAdmin(),
        workspaceId,
      });
      return jsonContent({ ok: true, count: skills.length, skills });
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("get_skill", {
    title: "Get a custom skill",
    description: "Read one custom Cowork skill by id or normalized name.",
    inputSchema: { id: z.string().uuid().optional(), name: z.string().optional() },
  }, async (args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      if (!exactlyOne(args)) return errorContent("Provide exactly one of: id, name.");
      const lookup = args.id ?? args.name!;
      const skill = await getSkillResource({
        db: supabaseAdmin(),
        workspaceId,
        id: args.id,
        name: args.name,
      });
      return skill
        ? jsonContent({ ok: true, skill })
        : notFoundContent("Skill", lookup);
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("create_skill", {
    title: "Create a custom skill",
    description: "Create a validated, bounded custom Cowork skill for this workspace.",
    inputSchema: skillInputSchema.shape,
  }, async (args, extra) => {
    try {
      const parsed = skillInputSchema.safeParse(args);
      if (!parsed.success) return errorContent(parsed.error.issues[0]?.message ?? "Invalid skill.");
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const result = await createSkillResource({
        db: supabaseAdmin(),
        workspaceId,
        data: parsed.data,
      });
      return result.ok
        ? jsonContent({ ok: true, skill: result.value })
        : errorContent(result.error);
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("list_lead_magnets", {
    title: "List lead magnets",
    description: "List the workspace's saved lead magnets, newest first (trimmed rows — no markdown_body; use get_lead_magnet for the full content of one).",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe("Max rows to return. Default 20, max 50."),
      offset: z.number().int().min(0).optional().describe("Rows to skip, for paging past the first page."),
    },
  }, async (args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;
      const { rows, total } = await listLeadMagnetResources({
        db: supabaseAdmin(),
        workspaceId,
        limit,
        offset,
      });
      return jsonContent({
        ok: true,
        count: rows.length,
        total,
        offset,
        lead_magnets: rows,
      });
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("get_lead_magnet", {
    title: "Get a lead magnet",
    description: "Read one workspace lead magnet with its complete Markdown and metadata.",
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const leadMagnet = await getLeadMagnetResource({
        db: supabaseAdmin(),
        workspaceId,
        id,
      });
      return leadMagnet
        ? jsonContent({ ok: true, lead_magnet: leadMagnet })
        : notFoundContent("Lead magnet", id);
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("create_lead_magnet", {
    title: "Create a lead magnet",
    description: "Create a manual lead magnet from complete Markdown content.",
    inputSchema: leadMagnetInputSchema.shape,
  }, async (args, extra) => {
    try {
      const parsed = leadMagnetInputSchema.safeParse(args);
      if (!parsed.success) return errorContent(parsed.error.issues[0]?.message ?? "Invalid lead magnet.");
      const { workspaceId, userId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      if (!userId) return errorContent("No user identity bound to this MCP session.");
      const result = await createLeadMagnetResource({
        db: supabaseAdmin(),
        workspaceId,
        userId,
        data: parsed.data,
      });
      return result.ok
        ? jsonContent({ ok: true, lead_magnet: result.value })
        : errorContent(result.error);
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("list_preferences", {
    title: "List standing writing preferences",
    description: "List the workspace writing rules automatically applied to every Cowork generation.",
    inputSchema: {},
  }, async (_args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const preferences = await listPreferenceResources({
        db: supabaseAdmin(),
        workspaceId,
      });
      return jsonContent({ ok: true, count: preferences.length, preferences });
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("create_preference", {
    title: "Create a standing writing preference",
    description: "Create a normalized, deduplicated writing rule applied to future Cowork generations.",
    inputSchema: preferenceInputSchema.shape,
  }, async (args, extra) => {
    try {
      const parsed = preferenceInputSchema.safeParse(args);
      if (!parsed.success) return errorContent(parsed.error.issues[0]?.message ?? "Invalid preference.");
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const result = await createPreferenceResource({
        db: supabaseAdmin(),
        workspaceId,
        data: parsed.data,
      });
      return result.ok
        ? jsonContent({ ok: true, preference: result.value })
        : errorContent(result.error);
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  registerVoiceTool(server, workspaceFromExtra);
  registerCreatorStyleTools(server, workspaceFromExtra);
}

function registerVoiceTool(server: McpServer, workspaceFromExtra: WorkspaceResolver) {
  server.registerTool("create_voice", {
    title: "Generate a voice profile",
    description: "Start the same guarded, asynchronous voice generation used by the Voice page.",
    inputSchema: { profile_url: z.string().trim().min(1) },
  }, async ({ profile_url }, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const result = await startVoiceGeneration({
        workspaceId,
        profileUrl: profile_url,
        db: supabaseAdmin(),
      });
      return result.ok
        ? jsonContent({ ok: true, accepted: true, voice: result.voice })
        : errorContent(result.error);
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });
}

function registerCreatorStyleTools(server: McpServer, workspaceFromExtra: WorkspaceResolver) {
  server.registerTool("list_creator_styles", {
    title: "List creator styles",
    description: "List creator writing-style profiles and their generation status.",
    inputSchema: {},
  }, async (_args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const { data, error } = await supabaseAdmin().from("creator_style_profiles").select(STYLE_COLS).eq("workspace_id", workspaceId).order("created_at", { ascending: false });
      if (error) return dbErrorContent("list_creator_styles", error);
      return jsonContent({ ok: true, count: data?.length ?? 0, styles: data ?? [] });
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("get_creator_style", {
    title: "Get a creator style",
    description: "Read one complete creator style and its workspace-scoped source references.",
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const sb = supabaseAdmin();
      const { data, error } = await sb.from("creator_style_profiles").select(STYLE_COLS).eq("id", id).eq("workspace_id", workspaceId).maybeSingle();
      if (error) return notFoundContent("Creator style", id);
      if (!data) return notFoundContent("Creator style", id);
      const { data: sources, error: sourceError } = await sb.from("creator_style_profile_sources").select("id, source_first_line, source_url").eq("profile_id", id).eq("workspace_id", workspaceId).order("created_at", { ascending: false });
      if (sourceError) return dbErrorContent("get_creator_style", sourceError);
      return jsonContent({ ok: true, style: data, sources: sources ?? [] });
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  server.registerTool("create_creator_style", {
    title: "Create a creator style",
    description: "Start the guarded creator-style distillation job used by the Creator Styles page.",
    inputSchema: creatorStyleCreateSchema.shape,
  }, async (args, extra) => {
    try {
      const parsed = creatorStyleCreateSchema.safeParse(args);
      if (!parsed.success) return errorContent(parsed.error.issues[0]?.message ?? "Invalid creator style.");
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const result = await startCreatorStyleGeneration({
        workspaceId,
        data: parsed.data,
        db: supabaseAdmin(),
      });
      return result.ok
        ? jsonContent({ ok: true, accepted: true, style: result.style })
        : errorContent(result.error);
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  // -------------------------------------------------------------------------
  // get_post_performance
  //
  // What actually happened to this workspace's published posts. An external
  // model can reason about a draft, but it cannot know that THIS author's
  // teardown posts out-performed their hot takes 4:1 — that lives here.
  //
  // Reads post_analytics snapshots only; the daily cron owns refreshing them.
  // No Zernio call at tool-call time (an MCP client can call this in a loop,
  // and a third-party API is not something to put behind that), and no model
  // call anywhere in this path — performance is measured, never inferred.
  // -------------------------------------------------------------------------
  server.registerTool("get_post_performance", {
    title: "Get published post performance",
    description:
      "Read real LinkedIn performance for posts this workspace has published: impressions, reach, likes, comments, shares, saves, sends, plus computed engagements and engagement rate. " +
      "Use this to ground advice in what worked for THIS author rather than general best practice — which topics, hooks, or formats earned engagement, and which underperformed. " +
      "Sort by 'engagement_rate' to compare posts fairly across different reach, or by 'impressions' for raw distribution. " +
      "Numbers come from daily snapshots, so a post published in the last day or two may not be measured yet and is omitted. Returns ok:true with an empty list when nothing has been measured.",
    inputSchema: {
      since: z
        .enum(["7d", "30d", "90d", "365d", "all"])
        .optional()
        .describe("Window over publish date. Default '90d'."),
      post_type: z
        .enum(["regular", "lead_magnet"])
        .optional()
        .describe("Only posts of this type."),
      sort: z
        .enum([
          "impressions",
          "engagements",
          "engagement_rate",
          "likes",
          "comments",
          "published",
        ])
        .optional()
        .describe("Sort key. Default 'impressions'."),
      dir: z.enum(["asc", "desc"]).optional().describe("Default 'desc'. Use 'asc' with a metric sort to surface what underperformed."),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20, max 100."),
    },
  }, async (args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);

      const sb = supabaseAdmin();
      const since = args.since ?? "90d";
      const publishedSince =
        since === "all"
          ? null
          : new Date(
              Date.now() - SINCE_DAYS[since] * 24 * 60 * 60 * 1000,
            ).toISOString();

      // Artifacts first: the window filters on publish date, and starting from
      // the (much smaller) published set keeps the snapshot read bounded by
      // what the caller actually asked for.
      let artifactQuery = sb
        .from("chat_artifacts")
        .select("id, title, body, published_at, kind")
        .eq("workspace_id", workspaceId)
        .eq("schedule_status", "published")
        .not("zernio_post_id", "is", null);
      if (publishedSince) {
        artifactQuery = artifactQuery.gte("published_at", publishedSince);
      }
      if (args.post_type === "lead_magnet") {
        artifactQuery = artifactQuery.eq("kind", "lead_magnet");
      } else if (args.post_type === "regular") {
        artifactQuery = artifactQuery.neq("kind", "lead_magnet");
      }

      const artifactRows = await selectAllRows<{
        id: string;
        title: string | null;
        body: string | null;
        published_at: string | null;
        kind: string | null;
      }>(() => artifactQuery.order("published_at", { ascending: false }) as never);

      if (artifactRows.length === 0) {
        return jsonContent({
          ok: true,
          window: since,
          totals: performanceTotals([]),
          posts: [],
          note: "No measured posts in this window yet.",
        });
      }

      // Chunked: a long `.in(...)` makes PostgREST reject the request with 400
      // "URL too long". Paged for the same reason the analytics page is — one
      // snapshot per post per day passes PostgREST's 1000-row cap in weeks, and
      // a silent truncation here would drop whole posts from the answer.
      const artifactIds = artifactRows.map((row) => row.id);
      const snapshotRows = await selectInChunks<{
        artifact_id: string;
        snapshot_date: string;
        impressions: number | null;
        reach: number | null;
        likes: number | null;
        comments: number | null;
        shares: number | null;
        saves: number | null;
        sends: number | null;
      }>(artifactIds, (idSlice) =>
        sb
          .from("post_analytics")
          .select(
            "artifact_id, snapshot_date, impressions, reach, likes, comments, shares, saves, sends",
          )
          .eq("workspace_id", workspaceId)
          .in("artifact_id", idSlice) as never,
      );

      const rows = buildPerformanceRows(
        artifactRows.map((row) => ({
          artifactId: row.id,
          title: row.title,
          body: row.body,
          publishedAt: row.published_at,
          kind: row.kind,
        })),
        snapshotRows.map((row) => ({
          artifactId: row.artifact_id,
          snapshotDate: row.snapshot_date,
          impressions: row.impressions,
          reach: row.reach,
          likes: row.likes,
          comments: row.comments,
          shares: row.shares,
          saves: row.saves,
          sends: row.sends,
        })),
      );

      const sorted = sortPerformanceRows(
        rows,
        args.sort ?? "impressions",
        args.dir ?? "desc",
      );
      const limit = args.limit ?? 20;

      return jsonContent({
        ok: true,
        window: since,
        // Totals describe the whole filtered window, NOT the truncated page —
        // otherwise "limit: 5" would silently redefine the workspace's average.
        totals: performanceTotals(rows),
        returned: Math.min(limit, sorted.length),
        posts: sorted.slice(0, limit),
      });
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  // -------------------------------------------------------------------------
  // analyze_posts
  //
  // The step after search_viral_posts. Search answers "which posts did well";
  // this answers "what do they DO" — the hook move they open with, how they
  // are shaped on the page, how long they run, the mechanics they share.
  //
  // Deterministic: every number is counted or pattern-matched, never judged by
  // a model. Same input, same answer, no tokens spent, and 50 posts analyze in
  // milliseconds. Structure and mechanics reuse the very modules the writer is
  // graded on, so the corpus is described on the same axes drafts are.
  // -------------------------------------------------------------------------
  server.registerTool("analyze_posts", {
    title: "Analyze what a set of posts has in common",
    description:
      "Given post ids (typically from search_viral_posts), compute what those posts share: which hook patterns they open with, their structure on the page (length, paragraphing, list usage, P.S. rate), and writing mechanics (casing, punctuation, emoji, list markers). " +
      "Use this to turn a pile of high-performing posts into a reusable brief before drafting, instead of eyeballing a few examples. Analysis is measured, not estimated, so repeated calls on the same posts return identical results. " +
      "Hook shares are reported alongside average engagement per pattern, but ranked by frequency — with few posts per pattern an average is easily skewed by one outlier. Treat a small analyzed_posts count as weak evidence.",
    inputSchema: {
      post_ids: z
        .array(z.string().uuid())
        .min(1)
        .max(ANALYZE_POSTS_MAX)
        .describe(
          `Source-post ids to analyze, from search_viral_posts or get_top_from_batch. Max ${ANALYZE_POSTS_MAX}.`,
        ),
    },
  }, async (args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);

      // Same tenancy predicate every other posts read uses: the corpus table is
      // shared across workspaces, so scoping is by tracked account, not by a
      // workspace_id column on the row.
      const accountIds = await trackedAccountIdsForService(workspaceId);
      if (accountIds.length === 0) {
        return jsonContent({
          ok: true,
          analyzed_posts: 0,
          requested_posts: args.post_ids.length,
          note: "This workspace tracks no creators yet, so none of those posts are readable here.",
        });
      }

      const rows = await selectInChunks<{
        id: string;
        text: string | null;
        reactions: number | null;
        comments: number | null;
      }>(args.post_ids, (idSlice) =>
        supabaseAdmin()
          .from("posts")
          .select("id, text, reactions, comments")
          .in("id", idSlice)
          .in("account_id", accountIds) as never,
      );

      const analysis = analyzePostPatterns(
        rows.map((row) => ({
          id: row.id,
          body: row.text ?? "",
          engagement: (row.reactions ?? 0) + (row.comments ?? 0),
        })),
      );

      return jsonContent({
        ok: true,
        // Both counts, always. A caller that asked about 20 posts and got 12
        // back (ids from another workspace, or deleted) must be able to see
        // that rather than reading the analysis as covering all 20.
        requested_posts: args.post_ids.length,
        ...analysis,
      });
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });

  // -------------------------------------------------------------------------
  // get_writing_rules
  //
  // The craft rules as INSTRUCTIONS. Same strings the writer is given; until
  // now they only existed inside the pipeline, so a post drafted by an external
  // agent could not be held to the standard even when the author wanted it to
  // be. The caller's model spends its own tokens and the quality bar travels
  // with the rules.
  //
  // Sectioned because the corpus is ~24k characters: returning all of it every
  // call would evict a caller's working context to deliver rules it did not ask
  // for. No workspace data and no model call — this is a static read.
  // -------------------------------------------------------------------------
  server.registerTool("get_writing_rules", {
    title: "Get SwipeIn's writing rules",
    description:
      "Read the drafting rules SwipeIn applies to its own generations: how to write like a human rather than an assistant, the expanded AI-tell reference (banned constructions, word bank, default swaps, the rhythm trap), how to vary post structure, and the archetype library. " +
      "Load these before drafting or editing a LinkedIn post so the output matches the standard SwipeIn holds itself to. Pair with get_voice — these are the general rules, get_voice is this specific author's habits, and the author's evidenced habits win where the two disagree. " +
      "Sections: 'voice' (core rules), 'ai_tells' (the detailed reference), 'structure' (architecture variety), 'formats' (post archetypes), 'language'. Defaults to voice + ai_tells; request more only when you need them, as the full set is long.",
    inputSchema: {
      sections: z
        .array(z.enum(WRITING_RULE_SECTIONS))
        .optional()
        .describe(
          "Which rule sections to return. Defaults to ['voice','ai_tells'].",
        ),
    },
  }, async (args) => {
    try {
      // Deliberately no workspace lookup: these rules are the same for every
      // caller, so requiring workspace resolution would add a failure mode to
      // a static read for no benefit.
      return jsonContent({ ok: true, ...buildWritingRules(args.sections) });
    } catch (e) { return dbErrorContent("mcp_resource_tool", e); }
  });
}

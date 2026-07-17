import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { DraftLifecycle, draftRecordToApi } from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";
import { postMediaAttachmentsSchema } from "@/lib/post-media";
import { BUILTIN_TEMPLATES } from "@/lib/templates-builtin";
import { templateInputSchema } from "@/lib/templates";
import { skillInputSchema } from "@/lib/custom-skills";
import { loadVisibleCategories } from "@/lib/categories";
import {
  LEAD_MAGNET_COLS,
  coerceLeadMagnet,
  leadMagnetInputSchema,
  type LeadMagnet,
} from "@/lib/lead-magnets";
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
  PREF_COLS,
  SKILL_COLS,
  TEMPLATE_COLS,
} from "@/lib/content-resource-operations";
import { errorContent, jsonContent, notFoundContent } from "./util";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type WorkspaceResolver = (extra: Extra) => string | null;

const NO_WORKSPACE_MSG = "No workspace bound to this session. Join a workspace before using MCP tools.";
const STYLE_COLS = CREATOR_STYLE_COLS;

function ids(extra: Extra, workspaceFromExtra: WorkspaceResolver) {
  const workspaceId = workspaceFromExtra(extra);
  const rawUserId = extra.authInfo?.extra?.userId;
  return {
    workspaceId,
    userId: typeof rawUserId === "string" && rawUserId ? rawUserId : null,
  };
}

function drafts(workspaceId: string) {
  const db = supabaseAdmin();
  return new DraftLifecycle(createSupabaseDraftLifecycleRepository(db, workspaceId));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// list_lead_magnets' row shape: everything in LEAD_MAGNET_COLS except
// markdown_body (up to LEAD_MAGNET_BODY_MAX = 60,000 chars/row), which is
// what made an unpaginated list of a real workspace's lead magnets blow past
// a client's response-size limit. get_lead_magnet still returns the full
// body for one at a time.
const LEAD_MAGNET_LIST_COLS =
  "id, workspace_id, user_id, title, source_url, source_type, public_slug, is_public, metadata, created_at, updated_at";

function exactlyOne(args: { id?: string; name?: string }) {
  return Number(Boolean(args.id)) + Number(Boolean(args.name)) === 1;
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
    } catch (e) { return errorContent((e as Error).message); }
  });

  server.registerTool("create_draft", {
    title: "Create a post draft",
    description: "Create a post, hook, or lead-magnet draft on the workspace Posts board.",
    inputSchema: {
      title: z.string().trim().max(200).optional(),
      body: z.string().trim().max(20_000).optional().default(""),
      kind: z.enum(["post", "hook", "lead_magnet"]).optional(),
      status: z.enum(["idea", "drafting", "ready", "posted"]).optional(),
      plan_to_post_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      media_attachments: postMediaAttachmentsSchema.optional(),
    },
  }, async (args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      if (!args.title?.trim() && !args.body?.trim()) return errorContent("Give the post a name or some content.");
      const draft = await drafts(workspaceId).create({
        title: args.title,
        body: args.body ?? "",
        kind: args.kind,
        status: args.status,
        planToPostOn: args.plan_to_post_on,
        mediaAttachments: args.media_attachments,
      });
      return jsonContent({ ok: true, draft: draftRecordToApi(draft) });
    } catch (e) { return errorContent((e as Error).message); }
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
      if (error) return errorContent((error as Error).message);
      return jsonContent({ ok: true, count: data?.length ?? 0, categories: data ?? [] });
    } catch (e) { return errorContent((e as Error).message); }
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
    } catch (e) { return errorContent((e as Error).message); }
  });

  server.registerTool("list_templates", {
    title: "List writing templates",
    description: "List built-in templates and custom templates created by this workspace.",
    inputSchema: {},
  }, async (_args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const { data, error } = await supabaseAdmin().from("content_templates").select(TEMPLATE_COLS).eq("workspace_id", workspaceId).order("created_at", { ascending: false });
      if (error) return errorContent(error.message);
      const templates = [...BUILTIN_TEMPLATES, ...(data ?? [])];
      return jsonContent({ ok: true, count: templates.length, templates });
    } catch (e) { return errorContent((e as Error).message); }
  });

  server.registerTool("get_template", {
    title: "Get a writing template",
    description: "Read one built-in or workspace-created writing template by id.",
    inputSchema: { id: z.string().min(1) },
  }, async ({ id }, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const builtin = BUILTIN_TEMPLATES.find((template) => template.id === id);
      if (builtin) return jsonContent({ ok: true, template: builtin });
      // Workspace-created templates are the only ones stored in Postgres (id
      // uuid); a builtin id like "builtin:client-win-story" would otherwise
      // reach the query below and surface a raw "invalid input syntax for
      // type uuid" driver error instead of a clean not-found.
      if (!UUID_RE.test(id)) return notFoundContent("Template", id);
      const { data, error } = await supabaseAdmin().from("content_templates").select(TEMPLATE_COLS).eq("id", id).eq("workspace_id", workspaceId).maybeSingle();
      if (error) return notFoundContent("Template", id);
      return data ? jsonContent({ ok: true, template: data }) : notFoundContent("Template", id);
    } catch (e) { return errorContent((e as Error).message); }
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
    } catch (e) { return errorContent((e as Error).message); }
  });

  server.registerTool("list_skills", {
    title: "List custom skills",
    description: "List the workspace's custom Cowork skills with their complete instruction bodies.",
    inputSchema: {},
  }, async (_args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const { data, error } = await supabaseAdmin().from("custom_skills").select(SKILL_COLS).eq("workspace_id", workspaceId).order("created_at", { ascending: false });
      if (error) return errorContent(error.message);
      return jsonContent({ ok: true, count: data?.length ?? 0, skills: data ?? [] });
    } catch (e) { return errorContent((e as Error).message); }
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
      let query = supabaseAdmin().from("custom_skills").select(SKILL_COLS).eq("workspace_id", workspaceId).limit(1);
      const lookup = args.id ?? args.name!;
      query = args.id ? query.eq("id", args.id) : query.eq("name", args.name!);
      const { data, error } = await query.maybeSingle();
      if (error) return notFoundContent("Skill", lookup);
      return data ? jsonContent({ ok: true, skill: data }) : notFoundContent("Skill", lookup);
    } catch (e) { return errorContent((e as Error).message); }
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
    } catch (e) { return errorContent((e as Error).message); }
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
      const { data, error, count } = await supabaseAdmin()
        .from("lead_magnets")
        .select(LEAD_MAGNET_LIST_COLS, { count: "exact" })
        .eq("workspace_id", workspaceId)
        .order("updated_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) return errorContent(error.message);
      return jsonContent({
        ok: true,
        count: data?.length ?? 0,
        total: count ?? 0,
        offset,
        lead_magnets: data ?? [],
      });
    } catch (e) { return errorContent((e as Error).message); }
  });

  server.registerTool("get_lead_magnet", {
    title: "Get a lead magnet",
    description: "Read one workspace lead magnet with its complete Markdown and metadata.",
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const { data, error } = await supabaseAdmin().from("lead_magnets").select(LEAD_MAGNET_COLS).eq("id", id).eq("workspace_id", workspaceId).maybeSingle();
      if (error) return notFoundContent("Lead magnet", id);
      return data ? jsonContent({ ok: true, lead_magnet: coerceLeadMagnet(data as LeadMagnet) }) : notFoundContent("Lead magnet", id);
    } catch (e) { return errorContent((e as Error).message); }
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
    } catch (e) { return errorContent((e as Error).message); }
  });

  server.registerTool("list_preferences", {
    title: "List standing writing preferences",
    description: "List the workspace writing rules automatically applied to every Cowork generation.",
    inputSchema: {},
  }, async (_args, extra) => {
    try {
      const { workspaceId } = ids(extra, workspaceFromExtra);
      if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
      const { data, error } = await supabaseAdmin().from("content_preferences").select(PREF_COLS).eq("workspace_id", workspaceId).order("created_at", { ascending: false });
      if (error) return errorContent(error.message);
      return jsonContent({ ok: true, count: data?.length ?? 0, preferences: data ?? [] });
    } catch (e) { return errorContent((e as Error).message); }
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
    } catch (e) { return errorContent((e as Error).message); }
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
    } catch (e) { return errorContent((e as Error).message); }
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
      if (error) return errorContent(error.message);
      return jsonContent({ ok: true, count: data?.length ?? 0, styles: data ?? [] });
    } catch (e) { return errorContent((e as Error).message); }
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
      if (sourceError) return errorContent(sourceError.message);
      return jsonContent({ ok: true, style: data, sources: sources ?? [] });
    } catch (e) { return errorContent((e as Error).message); }
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
    } catch (e) { return errorContent((e as Error).message); }
  });
}

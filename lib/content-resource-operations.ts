import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  SKILLS_PER_WORKSPACE_MAX,
  type CustomSkill,
  type SkillInput,
} from "@/lib/custom-skills";
import {
  TEMPLATES_PER_WORKSPACE_MAX,
  type BuiltinTemplate,
  type ContentTemplate,
  type TemplateInput,
} from "@/lib/templates";
import { BUILTIN_TEMPLATES } from "@/lib/templates-builtin";
import { embedTemplateBody, structureTypeFromCategory } from "@/lib/template-embeddings";
import {
  isDuplicatePreference,
  PREFS_PER_WORKSPACE_MAX,
  type ContentPreference,
  type PreferenceInput,
} from "@/lib/preferences";
import {
  LEAD_MAGNET_COLS,
  coerceLeadMagnet,
  makePublicSlug,
  normalizeLeadMagnetMetadata,
  type LeadMagnet,
} from "@/lib/lead-magnets";
import { normalizeCollapsedMarkdownTables } from "@/lib/markdown-tables";

export const CUSTOM_CATEGORY_LIMIT = 50;
export const CATEGORY_COLS = "id, label";
export const TEMPLATE_COLS = "id, workspace_id, title, category, body, source, origin_post_id, created_at, updated_at";
export const SKILL_COLS = "id, workspace_id, name, description, body, created_at, updated_at";
export const PREF_COLS = "id, workspace_id, rule, detail, source, created_at, updated_at";
export const BRAND_COLS = "id, name, brand_colors, notes, logo_url, font_primary, font_secondary, created_at";
export const LEAD_MAGNET_LIST_COLS =
  "id, workspace_id, user_id, title, source_url, source_type, public_slug, is_public, metadata, created_at, updated_at";
export const BOOKMARK_RESOURCE_COLS =
  "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, text, profile_pic_url, media_type, media_urls, video_url, reactions, comments, note, category_id, post_type, posted_at, saved_at, workspace_id, created_by_user_id";

export type SavedBookmarkResource = {
  id: string;
  post_url: string;
  activity_id: string;
  embed_urn: string | null;
  author_name: string | null;
  author_handle: string | null;
  text_snippet: string | null;
  text: string | null;
  profile_pic_url: string | null;
  media_type: string | null;
  media_urls: unknown[] | null;
  video_url: string | null;
  reactions: number | null;
  comments: number | null;
  note: string | null;
  category_id: string | null;
  post_type: string | null;
  posted_at: string | null;
  saved_at: string;
  workspace_id: string;
  created_by_user_id: string | null;
};

export type BookmarkResourceSummary = Pick<
  SavedBookmarkResource,
  | "id"
  | "post_url"
  | "activity_id"
  | "embed_urn"
  | "author_name"
  | "author_handle"
  | "text_snippet"
  | "note"
  | "category_id"
  | "saved_at"
>;

export function summarizeBookmarkResource(
  bookmark: SavedBookmarkResource,
): BookmarkResourceSummary {
  return {
    id: bookmark.id,
    post_url: bookmark.post_url,
    activity_id: bookmark.activity_id,
    embed_urn: bookmark.embed_urn,
    author_name: bookmark.author_name,
    author_handle: bookmark.author_handle,
    text_snippet: bookmark.text_snippet,
    note: bookmark.note,
    category_id: bookmark.category_id,
    saved_at: bookmark.saved_at,
  };
}

export async function findBookmarkResource(input: {
  db: SupabaseClient;
  workspaceId: string;
  activityId: string;
}): Promise<SavedBookmarkResource | null> {
  const { data, error } = await input.db
    .from("saved_posts")
    .select(BOOKMARK_RESOURCE_COLS)
    .eq("workspace_id", input.workspaceId)
    .eq("activity_id", input.activityId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as SavedBookmarkResource | null) ?? null;
}

export async function saveBookmarkResource(input: {
  db: SupabaseClient;
  workspaceId: string;
  activityId: string;
  values: Record<string, unknown>;
  knownAbsent?: boolean;
}): Promise<{ saved: SavedBookmarkResource; existed: boolean }> {
  if (!input.knownAbsent) {
    const existing = await findBookmarkResource(input);
    if (existing) return { saved: existing, existed: true };
  }

  const { data, error } = await input.db
    .from("saved_posts")
    .insert({
      ...input.values,
      workspace_id: input.workspaceId,
      activity_id: input.activityId,
    })
    .select(BOOKMARK_RESOURCE_COLS)
    .single();
  if (!error && data) {
    return {
      saved: data as unknown as SavedBookmarkResource,
      existed: false,
    };
  }
  if (error?.code === "23505") {
    const raced = await findBookmarkResource(input);
    if (raced) return { saved: raced, existed: true };
  }
  throw error ?? new Error("Bookmark insert returned no row.");
}

export async function listBookmarkResources(input: {
  db: SupabaseClient;
  workspaceId: string;
  limit: number;
}): Promise<SavedBookmarkResource[]> {
  const { data, error } = await input.db
    .from("saved_posts")
    .select(BOOKMARK_RESOURCE_COLS)
    .eq("workspace_id", input.workspaceId)
    .order("saved_at", { ascending: false })
    .limit(input.limit);
  if (error) throw error;
  return (data ?? []) as unknown as SavedBookmarkResource[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TemplateResource = ContentTemplate | BuiltinTemplate;

export async function listTemplateResources(input: {
  db: SupabaseClient;
  workspaceId: string;
}): Promise<TemplateResource[]> {
  const { data, error } = await input.db
    .from("content_templates")
    .select(TEMPLATE_COLS)
    .eq("workspace_id", input.workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return [...BUILTIN_TEMPLATES, ...((data ?? []) as ContentTemplate[])];
}

export async function getTemplateResource(input: {
  db: SupabaseClient;
  workspaceId: string;
  id: string;
}): Promise<TemplateResource | null> {
  const builtin = BUILTIN_TEMPLATES.find((template) => template.id === input.id);
  if (builtin) return builtin;
  if (!UUID_RE.test(input.id)) return null;
  const { data, error } = await input.db
    .from("content_templates")
    .select(TEMPLATE_COLS)
    .eq("id", input.id)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (error) throw error;
  return (data as ContentTemplate | null) ?? null;
}

export async function listSkillResources(input: {
  db: SupabaseClient;
  workspaceId: string;
}): Promise<CustomSkill[]> {
  const { data, error } = await input.db
    .from("custom_skills")
    .select(SKILL_COLS)
    .eq("workspace_id", input.workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as CustomSkill[];
}

export async function getSkillResource(input: {
  db: SupabaseClient;
  workspaceId: string;
  id?: string;
  name?: string;
}): Promise<CustomSkill | null> {
  let query = input.db
    .from("custom_skills")
    .select(SKILL_COLS)
    .eq("workspace_id", input.workspaceId)
    .limit(1);
  query = input.id ? query.eq("id", input.id) : query.eq("name", input.name!);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as CustomSkill | null) ?? null;
}

export async function getSkillsByIds(input: {
  db: SupabaseClient;
  workspaceId: string;
  ids: readonly string[];
}): Promise<CustomSkill[]> {
  if (input.ids.length === 0) return [];
  const { data, error } = await input.db
    .from("custom_skills")
    .select(SKILL_COLS)
    .eq("workspace_id", input.workspaceId)
    .in("id", [...input.ids]);
  if (error) throw error;
  return (data ?? []) as CustomSkill[];
}

export async function getSkillsByNames(input: {
  db: SupabaseClient;
  workspaceId: string;
  names: readonly string[];
}): Promise<CustomSkill[]> {
  if (input.names.length === 0) return [];
  const { data, error } = await input.db
    .from("custom_skills")
    .select(SKILL_COLS)
    .eq("workspace_id", input.workspaceId)
    .in("name", [...input.names]);
  if (error) throw error;
  return (data ?? []) as CustomSkill[];
}

export async function listPreferenceResources(input: {
  db: SupabaseClient;
  workspaceId: string;
  limit?: number;
}): Promise<ContentPreference[]> {
  let query = input.db
    .from("content_preferences")
    .select(PREF_COLS)
    .eq("workspace_id", input.workspaceId)
    .order("created_at", { ascending: false });
  if (input.limit !== undefined) query = query.limit(input.limit);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ContentPreference[];
}

export type LeadMagnetSummary = Omit<LeadMagnet, "markdown_body">;

export function listLeadMagnetResources(input: {
  db: SupabaseClient;
  workspaceId: string;
  limit: number;
  offset?: number;
  includeBody: true;
}): Promise<{ rows: LeadMagnet[]; total: number }>;
export function listLeadMagnetResources(input: {
  db: SupabaseClient;
  workspaceId: string;
  limit: number;
  offset?: number;
  includeBody?: false;
}): Promise<{ rows: LeadMagnetSummary[]; total: number }>;
export async function listLeadMagnetResources(input: {
  db: SupabaseClient;
  workspaceId: string;
  limit: number;
  offset?: number;
  includeBody?: boolean;
}): Promise<{ rows: Array<LeadMagnet | LeadMagnetSummary>; total: number }> {
  const offset = input.offset ?? 0;
  let query = input.db
    .from("lead_magnets")
    .select(input.includeBody ? LEAD_MAGNET_COLS : LEAD_MAGNET_LIST_COLS, {
      count: "exact",
    })
    .eq("workspace_id", input.workspaceId)
    .order("updated_at", { ascending: false });
  query = query.range(offset, offset + input.limit - 1);
  const { data, error, count } = await query;
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<LeadMagnet | LeadMagnetSummary>;
  return {
    rows: input.includeBody
      ? (rows as LeadMagnet[]).map(coerceLeadMagnet)
      : rows,
    total: count ?? 0,
  };
}

export async function getLeadMagnetResource(input: {
  db: SupabaseClient;
  workspaceId: string;
  id: string;
}): Promise<LeadMagnet | null> {
  const { data, error } = await input.db
    .from("lead_magnets")
    .select(LEAD_MAGNET_COLS)
    .eq("id", input.id)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data ? coerceLeadMagnet(data as LeadMagnet) : null;
}

export const brandInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  brand_colors: z
    .array(
      z.object({
        name: z.string().trim().max(80).optional(),
        hex: z.string().regex(/^#?[0-9a-fA-F]{6}$/),
      }),
    )
    .max(20)
    .default([]),
  notes: z.string().trim().max(10_000).optional().nullable(),
  logo_url: z.string().url().optional().nullable(),
  font_primary: z.string().trim().max(120).optional().nullable(),
  font_secondary: z.string().trim().max(120).optional().nullable(),
});
export type BrandInput = z.infer<typeof brandInputSchema>;

export type OperationResult<T> =
  | { ok: true; value: T; existed?: boolean }
  | { ok: false; status: number; error: string };

export async function createCategoryResource(input: {
  db: SupabaseClient;
  workspaceId: string;
  label: string;
}): Promise<OperationResult<{ id: string; label: string }>> {
  const { db, workspaceId, label } = input;
  const { data: rows, error } = await db
    .from("categories")
    .select(CATEGORY_COLS)
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  const existing = (rows ?? []).find(
    (row) => String(row.label).toLowerCase() === label.toLowerCase(),
  );
  if (existing) {
    return {
      ok: true,
      value: { id: String(existing.id), label: String(existing.label) },
      existed: true,
    };
  }
  if ((rows ?? []).length >= CUSTOM_CATEGORY_LIMIT) {
    return {
      ok: false,
      status: 400,
      error: `You've reached the ${CUSTOM_CATEGORY_LIMIT} custom category limit.`,
    };
  }
  const { data, error: insertError } = await db
    .from("categories")
    .insert({
      id: crypto.randomUUID(),
      label,
      sort_order: 1000,
      is_curated: false,
      workspace_id: workspaceId,
    })
    .select(CATEGORY_COLS)
    .single();
  if (insertError) throw insertError;
  return { ok: true, value: { id: String(data.id), label: String(data.label) } };
}

// Atomic: claim_content_template_slot (migration 100) takes a per-workspace
// advisory lock and counts + inserts INSIDE that lock, closing the
// count-then-insert TOCTOU race a plain SELECT-count-then-INSERT has (two
// concurrent creates could both read a below-cap count and both proceed).
export async function createTemplateResource(input: {
  db: SupabaseClient;
  workspaceId: string;
  data: TemplateInput;
}): Promise<OperationResult<ContentTemplate>> {
  const { db, workspaceId, data: request } = input;
  const embedding = await embedTemplateBody(request.body, { workspaceId });
  const inferredStructureType = structureTypeFromCategory(request.category);
  const { data, error } = await db
    .rpc("claim_content_template_slot", {
      p_workspace_id: workspaceId,
      p_max_templates: TEMPLATES_PER_WORKSPACE_MAX,
      p_title: request.title,
      p_category: request.category,
      p_body: request.body,
      p_source: "custom",
      p_origin_post_id: null,
      p_embedding: `[${embedding.join(",")}]`,
      p_structure_type: inferredStructureType,
    })
    .single();
  if (error) throw error;
  const row = data as ContentTemplate & { over_cap: boolean };
  if (row.over_cap) {
    return {
      ok: false,
      status: 409,
      error: `You've reached the limit of ${TEMPLATES_PER_WORKSPACE_MAX} templates. Delete one to add another.`,
    };
  }
  return {
    ok: true,
    value: {
      id: row.id,
      workspace_id: row.workspace_id,
      title: row.title,
      category: row.category,
      body: row.body,
      source: row.source,
      origin_post_id: row.origin_post_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  };
}

export async function createSkillResource(input: {
  db: SupabaseClient;
  workspaceId: string;
  data: SkillInput;
}): Promise<OperationResult<CustomSkill>> {
  const { db, workspaceId, data: request } = input;
  const { count, error: countError } = await db
    .from("custom_skills")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  if (countError) throw countError;
  if ((count ?? 0) >= SKILLS_PER_WORKSPACE_MAX) {
    return { ok: false, status: 409, error: `You've reached the limit of ${SKILLS_PER_WORKSPACE_MAX} custom skills. Delete one to add another.` };
  }
  const { data, error } = await db
    .from("custom_skills")
    .insert({ ...request, workspace_id: workspaceId })
    .select(SKILL_COLS)
    .single();
  if (error?.code === "23505") {
    return { ok: false, status: 409, error: `A skill named "${request.name}" already exists.` };
  }
  if (error) throw error;
  return { ok: true, value: data as CustomSkill };
}

export async function createPreferenceResource(input: {
  db: SupabaseClient;
  workspaceId: string;
  data: PreferenceInput;
}): Promise<OperationResult<ContentPreference>> {
  const { db, workspaceId, data: request } = input;
  const { data: existing, error: readError } = await db
    .from("content_preferences")
    .select(PREF_COLS)
    .eq("workspace_id", workspaceId);
  if (readError) throw readError;
  const rows = (existing ?? []) as ContentPreference[];
  if (rows.length >= PREFS_PER_WORKSPACE_MAX) {
    return { ok: false, status: 409, error: `You've reached the limit of ${PREFS_PER_WORKSPACE_MAX} preferences. Delete one to add another.` };
  }
  if (isDuplicatePreference(request.rule, rows)) {
    return { ok: false, status: 409, error: "You already have that preference." };
  }
  const { data, error } = await db
    .from("content_preferences")
    .insert({
      rule: request.rule,
      detail: request.detail || null,
      source: "user",
      workspace_id: workspaceId,
    })
    .select(PREF_COLS)
    .single();
  if (error?.code === "23505") {
    return {
      ok: false,
      status: 409,
      error: "You already have that preference.",
    };
  }
  if (error) throw error;
  return { ok: true, value: data as ContentPreference };
}

export async function createLeadMagnetResource(input: {
  db: SupabaseClient;
  workspaceId: string;
  userId: string;
  data: {
    title: string;
    markdown_body: string;
    source_url?: string | null;
    is_public: boolean;
    metadata: Record<string, unknown>;
  };
}): Promise<OperationResult<LeadMagnet>> {
  const { db, workspaceId, userId, data: request } = input;
  const markdown = normalizeCollapsedMarkdownTables(request.markdown_body).trim();
  const { data, error } = await db
    .from("lead_magnets")
    .insert({
      workspace_id: workspaceId,
      user_id: userId,
      title: request.title,
      markdown_body: markdown,
      source_url: request.source_url ?? null,
      source_type: "manual",
      public_slug: makePublicSlug(request.title),
      is_public: request.is_public,
      metadata: normalizeLeadMagnetMetadata(request.metadata, markdown),
    })
    .select(LEAD_MAGNET_COLS)
    .single();
  if (error) throw error;
  return { ok: true, value: coerceLeadMagnet(data as LeadMagnet) };
}

export async function createBrandResource(input: {
  db: SupabaseClient;
  workspaceId: string;
  data: BrandInput;
}): Promise<OperationResult<Record<string, unknown>>> {
  const { db, workspaceId, data: request } = input;
  const { data, error } = await db
    .from("clients")
    .insert({
      workspace_id: workspaceId,
      ...request,
      brand_colors: (request.brand_colors ?? []).map((color) => ({
        ...color,
        hex: color.hex.startsWith("#") ? color.hex : `#${color.hex}`,
      })),
    })
    .select(BRAND_COLS)
    .single();
  if (error) throw error;
  return { ok: true, value: data as Record<string, unknown> };
}

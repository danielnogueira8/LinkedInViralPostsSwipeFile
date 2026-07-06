import { randomBytes } from "crypto";
import { z } from "zod";

export type LeadMagnetSourceType = "manual" | "url" | "ai";

export type LeadMagnetMetadata = {
  summary?: string | null;
  deliverables?: string[];
};

export type LeadMagnet = {
  id: string;
  workspace_id: string;
  user_id: string;
  title: string;
  markdown_body: string;
  source_url: string | null;
  source_type: LeadMagnetSourceType;
  public_slug: string;
  is_public: boolean;
  metadata: LeadMagnetMetadata;
  created_at: string;
  updated_at: string;
};

export const LEAD_MAGNET_TITLE_MAX = 160;
export const LEAD_MAGNET_BODY_MAX = 60_000;
export const LEAD_MAGNET_AI_MONTHLY_LIMIT = 5;
export const LEAD_MAGNET_COLS =
  "id, workspace_id, user_id, title, markdown_body, source_url, source_type, public_slug, is_public, metadata, created_at, updated_at";

const metadataSchema = z
  .object({
    summary: z.string().trim().max(500).nullable().optional(),
    deliverables: z.array(z.string().trim().min(1).max(140)).max(12).optional(),
  })
  .passthrough()
  .optional()
  .default({});

export const leadMagnetInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(LEAD_MAGNET_TITLE_MAX),
  markdown_body: z
    .string()
    .trim()
    .min(1, "Content is required")
    .max(LEAD_MAGNET_BODY_MAX, "Lead magnets can be up to 60,000 characters."),
  source_url: z
    .string()
    .trim()
    .url("Use a valid URL.")
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  is_public: z.boolean().optional().default(true),
  metadata: metadataSchema,
});

export const leadMagnetGenerateSchema = z.object({
  prompt: z.string().trim().min(8, "Describe the lead magnet you want.").max(1200),
});

export const leadMagnetImportSchema = z.object({
  url: z.string().trim().url("Use a valid public Notion, Google Doc, or webpage URL."),
});

export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)).toISOString();
}

export function slugBase(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return base || "lead-magnet";
}

export function makePublicSlug(title: string): string {
  return `${slugBase(title)}-${randomBytes(4).toString("hex")}`;
}

export function normalizeLeadMagnetMetadata(input: unknown, markdown: string): LeadMagnetMetadata {
  const parsed = metadataSchema.safeParse(input);
  const raw = parsed.success ? parsed.data : {};
  const deliverables = raw.deliverables?.length
    ? raw.deliverables
    : extractDeliverables(markdown);
  const summary = raw.summary ?? firstParagraph(markdown);
  return {
    summary: summary ? summary.slice(0, 500) : null,
    deliverables: deliverables.slice(0, 8),
  };
}

export function extractDeliverables(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*]\s+(.{3,140})$/) ?? trimmed.match(/^\d+[.)]\s+(.{3,140})$/);
    if (!bullet) continue;
    const value = cleanInlineMarkdown(bullet[1]).replace(/[.:;]\s*$/, "").trim();
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= 8) break;
  }
  return out;
}

export function firstParagraph(markdown: string): string | null {
  for (const block of markdown.split(/\n{2,}/)) {
    const cleaned = cleanInlineMarkdown(block)
      .replace(/^#+\s+/gm, "")
      .replace(/^[-*]\s+/gm, "")
      .replace(/^\d+[.)]\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 20) return cleaned;
  }
  return null;
}

export function leadMagnetPromptContext(leadMagnet: Pick<LeadMagnet, "title" | "markdown_body" | "metadata">): string {
  const deliverables = leadMagnet.metadata.deliverables?.length
    ? leadMagnet.metadata.deliverables.map((d) => `- ${d}`).join("\n")
    : "- No explicit deliverables extracted";
  return [
    `Title: ${leadMagnet.title}`,
    "Deliverables:",
    deliverables,
    "Markdown excerpt:",
    leadMagnet.markdown_body.slice(0, 5000),
  ].join("\n");
}

export function coerceLeadMagnet(row: LeadMagnet): LeadMagnet {
  return {
    ...row,
    metadata: normalizeLeadMagnetMetadata(row.metadata, row.markdown_body),
  };
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

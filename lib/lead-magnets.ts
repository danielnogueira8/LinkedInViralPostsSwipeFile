import { randomBytes } from "crypto";
import { z } from "zod";

export type LeadMagnetSourceType = "manual" | "url" | "ai";

export type LeadMagnetMetadata = {
  summary?: string | null;
  selection_summary?: string | null;
  deliverables?: string[];
  ctas?: LeadMagnetCta[];
  cta_url?: string | null;
  cta_label?: string | null;
  quality_status?: "passed" | "review_suggested";
  quality_warnings?: string[];
};

export type LeadMagnetCta = {
  url: string;
  label: string;
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
export const LEAD_MAGNET_AI_MONTHLY_LIMIT = 10;
export const LEAD_MAGNET_COLS =
  "id, workspace_id, user_id, title, markdown_body, source_url, source_type, public_slug, is_public, metadata, created_at, updated_at";

const optionalUrlSchema = z
  .string()
  .trim()
  .url("Use a valid CTA URL.")
  .refine((url) => isHttpUrl(url), "Use an http or https CTA URL.")
  .nullable()
  .optional()
  .or(z.literal("").transform(() => null));

const optionalShortTextSchema = z
  .string()
  .trim()
  .max(80)
  .nullable()
  .optional()
  .or(z.literal("").transform(() => null));

const leadMagnetCtaSchema = z.object({
  url: z
    .string()
    .trim()
    .url("Use a valid CTA URL.")
    .refine((url) => isHttpUrl(url), "Use an http or https CTA URL."),
  label: z.string().trim().min(1).max(80),
});

const metadataSchema = z
  .object({
    summary: z.string().trim().max(500).nullable().optional(),
    selection_summary: z.string().trim().max(360).nullable().optional(),
    deliverables: z.array(z.string().trim().min(1).max(140)).max(12).optional(),
    ctas: z.array(leadMagnetCtaSchema).max(8).optional(),
    cta_url: optionalUrlSchema,
    cta_label: optionalShortTextSchema,
    quality_status: z.enum(["passed", "review_suggested"]).optional(),
    quality_warnings: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
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
    .refine((url) => isHttpUrl(url), "Use an http or https source URL.")
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  is_public: z.boolean().optional().default(true),
  metadata: metadataSchema,
});

export const leadMagnetGenerateSchema = z.object({
  prompt: z.string().trim().min(8, "Describe the lead magnet you want.").max(1200),
  cta_url: optionalUrlSchema,
  cta_label: optionalShortTextSchema,
});

export const leadMagnetImportSchema = z.object({
  url: z
    .string()
    .trim()
    .url("Use a valid public Notion, Google Doc, or webpage URL.")
    .refine((url) => isHttpUrl(url), "Use an http or https public URL."),
});

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

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
  const selectionSummary =
    raw.selection_summary ?? buildLeadMagnetSelectionSummary(summary, deliverables, markdown);
  const hasCtaUrl = Object.prototype.hasOwnProperty.call(raw, "cta_url");
  const hasCtaLabel = Object.prototype.hasOwnProperty.call(raw, "cta_label");
  const hasCtas = Object.prototype.hasOwnProperty.call(raw, "ctas");
  const extractedCtas = extractCtas(markdown);
  const explicitCtas = hasCtas ? dedupeCtas(raw.ctas ?? []) : [];
  const ctaUrl = hasCtaUrl ? (raw.cta_url ?? null) : explicitCtas[0]?.url ?? extractedCtas[0]?.url ?? null;
  const rawCtaLabel = hasCtaLabel
    ? (raw.cta_label ?? null)
    : explicitCtas[0]?.label ?? extractedCtas[0]?.label ?? (ctaUrl ? "Book a call" : null);
  const ctaLabel = rawCtaLabel?.trim() || null;
  const ctas = hasCtas
    ? explicitCtas
    : ctaUrl
      ? dedupeCtas([{ url: ctaUrl, label: ctaLabel ?? "Open link" }, ...extractedCtas])
      : extractedCtas;
  return {
    summary: summary ? summary.slice(0, 500) : null,
    selection_summary: selectionSummary ? selectionSummary.slice(0, 360) : null,
    deliverables: deliverables.slice(0, 8),
    ctas: ctas.slice(0, 8),
    cta_url: ctaUrl,
    cta_label: ctaLabel,
    quality_status: raw.quality_status,
    quality_warnings: raw.quality_warnings,
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

export function leadMagnetPromptContext(
  leadMagnet: Pick<LeadMagnet, "title" | "markdown_body" | "metadata">,
): string {
  const deliverables = leadMagnet.metadata.deliverables?.length
    ? leadMagnet.metadata.deliverables.map((d) => `- ${d}`).join("\n")
    : "- No explicit deliverables extracted";
  return [
    `Title: ${leadMagnet.title}`,
    `Summary: ${leadMagnet.metadata.selection_summary ?? leadMagnet.metadata.summary ?? "No summary available"}`,
    "Deliverables:",
    deliverables,
    "Markdown excerpt:",
    leadMagnetPromptExcerpt(leadMagnet.markdown_body, leadMagnet.metadata),
  ].join("\n");
}

function leadMagnetPromptExcerpt(markdown: string, metadata: LeadMagnetMetadata): string {
  const ctaUrls = new Set(
    [metadata.cta_url, ...(metadata.ctas ?? []).map((cta) => cta.url)]
      .map((url) => url?.trim())
      .filter((url): url is string => Boolean(url)),
  );
  return markdown
    .split(/\r?\n/)
    .filter((line) => {
      for (const ctaUrl of ctaUrls) {
        if (line.includes(ctaUrl)) return false;
      }
      return !/\b(book\s+(a|your)|schedule|calendly|strategy call|30[-\s]?min call|demo|apply|consultation|meeting)\b/i.test(line);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 5000);
}

export function extractCtaUrl(markdown: string): string | null {
  return extractCtas(markdown)[0]?.url ?? extractAllLinks(markdown)[0] ?? null;
}

export function extractCtas(markdown: string): LeadMagnetCta[] {
  const out: LeadMagnetCta[] = [];
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    if (!/https?:\/\//i.test(line)) continue;
    if (/\b(book|call|calendly|calendar|strategy|demo|apply|consultation|meeting|talk)\b/i.test(line)) {
      for (const match of line.matchAll(/https?:\/\/[^\s)\]>"]+/gi)) {
        out.push({
          url: cleanUrl(match[0]),
          label: inferCtaLabel(line, match[0]),
        });
      }
    }
  }
  if (out.length > 0) return dedupeCtas(out);
  return extractAllLinks(markdown).map((url) => ({ url, label: "Open resource" })).slice(0, 1);
}

export function coerceLeadMagnet(row: LeadMagnet): LeadMagnet {
  return {
    ...row,
    metadata: normalizeLeadMagnetMetadata(row.metadata, row.markdown_body),
  };
}

export function selectLeadMagnetForPrompt<T extends Pick<LeadMagnet, "title" | "metadata" | "updated_at">>(
  prompt: string,
  leadMagnets: T[],
): T | null {
  if (leadMagnets.length === 0) return null;
  const promptTerms = tokenSet(prompt);
  let best = leadMagnets[0];
  let bestScore = scoreLeadMagnet(promptTerms, best);
  for (const leadMagnet of leadMagnets.slice(1)) {
    const score = scoreLeadMagnet(promptTerms, leadMagnet);
    if (score > bestScore) {
      best = leadMagnet;
      bestScore = score;
    }
  }
  return best;
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function extractAllLinks(markdown: string): string[] {
  return Array.from(markdown.matchAll(/https?:\/\/[^\s)\]>"]+/gi)).map((m) => cleanUrl(m[0]));
}

function cleanUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/g, "");
}

function dedupeCtas(ctas: LeadMagnetCta[]): LeadMagnetCta[] {
  const seen = new Set<string>();
  const out: LeadMagnetCta[] = [];
  for (const cta of ctas) {
    const url = cta.url.trim();
    const label = cta.label.trim() || "Open link";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, label: label.slice(0, 80) });
  }
  return out;
}

function inferCtaLabel(line: string, rawUrl: string): string {
  const url = cleanUrl(rawUrl);
  const markdownLink = line.match(/\[([^\]]{1,80})\]\((https?:\/\/[^)]+)\)/i);
  if (markdownLink && cleanUrl(markdownLink[2]) === url) {
    return cleanInlineMarkdown(markdownLink[1]).slice(0, 80) || "Open link";
  }
  if (/\b(book|schedule|30[-\s]?min|call)\b/i.test(line)) return "Book a call";
  if (/\b(apply|application)\b/i.test(line)) return "Apply";
  if (/\b(demo)\b/i.test(line)) return "Book a demo";
  if (/\b(talk|consultation|strategy)\b/i.test(line)) return "Talk strategy";
  return "Open link";
}

function scoreLeadMagnet(
  promptTerms: Set<string>,
  leadMagnet: Pick<LeadMagnet, "title" | "metadata" | "updated_at">,
): number {
  const searchable = [
    leadMagnet.title,
    leadMagnet.metadata.selection_summary ?? "",
    leadMagnet.metadata.summary ?? "",
    ...(leadMagnet.metadata.deliverables ?? []),
  ].join(" ");
  const terms = tokenSet(searchable);
  let score = 0;
  for (const term of promptTerms) {
    if (terms.has(term)) score += 3;
  }
  if (/giveaway|lead\s*magnet|resource|checklist|template|guide|playbook/i.test(searchable)) {
    score += 1;
  }
  const updatedAt = Date.parse(leadMagnet.updated_at);
  if (Number.isFinite(updatedAt)) {
    score += Math.max(0, updatedAt / 1_000_000_000_000) / 100;
  }
  return score;
}

function buildLeadMagnetSelectionSummary(
  summary: string | null | undefined,
  deliverables: string[],
  markdown: string,
): string | null {
  const parts: string[] = [];
  if (summary) parts.push(summary.replace(/\s+/g, " ").trim());
  if (deliverables.length > 0) {
    parts.push(`Includes: ${deliverables.slice(0, 5).join(", ")}.`);
  }
  if (parts.length === 0) {
    const fallback = firstParagraph(markdown);
    if (fallback) parts.push(fallback);
  }
  const out = parts.join(" ").replace(/\s+/g, " ").trim();
  return out || null;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );
}

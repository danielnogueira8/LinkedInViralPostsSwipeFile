import { z } from "zod";

export const CoworkUsageStageKindSchema = z.enum([
  "planning",
  "research",
  "writing",
  "other",
]);
export type CoworkUsageStageKind = z.infer<typeof CoworkUsageStageKindSchema>;

export const CoworkTurnUsageWireSchema = z.object({
  total_credits: z.number().int().min(0).max(1_000),
  total_cost_usd: z.number().min(0).max(100),
  stages: z
    .array(
      z.object({
        kind: CoworkUsageStageKindSchema,
        credits: z.number().int().min(0).max(1_000),
        cost_usd: z.number().min(0).max(100),
        models: z.array(z.string().min(1).max(128)).max(8),
      }),
    )
    .max(4),
});

export type CoworkTurnUsageWire = z.infer<typeof CoworkTurnUsageWireSchema>;
export type CoworkTurnUsage = {
  totalCredits: number;
  totalCostUsd: number;
  stages: Array<{
    kind: CoworkUsageStageKind;
    credits: number;
    costUsd: number;
    models: string[];
  }>;
};

export function parseCoworkTurnUsage(value: unknown): CoworkTurnUsage | null {
  const parsed = CoworkTurnUsageWireSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    totalCredits: parsed.data.total_credits,
    totalCostUsd: parsed.data.total_cost_usd,
    stages: parsed.data.stages.map((stage) => ({
      kind: stage.kind,
      credits: stage.credits,
      costUsd: stage.cost_usd,
      models: stage.models,
    })),
  };
}

export type ResearchSource = {
  title: string;
  url: string;
  publishedAt?: string;
};

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function displaySourceTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const unwrapped = value
    .trim()
    .replace(/^<news_title(?:\s[^>]*)?>\s*/i, "")
    .replace(/\s*<\/news_title>$/i, "")
    .trim();
  return (unwrapped || fallback).slice(0, 300);
}

export function researchSourcesFromArtifact(
  meta: Record<string, unknown> | undefined,
): ResearchSource[] {
  const provenance = meta?.research_provenance;
  if (!provenance || typeof provenance !== "object") return [];
  const sources = (provenance as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  const seen = new Set<string>();
  return sources.flatMap((source): ResearchSource[] => {
    if (!source || typeof source !== "object") return [];
    const row = source as Record<string, unknown>;
    const url = safeHttpUrl(row.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const title = displaySourceTitle(
      row.title,
      new URL(url).hostname.replace(/^www\./, ""),
    );
    const publishedAt =
      typeof row.published_at === "string" && row.published_at.trim()
        ? row.published_at.trim().slice(0, 40)
        : undefined;
    return [{ title, url, ...(publishedAt ? { publishedAt } : {}) }];
  });
}

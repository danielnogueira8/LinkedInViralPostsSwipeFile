import { supabaseAdmin } from "./supabase";
import { embedText, EMBEDDING_MODEL } from "./openrouter";
import { toVectorLiteral } from "./post-embeddings";
import { selectAllRows } from "./db-paginate";
import {
  isStructureContentType,
  type StructureContentType,
} from "./templates";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Template embeddings (PLAN-agent-loop Phase A2).
//
// Reuses the same text-embedding-3-small model / OpenRouter seam as post
// embeddings so the structure pool is comparable. All callers are server-side.
// ---------------------------------------------------------------------------

export const TEMPLATE_EMBED_BATCH_SIZE = 64;

export async function embedTemplateBody(
  body: string,
  opts: { signal?: AbortSignal; workspaceId?: string } = {},
): Promise<number[]> {
  const { embeddings } = await embedText([body], {
    model: EMBEDDING_MODEL,
    signal: opts.signal,
    workspaceId: opts.workspaceId,
  });
  return embeddings[0];
}

export type TemplateRow = {
  id: string;
  workspace_id: string;
  body: string;
  category: string | null;
  embedding: string | null;
  structure_type: string | null;
};

// Heuristic mapping from template category → structure arc. A template's UI
// category is usually a good proxy for the structure it provides.
export function structureTypeFromCategory(category: string | null): StructureContentType {
  switch (category) {
    case "story":
      return "story";
    case "contrarian":
      return "contrarian";
    case "listicle":
      return "how_to";
    case "before_after":
      return "story";
    case "lead_magnet":
      return "announcement";
    case "single_insight":
      return "contrarian";
    case "question":
      return "how_to";
    case "namejack":
    case "brandjack":
      return "teardown";
    default:
      return "story";
  }
}

/**
 * Backfill embeddings + inferred structure_type for existing content_templates
 * rows. Idempotent: re-running only updates rows that are missing either field.
 */
export async function backfillTemplateEmbeddings(
  sb: SupabaseClient,
  opts: { signal?: AbortSignal; limit?: number; dryRun?: boolean } = {},
): Promise<{ scanned: number; embedded: number; typed: number }> {
  const model = EMBEDDING_MODEL;
  const rows = await selectAllRows<TemplateRow>(() =>
    sb
      .from("content_templates")
      .select("id, workspace_id, body, category, embedding, structure_type")
      .order("created_at", { ascending: false }),
  );

  const todo = rows
    .filter((row) => row.embedding === null || !isStructureContentType(row.structure_type))
    .slice(0, opts.limit ?? Infinity);

  let embedded = 0;
  let typed = 0;

  for (let i = 0; i < todo.length; i += TEMPLATE_EMBED_BATCH_SIZE) {
    const batch = todo.slice(i, i + TEMPLATE_EMBED_BATCH_SIZE);
    const bodies = batch.map((r) => r.body);
    const { embeddings } = await embedText(bodies, {
      model,
      signal: opts.signal,
    });

    for (let j = 0; j < batch.length; j += 1) {
      const row = batch[j];
      const embedding = embeddings[j];
      const inferredStructureType = isStructureContentType(row.structure_type)
        ? row.structure_type
        : structureTypeFromCategory(row.category);
      const updates: Record<string, unknown> = {};
      if (embedding) {
        updates.embedding = toVectorLiteral(embedding);
        embedded += 1;
      }
      if (!isStructureContentType(row.structure_type)) {
        updates.structure_type = inferredStructureType;
        typed += 1;
      }
      if (Object.keys(updates).length === 0) continue;
      if (opts.dryRun) continue;
      updates.updated_at = new Date().toISOString();
      const { error } = await sb.from("content_templates").update(updates).eq("id", row.id);
      if (error) {
        console.warn(`failed to update template ${row.id}: ${error.message}`);
        if (updates.embedding) embedded -= 1;
        if (updates.structure_type) typed -= 1;
      }
    }
  }

  return { scanned: rows.length, embedded, typed };
}

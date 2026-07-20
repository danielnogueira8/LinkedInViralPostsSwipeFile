import { z } from "zod";
import { resolveTurnCount } from "@/lib/agent/turn/count";

export const DRAFT_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6] as const;

export type DraftCount = (typeof DRAFT_COUNT_OPTIONS)[number];
export type DraftCountSelection = "auto" | DraftCount;

export const draftCountSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

// Post type: which kind of post the workspace-source lanes (search_viral_
// posts / get_top_from_batch, via the read-only orchestrator) should filter
// to. "auto" means no explicit choice — the orchestrator falls back to its
// own instruction-derived detection. Kept a plain string union (not the
// PostType from lib/post-type.ts) so this module has no dependency on the
// post-classification domain; the orchestrator maps between the two.
export const POST_TYPE_OPTIONS = ["regular", "lead_magnet"] as const;

export type PostTypeOption = (typeof POST_TYPE_OPTIONS)[number];
export type PostTypeSelection = "auto" | PostTypeOption;

export const postTypeSchema = z.union([
  z.literal("regular"),
  z.literal("lead_magnet"),
]);

export const generationConfigV1Schema = z
  .object({
    version: z.literal(1),
    draftCount: draftCountSchema,
    postType: postTypeSchema.optional(),
  })
  .strict();

export type GenerationConfigV1 = z.infer<typeof generationConfigV1Schema>;

export const resolvedGenerationConfigSchema = generationConfigV1Schema
  .extend({
    draftCountSource: z.enum(["ui", "message", "default"]),
    // Mirrors draftCountSource's shape, minus "message" — post type is never
    // derived from parsing the user's message text here; an unset UI
    // selection resolves to "default" and the read-only orchestrator's own
    // instruction-derived fallback (still regex, now narrowed) decides.
    postTypeSource: z.enum(["ui", "default"]),
  })
  .strict();

export type ResolvedGenerationConfig = z.infer<
  typeof resolvedGenerationConfigSchema
>;

export function generationConfigForSelection(
  draftCountSelection: DraftCountSelection,
  postTypeSelection: PostTypeSelection = "auto",
): GenerationConfigV1 | undefined {
  if (draftCountSelection === "auto" && postTypeSelection === "auto") {
    return undefined;
  }
  return {
    version: 1,
    draftCount: draftCountSelection === "auto" ? 1 : draftCountSelection,
    ...(postTypeSelection === "auto" ? {} : { postType: postTypeSelection }),
  };
}

/**
 * Resolve draft count once at the request boundary. Callers pass only a count
 * that was explicitly attached to the output noun in the user's message;
 * research/source quantities are deliberately excluded. The priority and the
 * 1-6 clamp live in resolveTurnCount — the ONE count rule for a turn.
 */
export function resolveGenerationConfig(input: {
  selected?: GenerationConfigV1 | null;
  explicitMessageDraftCount?: number | null;
}): ResolvedGenerationConfig {
  const resolved = resolveTurnCount({
    uiDraftCount: input.selected?.draftCount,
    messageCount: input.explicitMessageDraftCount,
  });
  return {
    version: 1,
    draftCount: resolved.count,
    draftCountSource: resolved.source,
    ...(input.selected?.postType
      ? { postType: input.selected.postType, postTypeSource: "ui" as const }
      : { postTypeSource: "default" as const }),
  };
}

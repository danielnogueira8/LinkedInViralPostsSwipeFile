import { z } from "zod";
import { resolveTurnCount } from "@/lib/agent/turn/compile";

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

export const generationConfigV1Schema = z
  .object({
    version: z.literal(1),
    draftCount: draftCountSchema,
  })
  .strict();

export type GenerationConfigV1 = z.infer<typeof generationConfigV1Schema>;

export const resolvedGenerationConfigSchema = generationConfigV1Schema
  .extend({
    draftCountSource: z.enum(["ui", "message", "default"]),
  })
  .strict();

export type ResolvedGenerationConfig = z.infer<
  typeof resolvedGenerationConfigSchema
>;

export function generationConfigForSelection(
  selection: DraftCountSelection,
): GenerationConfigV1 | undefined {
  return selection === "auto"
    ? undefined
    : { version: 1, draftCount: selection };
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
  };
}

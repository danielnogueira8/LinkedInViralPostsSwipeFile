import { z } from "zod";

export const DRAFT_COUNT_OPTIONS = [1, 2, 3, 4, 5] as const;

export type DraftCount = (typeof DRAFT_COUNT_OPTIONS)[number];
export type DraftCountSelection = "auto" | DraftCount;

export const draftCountSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
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
 * research/source quantities are deliberately excluded.
 */
export function resolveGenerationConfig(input: {
  selected?: GenerationConfigV1 | null;
  explicitMessageDraftCount?: number | null;
}): ResolvedGenerationConfig {
  const selectedCount = input.selected?.draftCount;
  const messageCount = input.explicitMessageDraftCount ?? null;
  if (selectedCount !== undefined) {
    return {
      version: 1,
      draftCount: selectedCount,
      draftCountSource: "ui",
    };
  }
  const parsedMessageCount = draftCountSchema.safeParse(messageCount);
  if (parsedMessageCount.success) {
    return {
      version: 1,
      draftCount: parsedMessageCount.data,
      draftCountSource: "message",
    };
  }
  return { version: 1, draftCount: 1, draftCountSource: "default" };
}

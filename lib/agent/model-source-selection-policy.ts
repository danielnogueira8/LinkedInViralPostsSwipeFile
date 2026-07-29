export const MODEL_SOURCE_SELECTION_POLICY = Object.freeze({
  candidateCount: 5 as const,
  minimumSources: 3 as const,
  // Over-fetch before modelability filtering so short/empty top rows do not
  // hide useful candidates that are still inside the ranked result set.
  searchPoolSize: 10 as const,
});

export type ModelSourceSelectionPolicy =
  typeof MODEL_SOURCE_SELECTION_POLICY;

const MIN_MODELABLE_WORDS = 40;

/** A modeling source needs enough prose to expose a reusable structure. */
export function isModelableSourceText(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length >= MIN_MODELABLE_WORDS;
}

/**
 * Preserve the previous immediate-modeling path as a rollback during rollout.
 * Selection is on by default; setting the flag to "false" restores the old
 * server behavior without a deploy.
 */
export function modelingSourceSelectionEnabled(): boolean {
  return process.env.MODEL_SOURCE_SELECTION_ENABLED !== "false";
}

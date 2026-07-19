// Agent specialist contracts.
//
// This is the typed boundary layer used by the AI-tell editor
// (lib/agent/specialists/editor.ts): a runtime-validated shape for the
// cleaned-draft result the editor produces, so a malformed editor output is
// caught at the boundary rather than deep inside the loop.
//
// Zod is already a dependency (v4) and is used throughout the codebase, so
// these schemas follow the same `z.infer` pattern as the shared agent contract.

import { z } from "zod";

// ---------------------------------------------------------------------------
// AI-Tell Editor — cleans a draft (deterministic + optional bounded rewrite)
// ---------------------------------------------------------------------------

// The specific AI-tell categories the editor checks. Kept as an enum so evals
// and telemetry can assert on named categories rather than free strings.
export const AI_TELL_CATEGORIES = [
  "em_dash",
  "generic_opener",
  "rule_of_three",
  "dense_paragraph",
  "fake_polish",
] as const;
export const AiTellCategorySchema = z.enum(AI_TELL_CATEGORIES);
export type AiTellCategory = z.infer<typeof AiTellCategorySchema>;

// The editor returns the cleaned body plus which categories it touched and
// whether it used the model (vs. pure deterministic passes). `changed` lets
// callers skip re-persisting when nothing moved.
export const EditorResultSchema = z.object({
  body: z.string().trim().min(1, "editor body must be non-empty"),
  changed: z.boolean(),
  usedModel: z.boolean(),
  fixedCategories: z.array(AiTellCategorySchema),
  notes: z.array(z.string()),
});
export type EditorResult = z.infer<typeof EditorResultSchema>;

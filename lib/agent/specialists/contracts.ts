// Agent specialist contracts.
//
// This is the typed boundary layer for the Cowork "orchestration" refactor.
// It defines the narrow input/output shapes each specialist stage produces so
// that the chat turn execution layer (lib/agent/chat-turn.ts) and the headless
// batch path (lib/batch/weekly.ts) can share ONE set of generation modules
// instead of the two divergent copies they carry today.
//
// Design rules (see the reviewed plan):
//   - Every pipeline envelope has a runtime schema factory, so callers validate
//     the concrete input/output contract selected for that specialist stage.
//   - Every model-produced specialist output gets a Zod schema so a malformed
//     model response is caught at the boundary, not deep inside the loop.
//   - We REUSE the dependency-free Artifact and PostMediaAttachment contracts
//     rather than redefining them, so specialist outputs cannot drift from what
//     the runtime and UI exchange.
//   - Pipeline selection is DETERMINISTIC (no new orchestrator model call): the
//     PipelineKind is chosen from signals the stream route already computes.
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

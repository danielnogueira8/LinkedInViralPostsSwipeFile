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
import type { Artifact } from "@/lib/agent/contracts";
import type { PostMediaAttachment } from "@/lib/post-media";

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

// The set of end-to-end workflows the deterministic orchestrator can route a
// turn into. These mirror the request shapes the stream route already
// distinguishes (model source vs. from-scratch vs. lead magnet vs. refine vs.
// batch), so selection needs no extra model call — it reads existing flags.
export const PIPELINE_KINDS = [
  "regular_post_from_scratch",
  "model_source_post",
  "lead_magnet_post",
  "weekly_batch",
  "refine_existing_draft",
  "image_adaptation",
] as const;

export const PipelineKindSchema = z.enum(PIPELINE_KINDS);
export type PipelineKind = z.infer<typeof PipelineKindSchema>;

// The post kinds a writer specialist can produce. Mirrors accounts/posts
// `post_type` ('regular' | 'lead_magnet') plus 'hook' for opener-only requests.
export const WriterOutputKindSchema = z.enum(["regular", "lead_magnet", "hook"]);
export type WriterOutputKind = z.infer<typeof WriterOutputKindSchema>;

// ---------------------------------------------------------------------------
// AgentTask / AgentResult — the generic envelope
// ---------------------------------------------------------------------------

// A unit of work handed to a specialist. `pipeline` names the workflow the
// orchestrator selected; `input` is the stage-specific payload (validated by
// that stage's own schema). Kept intentionally loose here — each specialist
// narrows `input`/`output` with its own schema below.
export type AgentTask<TInput = unknown> = {
  pipeline: PipelineKind;
  workspaceId: string;
  input: TInput;
  // Correlates progress/telemetry across stages of one turn. Not a DB id.
  turnId?: string;
};

export function createAgentTaskSchema<TSchema extends z.ZodType>(
  inputSchema: TSchema,
) {
  return z.object({
    pipeline: PipelineKindSchema,
    workspaceId: z.string().min(1),
    input: inputSchema,
    turnId: z.string().min(1).optional(),
  });
}

// The generic result envelope every specialist returns. `ok:false` carries a
// human-readable reason the orchestrator can surface or route on — mirroring
// the tool-result convention ({ ok, error }) the agent loop already uses, so a
// failure is data, never a thrown exception.
export type AgentResult<TOutput> =
  | { ok: true; output: TOutput }
  | { ok: false; error: string };

export function createAgentResultSchema<TSchema extends z.ZodType>(
  outputSchema: TSchema,
) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), output: outputSchema }),
    z.object({ ok: z.literal(false), error: z.string().min(1) }),
  ]);
}

// ---------------------------------------------------------------------------
// Source Scout — finds proven source posts (NO model call; wraps search tools)
// ---------------------------------------------------------------------------

// One source post the scout selected, with the why. `postId` is the swipe-file
// post UUID (so it can be rendered as a render_cite card later). Deliberately a
// superset of what search_viral_posts already returns.
export const SourcePostSelectionSchema = z.object({
  postId: z.string().uuid(),
  reason: z.string().min(1),
  reactions: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  // Whether this source carries media eligible for image adaptation.
  mediaEligible: z.boolean(),
});
export type SourcePostSelection = z.infer<typeof SourcePostSelectionSchema>;

export const SourceScoutResultSchema = z.object({
  posts: z.array(SourcePostSelectionSchema),
});
export type SourceScoutResult = z.infer<typeof SourceScoutResultSchema>;

// ---------------------------------------------------------------------------
// Voice — bounded voice context (NO model call; get_voice DB read)
// ---------------------------------------------------------------------------

// The bounded voice context block a writer receives. `block` is the ready-to-
// inject system text; the structured fields let callers reason about it without
// re-parsing. `ready:false` means no profile yet (writers fall back to global
// rules), which is a valid state, not an error.
export const VoiceContextSchema = z.object({
  ready: z.boolean(),
  block: z.string(),
  displayName: z.string().nullable(),
  // Present only for lead-magnet writing; the writer applies it ONLY then.
  leadMagnetStyle: z.string().nullable(),
});
export type VoiceContext = z.infer<typeof VoiceContextSchema>;

// ---------------------------------------------------------------------------
// Writer — produces ONE post/hook body (model call)
// ---------------------------------------------------------------------------

// A writer returns exactly one body plus the kind it wrote. Giveaway metadata
// is present only for lead-magnet posts. The body is the raw post text; the
// anti-slop nets + editor run AFTER this, so the writer's contract is just
// "one clean-intent body," not "final publish-ready."
export const GiveawayMetaSchema = z.object({
  resourceTitle: z.string().nullable(),
  resourceSummary: z.string().nullable(),
  cta: z.string().nullable(),
});
export type GiveawayMeta = z.infer<typeof GiveawayMetaSchema>;

export const WriterResultSchema = z.object({
  kind: WriterOutputKindSchema,
  body: z.string().trim().min(1, "writer body must be non-empty"),
  giveaway: GiveawayMetaSchema.nullable(),
});
export type WriterResult = z.infer<typeof WriterResultSchema>;

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
  "broken_list",
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

// ---------------------------------------------------------------------------
// Final QA — verifies the draft matches the request (mostly deterministic)
// ---------------------------------------------------------------------------

// A single QA finding. `category` reuses the tell categories plus request-match
// concerns; `fix` is an instruction for the single repair attempt.
export const QaCheckSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  fix: z.string().nullable(),
});
export type QaCheck = z.infer<typeof QaCheckSchema>;

export const QaResultSchema = z.object({
  passed: z.boolean(),
  checks: z.array(QaCheckSchema),
  // When !passed, the single consolidated repair instruction (one attempt max).
  repairInstruction: z.string().nullable(),
});
export type QaResult = z.infer<typeof QaResultSchema>;

// ---------------------------------------------------------------------------
// Image — adapts a source visual (background job; NEVER blocks the text draft)
// ---------------------------------------------------------------------------

// The image specialist's outcome. It never throws and never blocks: either it
// produced/queued an attachment, or it returns a clear skip/failure reason the
// draft card can show. `status` mirrors the async reality (queued vs. ready).
export const ImageAgentResultSchema = z.object({
  status: z.enum(["queued", "ready", "skipped", "failed"]),
  // The media attachment, when ready. Typed loosely here (validated by the
  // media layer) to avoid re-declaring PostMediaAttachment's full shape in Zod;
  // callers cast to PostMediaAttachment.
  attachment: z.custom<PostMediaAttachment>().nullable(),
  // Human-readable reason for skipped/failed/queued, shown on the draft card.
  reason: z.string().nullable(),
});
export type ImageAgentResult = z.infer<typeof ImageAgentResultSchema>;

// ---------------------------------------------------------------------------
// Draft provenance — which specialists contributed to a rendered draft
// ---------------------------------------------------------------------------

// Attached to an Artifact's meta so the draft card can show what fed it (source
// post, lead-magnet resource, image status, QA status) without the client
// re-deriving it. All optional so partial pipelines populate only what ran.
export const DraftProvenanceSchema = z.object({
  sourcePostId: z.string().uuid().nullable().optional(),
  leadMagnetResourceId: z.string().nullable().optional(),
  imageStatus: ImageAgentResultSchema.shape.status.nullable().optional(),
  qaPassed: z.boolean().nullable().optional(),
  pipeline: PipelineKindSchema.optional(),
});
export type DraftProvenance = z.infer<typeof DraftProvenanceSchema>;

// Convenience: an Artifact carrying provenance in meta. Purely a typed view —
// Artifact.meta already allows arbitrary keys.
export type ArtifactWithProvenance = Artifact & {
  meta?: Record<string, unknown> & { provenance?: DraftProvenance };
};

import {
  ArtifactSchema,
  type Artifact,
} from "@/lib/agent/contracts";
import type { DeliverableContract } from "@/lib/agent/deliverable-contract";
import { redactHighConfidenceLeaks } from "@/lib/agent/output-guard";
import type { DraftOutputPolicy } from "@/lib/agent/draft-output-policy";
import { editDraftBodySync } from "@/lib/agent/specialists/editor";
import { repairAiTells } from "@/lib/agent/specialists/ai-tell-repair";
import { checkSameness } from "@/lib/agent/specialists/sameness";
import {
  aiTellMetrics,
  normalizeDraftKey,
} from "@/lib/agent/specialists/nets";
import { reviewModeledDraft } from "@/lib/agent/specialists/source-fidelity";
import { RENDER_POST_MAX_CHARS } from "@/lib/agent/tools";
import type { RecentDraft } from "@/lib/recent-drafts";
import type { AdapterHealthRegistry } from "@/lib/agent/adapter-health";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import {
  aiTellRepairStage,
  contractStage,
  editStage,
  finalTransformStage,
  provenanceStage,
  sanityStage,
  sourceFidelityStage,
  type StageContext,
  type StageState,
} from "./finalizer-stages";

export const DRAFT_FINALIZER_REJECTION_CODES = [
  "cancelled",
  "empty",
  "corrupted",
  "truncated",
  "assistant_framing",
  "incomplete",
  "too_short",
  "character_range",
  "unsupported_specificity",
  "unsupported_claim",
  "provenance_missing",
  "provenance_unverified",
  "source_unavailable",
  "source_fidelity",
  "source_fidelity_unavailable",
  "structure_mismatch",
  "duplicate",
  "count_complete",
  "domain_constraint",
  "artifact_invalid",
] as const;

export type DraftFinalizerRejectionCode =
  (typeof DRAFT_FINALIZER_REJECTION_CODES)[number];

export type DraftCandidateOrigin =
  | "render_tool"
  | "legacy_fence"
  | "forced_final_fence"
  | "forced_final_leak"
  | "refine_leak"
  | "direct_writer";

export type DraftSource = {
  id: string;
  text: string;
};

export type DraftProvenance = {
  required: boolean;
  requestedSourceId?: string | null;
  discoveredSources: DraftSource[];
  userRequest: string;
  verifiedContext: string;
};

export type DraftCandidate = {
  origin: DraftCandidateOrigin;
  body: string;
  finishReason?: string | null;
  envelopeComplete?: boolean;
  provenance?: DraftProvenance;
};

type EditorResult = ReturnType<typeof editDraftBodySync>;
type RepairResult = Awaited<ReturnType<typeof repairAiTells>>;
type SamenessResult = Awaited<ReturnType<typeof checkSameness>>;
type SourceFidelityResult = Awaited<ReturnType<typeof reviewModeledDraft>>;

export type DraftFinalizerSpecialists = {
  edit: (
    body: string,
    kind: "post",
    editOpts?: { keepEmDashes?: boolean },
  ) => EditorResult;
  repairAiTells: (opts: {
    body: string;
    workspaceId?: string;
    signal?: AbortSignal;
    maxChars?: number;
    adapterHealth?: AdapterHealthRegistry;
    telemetry?: CoworkTurnTelemetry;
    keepEmDashes?: boolean;
  }) => Promise<RepairResult>;
  checkSameness: (opts: {
    body: string;
    priorDrafts: RecentDraft[];
    workspaceId?: string;
    signal?: AbortSignal;
    adapterHealth?: AdapterHealthRegistry;
    telemetry?: CoworkTurnTelemetry;
  }) => Promise<SamenessResult>;
  reviewSourceFidelity: (opts: {
    sourceText: string;
    draftBody: string;
    userRequest: string;
    verifiedContext: string;
    workspaceId: string;
    deliverableKind?:
      | "post"
      | "hook"
      | "idea"
      | "angle"
      | "outline"
      | "title"
      | "opener";
    signal?: AbortSignal;
    adapterHealth?: AdapterHealthRegistry;
    telemetry?: CoworkTurnTelemetry;
  }) => Promise<SourceFidelityResult>;
};

const DEFAULT_SPECIALISTS: DraftFinalizerSpecialists = {
  edit: editDraftBodySync,
  repairAiTells,
  // Cross-slot distinctness has moved out of the blocking finalizer path; the
  // slot/batch coordinator now owns it. The specialist slot stays in the type
  // for backward compatibility with existing callers and tests.
  checkSameness: async ({ body }) => ({
    body,
    rewrote: false,
    overlapMarkers: [],
    reason: "Cross-slot distinctness is enforced by the batch coordinator.",
  }),
  reviewSourceFidelity: reviewModeledDraft,
};

// Specialists for modeled batches. Modeled batches already arbitrate cross-slot
// duplicates and use a strong writer with explicit mechanics, so keep
// deterministic editing and the required fidelity reviewer on the blocking path
// but do not add paid rewrites that increase cost, latency, and post-review
// structural drift.
export const modeledBatchFinalizerSpecialists: DraftFinalizerSpecialists = {
  edit: editDraftBodySync,
  repairAiTells: async ({ body }) => ({
    body,
    repaired: false,
    detected: aiTellMetrics(body),
  }),
  checkSameness: async ({ body }) => ({
    body,
    rewrote: false,
    overlapMarkers: [],
    reason: "Modeled batch distinctness is enforced by the batch coordinator.",
  }),
  reviewSourceFidelity: reviewModeledDraft,
};

export type DraftFinalizerRejection = {
  code: DraftFinalizerRejectionCode;
  message: string;
  repairInstruction?: string;
};

export type DraftFinalizationResult =
  | {
      ok: true;
      artifact: Artifact & { kind: "post" };
      sourcePostId: string | null;
      origin: DraftCandidateOrigin;
      aiTells: string[];
      edited: boolean;
      repaired: boolean;
      samenessRewrote: boolean;
    }
  | {
      ok: false;
      rejection: DraftFinalizerRejection;
      origin: DraftCandidateOrigin;
    };

export type DraftFinalizerDecision = {
  origin: DraftCandidateOrigin;
  outcome: "accepted" | "rejected";
  rejectionCode?: DraftFinalizerRejectionCode;
  sourceVerified: boolean;
  edited: boolean;
  repaired: boolean;
  samenessRewrote: boolean;
};

export type DraftFinalizerStage =
  | "validation"
  | "source_fidelity"
  | "ai_tell_check"
  | "artifact";

export type DraftFinalizerOptions = {
  workspaceId: string;
  policy?: DraftOutputPolicy;
  contract?: DeliverableContract | null;
  priorDrafts: RecentDraft[];
  signal?: AbortSignal;
  specialists?: Partial<DraftFinalizerSpecialists>;
  transformCandidate?: DraftCandidateTransform;
  finalTransformCandidate?: DraftCandidateTransform;
  /** @deprecated Cross-slot distinctness moved to the slot coordinator. */
  skipSameness?: boolean;
  maxPostChars?: number;
  idFactory?: () => string;
  onDecision?: (decision: DraftFinalizerDecision) => void;
  /** Reports the exact blocking stage currently running for live narration. */
  onStage?: (stage: DraftFinalizerStage) => void;
  adapterHealth?: AdapterHealthRegistry;
  telemetry?: CoworkTurnTelemetry;
  // Voice-aware editor options, passed BY REFERENCE to every specialists.edit
  // / repairAiTells call. Callers may mutate the object after the finalizer is
  // created (e.g. the chat loop flips keepEmDashes when a mid-turn get_voice
  // reveals the writer genuinely uses em dashes) and later finalize calls see
  // the current value.
  editOptions?: { keepEmDashes?: boolean };
};

export type DraftCandidateTransform = (
  body: string,
) =>
  | { ok: true; body: string }
  | { ok: false; message: string };

export type DraftFinalizer = {
  finalize(candidate: DraftCandidate): Promise<DraftFinalizationResult>;
  acceptedCount(): number;
};

let artifactSequence = 0;

function defaultArtifactId(): string {
  return `art_${Date.now()}_${artifactSequence++}`;
}

function reject(
  origin: DraftCandidateOrigin,
  code: DraftFinalizerRejectionCode,
  message: string,
  repairInstruction?: string,
): DraftFinalizationResult {
  return {
    ok: false,
    origin,
    rejection: {
      code,
      message,
      ...(repairInstruction ? { repairInstruction } : {}),
    },
  };
}

function validateFinalArtifact(
  artifact: Artifact & { kind: "post" },
): (Artifact & { kind: "post" }) | null {
  const parsed = ArtifactSchema.safeParse(artifact);
  if (!parsed.success || parsed.data.kind !== "post") return null;
  // ArtifactSchema validates non-empty draft text but its legacy `.trim()` is
  // a parser transform. Return the already-redacted original bytes after a
  // successful validation, matching validateArtifact's long-standing behavior.
  return artifact;
}

export function createDraftFinalizer(
  options: DraftFinalizerOptions,
): DraftFinalizer {
  const specialists = { ...DEFAULT_SPECIALISTS, ...options.specialists };
  const maxPostChars = options.maxPostChars ?? RENDER_POST_MAX_CHARS;
  const makeId = options.idFactory ?? defaultArtifactId;
  const acceptedKeys = new Set<string>();
  const rejectedCandidateKeys = new Set<string>();
  let acceptedCount = 0;
  const reportStage = (stage: DraftFinalizerStage): void => {
    try {
      options.onStage?.(stage);
    } catch {
      // Progress narration must never be able to break draft delivery.
    }
  };

  const candidateIdentity = (candidate: DraftCandidate): string | null => {
    const body = candidate.body.trim();
    if (!body) return null;
    const sources = candidate.provenance?.discoveredSources ?? [];
    const sourceId =
      candidate.provenance?.requestedSourceId ??
      (sources.length === 1 ? sources[0].id : "none");
    const selectedSource = sources.find((source) => source.id === sourceId);
    const sourceState = selectedSource
      ? `${selectedSource.id}:${normalizeDraftKey(selectedSource.text) || "empty"}`
      : sources
          .map((source) => `${source.id}:${normalizeDraftKey(source.text) || "empty"}`)
          .sort()
          .join("|") || "unverified";
    return [
      candidate.finishReason ?? "complete",
      sourceId,
      sourceState,
      normalizeDraftKey(body),
    ].join(":");
  };

  const emit = (
    candidate: DraftCandidate,
    result: DraftFinalizationResult,
    sourceVerified = false,
    edits = { edited: false, repaired: false, samenessRewrote: false },
  ) => {
    if (
      !result.ok &&
      result.rejection.code !== "cancelled" &&
      result.rejection.code !== "empty" &&
      result.rejection.code !== "provenance_missing" &&
      result.rejection.code !== "provenance_unverified" &&
      result.rejection.code !== "source_unavailable" &&
      // A reviewer OUTAGE is not a verdict on the body. If we poisoned the
      // dedupe cache with it, a retry that re-renders the IDENTICAL (good)
      // draft would then be rejected as `duplicate` — an unwinnable dead-end
      // for a draft whose only problem was that the fidelity reviewer was
      // briefly unreachable. Availability failures must never poison the
      // content-dedupe cache (same rule as source_unavailable above).
      result.rejection.code !== "source_fidelity_unavailable"
    ) {
      const identity = candidateIdentity(candidate);
      if (identity) rejectedCandidateKeys.add(identity);
    }
    options.onDecision?.({
      origin: candidate.origin,
      outcome: result.ok ? "accepted" : "rejected",
      ...(!result.ok ? { rejectionCode: result.rejection.code } : {}),
      sourceVerified,
      ...edits,
    });
    return result;
  };

  const finalize = async (
    candidate: DraftCandidate,
  ): Promise<DraftFinalizationResult> => {
    const aborted = () => options.signal?.aborted === true;
    if (aborted()) {
      return emit(
        candidate,
        reject(candidate.origin, "cancelled", "Draft finalization was cancelled."),
      );
    }
    reportStage("validation");

    // Gates 1-4 run as an ordered stage sequence (see finalizer-stages.ts).
    // Each stage assumes every earlier one already passed, so the runner
    // stops at the first rejection.
    const ctx: StageContext = {
      workspaceId: options.workspaceId,
      candidate,
      contract: options.contract,
      acceptedCount,
      isDuplicateOfRejected: (c) => {
        const identity = candidateIdentity(c);
        return identity !== null && rejectedCandidateKeys.has(identity);
      },
      transformCandidate: options.transformCandidate,
      finalTransformCandidate: options.finalTransformCandidate,
      maxPostChars,
      specialists,
      editOptions: options.editOptions,
      characterRangeMax: options.policy?.characterRange?.max,
      signal: options.signal,
      adapterHealth: options.adapterHealth,
      telemetry: options.telemetry,
      aborted,
    };
    let state: StageState = {
      origin: candidate.origin,
      finishReason: candidate.finishReason,
      envelopeComplete: candidate.envelopeComplete,
      body: candidate.body,
      sourceVerified: false,
      edited: false,
      repaired: false,
    };
    const editsSoFar = () => ({
      edited: state.edited,
      repaired: state.repaired,
      samenessRewrote: false,
    });

    // -------------------------------------------------------------------------
    // Gate 1: Sanity — empty / corrupt / truncated / malformed in one pass.
    // -------------------------------------------------------------------------
    const sanityResult = sanityStage(ctx, state);
    if (!sanityResult.ok) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          sanityResult.rejection.code,
          sanityResult.rejection.message,
          sanityResult.rejection.repairInstruction,
        ),
      );
    }
    state = sanityResult.state;

    // -------------------------------------------------------------------------
    // Gate 2: Contract — enforce the exact deliverable count.
    // -------------------------------------------------------------------------
    const contractResult = contractStage(ctx, state);
    if (!contractResult.ok) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          contractResult.rejection.code,
          contractResult.rejection.message,
        ),
      );
    }
    state = contractResult.state;

    // -------------------------------------------------------------------------
    // Gate 3: Provenance — resolve the verified source (if any).
    // -------------------------------------------------------------------------
    const provenanceResult = provenanceStage(ctx, state);
    if (!provenanceResult.ok) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          provenanceResult.rejection.code,
          provenanceResult.rejection.message,
        ),
      );
    }
    state = provenanceResult.state;
    const resolvedSourceRow = provenanceResult.source;
    const sourceVerified = state.sourceVerified;

    // -------------------------------------------------------------------------
    // Gate 4: Quality — deterministic edit, then the model specialists.
    // Source/modeled turns run source-fidelity review for telemetry only; the
    // model-based verdict is no longer a hard rejection. AI-tell repair runs
    // for EVERY draft, sourced or not — it was previously skipped on sourced
    // turns, which let grounded drafts ship with classic AI tells (staccato
    // triads, signposting) because only ungrounded originals were repaired.
    // The repair pass itself short-circuits on clean bodies, so a tell-free
    // draft pays no extra model call. Cross-slot sameness rewriting is
    // intentionally off the blocking path.
    // -------------------------------------------------------------------------
    const editResult = editStage(ctx, state);
    // editStage never rejects (a pure body transform) but is typed as a
    // StageResult for symmetry with the rest of the sequence.
    state = editResult.ok ? editResult.state : state;

    if (resolvedSourceRow && candidate.provenance) {
      reportStage("source_fidelity");
      const fidelityResult = await sourceFidelityStage(ctx, state, resolvedSourceRow);
      if (!fidelityResult.ok) {
        return emit(
          candidate,
          reject(candidate.origin, fidelityResult.rejection.code, fidelityResult.rejection.message),
          sourceVerified,
          editsSoFar(),
        );
      }
      state = fidelityResult.state;
    }
    reportStage("ai_tell_check");
    const repairResult = await aiTellRepairStage(ctx, state);
    if (!repairResult.ok) {
      return emit(
        candidate,
        reject(candidate.origin, repairResult.rejection.code, repairResult.rejection.message),
        sourceVerified,
        editsSoFar(),
      );
    }
    state = repairResult.state;

    const finalTransformResult = finalTransformStage(ctx, state);
    if (!finalTransformResult.ok) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          finalTransformResult.rejection.code,
          finalTransformResult.rejection.message,
        ),
        sourceVerified,
        editsSoFar(),
      );
    }
    state = finalTransformResult.state;

    const edited = { changed: state.edited };
    const repaired = state.repaired;

    // Security redaction is itself a body mutation. It must happen before the
    // artifact build so a prompt leak cannot be persisted as a broken
    // placeholder-only artifact.
    reportStage("artifact");
    const body = redactHighConfidenceLeaks(state.body).text;

    // -------------------------------------------------------------------------
    // Gate 5: Artifact build — dedupe, validate, emit.
    // -------------------------------------------------------------------------
    const key = `post:${normalizeDraftKey(body)}`;
    if (acceptedKeys.has(key)) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "duplicate",
          "That exact draft was already accepted in this turn. Produce a genuinely different version or finish the reply.",
        ),
        sourceVerified,
        { edited: edited.changed, repaired, samenessRewrote: false },
      );
    }
    const title = body.split("\n", 1)[0].slice(0, 60).trim() || "Draft post";
    const artifact = validateFinalArtifact({
      id: makeId(),
      kind: "post",
      title,
      body,
    });
    if (!artifact) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "artifact_invalid",
          "The finalized draft failed the artifact contract and was discarded.",
        ),
        sourceVerified,
        { edited: edited.changed, repaired, samenessRewrote: false },
      );
    }

    acceptedKeys.add(key);
    acceptedCount += 1;
    const edits = {
      edited: edited.changed,
      repaired,
      samenessRewrote: false,
    };
    const result: DraftFinalizationResult = {
      ok: true,
      artifact,
      sourcePostId: resolvedSourceRow?.id ?? null,
      origin: candidate.origin,
      aiTells: aiTellMetrics(body),
      ...edits,
    };
    return emit(candidate, result, sourceVerified, edits);
  };

  return {
    finalize,
    acceptedCount: () => acceptedCount,
  };
}

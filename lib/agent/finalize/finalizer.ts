import {
  ArtifactSchema,
  type Artifact,
} from "@/lib/agent/contracts";
import type { DeliverableContract } from "@/lib/agent/deliverable-contract";
import {
  evaluateDeliverableArtifact,
} from "@/lib/agent/deliverable-contract";
import { redactHighConfidenceLeaks } from "@/lib/agent/output-guard";
import type { DraftOutputPolicy } from "@/lib/agent/draft-output-policy";
import { editDraftBodySync } from "@/lib/agent/specialists/editor";
import { repairAiTells } from "@/lib/agent/specialists/ai-tell-repair";
import { checkSameness } from "@/lib/agent/specialists/sameness";
import {
  aiTellMetrics,
  looksCorruptedDraft,
  normalizeDraftKey,
} from "@/lib/agent/specialists/nets";
import {
  reviewModeledDraft,
  sourceFidelityRejection,
} from "@/lib/agent/specialists/source-fidelity";
import { RENDER_POST_MAX_CHARS } from "@/lib/agent/tools";
import type { RecentDraft } from "@/lib/recent-drafts";
import type { AdapterHealthRegistry } from "@/lib/agent/adapter-health";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";

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

function resolveSource(
  provenance: DraftProvenance | undefined,
  origin: DraftCandidateOrigin,
):
  | { ok: true; source: DraftSource | null }
  | { ok: false; code: DraftFinalizerRejectionCode; message: string } {
  if (!provenance) return { ok: true, source: null };
  const sourceById = new Map(
    provenance.discoveredSources.map((source) => [source.id, source]),
  );
  const effectiveId =
    provenance.requestedSourceId ??
    (sourceById.size === 1 ? [...sourceById.keys()][0] : null);
  // "Sources were discovered this turn" only auto-REQUIRES a match for the
  // render_tool origin — the only one built from a real render_post tool
  // call, where sourcePostId is an actual argument the model could have
  // filled. Every other origin (legacy_fence, forced_final_fence,
  // forced_final_leak, refine_leak) is extracted from plain generated text
  // that structurally has no field to carry a sourcePostId in; treating a
  // multi-source turn as "required" for those origins is an unwinnable trap
  // — retrying produces the same shape and fails identically (confirmed:
  // brandjack/namejack/newsjack turns, which research multiple reference
  // posts but are correctly NOT single-source-modeling turns, hit this).
  // provenance.required — the explicit "this IS a strict one-post modeling
  // turn" signal computed upstream from the user's actual request — still
  // applies to every origin unconditionally; only the size>0 SAFETY-NET
  // fallback is origin-scoped.
  const sourceRequired =
    provenance.required || (origin === "render_tool" && sourceById.size > 0);
  if (!effectiveId) {
    return sourceRequired
      ? {
          ok: false,
          code: "provenance_missing",
          message:
            "This modeled draft is missing the verified source id. Re-render it with the exact sourcePostId returned by the source search.",
        }
      : { ok: true, source: null };
  }
  const source = sourceById.get(effectiveId);
  if (!source) {
    return {
      ok: false,
      code: "provenance_unverified",
      message:
        "sourcePostId was not returned by this turn's verified source search. Re-render using the exact source that was selected.",
    };
  }
  if (!source.text.trim()) {
    return {
      ok: false,
      code: "source_unavailable",
      message:
        "The selected source could not be re-read for verification. Re-search it before rendering the draft again.",
    };
  }
  return { ok: true, source };
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

    // -------------------------------------------------------------------------
    // Gate 1: Sanity — empty / corrupt / truncated / malformed in one pass.
    // -------------------------------------------------------------------------
    if (candidate.envelopeComplete === false) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "truncated",
          "The draft delivery fence was not closed, so the incomplete candidate was discarded. Write a complete replacement.",
        ),
      );
    }

    const inputBody = candidate.body;
    if (!inputBody.trim()) {
      return emit(
        candidate,
        reject(candidate.origin, "empty", "The draft body is empty."),
      );
    }
    const transformed = options.transformCandidate?.(inputBody) ?? {
      ok: true as const,
      body: inputBody,
    };
    if (!transformed.ok) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "domain_constraint",
          transformed.message,
        ),
      );
    }
    const rawBody = transformed.body;
    if (!rawBody.trim()) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "empty",
          "The trusted draft transform produced an empty body.",
        ),
      );
    }
    const identity = candidateIdentity(candidate);
    if (identity && rejectedCandidateKeys.has(identity)) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "duplicate",
          "This exact candidate was already rejected by the finalizer. Produce a corrected candidate instead of replaying it.",
        ),
      );
    }
    if (candidate.finishReason === "length") {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "truncated",
          "The provider stopped at its length limit, so this candidate cannot be delivered. Write a complete tighter replacement.",
        ),
      );
    }
    const rawCorruption = looksCorruptedDraft(rawBody);
    if (rawCorruption) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "corrupted",
          `The draft contained corrupted markup (${rawCorruption}). Re-render clean plain text.`,
        ),
      );
    }

    // -------------------------------------------------------------------------
    // Gate 2: Contract — enforce deliverable count and the single hard char cap.
    // -------------------------------------------------------------------------
    if (options.contract) {
      const contractDecision = evaluateDeliverableArtifact(
        options.contract,
        acceptedCount,
        "post",
      );
      if (!contractDecision.accept) {
        return emit(
          candidate,
          reject(
            candidate.origin,
            "count_complete",
            `The exact ${options.contract.expectedCount}-post contract is already complete. Do not render another draft.`,
          ),
        );
      }
    }

    // -------------------------------------------------------------------------
    // Gate 3: Provenance — resolve the verified source (if any).
    // -------------------------------------------------------------------------
    const resolvedSource = resolveSource(candidate.provenance, candidate.origin);
    if (!resolvedSource.ok) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          resolvedSource.code,
          resolvedSource.message,
        ),
      );
    }
    const sourceVerified = resolvedSource.source !== null;

    // -------------------------------------------------------------------------
    // Gate 4: Quality — deterministic edit, then ONE model specialist chosen by
    // turn type. Source/modeled turns run source-fidelity review for telemetry
    // only; the model-based verdict is no longer a hard rejection. Everything
    // else runs AI-tell repair. Cross-slot sameness rewriting is intentionally
    // off the blocking path.
    // -------------------------------------------------------------------------
    const edited = specialists.edit(rawBody, "post", options.editOptions);
    let body = edited.body;
    let repaired = false;

    if (resolvedSource.source && candidate.provenance) {
      // Source-fidelity review is now telemetry-only. The writer is responsible
      // for producing an original adaptation; the finalizer no longer rejects
      // modeled drafts for being too similar to the source.
      const fidelity = await specialists.reviewSourceFidelity({
        sourceText: resolvedSource.source.text,
        draftBody: body,
        userRequest: candidate.provenance.userRequest,
        verifiedContext: candidate.provenance.verifiedContext,
        workspaceId: options.workspaceId,
        signal: options.signal,
        adapterHealth: options.adapterHealth,
        telemetry: options.telemetry,
      });
      if (aborted()) {
        return emit(
          candidate,
          reject(candidate.origin, "cancelled", "Draft finalization was cancelled."),
          sourceVerified,
          { edited: edited.changed, repaired, samenessRewrote: false },
        );
      }
      // Record the model fidelity verdict for telemetry, but accept the draft
      // regardless.
      const fidelityRejection = sourceFidelityRejection(fidelity);
      options.telemetry?.recordAttempt({
        stage: "finalizer_source_fidelity_verdict",
        attempt: 1,
        provider: "server",
        outcome: fidelityRejection ? "rejected" : "accepted",
        reasonCode: fidelityRejection?.code,
        latencyMs: 0,
      });
    } else {
      const repair = await specialists.repairAiTells({
        body,
        workspaceId: options.workspaceId,
        signal: options.signal,
        maxChars: options.policy?.characterRange?.max ?? maxPostChars,
        adapterHealth: options.adapterHealth,
        telemetry: options.telemetry,
        keepEmDashes: options.editOptions?.keepEmDashes,
      });
      body = repair.body;
      repaired = repair.repaired;
      if (aborted()) {
        return emit(
          candidate,
          reject(candidate.origin, "cancelled", "Draft finalization was cancelled."),
          sourceVerified,
          { edited: edited.changed, repaired, samenessRewrote: false },
        );
      }
    }

    const finalTransformed = options.finalTransformCandidate?.(body) ?? {
      ok: true as const,
      body,
    };
    if (!finalTransformed.ok) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "domain_constraint",
          finalTransformed.message,
        ),
        sourceVerified,
        { edited: edited.changed, repaired, samenessRewrote: false },
      );
    }
    body = finalTransformed.body;
    if (!body.trim()) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "empty",
          "The trusted final draft transform produced an empty body.",
        ),
        sourceVerified,
        { edited: edited.changed, repaired, samenessRewrote: false },
      );
    }
    const finalCorruption = looksCorruptedDraft(body);
    if (finalCorruption) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "corrupted",
          `A finalization rewrite introduced corrupted markup (${finalCorruption}). The candidate was discarded.`,
        ),
        sourceVerified,
        { edited: edited.changed, repaired, samenessRewrote: false },
      );
    }

    // Single hard server character cap — enforced after all mutations.
    if (body.length > maxPostChars) {
      return emit(
        candidate,
        reject(
          candidate.origin,
          "character_range",
          `The finalized draft was ${body.length} characters, over the ${maxPostChars}-character server limit. Tighten it and re-render the complete post.`,
        ),
        sourceVerified,
        { edited: edited.changed, repaired, samenessRewrote: false },
      );
    }

    // Security redaction is itself a body mutation. It must happen before the
    // artifact build so a prompt leak cannot be persisted as a broken
    // placeholder-only artifact.
    body = redactHighConfidenceLeaks(body).text;

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
      sourcePostId: resolvedSource.source?.id ?? null,
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

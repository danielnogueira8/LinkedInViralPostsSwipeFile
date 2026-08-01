// Quality-gate stages for a draft candidate, run in order by finalizer.ts's
// finalize(). Extracted verbatim out of a single 700-line function so a new
// check can be added as a new stage + one line in the sequence, instead of
// requiring an edit to that function's body.
//
// A stage receives the pipeline's running state and returns either "pass"
// (with whatever it changed folded into the next stage's state) or "reject"
// (with a typed rejection). The runner stops at the first rejection — gates
// are ordered because each one assumes the previous ones already passed
// (e.g. gate 4 assumes gate 1's non-empty/non-corrupted checks already ran).
//
// What is deliberately NOT a stage here: gate 5 (artifact build, dedupe,
// telemetry emission) stays inside finalize() itself — those aren't quality
// checks on the body, they're the function's own bookkeeping (the accepted-
// keys cache, the onDecision callback, the artifact schema validation), and
// folding them into "just another stage" would risk changing when that
// bookkeeping fires relative to everything else.

import { evaluateDeliverableArtifact } from "@/lib/agent/deliverable-contract";
import type { DeliverableContract } from "@/lib/agent/deliverable-contract";
import {
  aiTellMetrics,
  looksCorruptedDraft,
} from "@/lib/agent/specialists/nets";
import { sourceFidelityRejection } from "@/lib/agent/specialists/source-fidelity";
import type { AdapterHealthRegistry } from "@/lib/agent/adapter-health";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import type {
  DraftCandidate,
  DraftCandidateOrigin,
  DraftCandidateTransform,
  DraftFinalizerRejectionCode,
  DraftFinalizerSpecialists,
  DraftSource,
} from "./finalizer";

export type StageRejection = {
  code: DraftFinalizerRejectionCode;
  message: string;
  repairInstruction?: string;
};

/** Everything gates 1-4 accumulate about the candidate as they run. Each
 *  stage receives the current state and returns the next one on pass. */
export type StageState = {
  origin: DraftCandidateOrigin;
  /** The candidate's original finishReason/envelopeComplete, unchanged —
   *  gate 1 reads these directly rather than through `body`. */
  finishReason?: string | null;
  envelopeComplete?: boolean;
  body: string;
  sourceVerified: boolean;
  edited: boolean;
  repaired: boolean;
};

export type StageContext = {
  workspaceId: string;
  candidate: DraftCandidate;
  contract?: DeliverableContract | null;
  acceptedCount: number;
  isDuplicateOfRejected: (candidate: DraftCandidate) => boolean;
  transformCandidate?: DraftCandidateTransform;
  finalTransformCandidate?: DraftCandidateTransform;
  maxPostChars: number;
  specialists: DraftFinalizerSpecialists;
  /** Read by reference on every call — see finalizer.ts's own note on
   *  editOptions: a caller may mutate this object between finalize() calls
   *  and later stages must see the current value, not a value captured at
   *  finalizer-construction time. */
  editOptions?: { keepEmDashes?: boolean };
  characterRangeMax?: number | null;
  signal?: AbortSignal;
  adapterHealth?: AdapterHealthRegistry;
  telemetry?: CoworkTurnTelemetry;
  aborted: () => boolean;
};

export type StageResult =
  | { ok: true; state: StageState }
  | { ok: false; rejection: StageRejection };

function pass(state: StageState): StageResult {
  return { ok: true, state };
}

function fail(
  code: DraftFinalizerRejectionCode,
  message: string,
  repairInstruction?: string,
): StageResult {
  return { ok: false, rejection: { code, message, repairInstruction } };
}

// ---------------------------------------------------------------------------
// Gate 1 — Sanity: empty / corrupt / truncated / malformed in one pass.
// ---------------------------------------------------------------------------
export function sanityStage(ctx: StageContext, state: StageState): StageResult {
  if (state.envelopeComplete === false) {
    return fail(
      "truncated",
      "The draft delivery fence was not closed, so the incomplete candidate was discarded. Write a complete replacement.",
    );
  }

  const inputBody = state.body;
  if (!inputBody.trim()) {
    return fail("empty", "The draft body is empty.");
  }
  const transformed = ctx.transformCandidate?.(inputBody) ?? {
    ok: true as const,
    body: inputBody,
  };
  if (!transformed.ok) {
    return fail("domain_constraint", transformed.message);
  }
  const rawBody = transformed.body;
  if (!rawBody.trim()) {
    return fail(
      "empty",
      "The trusted draft transform produced an empty body.",
    );
  }
  if (ctx.isDuplicateOfRejected(ctx.candidate)) {
    return fail(
      "duplicate",
      "This exact candidate was already rejected by the finalizer. Produce a corrected candidate instead of replaying it.",
    );
  }
  if (state.finishReason === "length") {
    return fail(
      "truncated",
      "The provider stopped at its length limit, so this candidate cannot be delivered. Write a complete tighter replacement.",
    );
  }
  const rawCorruption = looksCorruptedDraft(rawBody);
  if (rawCorruption) {
    return fail(
      "corrupted",
      `The draft contained corrupted markup (${rawCorruption}). Re-render clean plain text.`,
    );
  }

  return pass({ ...state, body: rawBody });
}

// ---------------------------------------------------------------------------
// Gate 2 — Contract: enforce the exact deliverable count.
// ---------------------------------------------------------------------------
export function contractStage(ctx: StageContext, state: StageState): StageResult {
  if (!ctx.contract) return pass(state);
  const contractDecision = evaluateDeliverableArtifact(
    ctx.contract,
    ctx.acceptedCount,
    "post",
  );
  if (!contractDecision.accept) {
    return fail(
      "count_complete",
      `The exact ${ctx.contract.expectedCount}-post contract is already complete. Do not render another draft.`,
    );
  }
  return pass(state);
}

// ---------------------------------------------------------------------------
// Gate 3 — Provenance: resolve the verified source (if any).
// ---------------------------------------------------------------------------
export function resolveSource(
  provenance: DraftCandidate["provenance"],
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

export type ProvenanceStageResult =
  | { ok: true; state: StageState; source: DraftSource | null }
  | { ok: false; rejection: StageRejection };

export function provenanceStage(
  ctx: StageContext,
  state: StageState,
): ProvenanceStageResult {
  const resolved = resolveSource(ctx.candidate.provenance, ctx.candidate.origin);
  if (!resolved.ok) {
    return { ok: false, rejection: { code: resolved.code, message: resolved.message } };
  }
  return {
    ok: true,
    source: resolved.source,
    state: { ...state, sourceVerified: resolved.source !== null },
  };
}

// ---------------------------------------------------------------------------
// Gate 4a — Deterministic edit (em-dash strip + paragraph normalize). Always
// runs, regardless of task kind.
// ---------------------------------------------------------------------------
export function editStage(ctx: StageContext, state: StageState): StageResult {
  const edited = ctx.specialists.edit(state.body, "post", ctx.editOptions);
  return pass({ ...state, body: edited.body, edited: edited.changed });
}

// ---------------------------------------------------------------------------
// Gate 4b — Quality model specialist. Mutually exclusive by design: a turn
// with a verified source runs fidelity review (telemetry-only for a full
// post — see finalizer.ts's own comment on why); a turn with no source runs
// AI-tell repair. Exactly one of these two stages ever executes per
// finalize() call — the caller (finalize()) picks which and only calls that
// one, rather than both stages being registered and self-selecting, so the
// mutual-exclusivity is visible at the call site, not hidden inside a
// stage's own logic.
// ---------------------------------------------------------------------------
export async function sourceFidelityStage(
  ctx: StageContext,
  state: StageState,
  source: DraftSource,
): Promise<StageResult> {
  if (!ctx.candidate.provenance) return pass(state);
  // Source-fidelity review is telemetry-only. The writer is responsible for
  // producing an original adaptation; this stage never rejects a modeled
  // draft for being too similar to the source — it only records the verdict.
  const fidelity = await ctx.specialists.reviewSourceFidelity({
    sourceText: source.text,
    draftBody: state.body,
    userRequest: ctx.candidate.provenance.userRequest,
    verifiedContext: ctx.candidate.provenance.verifiedContext,
    workspaceId: ctx.workspaceId,
    signal: ctx.signal,
    adapterHealth: ctx.adapterHealth,
    telemetry: ctx.telemetry,
  });
  if (ctx.aborted()) {
    return fail("cancelled", "Draft finalization was cancelled.");
  }
  const fidelityRejection = sourceFidelityRejection(fidelity);
  ctx.telemetry?.recordAttempt({
    stage: "finalizer_source_fidelity_verdict",
    attempt: 1,
    provider: "server",
    outcome: fidelityRejection ? "rejected" : "accepted",
    reasonCode: fidelityRejection?.code,
    latencyMs: 0,
  });
  return pass(state);
}

export async function aiTellRepairStage(
  ctx: StageContext,
  state: StageState,
): Promise<StageResult> {
  const repair = await ctx.specialists.repairAiTells({
    body: state.body,
    workspaceId: ctx.workspaceId,
    signal: ctx.signal,
    maxChars: ctx.characterRangeMax ?? ctx.maxPostChars,
    adapterHealth: ctx.adapterHealth,
    telemetry: ctx.telemetry,
    keepEmDashes: ctx.editOptions?.keepEmDashes,
  });
  if (ctx.aborted()) {
    return fail("cancelled", "Draft finalization was cancelled.");
  }
  const remaining = aiTellMetrics(repair.body);
  if (remaining.length > 0) {
    const labels = remaining.join(", ");
    return fail(
      "domain_constraint",
      `The draft still contains blocked AI-writing patterns (${labels}). Rewrite those patterns before rendering the post again.`,
      `Remove these AI-writing patterns while preserving the facts, meaning, paragraph order, and voice: ${labels}.`,
    );
  }
  return pass({ ...state, body: repair.body, repaired: repair.repaired });
}

// ---------------------------------------------------------------------------
// Gate 4c — Final trusted transform + post-transform sanity re-check + the
// single hard character cap. Runs after whichever of 4b's two stages ran.
// ---------------------------------------------------------------------------
export function finalTransformStage(
  ctx: StageContext,
  state: StageState,
): StageResult {
  const finalTransformed = ctx.finalTransformCandidate?.(state.body) ?? {
    ok: true as const,
    body: state.body,
  };
  if (!finalTransformed.ok) {
    return fail("domain_constraint", finalTransformed.message);
  }
  const body = finalTransformed.body;
  if (!body.trim()) {
    return fail(
      "empty",
      "The trusted final draft transform produced an empty body.",
    );
  }
  const finalCorruption = looksCorruptedDraft(body);
  if (finalCorruption) {
    return fail(
      "corrupted",
      `A finalization rewrite introduced corrupted markup (${finalCorruption}). The candidate was discarded.`,
    );
  }
  if (body.length > ctx.maxPostChars) {
    return fail(
      "character_range",
      `The finalized draft was ${body.length} characters, over the ${ctx.maxPostChars}-character server limit. Tighten it and re-render the complete post.`,
    );
  }
  return pass({ ...state, body });
}

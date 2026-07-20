// Drop-in compatibility shim for the collapsed 5-gate finalizer.
// New code should import from @/lib/agent/finalize/finalizer directly.
export {
  createDraftFinalizer,
  DRAFT_FINALIZER_REJECTION_CODES,
  type DraftFinalizerRejectionCode,
  type DraftCandidateOrigin,
  type DraftSource,
  type DraftProvenance,
  type DraftCandidate,
  type DraftFinalizerSpecialists,
  type DraftFinalizerRejection,
  type DraftFinalizationResult,
  type DraftFinalizerDecision,
  type DraftFinalizerOptions,
  type DraftCandidateTransform,
  type DraftFinalizer,
} from "@/lib/agent/finalize/finalizer";

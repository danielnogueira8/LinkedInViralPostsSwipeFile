import { editDraftBodySync } from "@/lib/agent/specialists/editor";
import { reviewModeledDraft } from "@/lib/agent/specialists/source-fidelity";
import { aiTellMetrics } from "@/lib/agent/specialists/nets";
import type { DraftFinalizerSpecialists } from "@/lib/agent/draft-finalizer";

// The THIN drafting path re-enables the full finalizer specialist pipeline —
// edit → repairAiTells → checkSameness → reviewSourceFidelity — same as the
// heavy path. Luna (CHAT_MODEL) is a strong writer, but these specialists
// check different things than raw writing quality: AI-tell polish
// (repairAiTells), cross-draft variety (checkSameness), and
// structural/mechanical family-resemblance to the selected source when
// modeling one (reviewSourceFidelity — its actual prompt judges "does this
// open/build/land like the source", NOT deep factual fidelity; it explicitly
// does not fail for changed topic/examples/numbers). Live-tested (2026-07):
// re-enabling these costs up to 3 extra model calls per draft, same as the
// heavy path always paid.
//
// This set is definitionally identical to createDraftFinalizer's own
// DEFAULT_SPECIALISTS, so the lean call site in draft-engine.ts passes
// `undefined` (falling through to that default) rather than duplicating the
// same four specialists here under a second name.

// Modeled batches already arbitrate cross-slot duplicates and use a strong
// writer with explicit mechanics. Keep deterministic editing and the required
// fidelity reviewer on the blocking path, but do not add two unrelated model
// rewrites that can increase cost, latency, and post-review structural drift.
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

import { editDraftBodySync } from "@/lib/agent/specialists/editor";
import { repairAiTells } from "@/lib/agent/specialists/ai-tell-repair";
import { checkSameness } from "@/lib/agent/specialists/sameness";
import { reviewModeledDraft } from "@/lib/agent/specialists/source-fidelity";
import { aiTellMetrics } from "@/lib/agent/specialists/nets";
import type { DraftFinalizerSpecialists } from "@/lib/agent/draft-finalizer";

// Finalizer specialists for the THIN drafting path.
//
// The draft finalizer runs a fixed pipeline of "specialists" on every candidate:
//   edit → repairAiTells → checkSameness → (later) reviewSourceFidelity
//
// All four run on the thin path, same as the heavy path — Luna (CHAT_MODEL) is
// a strong writer, but these specialists check different things than raw
// writing quality: AI-tell polish (repairAiTells), cross-draft variety
// (checkSameness), and structural/mechanical family-resemblance to the
// selected source when modeling one (reviewSourceFidelity — its actual prompt
// judges "does this open/build/land like the source", NOT deep factual
// fidelity; it explicitly does not fail for changed topic/examples/numbers).
// Live-tested (2026-07): re-enabling these costs up to 3 extra model calls per
// draft, same as the heavy path always paid.
export const leanFinalizerSpecialists: DraftFinalizerSpecialists = {
  edit: editDraftBodySync,
  repairAiTells,
  checkSameness,
  reviewSourceFidelity: reviewModeledDraft,
};

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

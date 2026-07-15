import { editDraftBodySync } from "@/lib/agent/specialists/editor";
import type { DraftFinalizerSpecialists } from "@/lib/agent/draft-finalizer";

// Lean finalizer specialists for the THIN drafting path.
//
// The draft finalizer runs a fixed pipeline of "specialists" on every candidate:
//   edit → repairAiTells → checkSameness → (later) reviewSourceFidelity
// The default specialists make up to three EXTRA model calls per draft (an
// ai-tell rewrite, a sameness rewrite, and a Sonnet source-fidelity judgment
// that BLOCKS the draft when it fires). Those police TASTE — they exist because
// the legacy GLM writer needed babysitting. A strong reasoning model (the thin
// path's Gemini 3.1 Pro / Sonnet) writes better than those gates police, so on
// the thin path we swap them for no-ops.
//
// We KEEP `edit` (editDraftBodySync) — that's the DETERMINISTIC, model-free
// corruption/structure net: em-dash strip + list/whitespace normalization
// (normalizePostBody, incl. the inline-arrow-list splitter). It catches broken
// RENDERING, not style, so it stays. The other structural safeguards inside the
// finalizer (security redaction, the hard character cap, corrupt-fence
// rejection) are NOT specialist-gated — they always run — so this override
// doesn't touch them.
//
// The three no-ops each return the specialists' real success shape so the
// finalizer's downstream code is unchanged: it sees "nothing to repair / no
// sameness overlap / fidelity passed" and accepts the model's own output.
export const leanFinalizerSpecialists: DraftFinalizerSpecialists = {
  // KEEP: deterministic, model-free cleanup (em-dash + normalizePostBody).
  edit: editDraftBodySync,
  // DROP: no second model pass to "fix AI tells". Report the body unchanged.
  repairAiTells: async ({ body }) => ({ body, repaired: false, detected: [] }),
  // DROP: no anti-repetition rewrite. Report no overlap so the body passes as-is.
  checkSameness: async ({ body }) => ({
    body,
    rewrote: false,
    overlapMarkers: [],
    reason: "Sameness review skipped on the thin path.",
  }),
  // DROP: no Sonnet source-fidelity gate. Always pass — the strong model is
  // trusted to adapt the source itself.
  reviewSourceFidelity: async () => ({
    pass: true,
    reasons: [],
    retryInstruction: "",
  }),
};

// AI-Tell Editor — the consolidated draft-cleanup stage.
//
// This runs AFTER a writer produces a body and BEFORE the draft is rendered, on
// EVERY draft path (render tool, legacy fence, forced-final fence). It composes
// the existing deterministic nets into one reporting pass, so a caller gets both
// a cleaned body AND a structured EditorResult saying what it fixed.
//
// SAFETY MODEL (deliberately conservative):
//   - Deterministic passes only DO the fixes that are safe to apply mechanically
//     without rephrasing: em-dash stripping, list-heading + dense-paragraph
//     normalization. These already ship today; the editor just centralizes them
//     and reports them.
//   - The UNSAFE tells (rule-of-three cadence, banned-word "fake polish") are
//     only DETECTED and reported in `notes`, never mechanically rewritten —
//     rewriting a deliberate line risks mangling the user's voice. This mirrors
//     why aiTellMetrics only logs those today.
//   - An OPTIONAL model rewrite can address the unsafe tells, but it is OFF by
//     default (AGENT_AI_TELL_EDITOR_MODEL=1 to enable), bounded to ONE call, and
//     injected via a hook so this module stays pure + unit-testable. It runs
//     only when unsafe tells remain after the deterministic pass, and it fails
//     open: any error/short/empty rewrite → keep the deterministic body.
//
// The editor NEVER blocks or drops a draft: worst case it returns the input body
// unchanged with changed=false.

import {
  stripEmDashes,
  aiTellMetrics,
} from "./nets";
import { normalizePostBody } from "@/lib/post-body-normalize";
import {
  EditorResultSchema,
  type EditorResult,
  type AiTellCategory,
} from "./contracts";

// A model rewrite function the caller can inject. Returns the rewritten body, or
// null on any failure (transport error, empty, refusal) so the editor falls back
// to the deterministic body. Kept as a narrow contract so editor.ts has no
// direct model dependency and stays trivially testable.
export type EditorModelRewrite = (args: {
  body: string;
  // The unsafe tells detected, so the rewrite prompt can target them.
  tells: AiTellCategory[];
}) => Promise<string | null>;

export type EditDraftOptions = {
  // Inject the model rewrite. When omitted, the editor is purely deterministic.
  modelRewrite?: EditorModelRewrite;
  // Force-enable/disable the model pass regardless of env (mainly for tests).
  // When undefined, falls back to the AGENT_AI_TELL_EDITOR_MODEL env flag.
  useModel?: boolean;
  // Voice-aware em-dash suppression: when the user's measured mechanics
  // fingerprint shows they GENUINELY write with em dashes
  // (voiceKeepsEmDashes, lib/voice-mechanics.ts), stripping them makes
  // drafts LESS like the user — so the net backs off. Default false: the em
  // dash stays the AI tell it is for everyone else.
  keepEmDashes?: boolean;
};

// Is the optional model rewrite enabled? Off unless explicitly turned on, so the
// default behavior is deterministic-only (no added cost/latency, no voice risk).
function modelEnabled(opts: EditDraftOptions): boolean {
  if (typeof opts.useModel === "boolean") return opts.useModel;
  return process.env.AGENT_AI_TELL_EDITOR_MODEL === "1";
}

// Map aiTellMetrics' string tells to the typed AiTellCategory contract.
function toCategory(tell: string): AiTellCategory | null {
  if (tell === "rule-of-three") return "rule_of_three";
  if (tell === "formulaic-opener") return "generic_opener";
  if (
    [
      "dismissive-negation",
      "contrast-pivot",
      "chatbot-artifact",
      "vague-attribution",
      "infomercial-hook",
      "generic-closer",
      "hedge-stack",
      "significance-inflation",
      "model-disclaimer",
      "unfilled-placeholder",
      "citation-markup-leak",
      "hashtag-stuffing",
    ].includes(tell)
  ) return "fake_polish";
  return null;
}

// What the deterministic clean applies. A "post" gets the full treatment
// (em-dash strip + paragraph normalization); a "hook" is a single opener unit,
// so it only gets em-dash stripping + a trailing-whitespace trim, NEVER
// paragraph injection. This mirrors exactly what run.ts's render dispatch and
// fence extraction already do per-kind, so routing those sites through this
// function is behavior-identical.
export type EditableKind = "post" | "hook";

// The core deterministic clean: em-dash strip, then (posts only) post-body
// normalize (list-heading + dense-paragraph fixes). Returns the cleaned body
// plus which safe categories actually changed something. Pure + synchronous.
function deterministicClean(
  body: string,
  kind: EditableKind = "post",
  keepEmDashes = false,
): {
  body: string;
  fixed: AiTellCategory[];
} {
  const fixed: AiTellCategory[] = [];

  const deAshed = keepEmDashes ? body : stripEmDashes(body);
  if (deAshed !== body) fixed.push("em_dash");

  // Hooks are a single opener line — never inject paragraph breaks; just trim
  // trailing whitespace (matches run.ts's hook path exactly).
  if (kind === "hook") {
    return { body: deAshed.replace(/\s+$/, ""), fixed };
  }

  // normalizePostBody is now just the dense-block paragraph split (the list-
  // heading/number repair nets were removed: the live writer model formats
  // lists correctly on its own, so those nets never fired — the now-removed
  // "broken_list" AI_TELL_CATEGORIES entry existed only for that retired net).
  const trimmed = deAshed.replace(/\s+$/, "");
  const normalized = normalizePostBody(deAshed);
  if (normalized !== trimmed) fixed.push("dense_paragraph");

  return { body: normalized, fixed };
}

// Synchronous, deterministic-only editor entry point. This is what the live
// draft paths (render dispatch, fence extraction, forced-final salvage) call:
// it's byte-for-byte the em-dash + normalize treatment those sites already do
// inline, now behind ONE function that also reports what it fixed (for
// telemetry). No model call, no async — safe to drop into the synchronous
// artifact-building code. The async editDraftBody() below layers the optional
// model rewrite on top for callers that opt in.
export function editDraftBodySync(
  input: string,
  kind: EditableKind = "post",
  editOpts: Pick<EditDraftOptions, "keepEmDashes"> = {},
): EditorResult {
  const { body, fixed } = deterministicClean(input, kind, editOpts.keepEmDashes);
  return {
    body,
    changed: body !== input,
    usedModel: false,
    fixedCategories: fixed,
    notes: [],
  };
}

// Edit a draft body: deterministic cleanup + optional bounded model rewrite.
// Always returns a valid EditorResult (schema-validated), never throws.
export async function editDraftBody(
  input: string,
  opts: EditDraftOptions = {},
): Promise<EditorResult> {
  const { body: cleaned, fixed } = deterministicClean(input, "post", opts.keepEmDashes);

  // Detect the UNSAFE tells that remain after the deterministic pass. These are
  // reported (and, only if the model pass is on, targeted for rewrite).
  const remainingTells = aiTellMetrics(cleaned)
    .map(toCategory)
    .filter((c): c is AiTellCategory => c !== null);

  const notes: string[] = [];
  for (const t of remainingTells) {
    notes.push(`unsafe tell not auto-fixed: ${t}`);
  }

  let finalBody = cleaned;
  let usedModel = false;

  // Optional model rewrite: only when enabled, a rewrite fn is provided, AND
  // there are unsafe tells worth fixing. One attempt, fail-open.
  if (modelEnabled(opts) && opts.modelRewrite && remainingTells.length > 0) {
    try {
      const rewritten = await opts.modelRewrite({ body: cleaned, tells: remainingTells });
      // Guard: a usable rewrite is non-empty and not drastically shorter (a sign
      // the model dropped content). Anything else → keep the deterministic body.
      if (
        rewritten &&
        rewritten.trim().length >= Math.floor(cleaned.trim().length * 0.6)
      ) {
        // Re-run the deterministic clean on the model output so the rewrite can't
        // reintroduce an em-dash or a dense block.
        finalBody = deterministicClean(rewritten).body;
        usedModel = true;
      }
    } catch (error) {
      // Provider failures are editorial fail-open. The workspace cost ledger is
      // different: its atomic cap must fail closed, so never hide its typed
      // persistence error behind a deterministic fallback.
      if (error instanceof Error && error.name === "UsagePersistenceError") {
        throw error;
      }
      // Fail open: keep the deterministic body.
    }
  }

  const fixedCategories = usedModel
    ? // When the model ran, the unsafe tells it targeted count as fixed too
      // (best-effort; we don't re-assert they're gone to avoid over-claiming).
      Array.from(new Set([...fixed, ...remainingTells]))
    : fixed;

  const result: EditorResult = {
    body: finalBody,
    changed: finalBody !== input,
    usedModel,
    fixedCategories,
    notes,
  };

  // Validate at the boundary. If the body somehow normalized to empty (it can't,
  // stripEmDashes/normalize preserve content), fall back to the input so we never
  // emit an empty draft.
  const parsed = EditorResultSchema.safeParse(result);
  if (!parsed.success) {
    return {
      body: input,
      changed: false,
      usedModel: false,
      fixedCategories: [],
      notes: ["editor result failed validation; returned input unchanged"],
    };
  }
  return parsed.data;
}

// Structure skeleton — a deterministic measurement of a single source post's
// FORMAT (paragraph shape, list usage, hook length, overall length), used
// exclusively on MODELING turns (the user asked to adapt an existing post's
// structure). This is NOT the voice-mechanics fingerprint (lib/voice-
// mechanics.ts, which profiles a CREATOR across many posts for their own
// voice) — this measures ONE source post, once, per modeling turn.
//
// Two consumers:
//   1. renderStructureSkeletonReference() — a soft, prose reference block for
//      the writer prompt. Explicitly non-prescriptive on exact numbers (the
//      user pushed back: "sometimes we need more words on the hook or
//      something") — it names the beats and their order, gives approximate
//      sizes as a reference point, and tells the model to deviate on size
//      whenever the content needs it, but never to drop/add/reorder a beat.
//   2. checkStructureMatch() — a COARSE, high-precision post-check for the
//      finalizer gate (lib/post-structure-gate.ts). It only catches gross
//      mismatches (source has a list, draft has none; wildly different
//      length) — never the fine-grained sizes the reference block treats as
//      negotiable. False positives here burn a retry or drop a good draft,
//      so this stays deliberately coarse.

import { extractHookHeuristic } from "./hooks";

const LIST_MARKER_RE = /^\s*([-•→*]|\d+\.)\s+/;

export type StructureSkeleton = {
  // Number of paragraphs (blank-line-separated blocks), matching the
  // codebase's paragraph convention (lib/voice-mechanics.ts paragraphsOf).
  paragraphCount: number;
  // Whether the source contains a list block anywhere.
  hasList: boolean;
  // The list marker character, normalized ("1." for any numbered marker),
  // or null when hasList is false.
  listMarker: string | null;
  // Number of list items, or 0 when hasList is false.
  listItemCount: number;
  // Character length of the extracted hook (first ~1-2 sentences/lines).
  hookChars: number;
  // Total character length of the source body.
  totalChars: number;
  // Total word count of the source body.
  totalWords: number;
};

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function wordCount(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+/gu);
  return matches ? matches.length : 0;
}

function listStatsOf(text: string): { hasList: boolean; marker: string | null; itemCount: number } {
  const lines = text.split("\n");
  let itemCount = 0;
  const markerCounts = new Map<string, number>();
  for (const line of lines) {
    const m = line.match(LIST_MARKER_RE);
    if (!m) continue;
    itemCount++;
    const marker = /^\d+\./.test(m[1]) ? "1." : m[1];
    markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1);
  }
  let marker: string | null = null;
  let best = 0;
  for (const [m, count] of markerCounts) {
    if (count > best) {
      best = count;
      marker = m;
    }
  }
  return { hasList: itemCount > 0, marker, itemCount };
}

// Measure a single source post's structure. Pure, synchronous, no model
// call. Never throws — an empty/whitespace-only input yields a zeroed
// skeleton (callers should check totalChars > 0 before using it).
export function computeStructureSkeleton(sourceText: string): StructureSkeleton {
  const text = sourceText.trim();
  const { hasList, marker, itemCount } = listStatsOf(text);
  const hook = extractHookHeuristic(text);
  return {
    paragraphCount: paragraphsOf(text).length,
    hasList,
    listMarker: marker,
    listItemCount: itemCount,
    hookChars: hook?.length ?? 0,
    totalChars: text.length,
    totalWords: wordCount(text),
  };
}

// Render the skeleton as a soft, non-prescriptive reference block for the
// writer prompt. Deliberately frames sizes as approximate reference points,
// not a contract — the model should stay close when it naturally can, and
// deviate freely (a longer hook, an extra sentence) whenever the user's
// actual content needs the room. The one thing that IS a hard rule: never
// drop, add, or reorder a structural beat to compensate for size changes.
//
// Returns "" for a source with essentially no structure to reference
// (empty/near-empty text) — callers should skip injecting an empty block.
export function renderStructureSkeletonReference(skeleton: StructureSkeleton): string {
  if (skeleton.totalChars === 0) return "";
  const beats: string[] = [];
  beats.push(
    `Hook: roughly ${approxWords(skeleton.hookChars)} — a reference point, not a limit; write however many words your actual opener needs.`,
  );
  beats.push(
    `Body: ${skeleton.paragraphCount} paragraph${skeleton.paragraphCount === 1 ? "" : "s"} in the source — match that general density (tight single-line paragraphs stay tight; longer blocks can stay longer), not an exact count.`,
  );
  if (skeleton.hasList && skeleton.listMarker) {
    beats.push(
      `List: the source uses a "${skeleton.listMarker}" list with ${skeleton.listItemCount} item${skeleton.listItemCount === 1 ? "" : "s"} — keep the list (same marker), but the item count and each item's length can flex to fit your content.`,
    );
  }
  beats.push(
    `Overall length: the source is about ${approxWords(skeleton.totalChars)} — a rough target, not a cap. Write shorter or longer if your content genuinely needs it.`,
  );
  return [
    "SOURCE STRUCTURE REFERENCE (soft — approximate sizes, not exact targets):",
    ...beats.map((b) => `- ${b}`),
    "Reproduce the BEATS and their ORDER (hook, then body, then list if present, then close) — that's what must match. The exact word/line counts above are reference points: stay close when it's natural, deviate freely when your content needs more or less room. Never drop, add, or reorder a beat to compensate for a size change.",
  ].join("\n");
}

function approxWords(chars: number): string {
  const words = Math.max(1, Math.round(chars / 5.5));
  return `${words} words`;
}

// ---------------------------------------------------------------------------
// Coarse structural match check — the finalizer gate's measurement, deemed
// only against the DRAFT's own skeleton vs the SOURCE's. Deliberately only
// catches gross mismatches; every size difference the reference block above
// calls "flex freely" is NOT checked here.
// ---------------------------------------------------------------------------

export type StructureMismatch = {
  // Short machine-readable reason, used to build the retry instruction.
  code: "missing_list" | "wrong_list_marker" | "too_short" | "too_long";
  message: string;
};

// Length band: a draft between 0.6x and 1.6x of the source's length is
// considered a legitimate size deviation (the reference block explicitly
// invites this). Outside that band, the draft has abandoned the source's
// scale entirely — that's the only length signal worth gating on.
const LENGTH_BAND_MIN = 0.6;
const LENGTH_BAND_MAX = 1.6;

// Compare a draft's skeleton against its source's. Returns the FIRST
// mismatch found (deliberately singular — a single named delta drives one
// clean retry instruction, not a multi-issue report), or null when the
// draft's structure is an acceptable adaptation of the source's.
export function checkStructureMatch(
  source: StructureSkeleton,
  draft: StructureSkeleton,
): StructureMismatch | null {
  if (source.hasList && !draft.hasList) {
    return {
      code: "missing_list",
      message: `The source post uses a "${source.listMarker}" list (${source.listItemCount} items) — the draft dropped the list entirely and wrote prose instead.`,
    };
  }
  if (source.hasList && draft.hasList && source.listMarker && draft.listMarker !== source.listMarker) {
    return {
      code: "wrong_list_marker",
      message: `The source post's list uses "${source.listMarker}" as its marker — the draft used "${draft.listMarker}" instead.`,
    };
  }
  if (source.totalChars > 0) {
    const ratio = draft.totalChars / source.totalChars;
    if (ratio < LENGTH_BAND_MIN) {
      return {
        code: "too_short",
        message: `The source post is roughly ${approxWords(source.totalChars)} — the draft is far shorter (roughly ${approxWords(draft.totalChars)}), well outside a reasonable adaptation range.`,
      };
    }
    if (ratio > LENGTH_BAND_MAX) {
      return {
        code: "too_long",
        message: `The source post is roughly ${approxWords(source.totalChars)} — the draft is far longer (roughly ${approxWords(draft.totalChars)}), well outside a reasonable adaptation range.`,
      };
    }
  }
  return null;
}

// Render a mismatch into a repair instruction for the writer — names the
// specific delta rather than a generic "try again", matching the codebase's
// existing repairInstruction convention (source-fidelity.ts,
// draft-finalizer.ts).
export function structureMismatchRepairInstruction(mismatch: StructureMismatch): string {
  switch (mismatch.code) {
    case "missing_list":
      return `Rewrite the draft to include a list (matching the source's marker), while keeping the rest of your original content and voice.`;
    case "wrong_list_marker":
      return `Rewrite the draft's list to use the source's marker instead of your own.`;
    case "too_short":
      return `Rewrite the draft with more substance so its length is closer to the source's — expand the body, not the hook or CTA alone.`;
    case "too_long":
      return `Rewrite the draft more concisely so its length is closer to the source's — tighten the body, don't cut structural beats.`;
  }
}

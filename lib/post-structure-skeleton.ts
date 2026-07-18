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

export type StructureLayoutBeat = {
  kind: "prose" | "list";
  marker: string | null;
};

// One shared writer contract for every modeled-post path. The reference block
// supplies the concrete layout; this policy explains how to use it without
// assuming every source has the same hook/body/list/close arrangement.
export const SOURCE_STRUCTURE_REFERENCE_POLICY =
  "A SOURCE STRUCTURE REFERENCE may follow the source data. It names the source's detected beats, their order, and approximate sizes. Reproduce that detected sequence; treat sizes as a reference point, not a limit, and deviate freely when the user's content genuinely needs it. Keep a list in the same position and use the same marker when present. Never drop, add, or reorder a beat to compensate for a size change.";

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
  // Ordered visual runs in the source. Unlike aggregate paragraph/list
  // counts, this preserves where a list appears (opening, middle, closing)
  // and whether prose resumes after it.
  layout: StructureLayoutBeat[];
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

function layoutOf(text: string): StructureLayoutBeat[] {
  const layout: StructureLayoutBeat[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(LIST_MARKER_RE);
    const marker = match ? (/^\d+\./.test(match[1]) ? "1." : match[1]) : null;
    const kind: StructureLayoutBeat["kind"] = match ? "list" : "prose";
    const previous = layout[layout.length - 1];
    if (
      !previous ||
      previous.kind !== kind ||
      (kind === "list" && previous.marker !== marker)
    ) {
      layout.push({ kind, marker });
    }
  }
  return layout;
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
    layout: layoutOf(text),
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
  const layout = skeleton.layout
    .map((beat) =>
      beat.kind === "list" ? `"${beat.marker}" list` : "prose",
    )
    .join(" → ");
  if (layout) {
    beats.push(
      `Layout: ${layout}. Keep this sequence: a list belongs in the same part of the post, and prose before or after it remains before or after it.`,
    );
  }
  beats.push(
    `Overall length: the source is about ${approxWords(skeleton.totalChars)} — a rough target, not a cap. Write shorter or longer if your content genuinely needs it.`,
  );
  return [
    "SOURCE STRUCTURE REFERENCE (soft — approximate sizes, not exact targets):",
    ...beats.map((b) => `- ${b}`),
    SOURCE_STRUCTURE_REFERENCE_POLICY,
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
  code:
    | "missing_list"
    | "wrong_list_marker"
    | "layout_order"
    | "paragraph_density"
    | "too_short"
    | "too_long";
  message: string;
};

// Length band: a draft between 0.6x and 1.6x of the source's length is
// considered a legitimate size deviation (the reference block explicitly
// invites this). Outside that band, the draft has abandoned the source's
// scale entirely — that's the only length signal worth gating on.
const LENGTH_BAND_MIN = 0.6;
const LENGTH_BAND_MAX = 1.6;

// Below this, the source is too short (a one-line hook, a fragment) for a
// length RATIO to mean anything — a 40-char source vs. a normal 250-char
// post is already a 6x ratio despite being a perfectly reasonable
// adaptation. The list-marker checks above still apply regardless of
// source length; only the ratio check needs this floor.
const MIN_SOURCE_CHARS_FOR_LENGTH_CHECK = 120;

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
  const sourceLayout = source.layout.map((beat) => beat.kind).join(",");
  const draftLayout = draft.layout.map((beat) => beat.kind).join(",");
  if (sourceLayout !== draftLayout) {
    return {
      code: "layout_order",
      message: `The source's visual sequence is ${sourceLayout || "empty"}, but the draft's is ${draftLayout || "empty"}. Keep prose and list beats in the same order.`,
    };
  }
  // Paragraph density is a strong visual-format cue for longer posts, but a
  // short source does not have enough paragraphs for a ratio to be meaningful.
  // Keep this deliberately broad so an adaptation can expand or tighten an
  // argument without flattening a six-beat post into two dense blocks.
  if (source.paragraphCount >= 3) {
    const minimumParagraphs = Math.max(2, Math.floor(source.paragraphCount * 0.6));
    const maximumParagraphs = Math.ceil(source.paragraphCount * 1.6);
    if (
      draft.paragraphCount < minimumParagraphs ||
      draft.paragraphCount > maximumParagraphs
    ) {
      return {
        code: "paragraph_density",
        message: `The source uses ${source.paragraphCount} visual paragraphs, but the draft uses ${draft.paragraphCount}. Keep a comparable paragraph density while preserving the user's content.`,
      };
    }
  }
  if (source.totalChars >= MIN_SOURCE_CHARS_FOR_LENGTH_CHECK) {
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
    case "layout_order":
      return "Rewrite the draft so its prose and list beats occur in the same order as the source. Keep the content original and user-relevant.";
    case "paragraph_density":
      return "Rewrite the draft with a paragraph density closer to the source. Preserve the source's visual pacing while keeping the content original and user-relevant.";
    case "too_short":
      return `Rewrite the draft with more substance so its length is closer to the source's — expand the body, not the hook or CTA alone.`;
    case "too_long":
      return `Rewrite the draft more concisely so its length is closer to the source's — tighten the body, don't cut structural beats.`;
  }
}

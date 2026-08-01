// Structure skeleton — a deterministic measurement of a single source post's
// FORMAT (paragraph shape, list usage and grouped list items, P.S. sign-off,
// hook length, overall length), used
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

// Formal line grammar, kept private behind computeStructureSkeleton():
// - ordered markers and ASCII bullets require separating whitespace;
// - established typographic bullets may touch their content;
// - a Unicode pictographic grapheme can be a marker in a compact adjacent
//   block, or in a stricter three-item spaced block described below.
// The rules recognize future and mixed emoji bullets without turning isolated
// decorative emoji paragraphs into a list.
const STANDARD_LIST_MARKER_RE =
  /^\s*(?:(\d+)[.)]\s+|([-*+])\s+|([•→▪◦‣⁃∙])\s*)/;
const EMOJI_GRAPHEME_RE =
  /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
const KEYCAP_EMOJI_GRAPHEME_RE = /^[#*0-9]\uFE0F?\u20E3$/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export type StructureListMarker =
  | { kind: "ordered" }
  | { kind: "bullet"; glyph: string }
  | { kind: "emoji" };

type StructuralLine = {
  marker: StructureListMarker | null;
  // Which blank-line-separated paragraph this line belongs to, used to detect
  // grouped list items (a marker line with a same-paragraph supporting line).
  paragraphIndex: number;
};

function standardListMarkerOf(line: string): StructureListMarker | null {
  const match = line.match(STANDARD_LIST_MARKER_RE);
  if (!match) return null;
  if (match[1]) return { kind: "ordered" };
  const glyph = match[2] ?? match[3];
  return glyph ? { kind: "bullet", glyph } : null;
}

function leadingEmojiGraphemeOf(line: string): string | null {
  const first = GRAPHEME_SEGMENTER.segment(line.trimStart())[Symbol.iterator]().next();
  return !first.done &&
    (EMOJI_GRAPHEME_RE.test(first.value.segment) ||
      KEYCAP_EMOJI_GRAPHEME_RE.test(first.value.segment))
    ? first.value.segment
    : null;
}

export type StructureLayoutBeat = {
  kind: "prose" | "list";
  marker: StructureListMarker | null;
};

// One shared writer contract for every modeled-post path. The reference block
// supplies the concrete layout; this policy explains how to use it without
// assuming every source has the same hook/body/list/close arrangement.
export const SOURCE_STRUCTURE_REFERENCE_POLICY =
  "A SOURCE STRUCTURE REFERENCE may follow the source data. It names the source's detected beats, their order, and approximate sizes. Reproduce that detected sequence; treat sizes as a reference point, not a limit, and deviate freely when the user's content genuinely needs it. Keep a list in the same position and use the same marker style when present. Never drop, add, or reorder a beat to compensate for a size change.";

export type StructureSkeleton = {
  // Number of paragraphs (blank-line-separated blocks), matching the
  // codebase's paragraph convention (lib/voice-mechanics.ts paragraphsOf).
  paragraphCount: number;
  // Non-empty rendered text lines. This captures visible beats that share one
  // blank-line paragraph (for example, emoji-led list-like lines) and is the
  // reliable signal for the coarse density gate.
  visualLineCount: number;
  // Whether the source contains a list block anywhere.
  hasList: boolean;
  // The dominant list marker category. Numbered and emoji-led lists are
  // normalized by kind; explicit bullet glyphs retain their glyph.
  listMarker: StructureListMarker | null;
  // Number of list items, or 0 when hasList is false.
  listItemCount: number;
  // List items that span two lines — a marker/label line followed by a
  // supporting line inside the same paragraph (e.g. a numbered framework
  // stage with its component roster underneath). A distinct shape from a
  // flat one-line-item list, and easy for a writer to wrongly flatten.
  groupedListItemCount: number;
  // Whether the source closes with a P.S. line — a deliberate sign-off beat
  // the reference block tells the writer to keep.
  hasPostScript: boolean;
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

function parseStructuralLines(text: string): StructuralLine[] {
  const paragraphs = paragraphsOf(text).map((paragraph) =>
    paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const lines = paragraphs.flatMap((paragraph, paragraphIndex) =>
    paragraph
      .map((line) => ({
        paragraphIndex,
        paragraphLineCount: paragraph.length,
        standardMarker: standardListMarkerOf(line),
        emojiGrapheme: leadingEmojiGraphemeOf(line),
      })),
  );
  const repeatedEmojiLines = new Set<number>();

  for (let index = 0; index < lines.length; ) {
    const candidate = lines[index];
    if (candidate.standardMarker || !candidate.emojiGrapheme) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < lines.length &&
      lines[end].paragraphIndex === candidate.paragraphIndex &&
      !lines[end].standardMarker &&
      lines[end].emojiGrapheme
    ) {
      end += 1;
    }
    if (end - index >= 2) {
      for (let repeated = index; repeated < end; repeated += 1) {
        repeatedEmojiLines.add(repeated);
      }
    }
    index = end;
  }

  // LinkedIn writers often put a blank line between visual list items. Treat
  // three or more consecutive one-line emoji paragraphs as a spaced list, but
  // keep one or two repeated decorative callouts as prose. This rule is
  // intentionally stricter than the within-paragraph rule because paragraph
  // breaks otherwise erase the only deterministic distinction between a list
  // and ordinary emoji-led prose.
  for (let index = 0; index < lines.length; ) {
    const candidate = lines[index];
    if (
      candidate.standardMarker ||
      !candidate.emojiGrapheme ||
      candidate.paragraphLineCount !== 1
    ) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < lines.length &&
      lines[end].paragraphIndex === lines[end - 1].paragraphIndex + 1 &&
      lines[end].paragraphLineCount === 1 &&
      !lines[end].standardMarker &&
      lines[end].emojiGrapheme === candidate.emojiGrapheme
    ) {
      end += 1;
    }
    if (end - index >= 3) {
      for (let repeated = index; repeated < end; repeated += 1) {
        repeatedEmojiLines.add(repeated);
      }
    }
    index = end;
  }

  return lines.map((line, index) => ({
    marker:
      line.standardMarker ??
      (repeatedEmojiLines.has(index) ? { kind: "emoji" } : null),
    paragraphIndex: line.paragraphIndex,
  }));
}

function markerKey(marker: StructureListMarker): string {
  return marker.kind === "bullet" ? `bullet:${marker.glyph}` : marker.kind;
}

function sameMarkerStyle(
  left: StructureListMarker | null,
  right: StructureListMarker | null,
): boolean {
  return Boolean(left && right && markerKey(left) === markerKey(right));
}

function listStyle(marker: StructureListMarker | null): string {
  if (!marker) return '"unknown"';
  if (marker.kind === "emoji") return "emoji-led";
  if (marker.kind === "ordered") return "numbered";
  return `"${marker.glyph}"`;
}

function listStyleWithArticle(marker: StructureListMarker | null): string {
  return `${marker?.kind === "emoji" ? "an" : "a"} ${listStyle(marker)}`;
}

function wordCount(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+/gu);
  return matches ? matches.length : 0;
}

function listStatsOf(lines: StructuralLine[]): {
  hasList: boolean;
  marker: StructureListMarker | null;
  itemCount: number;
} {
  let itemCount = 0;
  const markerCounts = new Map<
    string,
    { marker: StructureListMarker; count: number }
  >();
  for (const line of lines) {
    if (!line.marker) continue;
    itemCount++;
    const key = markerKey(line.marker);
    const current = markerCounts.get(key);
    markerCounts.set(key, {
      marker: line.marker,
      count: (current?.count ?? 0) + 1,
    });
  }
  let marker: StructureListMarker | null = null;
  let best = 0;
  for (const { marker: candidate, count } of markerCounts.values()) {
    if (count > best) {
      best = count;
      marker = candidate;
    }
  }
  return { hasList: itemCount > 0, marker, itemCount };
}

function layoutOf(lines: StructuralLine[]): StructureLayoutBeat[] {
  const layout: StructureLayoutBeat[] = [];
  for (const line of lines) {
    const marker = line.marker;
    const kind: StructureLayoutBeat["kind"] = marker ? "list" : "prose";
    const previous = layout[layout.length - 1];
    if (
      !previous ||
      previous.kind !== kind ||
      (kind === "list" && !sameMarkerStyle(previous.marker, marker))
    ) {
      layout.push({ kind, marker });
    }
  }
  return layout;
}

// A trailing sign-off paragraph: "P.S.", "PS:", "P.S. —", etc.
const POST_SCRIPT_RE = /^p\.?\s*s\.?(?=[\s.:)—-]|$)/i;

// Count list items whose marker line is immediately followed by a
// non-marker supporting line inside the SAME paragraph — the "1. Stage name
// / Component A, Component B, Component C." pattern framework posts use. A
// lead-in line before a list is unaffected (it has no marker); a flat
// one-line-item list scores 0.
function groupedListItemCountOf(lines: StructuralLine[]): number {
  let count = 0;
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index];
    const next = lines[index + 1];
    if (
      line.marker &&
      !next.marker &&
      next.paragraphIndex === line.paragraphIndex
    ) {
      count++;
    }
  }
  return count;
}

// Measure a single source post's structure. Pure, synchronous, no model
// call. Never throws — an empty/whitespace-only input yields a zeroed
// skeleton (callers should check totalChars > 0 before using it).
export function computeStructureSkeleton(sourceText: string): StructureSkeleton {
  const text = sourceText.trim();
  const structuralLines = parseStructuralLines(text);
  const { hasList, marker, itemCount } = listStatsOf(structuralLines);
  const hook = extractHookHeuristic(text);
  const paragraphs = paragraphsOf(text);
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? "";
  return {
    paragraphCount: paragraphs.length,
    visualLineCount: structuralLines.length,
    hasList,
    listMarker: marker,
    listItemCount: itemCount,
    groupedListItemCount: groupedListItemCountOf(structuralLines),
    hasPostScript: POST_SCRIPT_RE.test(lastParagraph.trimStart()),
    hookChars: hook?.length ?? 0,
    totalChars: text.length,
    totalWords: wordCount(text),
    layout: layoutOf(structuralLines),
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
      `List: the source uses ${listStyleWithArticle(skeleton.listMarker)} list with ${skeleton.listItemCount} item${skeleton.listItemCount === 1 ? "" : "s"} — keep the list (same marker style), but the item count and each item's length can flex to fit your content.`,
    );
  }
  if (skeleton.groupedListItemCount >= 2) {
    beats.push(
      `Grouped items: ${skeleton.groupedListItemCount} of the source's list items run two lines — a label line, then a supporting line underneath (for example a named stage with its component roster). Keep that two-line pattern per item; do not flatten each item into a single line.`,
    );
  }
  const layout = skeleton.layout
    .map((beat) =>
      beat.kind === "list" ? `${listStyle(beat.marker)} list` : "prose",
    )
    .join(" → ");
  if (layout) {
    beats.push(
      `Layout: ${layout}. Keep this sequence: a list belongs in the same part of the post, and prose before or after it remains before or after it.`,
    );
  }
  if (skeleton.hasPostScript) {
    beats.push(
      "P.S.: the source closes with a P.S. line — end your draft with a P.S. too. It is the final beat, not an optional extra.",
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
    | "visual_line_density"
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

// Collapse consecutive same-kind beats to a run-length sequence, e.g.
// [prose, prose, list, prose] → [prose, list, prose]. Merging adjacent beats of
// the same kind is a size choice the reference block invites, not a structural
// change.
function collapseRuns(kinds: Array<"prose" | "list">): Array<"prose" | "list"> {
  const out: Array<"prose" | "list"> = [];
  for (const kind of kinds) {
    if (out[out.length - 1] !== kind) out.push(kind);
  }
  return out;
}

// True when `inner` is a subsequence of `outer` (same items, same relative
// order, gaps allowed). Used to accept a draft that consolidated some of the
// source's beats — e.g. two separate list blocks merged into one — while still
// rejecting a genuine reorder (leading with the list when the source led with
// prose) or an added beat kind the source never had.
function isSubsequence(
  inner: Array<"prose" | "list">,
  outer: Array<"prose" | "list">,
): boolean {
  let i = 0;
  for (const kind of outer) {
    if (i < inner.length && inner[i] === kind) i += 1;
  }
  return i === inner.length;
}

// The coarse beat-order check. Accept the draft's layout as a legitimate
// adaptation of the source's when, after collapsing same-kind runs:
//   (a) the draft's beat sequence is a SUBSEQUENCE of the source's — permits
//       consolidation (fewer beats, same relative order), and
//   (b) the draft's FIRST and LAST beat kinds match the source's — the hook
//       shape and the landing shape are the load-bearing structural signals,
//       so a draft that opens with a list when the source opened with prose,
//       or lands on a list when the source landed on prose, is a real reorder,
//       not a consolidation.
// Together these accept e.g. source prose,list,prose,list,prose → draft
// prose,list,prose (two lists merged) while still rejecting source
// prose,list,prose → draft prose,prose,list (the list moved to the end).
// Empty source layouts always match.
function layoutIsAcceptableAdaptation(
  sourceKinds: Array<"prose" | "list">,
  draftKinds: Array<"prose" | "list">,
): boolean {
  const source = collapseRuns(sourceKinds);
  const draft = collapseRuns(draftKinds);
  if (source.length === 0) return true;
  if (draft.length === 0) return false;
  if (source[0] !== draft[0]) return false;
  if (source[source.length - 1] !== draft[draft.length - 1]) return false;
  return isSubsequence(draft, source);
}

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
      message: `The source post uses ${listStyleWithArticle(source.listMarker)} list (${source.listItemCount} items) — the draft dropped the list entirely and wrote prose instead.`,
    };
  }
  const sourceKinds = source.layout.map((beat) => beat.kind);
  const draftKinds = draft.layout.map((beat) => beat.kind);
  // Beat-order check, deliberately loose. The reference block invites the writer
  // to merge or split beats freely (list item counts "can flex"), so requiring
  // the draft's beat sequence to be BYTE-IDENTICAL to the source's is a false-
  // positive machine: a source with two separate list blocks
  // (prose,list,prose,list,prose) that the model naturally consolidates into one
  // (prose,list,prose) is a perfectly good adaptation, not a structural failure.
  // Instead, after collapsing consecutive same-kind beats, accept when the
  // draft's beat sequence is a SUBSEQUENCE of the source's — same beats, same
  // relative order, consolidation allowed. This still catches genuine scrambles
  // (a source prose→list→prose whose draft leads with the list) and reordering.
  // A wholly-dropped list is already caught by the missing_list guard above.
  if (!layoutIsAcceptableAdaptation(sourceKinds, draftKinds)) {
    const sourceLayout = sourceKinds.join(",");
    const draftLayout = draftKinds.join(",");
    return {
      code: "layout_order",
      message: `The source's visual sequence is ${sourceLayout || "empty"}, but the draft's is ${draftLayout || "empty"}. Keep prose and list beats in the same order.`,
    };
  }
  // Marker-style check is POSITIONAL, so it's only meaningful when the draft
  // kept the source's exact beat count. Once the draft is allowed to consolidate
  // beats (layouts differ in length but still an acceptable adaptation),
  // comparing beat-by-index would compare unrelated beats — skip it rather than
  // false-positive. The subsequence check above already accepted the shape.
  const markerMismatchIndex =
    source.layout.length === draft.layout.length
      ? source.layout.findIndex(
          (sourceBeat, index) =>
            sourceBeat.kind === "list" &&
            !sameMarkerStyle(
              sourceBeat.marker,
              draft.layout[index]?.marker ?? null,
            ),
        )
      : -1;
  if (markerMismatchIndex >= 0) {
    const sourceMarker = source.layout[markerMismatchIndex].marker;
    const draftMarker = draft.layout[markerMismatchIndex]?.marker ?? null;
    const listBeatNumber = source.layout
      .slice(0, markerMismatchIndex + 1)
      .filter((beat) => beat.kind === "list").length;
    return {
      code: "wrong_list_marker",
      message: `List beat ${listBeatNumber} in the source uses the ${listStyle(sourceMarker)} marker style — the corresponding draft beat used ${listStyle(draftMarker)} instead.`,
    };
  }
  // Visible-line density is a strong visual-format cue for longer posts, but a
  // short source does not have enough lines for a ratio to be meaningful.
  // Keep this deliberately broad so an adaptation can expand or tighten an
  // argument without flattening a six-beat post into two dense blocks.
  if (source.visualLineCount >= 3) {
    const minimumVisualLines = Math.max(
      2,
      Math.floor(source.visualLineCount * 0.6),
    );
    const maximumVisualLines = Math.ceil(source.visualLineCount * 1.6);
    if (
      draft.visualLineCount < minimumVisualLines ||
      draft.visualLineCount > maximumVisualLines
    ) {
      return {
        code: "visual_line_density",
        message: `The source uses ${source.visualLineCount} visible text lines, but the draft uses ${draft.visualLineCount}. Keep comparable visual pacing while preserving the user's content.`,
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
    case "visual_line_density":
      return "Rewrite the draft with a visible-line density closer to the source. Preserve the source's visual pacing while keeping the content original and user-relevant.";
    case "too_short":
      return `Rewrite the draft with more substance so its length is closer to the source's — expand the body, not the hook or CTA alone.`;
    case "too_long":
      return `Rewrite the draft more concisely so its length is closer to the source's — tighten the body, don't cut structural beats.`;
  }
}

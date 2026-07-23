import type { Artifact } from "@/lib/agent/contracts";
import type { AppliedLeadMagnet } from "@/lib/chat-hydration";
import type { PostMediaAttachment } from "@/lib/post-media";

export function kindNoun(kind: Artifact["kind"]): string {
  if (kind === "post") return "Post";
  if (kind === "hook") return "Hook";
  return "Source";
}

export type WritableArtifactKind = "post" | "hook";

export type ArtifactIndexEntry = {
  artifactId: string;
  artifact: Artifact;
  kind: WritableArtifactKind;
  ordinal: number;
  label: string;
};

export type ArtifactReferenceResolution =
  | { kind: "selected"; artifactId: string }
  | { kind: "unresolved_explicit"; reference: string }
  | { kind: "none" };

/**
 * Canonical writable-Artifact ordering shared by presentation and intent
 * resolution. A re-emitted Artifact keeps its first creation position while
 * its latest value wins, so source backfills and streamed replacements cannot
 * renumber Post or Hook Artifacts.
 */
export function buildArtifactIndex(
  artifacts: readonly Artifact[],
): { entries: ArtifactIndexEntry[] } {
  const orderedIds: string[] = [];
  const latestById = new Map<string, Artifact>();
  for (const artifact of artifacts) {
    if (artifact.kind !== "post" && artifact.kind !== "hook") continue;
    if (!latestById.has(artifact.id)) orderedIds.push(artifact.id);
    latestById.set(artifact.id, artifact);
  }
  const writable = orderedIds.flatMap((id) => {
    const artifact = latestById.get(id);
    return artifact ? [artifact] : [];
  });
  const totals = writable.reduce<Record<WritableArtifactKind, number>>(
    (counts, artifact) => {
      counts[artifact.kind as WritableArtifactKind] += 1;
      return counts;
    },
    { post: 0, hook: 0 },
  );
  const ordinals: Record<WritableArtifactKind, number> = { post: 0, hook: 0 };
  const entries = writable.map((artifact): ArtifactIndexEntry => {
    const kind = artifact.kind as WritableArtifactKind;
    const ordinal = ++ordinals[kind];
    const noun = kindNoun(kind);
    return {
      artifactId: artifact.id,
      artifact,
      kind,
      ordinal,
      label: totals[kind] > 1 ? `${noun} ${ordinal}` : noun,
    };
  });
  return { entries };
}

export function numberedArtifactLabel(entry: ArtifactIndexEntry): string {
  return `${kindNoun(entry.kind)} ${entry.ordinal}`;
}

/**
 * Resolve the visible Edit target without ever retargeting a stale explicit
 * selection. A fallback is allowed only before the user has selected an id,
 * such as when Posts arrive after the user entered Edit during a live Create.
 */
export function resolveArtifactEditTarget(
  entries: readonly ArtifactIndexEntry[],
  input: { targetArtifactId?: string; expandedArtifactId?: string | null },
): ArtifactIndexEntry | undefined {
  if (input.targetArtifactId) {
    return entries.find((entry) => entry.artifactId === input.targetArtifactId);
  }
  return (
    entries.find((entry) => entry.artifactId === input.expandedArtifactId) ??
    entries.at(-1)
  );
}

const CARDINAL_NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const ORDINAL_NUMBER_WORDS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
};
const ARTIFACT_REFERENCE_NOUN_PATTERN =
  String.raw`(?:post\s+artifact|hook\s+artifact|draft|post|hook)`;
const CARDINAL_NUMBER_WORD_PATTERN = Object.keys(CARDINAL_NUMBER_WORDS).join(
  "|",
);
const ORDINAL_NUMBER_WORD_PATTERN = Object.keys(ORDINAL_NUMBER_WORDS).join(
  "|",
);
const ARTIFACT_ORDINAL_PATTERN =
  String.raw`(?:\d+(?:st|nd|rd|th)?|(?:(?:${CARDINAL_NUMBER_WORD_PATTERN}|hundred|and)[\s-]+)*(?:${ORDINAL_NUMBER_WORD_PATTERN}|hundredth))`;

function artifactOrdinal(value: string): number {
  const numeric = /^\d+/.exec(value)?.[0];
  if (numeric) return Number(numeric);
  let total = 0;
  for (const token of value.toLowerCase().split(/[\s-]+/)) {
    if (!token || token === "and") continue;
    if (token === "hundred" || token === "hundredth") {
      total = Math.max(total, 1) * 100;
      continue;
    }
    total += CARDINAL_NUMBER_WORDS[token] ?? ORDINAL_NUMBER_WORDS[token] ?? 0;
  }
  return total;
}

function artifactKindForNoun(noun: string): WritableArtifactKind {
  return noun.toLowerCase().startsWith("hook") ? "hook" : "post";
}

function explicitArtifactOrdinal(message: string): {
  noun: string;
  ordinal: number;
} | null {
  const nounFirst = new RegExp(
    String.raw`\b(${ARTIFACT_REFERENCE_NOUN_PATTERN})\s+#?\s*(${ARTIFACT_ORDINAL_PATTERN})\b`,
    "i",
  ).exec(message);
  if (nounFirst) {
    return { noun: nounFirst[1], ordinal: artifactOrdinal(nounFirst[2]) };
  }
  const ordinalFirst = new RegExp(
    String.raw`(?<![\w-])(?:the\s+)?(${ARTIFACT_ORDINAL_PATTERN})\s+(${ARTIFACT_REFERENCE_NOUN_PATTERN})\b`,
    "i",
  ).exec(message);
  return ordinalFirst
    ? { noun: ordinalFirst[2], ordinal: artifactOrdinal(ordinalFirst[1]) }
    : null;
}

export function hasExplicitArtifactReference(message: string): boolean {
  return explicitArtifactOrdinal(message) !== null;
}

/** Resolve a textual Artifact reference without inferring the turn operation. */
export function resolveArtifactReference(
  message: string,
  artifacts: readonly Artifact[],
  selectedArtifactId: string | null,
): ArtifactReferenceResolution {
  const { entries } = buildArtifactIndex(artifacts);
  const explicitOrdinal = explicitArtifactOrdinal(message);
  if (explicitOrdinal) {
    const kind = artifactKindForNoun(explicitOrdinal.noun);
    const ordinal = explicitOrdinal.ordinal;
    const artifactId = entries.find(
      (entry) => entry.kind === kind && entry.ordinal === ordinal,
    )?.artifactId;
    return artifactId
      ? { kind: "selected", artifactId }
      : {
          kind: "unresolved_explicit",
          reference: `${kindNoun(kind)} ${ordinal}`,
        };
  }
  const latest =
    /\b(?:latest|newest|most\s+recent)\s+(post(?:\s+artifact)?|draft|hook(?:\s+artifact)?|artifact|one)\b/i.exec(
      message,
    );
  if (latest) {
    const noun = latest[1].toLowerCase();
    const matching =
      noun === "draft" || noun.startsWith("post")
        ? entries.filter((entry) => entry.kind === "post")
        : noun.startsWith("hook")
          ? entries.filter((entry) => entry.kind === "hook")
          : entries;
    const artifactId = matching.at(-1)?.artifactId;
    return artifactId ? { kind: "selected", artifactId } : { kind: "none" };
  }
  const selected = entries.find(
    (entry) => entry.artifactId === selectedArtifactId,
  )?.artifactId;
  if (selectedArtifactId && !selected) {
    return {
      kind: "unresolved_explicit",
      reference: "the selected post",
    };
  }
  const artifactId = selected ?? entries.at(-1)?.artifactId;
  return artifactId ? { kind: "selected", artifactId } : { kind: "none" };
}

export const ARTIFACT_PANEL_TITLE = "Posts";

export function refineSuggestions(kind: Artifact["kind"]): string[] {
  if (kind === "hook") {
    return ["Punchier", "More contrarian", "Add a number", "Shorter"];
  }
  return ["Punchier hook", "Make it shorter", "Stronger CTA", "More story-driven"];
}

// Read the custom-skill slugs an artifact was produced under (meta.skills,
// stamped server-side — see route's tagArtifactWithSkills). Defensive: meta is
// unknown-shape; only string entries survive. Pure + exported for tests.
export function artifactSkillNames(artifact: { meta?: Record<string, unknown> }): string[] {
  const v = (artifact.meta as { skills?: unknown } | undefined)?.skills;
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

export function artifactLeadMagnet(
  artifact: { meta?: Record<string, unknown> },
): AppliedLeadMagnet | null {
  const v = (artifact.meta as { lead_magnet?: unknown } | undefined)?.lead_magnet;
  if (!v || typeof v !== "object") return null;
  const raw = v as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const deliverables = Array.isArray(raw.deliverables)
    ? raw.deliverables
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
        .slice(0, 6)
    : [];
  const estimatedMinutes = Number(raw.estimatedMinutes);
  return {
    ...(id ? { id } : {}),
    title,
    selection: raw.selection === "manual" ? "manual" : "auto",
    publicSlug: typeof raw.public_slug === "string" ? raw.public_slug.trim() : null,
    ...(typeof raw.publicSlug === "string" && raw.publicSlug.trim()
      ? { publicSlug: raw.publicSlug.trim() }
      : {}),
    ...(typeof raw.selectionSummary === "string" && raw.selectionSummary.trim()
      ? { selectionSummary: raw.selectionSummary.trim() }
      : {}),
    ...(deliverables.length ? { deliverables } : {}),
    ...(typeof raw.resourceType === "string"
      ? { resourceType: raw.resourceType as NonNullable<AppliedLeadMagnet["resourceType"]> }
      : {}),
    ...(Number.isFinite(estimatedMinutes) && estimatedMinutes > 0
      ? { estimatedMinutes: Math.round(estimatedMinutes) }
      : {}),
  };
}

export function artifactMediaAttachments(artifact: {
  media_attachments?: PostMediaAttachment[];
  meta?: Record<string, unknown>;
}): PostMediaAttachment[] {
  const raw =
    artifact.media_attachments ??
    (artifact.meta as { media_attachments?: unknown } | undefined)?.media_attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is PostMediaAttachment => {
    if (!item || typeof item !== "object") return false;
    const a = item as Partial<PostMediaAttachment>;
    return (
      typeof a.id === "string" &&
      typeof a.name === "string" &&
      typeof a.mimeType === "string" &&
      typeof a.type === "string" &&
      typeof a.uploadedAt === "string"
    );
  });
}

export function generatedLeadMagnetImageStatus(artifact: {
  meta?: Record<string, unknown>;
}): { status: string; reason?: string } | null {
  const raw = (artifact.meta as { generated_lead_magnet_image?: unknown } | undefined)
    ?.generated_lead_magnet_image;
  if (!raw || typeof raw !== "object") return null;
  const status = (raw as { status?: unknown }).status;
  if (typeof status !== "string") return null;
  const reason = (raw as { reason?: unknown }).reason;
  return {
    status,
    ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}),
  };
}

// The consistent character budget for the author headline shown in a draft
// card's LinkedIn-style header. The header used a CSS `truncate` (ellipsis at
// the pixel edge), so the SAME headline cut at a different word on every card
// and screen width — it "cut off weirdly". Truncating at a fixed CHARACTER
// count first makes the cut identical everywhere; the CSS truncate stays as a
// belt-and-suspenders guard for very narrow viewports.
export const HEADLINE_PREVIEW_CHARS = 48;

// Truncate a headline to a stable length: cut at HEADLINE_PREVIEW_CHARS, but
// back up to the last word boundary so we never slice a word in half, then
// append an ellipsis. Returns the headline unchanged when it already fits.
// Pure + exported for unit tests.
export function truncateHeadline(
  headline: string,
  max: number = HEADLINE_PREVIEW_CHARS,
): string {
  const trimmed = headline.trim();
  if (trimmed.length <= max) return trimmed;
  // Cut to the budget, then drop back to the last space so the last word isn't
  // sliced. If there's no space in the window (one very long token), hard-cut.
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const base = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${base.trimEnd()}…`;
}

// Split a post body into [hook, rest] at the first BLANK-LINE paragraph break.
// The hook is the first paragraph (LinkedIn's "…see more" cut); the rest is
// everything after it, including the blank-line separator's trailing content.
// Returns rest = "" when the post is a single paragraph (no break).
export function splitHook(body: string): { hook: string; rest: string } {
  const m = body.match(/\n[ \t]*\n/); // first blank line
  if (!m || m.index === undefined) return { hook: body, rest: "" };
  return {
    hook: body.slice(0, m.index),
    rest: body.slice(m.index + m[0].length),
  };
}

// splitHookLines / splicePreservedBody / HOOK_LINE_COUNT / isHookFocusedRefine
// live in lib/hook-splice.ts now (shared with the server stream route so
// splicing is byte-identical on both sides). Re-exported at the top of this
// file — see the `export { … } from "@/lib/hook-splice"` block above.

// A refine must not DESTROY a post. GLM, told to "shorten"/"tighten", sometimes
// returns a fragment that no longer makes sense — either a lone hook (dropped
// the body) or a drastically gutted post (e.g. a coherent 1,111-char post
// reduced to a nonsensical 164 chars). Either way the user's post is replaced
// by something worse, recoverable only via the version stepper. This is a
// deterministic backstop — no model judgment — that rejects such a refine.
//
// Two independent collapse signals; EITHER trips it (only for a POST that was a
// real, substantial post to begin with — we never touch a short original):
//   A. LONE HOOK: the original was multi-paragraph but the refined is a single
//      paragraph that's ~just the opener (<=45% of the original AND <=1.4x its
//      own hook). Catches "returned only the hook", even if it's a few lines.
//   B. GUTTED: the refined dropped below BOTH ~35% of the original length AND an
//      absolute floor (~400 chars). A 1,111→164 (15%) post is caught here even
//      if it kept a blank line; a genuine heavy trim (1,111→500, 45%) passes.
// The "was a real post" gate (original >= MIN chars) means a deliberately tiny
// post, or shortening an already-short one, is never blocked.
//
// On a detected collapse, KEEP THE ORIGINAL body and report it so the caller can
// tell the user the refine was rejected. Otherwise return the refined unchanged.
// Pure + exported for unit tests.
// A cite arriving AFTER its draft (the normal order — the model is told to
// call render_cite AFTER mentioning the post in chat text) backfills the
// draft's source_url server-side and RE-SENDS that same artifact id so the
// live client picks up the "Source post" chip. Without a replace-by-id check,
// the plain-append path in the SSE artifact handler would have shipped a
// SECOND copy of the same draft (as a "new" artifact with the same id landing
// twice in the array) instead of updating the one already on screen.
// Pure + exported for unit tests.
export const REFINE_MIN_ORIGINAL_CHARS = 500; // only guard a substantial post
export const REFINE_GUT_RATIO = 0.35; // below this fraction of the original …
export const REFINE_GUT_ABS_CHARS = 400; // … AND below this absolute length → gutted
export function guardRefineCollapse(
  originalBody: string,
  refinedBody: string,
): { body: string; collapsed: boolean } {
  const orig = splitHook(originalBody);
  const origLen = originalBody.trim().length;
  const refinedTrim = refinedBody.trim();
  const refinedLen = refinedTrim.length;
  const refinedHasBody = /\n[ \t]*\n/.test(refinedTrim); // a blank-line break

  // A. Lone-hook collapse (original was multi-paragraph → refined is ~just the
  // opener). Independent of the size gate below so a shorter multi-paragraph
  // original that collapses to its hook is still caught.
  const loneHook =
    orig.rest.trim().length > 0 &&
    !refinedHasBody &&
    refinedLen <= origLen * 0.45 &&
    refinedLen <= orig.hook.trim().length * 1.4;

  // B. Gutted: a substantial post shrunk past BOTH the ratio and the absolute
  // floor. This is the 1,111→164 case (structured or not).
  const gutted =
    origLen >= REFINE_MIN_ORIGINAL_CHARS &&
    refinedLen <= origLen * REFINE_GUT_RATIO &&
    refinedLen <= REFINE_GUT_ABS_CHARS;

  const collapsed = loneHook || gutted;
  return collapsed
    ? { body: originalBody, collapsed: true }
    : { body: refinedBody, collapsed: false };
}

// Re-insert a deleted artifact back into a (possibly-changed) current list at
// its original index — the rollback for an optimistic delete that FAILED. We
// reconcile against current state instead of restoring a pre-delete snapshot,
// so an artifact that streamed in during the delete's network round-trip isn't
// erased. No-ops if the artifact is somehow already present (avoid duplicates);
// clamps the index to the current bounds. Pure + exported for unit tests.
export function reinsertArtifact(
  list: readonly Artifact[],
  at: number,
  art: Artifact,
): readonly Artifact[] {
  if (list.some((a) => a.id === art.id)) return list;
  const next = [...list];
  next.splice(Math.min(Math.max(at, 0), next.length), 0, art);
  return next;
}

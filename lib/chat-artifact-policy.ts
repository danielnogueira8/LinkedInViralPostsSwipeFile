import type { Artifact } from "@/lib/agent/contracts";
import type { AppliedLeadMagnet } from "@/lib/chat-hydration";
import type { PostMediaAttachment } from "@/lib/post-media";

export function kindNoun(kind: Artifact["kind"]): string {
  return kind === "hook" ? "Hook" : "Draft";
}

// Assign each artifact a display label numbered WITHIN its kind ("Hook 1",
// "Hook 2", "Draft 1"…), in creation order. The number is omitted when there's
// only one of that kind (a lone draft is just "Draft", matching the old single-
// draft behavior). Returns artifacts in creation order; caller reverses for
// newest-first display.
export function labelArtifacts(
  artifacts: Artifact[],
): { a: Artifact; label: string | undefined }[] {
  const totals = artifacts.reduce<Record<string, number>>((acc, a) => {
    acc[a.kind] = (acc[a.kind] ?? 0) + 1;
    return acc;
  }, {});
  const seq: Record<string, number> = {};
  return artifacts.map((a) => {
    seq[a.kind] = (seq[a.kind] ?? 0) + 1;
    const noun = kindNoun(a.kind);
    const label = totals[a.kind] > 1 ? `${noun} ${seq[a.kind]}` : noun;
    return { a, label };
  });
}

// Panel header noun: "Drafts", "Hooks", or "Drafts & Hooks" depending on the mix.
export function panelTitle(artifacts: Artifact[]): string {
  const hasPost = artifacts.some((a) => a.kind === "post");
  const hasHook = artifacts.some((a) => a.kind === "hook");
  if (hasPost && hasHook) return "Drafts & Hooks";
  if (hasHook) return "Hooks";
  return "Drafts";
}

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
  return {
    ...(id ? { id } : {}),
    title,
    selection: raw.selection === "manual" ? "manual" : "auto",
    publicSlug: typeof raw.public_slug === "string" ? raw.public_slug.trim() : null,
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

// Map skill slugs → their ids using the workspace's loaded skills. A slug that
// no longer resolves (skill deleted/renamed since the draft was made) is
// dropped, so a refine never sends a stale id. Pure + exported for tests.
export function skillNamesToIds(
  names: string[],
  skills: { id: string; name: string }[],
): string[] {
  const byName = new Map(skills.map((s) => [s.name, s.id]));
  return names.map((n) => byName.get(n)).filter((id): id is string => !!id);
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
  list: Artifact[],
  at: number,
  art: Artifact,
): Artifact[] {
  if (list.some((a) => a.id === art.id)) return list;
  const next = [...list];
  next.splice(Math.min(Math.max(at, 0), next.length), 0, art);
  return next;
}

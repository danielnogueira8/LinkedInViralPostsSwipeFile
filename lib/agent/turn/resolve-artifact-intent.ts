import type { Artifact, AskQuestion } from "@/lib/agent/contracts";
import { isExclusiveHookRefine } from "@/lib/agent/direct-refine-policy";
import {
  hasExplicitArtifactReference,
  resolveArtifactReference,
} from "@/lib/chat-artifact-policy";

const ARTIFACT_MUTATION_VERBS = String.raw`(?:rewrite|edit|change|update|refine|revise|modify|shorten|tighten|strengthen|improve|fix|polish|add|remove|cut|replace|reorder|restructure|make(?=\s+(?:it|this|the|draft|post|hook)\b)|turn(?=\s+(?:it|this|the|draft|post|hook)\b))`;
const ARTIFACT_MUTATION_RE = new RegExp(
  String.raw`\b${ARTIFACT_MUTATION_VERBS}\b`,
  "gi",
);
const MUTATION_CLAUSE_BOUNDARY_RE = /[,.!?;\n]|\b(?:but|then|plus)\b/gi;
const COORDINATION_BOUNDARY_RE = /\b(?:then|and|but|plus)\b/gi;
const MUTATION_NEGATION_RE =
  /\b(?:do\s+not|don(?:'|’)?t|dont|never|without)\b/i;
const MUTATION_ADVICE_PREFIX_RE =
  /\b(?:(?:how|what|why|whether)\s+(?:(?:can|could|should|would|do|might)\s+(?:i|we|you)|(?:i|we|you)\s+(?:can|could|should|would|might)|to)|ways?\s+to)\s*$/i;
const EXPLICIT_NEW_ARTIFACT_RE =
  /\b(?:(?:another|new|fresh|different|other)\s+(?:draft|post|version|hook|one|variation|angle|take)|(?:write|create|draft|generate|produce|give(?:\s+me)?|show(?:\s+me)?)\s+(?:an?\s+)?(?:alternative|variation)(?:\s+(?:draft|post|version|hook|one))?|(?:an?\s+)?(?:alternative|variation)\s+(?:draft|post|version|hook|one)|make\s+it\s+(?:an?\s+)?(?:[a-z-]+\s+)?(?:alternative|variation)|version\s+(?!(?:history|control)\b)(?:#?\d+|[a-z][a-z-]*)|v\d+|(?:\d+(?:st|nd|rd|th)|[a-z]+(?:st|nd|rd|th))\s+version|a\s+second\s+(?:draft|post|version|hook|one)|one\s+more\s+(?:draft|post|version|hook|one)|give\s+me\s+\d+\s+(?:drafts?|posts?|versions?|hooks?)|draft\s+\d+\s+more)\b/gi;
const REVIEW_IMPERATIVE_RE =
  /^\s*(?:please\s+)?(?:(?:review|critique|analy[sz]e|assess|evaluate|grade|rate|summari[sz]e)\b|give(?:\s+me)?\b[\s\S]{0,100}\b(?:feedback|critique|review|summary|assessment|analysis|strengths?|weaknesses?|takeaways?)\b|(?:tell\s+me|explain|list)\b[\s\S]{0,100}\b(?:feedback|strengths?|weaknesses?|issues?|problems?|works?|working|effective|land|resonate|why|how)\b)/i;
const DIRECT_MODAL_MUTATION_RE = new RegExp(
  String.raw`^\s*(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?${ARTIFACT_MUTATION_VERBS}\b`,
  "i",
);

export function explicitlyRequestsNewArtifact(message: string): boolean {
  for (const match of message.matchAll(new RegExp(EXPLICIT_NEW_ARTIFACT_RE.source, "gi"))) {
    const prefix = message.slice(0, match.index ?? 0);
    const boundaries = [
      ...prefix.matchAll(new RegExp(MUTATION_CLAUSE_BOUNDARY_RE.source, "gi")),
    ];
    const clauseStart = boundaries.at(-1);
    const clausePrefix = prefix.slice(
      clauseStart ? (clauseStart.index ?? 0) + clauseStart[0].length : 0,
    );
    if (MUTATION_ADVICE_PREFIX_RE.test(clausePrefix)) continue;
    if (!MUTATION_NEGATION_RE.test(clausePrefix)) return true;
  }
  return false;
}

function hasAffirmativeArtifactMutation(message: string): boolean {
  for (const match of message.matchAll(new RegExp(ARTIFACT_MUTATION_RE.source, "gi"))) {
    const prefix = message.slice(0, match.index ?? 0);
    const boundaries = [...prefix.matchAll(new RegExp(MUTATION_CLAUSE_BOUNDARY_RE.source, "gi"))];
    const clauseStart = boundaries.at(-1);
    const clausePrefix = prefix.slice(
      clauseStart ? (clauseStart.index ?? 0) + clauseStart[0].length : 0,
    );
    if (MUTATION_ADVICE_PREFIX_RE.test(clausePrefix)) continue;
    if (!MUTATION_NEGATION_RE.test(clausePrefix)) return true;
  }
  return false;
}

function affirmativeMutationAfterCoordination(message: string): string | null {
  const boundary = new RegExp(COORDINATION_BOUNDARY_RE.source, "i").exec(
    message,
  );
  if (!boundary) return null;
  // Keep the entire coordinated tail together. A later "and" can still be
  // governed by an earlier negation ("do not edit and rewrite it"); slicing at
  // every conjunction would discard that scope and turn a review into an edit.
  const suffix = message.slice((boundary.index ?? 0) + boundary[0].length);
  return hasAffirmativeArtifactMutation(suffix) ? suffix.trim() : null;
}

export function looksLikeArtifactReviewRequest(message: string): boolean {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) return false;
  const hasArtifactReferent =
    /\b(?:this|that|the|current|selected|latest)\s+(?:post(?:\s+artifact)?|draft|hook(?:\s+artifact)?|artifact|one)\b|\bit\b/i.test(
      trimmedMessage,
    ) || hasExplicitArtifactReference(trimmedMessage);
  const imperative = REVIEW_IMPERATIVE_RE.test(trimmedMessage);
  const evaluativeQuestion =
    /^\s*(?:what|why|how|is|are|does|do|would|should|can|could)\b/i.test(
      trimmedMessage,
    ) &&
    /\b(?:think|feedback|good|bad|strong|weak|work|effective|land|resonate|improve|issue|problem|summary|mean|argument|point)\b/i.test(
      trimmedMessage,
    );
  if (
    (imperative || evaluativeQuestion) &&
    affirmativeMutationAfterCoordination(trimmedMessage)
  ) {
    return false;
  }
  if (DIRECT_MODAL_MUTATION_RE.test(trimmedMessage)) return false;
  return hasArtifactReferent && (imperative || evaluativeQuestion);
}

export function looksLikeComposerRefine(message: string): boolean {
  const normalizedMessage = message.toLowerCase().trim();
  if (!normalizedMessage) return false;
  if (looksLikeArtifactReviewRequest(message)) return false;
  if (explicitlyRequestsNewArtifact(normalizedMessage)) {
    return false;
  }
  const hasMutationVerb = new RegExp(ARTIFACT_MUTATION_RE.source, "i").test(
    normalizedMessage,
  );
  const hasAffirmativeMutation =
    hasAffirmativeArtifactMutation(normalizedMessage);
  if (hasMutationVerb && !hasAffirmativeMutation) return false;
  return (
    hasAffirmativeMutation ||
    /\b(?:lengthen|punchier|simpler|stronger|sharper|crisper|tweak)\b/.test(
      normalizedMessage,
    )
  );
}

export type ResolvedFreeTextArtifactIntent =
  | {
      kind: "operation";
      operation:
        | {
            kind: "edit_artifact";
            artifactId: string;
            instruction: string;
            editMode?: "general" | "hook_only";
          }
        | {
            kind: "review_artifact";
            artifactId: string;
          };
    }
  | { kind: "clarification"; clarification: AskQuestion }
  | { kind: "none" };

function mutationClauseAfterReview(message: string): string {
  return affirmativeMutationAfterCoordination(message) ?? message;
}

/**
 * The single server-owned decision for free-text operations on conversation
 * Artifacts. It resolves identity through the shared Artifact index and fails
 * closed to clarification; callers may route non-Artifact turns normally.
 */
export function resolveFreeTextArtifactIntent(input: {
  message: string;
  artifacts: readonly Artifact[];
  selectedArtifactId: string | null;
}): ResolvedFreeTextArtifactIntent {
  if (explicitlyRequestsNewArtifact(input.message)) return { kind: "none" };
  const review = looksLikeArtifactReviewRequest(input.message);
  const edit = !review && looksLikeComposerRefine(input.message);
  if (!review && !edit) return { kind: "none" };

  const target = resolveArtifactReference(
    input.message,
    input.artifacts,
    input.selectedArtifactId,
  );
  if (target.kind !== "selected") {
    const reference =
      target.kind === "unresolved_explicit"
        ? target.reference
        : "the current Artifact";
    return {
      kind: "clarification",
      clarification: {
        question: `I couldn’t resolve ${reference} safely. Which Artifact should I ${edit ? "edit" : "review"}?`,
        options: edit
          ? ["Edit the latest post Artifact", "Choose a post or Hook Artifact"]
          : ["Review the latest post Artifact", "Choose a post or Hook Artifact"],
        allowOther: true,
      },
    };
  }

  if (review) {
    return {
      kind: "operation",
      operation: {
        kind: "review_artifact",
        artifactId: target.artifactId,
      },
    };
  }

  const targetArtifact = input.artifacts.find(
    (artifact) => artifact.id === target.artifactId,
  );
  const hookOnly =
    targetArtifact?.kind === "post" &&
    isExclusiveHookRefine(mutationClauseAfterReview(input.message));
  return {
    kind: "operation",
    operation: {
      kind: "edit_artifact",
      artifactId: target.artifactId,
      instruction: input.message,
      editMode: hookOnly ? "hook_only" : "general",
    },
  };
}

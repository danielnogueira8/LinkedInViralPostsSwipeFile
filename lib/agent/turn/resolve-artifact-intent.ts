import type { Artifact, AskQuestion } from "@/lib/agent/contracts";
import { isExclusiveHookRefine } from "@/lib/agent/direct-refine-policy";
import { resolveArtifactReference } from "@/lib/chat-artifact-policy";

const ARTIFACT_MUTATION_RE =
  /\b(?:rewrite|edit|change|update|refine|revise|modify|shorten|tighten|strengthen|improve|fix|polish|add|remove|cut|replace|reorder|restructure|make(?=\s+(?:it|this|the|draft|post|hook)\b)|turn(?=\s+(?:it|this|the|draft|post|hook)\b))\b/gi;
const MUTATION_CLAUSE_BOUNDARY_RE = /[.!?;\n]|\b(?:but|then|plus)\b/gi;
const MUTATION_NEGATION_RE =
  /\b(?:do\s+not|don(?:'|’)?t|dont|never|without)\b/i;
const EXPLICIT_NEW_ARTIFACT_RE =
  /\b(?:another|(?:new|fresh|different|other)\s+(?:draft|post|version)|another\s+version|alternative|variation|version\s+2|v2|a\s+second|one\s+more|give\s+me\s+\d+|draft\s+\d+\s+more)\b/i;

export function explicitlyRequestsNewArtifact(message: string): boolean {
  return EXPLICIT_NEW_ARTIFACT_RE.test(message);
}

function hasAffirmativeArtifactMutation(message: string): boolean {
  for (const match of message.matchAll(new RegExp(ARTIFACT_MUTATION_RE.source, "gi"))) {
    const prefix = message.slice(0, match.index ?? 0);
    const boundaries = [...prefix.matchAll(new RegExp(MUTATION_CLAUSE_BOUNDARY_RE.source, "gi"))];
    const clauseStart = boundaries.at(-1);
    const clausePrefix = prefix.slice(
      clauseStart ? (clauseStart.index ?? 0) + clauseStart[0].length : 0,
    );
    if (!MUTATION_NEGATION_RE.test(clausePrefix)) return true;
  }
  return false;
}

export function looksLikeArtifactReviewRequest(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  const compoundContinuation =
    /\b(?:review|critique|analy[sz]e|assess|evaluate)\b[\s\S]{0,160}?\b(?:then|and|but|plus)\b([\s\S]{0,120})/i.exec(
      t,
    )?.[1];
  if (compoundContinuation && hasAffirmativeArtifactMutation(compoundContinuation)) {
    return false;
  }
  const hasArtifactReferent =
    /\b(?:this|that|the|current|selected|latest)\s+(?:post|draft|hook|one)\b|\b(?:draft|hook)\s+#?\s*\d+\b|\bit\b/i.test(
      t,
    );
  const imperative =
    /^\s*(?:please\s+)?(?:review|critique|analy[sz]e|assess|evaluate|grade|rate|summari[sz]e|explain)\b/i.test(
      t,
    ) ||
    /^\s*(?:please\s+)?give(?:\s+me)?\b[\s\S]{0,100}\b(?:feedback|critique|review|summary|assessment|analysis|strengths?|weaknesses?|takeaways?)\b/i.test(
      t,
    ) ||
    /^\s*(?:please\s+)?(?:tell\s+me|explain|list)\b[\s\S]{0,100}\b(?:feedback|strengths?|weaknesses?|issues?|problems?|works?|working|effective|land|resonate|why|how)\b/i.test(
      t,
    );
  const evaluativeQuestion =
    /^\s*(?:what|why|how|is|are|does|do|would|should|can|could)\b/i.test(t) &&
    /\b(?:think|feedback|good|bad|strong|weak|work|effective|land|resonate|improve|issue|problem|summary|mean|argument|point)\b/i.test(
      t,
    );
  return hasArtifactReferent && (imperative || evaluativeQuestion);
}

export function looksLikeComposerRefine(message: string): boolean {
  const t = message.toLowerCase().trim();
  if (!t) return false;
  if (looksLikeArtifactReviewRequest(message)) return false;
  if (explicitlyRequestsNewArtifact(t)) {
    return false;
  }
  const hasMutationVerb = new RegExp(ARTIFACT_MUTATION_RE.source, "i").test(t);
  const hasAffirmativeMutation = hasAffirmativeArtifactMutation(t);
  if (hasMutationVerb && !hasAffirmativeMutation) return false;
  return (
    hasAffirmativeMutation ||
    /\b(?:lengthen|punchier|simpler|stronger|sharper|crisper|tweak)\b/.test(t)
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
  return (
    /\b(?:review|critique|analy[sz]e|assess|evaluate)\b[\s\S]{0,160}?\b(?:then|and|but|plus)\b([\s\S]{0,120})/i
      .exec(message)?.[1]
      ?.trim() || message
  );
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
          ? ["Edit the latest Draft", "Choose a Draft or Hook"]
          : ["Review the latest Draft", "Choose a Draft or Hook"],
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

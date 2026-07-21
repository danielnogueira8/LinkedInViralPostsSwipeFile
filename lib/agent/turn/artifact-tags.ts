import type { Artifact, PlanStep } from "@/lib/agent/contracts";
import type { NoModelFormatId } from "@/lib/agent/no-model-format-catalog";
import type { AppliedLeadMagnet } from "@/lib/chat-hydration";
import {
  computeStructureSkeleton,
  type StructureSkeleton,
} from "@/lib/post-structure-skeleton";
import type {
  ModelSourceReference,
  ModelSourceRow,
} from "@/lib/agent/turn/context";

// ---------------------------------------------------------------------------
// Artifact metadata tagging helpers.
//
// These helpers are used by the execution stream to decorate generated
// artifacts with the turn's active skills, no-model format, lead magnet,
// creator style, and source provenance. They live in their own module so
// `lib/agent/turn/execute.ts` can use them without creating an import cycle
// with `lib/agent/chat-turn.ts`, which re-exports them for existing callers.
// ---------------------------------------------------------------------------

export function withGeneratedImageMeta(
  artifact: Artifact,
  generatedImageMeta: Record<string, unknown>,
): Artifact {
  return {
    ...artifact,
    meta: {
      ...(artifact.meta ?? {}),
      generated_lead_magnet_image: generatedImageMeta,
    },
  };
}

// The raw skeleton (not the rendered prose block) for a genuine modeling
// source — same genre gate as modelSourceStructureBlock. Feeds the
// finalizer's coarse structure gate (DraftFinalizerOptions.structureSkeleton
// in lib/agent/draft-finalizer.ts): its mere presence scopes that gate to
// modeled-post turns only, so a refine/template source must yield undefined
// here, not just an empty prose block.
export function modelSourceStructureSkeleton(
  src: Pick<ModelSourceRow, "post_text" | "source">,
): StructureSkeleton | undefined {
  if (src.source === "draft" || src.source === "template") return undefined;
  const clean = src.post_text.trim();
  if (!clean) return undefined;
  return computeStructureSkeleton(clean);
}

export function tagArtifactWithModelSourceReference(
  artifact: Artifact,
  sourceRef: ModelSourceReference | null,
): Artifact {
  if (!sourceRef) return artifact;
  if (artifact.kind === "cite") return artifact;
  const meta = artifact.meta ?? {};
  const existingSourceId =
    typeof meta.source_post_id === "string" && meta.source_post_id.trim()
      ? meta.source_post_id
      : null;
  // A durable modeled batch already owns one canonical source per artifact.
  // Turn-level history may still contain an older attached source; that
  // convenience reference may fill missing provenance, but it must never
  // replace an artifact's explicit slot identity.
  if (existingSourceId && existingSourceId !== sourceRef.source_post_id) {
    return artifact;
  }
  return {
    ...artifact,
    meta: {
      ...meta,
      source: "model_source",
      source_post_id: sourceRef.source_post_id,
      ...(sourceRef.source_url ? { source_url: sourceRef.source_url } : {}),
    },
  };
}

export function sourceReferenceFromCiteArtifact(
  artifact: Artifact,
): ModelSourceReference | null {
  if (artifact.kind !== "cite") return null;
  const meta = artifact.meta as
    | {
        postId?: unknown;
        card?: { id?: unknown; postUrl?: unknown };
      }
    | undefined;
  const sourcePostId =
    typeof meta?.card?.id === "string"
      ? meta.card.id
      : typeof meta?.postId === "string"
        ? meta.postId
        : "";
  const sourceUrl =
    typeof meta?.card?.postUrl === "string" &&
    /^https?:\/\//i.test(meta.card.postUrl)
      ? meta.card.postUrl
      : null;
  if (!sourcePostId) return null;
  return { source_post_id: sourcePostId, source_url: sourceUrl };
}

export function sourceReferenceFromCiteArtifacts(
  citeArtifacts: Artifact[],
): ModelSourceReference | null {
  for (const artifact of citeArtifacts) {
    const sourceRef = sourceReferenceFromCiteArtifact(artifact);
    if (sourceRef) return sourceRef;
  }
  return null;
}

export function isDraftArtifact(artifact: Artifact): boolean {
  return artifact.kind === "post" || artifact.kind === "hook";
}

// Mutates `artifacts` in place (an already-streamed draft gets its source_url
// backfilled) AND returns the artifacts that actually changed, so the caller
// can re-send exactly those over the live SSE stream. Without that second
// half, a cite arriving AFTER its draft (the prompt's own instructed order —
// "call render_cite AFTER mentioning the post") patches the SERVER's copy but
// the browser — which already rendered the draft with no chip — never learns
// about the correction until a later page reload re-fetches from the DB.
export function applyCiteSourceToDraftArtifacts(
  artifacts: Artifact[],
  citeArtifacts: Artifact[],
): Artifact[] {
  const sourceRef = sourceReferenceFromCiteArtifacts(citeArtifacts);
  if (!sourceRef) return [];
  const updated: Artifact[] = [];
  for (let i = 0; i < artifacts.length; i++) {
    const artifact = artifacts[i];
    if (!isDraftArtifact(artifact)) continue;
    const currentMeta = artifact.meta as
      | { source_post_id?: unknown; source_url?: unknown }
      | undefined;
    const currentSourceId =
      typeof currentMeta?.source_post_id === "string"
        ? currentMeta.source_post_id
        : "";
    if (currentSourceId && currentSourceId !== sourceRef.source_post_id) {
      continue;
    }
    const currentUrl = currentMeta?.source_url;
    if (typeof currentUrl === "string" && currentUrl) continue;
    artifacts[i] = tagArtifactWithModelSourceReference(artifact, sourceRef);
    updated.push(artifacts[i]);
  }
  return updated;
}

// Stamp the turn's active custom-skill slugs onto a generated artifact's meta
// so the draft card can show "produced with /name" chips. Pure — exported so
// the contract (cite is never tagged; existing meta keys are preserved; no
// skills → passthrough) is unit-tested.
export function tagArtifactWithSkills(
  artifact: Artifact,
  skillNames: string[],
): Artifact {
  if (skillNames.length === 0) return artifact;
  if (artifact.kind === "cite") return artifact;
  return {
    ...artifact,
    meta: { ...(artifact.meta ?? {}), skills: skillNames },
  };
}

export function tagArtifactWithNoModelFormat(
  artifact: Artifact,
  format: { id: NoModelFormatId; label: string; forced: boolean } | null,
): Artifact {
  if (!format) return artifact;
  if (artifact.kind === "cite") return artifact;
  return {
    ...artifact,
    meta: {
      ...(artifact.meta ?? {}),
      no_model_format: format,
    },
  };
}

export function tagArtifactWithLeadMagnet(
  artifact: Artifact,
  leadMagnet: (AppliedLeadMagnet & { id: string }) | null,
): Artifact {
  if (!leadMagnet) return artifact;
  if (artifact.kind === "cite") return artifact;
  return {
    ...artifact,
    meta: {
      ...(artifact.meta ?? {}),
      lead_magnet: leadMagnet,
    },
  };
}

// Stamp the applied creator style onto a generated artifact's meta (not shown on
// cards in v1, but preserved for reload context + parity with the skill/format
// tags). Same contract: cite untagged, no style → passthrough, meta preserved.
export function tagArtifactWithCreatorStyle(
  artifact: Artifact,
  style: { id: string; name: string; creatorName: string } | null,
): Artifact {
  if (!style) return artifact;
  if (artifact.kind === "cite") return artifact;
  return {
    ...artifact,
    meta: {
      ...(artifact.meta ?? {}),
      creator_style: style,
    },
  };
}

const LEAD_MAGNET_IMAGE_PLAN_STEP_ID = "server_lead_magnet_image";
const LEAD_MAGNET_RESOURCE_PLAN_STEP_ID = "server_lead_magnet_resource";

export function withLeadMagnetImagePlanStep(
  steps: PlanStep[],
  status: PlanStep["status"],
): PlanStep[] {
  const imageStep: PlanStep = {
    id: LEAD_MAGNET_IMAGE_PLAN_STEP_ID,
    label: "Adapting the source image",
    status,
  };
  if (steps.length === 0) {
    return [
      {
        id: "server_draft_lead_magnet_post",
        // Synthetic already-completed step — reads in past tense next to its
        // green check, matching the done-side of the tool phrases.
        label: "Drafted the lead-magnet post",
        status: "done",
      },
      imageStep,
    ];
  }
  const existing = steps.findIndex(
    (step) => step.id === LEAD_MAGNET_IMAGE_PLAN_STEP_ID,
  );
  if (existing >= 0) {
    return steps.map((step, index) =>
      index === existing ? { ...step, status } : step,
    );
  }
  return [...steps, imageStep];
}

export function withLeadMagnetResourcePlanStep(
  steps: PlanStep[],
  status: PlanStep["status"],
): PlanStep[] {
  const resourceStep: PlanStep = {
    id: LEAD_MAGNET_RESOURCE_PLAN_STEP_ID,
    label: "Generating or matching the lead magnet resource",
    status,
  };
  if (steps.length === 0) {
    return [
      {
        id: "server_draft_lead_magnet_post",
        // Synthetic already-completed step — reads in past tense next to its
        // green check, matching the done-side of the tool phrases.
        label: "Drafted the lead-magnet post",
        status: "done",
      },
      resourceStep,
    ];
  }
  const existing = steps.findIndex(
    (step) => step.id === LEAD_MAGNET_RESOURCE_PLAN_STEP_ID,
  );
  if (existing >= 0) {
    return steps.map((step, index) =>
      index === existing ? { ...step, status } : step,
    );
  }
  return [...steps, resourceStep];
}

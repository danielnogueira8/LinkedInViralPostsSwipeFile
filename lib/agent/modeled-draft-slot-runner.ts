import type { AgentEvent, Artifact } from "@/lib/agent/contracts";
import {
  runDraftEngine,
  type DraftEngineInput,
} from "@/lib/agent/draft-engine";
import type {
  DraftFinalizerDecision,
  DraftFinalizerRejectionCode,
} from "@/lib/agent/finalize/finalizer";
import { RENDER_POST_MAX_CHARS } from "@/lib/agent/tools";
import { UsagePersistenceError } from "@/lib/openrouter";

export type ModeledDraftSlotIdentity = Readonly<{
  id: string;
  index: number;
}>;

export type CanonicalWorkspaceModelingSource = Readonly<{
  id: string;
  text: string;
  url?: string;
  title?: string;
  publishedAt?: string;
}>;

export type ModeledDraftBatchContext = Readonly<{
  count: number;
  previousBodies: readonly string[];
}>;

export type ModeledDraftSlotInput = Readonly<{
  slot: ModeledDraftSlotIdentity;
  source: CanonicalWorkspaceModelingSource;
  batch?: ModeledDraftBatchContext;
  engineInput: Omit<DraftEngineInput, "task">;
}>;

export type ModeledDraftSlotRunner = (
  input: DraftEngineInput,
) => AsyncGenerator<AgentEvent>;

export type ModeledDraftSlotDependencies = Readonly<{
  runDraftEngine: ModeledDraftSlotRunner;
}>;

export const MODELED_DRAFT_SLOT_REJECTION_CODES = [
  "empty",
  "corrupted",
  "truncated",
  "assistant_framing",
  "incomplete",
  "too_short",
  "character_range",
  "unsupported_specificity",
  "unsupported_claim",
  "provenance_missing",
  "provenance_unverified",
  "source_unavailable",
  "source_fidelity",
  "structure_mismatch",
  "duplicate",
  "domain_constraint",
  "artifact_invalid",
] as const satisfies readonly DraftFinalizerRejectionCode[];

export type ModeledDraftSlotRejectionCode =
  (typeof MODELED_DRAFT_SLOT_REJECTION_CODES)[number];

export const MODELED_DRAFT_SLOT_PROTOCOL_ERROR_CODES = [
  "missing_artifact",
  "multiple_artifacts",
  "artifact_with_error",
  "missing_terminal",
  "multiple_terminals",
  "mismatched_artifact_kind",
  "unexpected_terminal",
] as const;

export type ModeledDraftSlotProtocolErrorCode =
  (typeof MODELED_DRAFT_SLOT_PROTOCOL_ERROR_CODES)[number];

type OutcomeBase = {
  slot: ModeledDraftSlotIdentity;
  inputTokens: number;
  outputTokens: number;
};

export type ModeledDraftSlotOutcome =
  | (OutcomeBase & {
      kind: "accepted";
      artifact: Artifact & { kind: "post" };
    })
  | (OutcomeBase & {
      kind: "rejected";
      code: ModeledDraftSlotRejectionCode;
    })
  | (OutcomeBase & { kind: "reviewer_unavailable" })
  | (OutcomeBase & { kind: "writer_error" })
  | (OutcomeBase & { kind: "deadline" })
  | (OutcomeBase & { kind: "cancelled" })
  | (OutcomeBase & {
      kind: "protocol_error";
      code: ModeledDraftSlotProtocolErrorCode;
    });

const productionDependencies: ModeledDraftSlotDependencies = {
  runDraftEngine,
};

const MIN_MODELED_BATCH_COUNT = 2;
const MAX_MODELED_BATCH_COUNT = 6;
const rejectionCodes = new Set<string>(MODELED_DRAFT_SLOT_REJECTION_CODES);

type SourceTask = Extract<
  NonNullable<DraftEngineInput["task"]>,
  { kind: "source" }
>;

function validatedVariation(
  input: ModeledDraftSlotInput,
): SourceTask["variation"] {
  const validStandaloneSlot =
    Number.isInteger(input.slot.index) &&
    input.slot.index >= 0 &&
    input.slot.index < MAX_MODELED_BATCH_COUNT;

  if (!validStandaloneSlot) {
    throw new RangeError(
      `Invalid modeled draft slot index: expected a zero-based integer below ${MAX_MODELED_BATCH_COUNT}.`,
    );
  }

  if (!input.batch) return undefined;

  const { count, previousBodies } = input.batch;
  const validCount =
    Number.isInteger(count) &&
    count >= MIN_MODELED_BATCH_COUNT &&
    count <= MAX_MODELED_BATCH_COUNT;
  const validSlot =
    Number.isInteger(input.slot.index) &&
    input.slot.index >= 0 &&
    input.slot.index < count;
  const validPreviousBodyCount =
    Array.isArray(previousBodies) &&
    previousBodies.length <= MAX_MODELED_BATCH_COUNT - 1 &&
    previousBodies.length <= count - 1;
  const validPreviousBodies =
    validPreviousBodyCount &&
    previousBodies.every(
      (body) =>
        typeof body === "string" &&
        body.trim().length > 0 &&
        body.length <= RENDER_POST_MAX_CHARS,
    );
  const uniquePreviousBodies =
    validPreviousBodies &&
    new Set(previousBodies.map((body) => body.trim())).size ===
      previousBodies.length;

  if (
    !validCount ||
    !validSlot ||
    !validPreviousBodies ||
    !uniquePreviousBodies
  ) {
    throw new RangeError(
      `Invalid modeled draft batch context: count must be ${MIN_MODELED_BATCH_COUNT}-${MAX_MODELED_BATCH_COUNT}, the zero-based slot must be inside that count, and previousBodies must contain at most count - 1 unique bounded accepted posts.`,
    );
  }

  return {
    index: input.slot.index + 1,
    count,
    previousBodies: [...previousBodies],
  };
}

function isUsagePersistenceError(error: unknown): boolean {
  return (
    error instanceof UsagePersistenceError ||
    (error instanceof Error && error.name === "UsagePersistenceError")
  );
}

function isAllowlistedRejection(
  code: DraftFinalizerRejectionCode | undefined,
): code is ModeledDraftSlotRejectionCode {
  return typeof code === "string" && rejectionCodes.has(code);
}

function taggedArtifact(
  artifact: Artifact & { kind: "post" },
  slot: ModeledDraftSlotIdentity,
  source: CanonicalWorkspaceModelingSource,
): Artifact & { kind: "post" } {
  const canonicalMeta = { ...(artifact.meta ?? {}) };
  delete canonicalMeta.modeled_draft_slot_id;
  delete canonicalMeta.modeled_draft_slot_index;
  delete canonicalMeta.source;
  delete canonicalMeta.source_post_id;
  delete canonicalMeta.source_url;
  delete canonicalMeta.research_provenance;

  return {
    ...artifact,
    meta: {
      ...canonicalMeta,
      modeled_draft_slot_id: slot.id,
      modeled_draft_slot_index: slot.index,
      source: "model_source",
      source_post_id: source.id,
      ...(source.url ? { source_url: source.url } : {}),
      research_provenance: {
        route: "workspace_research",
        sources: [
          {
            id: source.id,
            kind: "workspace_post",
            ...(source.title ? { title: source.title } : {}),
            ...(source.url ? { url: source.url } : {}),
            ...(source.publishedAt
              ? { published_at: source.publishedAt }
              : {}),
          },
        ],
      },
    },
  };
}

export async function runModeledDraftSlot(
  input: ModeledDraftSlotInput,
  dependencies: Partial<ModeledDraftSlotDependencies> = {},
): Promise<ModeledDraftSlotOutcome> {
  const deps = { ...productionDependencies, ...dependencies };
  const variation = validatedVariation(input);
  const artifacts: Artifact[] = [];
  const terminals: Array<Extract<AgentEvent, { type: "done" }>> = [];
  const errors: Array<Extract<AgentEvent, { type: "error" }>> = [];
  let finalizerDecision: DraftFinalizerDecision | undefined;
  let streamFailed = false;
  const callerFinalizerDecision = input.engineInput.onFinalizerDecision;

  try {
    for await (const event of deps.runDraftEngine({
      ...input.engineInput,
      task: {
        kind: "source",
        source: { id: input.source.id, text: input.source.text },
        ...(variation ? { variation } : {}),
      },
      enableStructureGate: true,
      onFinalizerDecision: (decision) => {
        finalizerDecision = decision;
        callerFinalizerDecision?.(decision);
      },
    })) {
      if (event.type === "artifact") artifacts.push(event.artifact);
      else if (event.type === "done") terminals.push(event);
      else if (event.type === "error") errors.push(event);
    }
  } catch (error) {
    if (isUsagePersistenceError(error)) throw error;
    streamFailed = true;
  }

  const terminal = terminals[0];
  const usage = {
    inputTokens: terminal?.message.inputTokens ?? 0,
    outputTokens: terminal?.message.outputTokens ?? 0,
  };
  const protocol = (
    code: ModeledDraftSlotProtocolErrorCode,
  ): ModeledDraftSlotOutcome => ({
    kind: "protocol_error",
    slot: input.slot,
    code,
    ...usage,
  });

  if (streamFailed) {
    return { kind: "writer_error", slot: input.slot, ...usage };
  }
  if (terminals.length === 0) return protocol("missing_terminal");
  if (terminals.length > 1) return protocol("multiple_terminals");
  if (artifacts.length > 0 && errors.length > 0) {
    return protocol("artifact_with_error");
  }
  if (artifacts.length > 1) return protocol("multiple_artifacts");
  if (artifacts.length === 1 && artifacts[0].kind !== "post") {
    return protocol("mismatched_artifact_kind");
  }
  if (terminal.terminalReason === "deadline") {
    if (artifacts.length > 0) return protocol("unexpected_terminal");
    return { kind: "deadline", slot: input.slot, ...usage };
  }
  if (terminal.terminalReason === "cancelled") {
    if (artifacts.length > 0) return protocol("unexpected_terminal");
    return { kind: "cancelled", slot: input.slot, ...usage };
  }
  if (terminal.terminalReason === "ask") {
    return protocol("unexpected_terminal");
  }
  // Classify error-bearing streams by their error codes BEFORE the blanket
  // "error" terminal branch: the engine reports failed turns with an honest
  // terminalReason "error", and a finalizer-rejected candidate (retry the
  // slot) must stay distinguishable from an infrastructure failure
  // (writer_error).
  if (errors.length > 0) {
    const errorCodes = new Set(errors.map((error) => String(error.code ?? "")));
    const rejectionCode =
      finalizerDecision?.outcome === "rejected"
        ? finalizerDecision.rejectionCode
        : undefined;

    if (
      rejectionCode === "source_fidelity_unavailable" ||
      errorCodes.has("draft_engine_source_fidelity_unavailable")
    ) {
      return { kind: "reviewer_unavailable", slot: input.slot, ...usage };
    }
    if (rejectionCode === "cancelled") {
      return { kind: "cancelled", slot: input.slot, ...usage };
    }
    if (
      errorCodes.has("draft_engine_exhausted") &&
      isAllowlistedRejection(rejectionCode)
    ) {
      return {
        kind: "rejected",
        slot: input.slot,
        code: rejectionCode,
        ...usage,
      };
    }
    return { kind: "writer_error", slot: input.slot, ...usage };
  }
  if (terminal.terminalReason === "error") {
    if (artifacts.length > 0) return protocol("unexpected_terminal");
    return { kind: "writer_error", slot: input.slot, ...usage };
  }

  if (artifacts.length === 0) return protocol("missing_artifact");

  return {
    kind: "accepted",
    slot: input.slot,
    artifact: taggedArtifact(
      artifacts[0] as Artifact & { kind: "post" },
      input.slot,
      input.source,
    ),
    ...usage,
  };
}

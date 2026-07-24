// Shared preclaim routing resolver.
//
// This is the exact routing decision setupChatTurn computes BEFORE it claims a
// turn or persists a user message (formerly inline in setup.ts, ~lines
// 1142-1262). It is side-effect-free: pure functions + injected `now` /
// `explicitMessageDraftCount`, returning every value it used to reassign into
// setup's locals.
//
// It exists as its own module so BOTH the live turn (setupChatTurn) and the
// dry-run "confirm before generating" resolver call the SAME code — the
// read-back a user confirms can never describe one thing while the real turn
// does another, because there is only one implementation.
import {
  resolveGenerationConfig,
  type ResolvedGenerationConfig,
} from "@/lib/generation-config";
import {
  compileActionOrchestratorRoute,
  compileReadOnlyOrchestratorReserveRoute,
  resolveTurnContract,
  resolveTurnCount,
  type ActionOrchestratorRoute,
  type ReadOnlyOrchestratorRoute,
  type TurnContract,
} from "@/lib/agent/turn/compile";
import { continuationForModeledDraftRoute } from "@/lib/agent/modeled-draft-continuation";
import type { ModeledDraftBatchContinuation } from "@/lib/agent/modeled-draft-continuation";
import { compileModeledPostIntent } from "@/lib/agent/modeled-post-intent";
import { compileDirectPartialTextSpec } from "@/lib/agent/direct-deliverable-policy";
import {
  resolveComposerTaskContext,
  type ComposerStarterId,
  type ComposerTaskContext,
  type ComposerTaskSelection,
} from "@/lib/composer-task-context";
import {
  requestedBasePostCount,
  requestedExplicitBasePostCount,
} from "@/lib/agent/turn/context";
import type { GenerationConfigV1 } from "@/lib/generation-config";
import type { ChatTurnOperation } from "@/lib/agent/turn/operation-marker";

export type PreclaimRoutingInput = {
  /** The instruction the router reads (already resolved from the raw message). */
  preclaimInstruction: string;
  /**
   * Generation config resolved earlier in setup if present; when null the
   * resolver derives it from `requestedGenerationConfig` +
   * `explicitMessageDraftCount`, mirroring the original inline guard.
   */
  resolvedGenerationConfig: ResolvedGenerationConfig | null;
  requestedGenerationConfig: GenerationConfigV1 | null;
  generationConfigRestoredFromRetry: boolean;
  currentTurnOperation: ChatTurnOperation | null;
  composerStarterId: ComposerStarterId | undefined;
  modelSourceId: string | undefined;
  attachmentCount: number;
  hasLeadMagnetSelection: boolean;
  hasCreatorStyle: boolean;
  skipDecision: boolean;
  /** From hasUnsavedAssistantDraftReferent(recentMessageWindow) — precomputed by caller. */
  hasUnsavedDraftReferent: boolean;
  /** An action route already normalized upstream (retry/continuation); null otherwise. */
  normalizedActionRoute: ActionOrchestratorRoute | null;
  modeledBatchContinuation: ModeledDraftBatchContinuation | null;
  pendingAskOnly: boolean;
  clientTimezone: string | undefined;
  now: () => Date;
  explicitMessageDraftCount: (instruction: string) => number | null;
};

export type PreclaimRouting = {
  resolvedGenerationConfig: ResolvedGenerationConfig;
  hasAuthoritativeDraftCount: boolean;
  composerTaskSelection: ComposerTaskSelection;
  composerTaskContext: ComposerTaskContext;
  activeDraftCountOverride: number | undefined;
  /** = preclaimActionRoute; setup reassigns normalizedActionRoute to this. */
  normalizedActionRoute: ActionOrchestratorRoute | null;
  preclaimReadOnlyRoute: ReadOnlyOrchestratorRoute | null;
  preclaimModeledRoute: boolean;
  currentTurnModelSourceOwnership: "historical_continuation" | "server_selected";
  modeledBatchContractRequested: boolean;
  preclaimContractPlaceholder: TurnContract;
  preclaimPostDraftEstimate: number | null;
};

/**
 * Compute the full routing decision (mode, count, action/read-only route,
 * contract) from resolved turn inputs, with no side effects. Byte-for-byte the
 * former setup.ts inline block; see the module header for why it's shared.
 */
export function resolvePreclaimRouting(
  input: PreclaimRoutingInput,
): PreclaimRouting {
  const {
    preclaimInstruction,
    requestedGenerationConfig,
    generationConfigRestoredFromRetry,
    currentTurnOperation,
    composerStarterId,
    modelSourceId,
    attachmentCount,
    hasLeadMagnetSelection,
    hasCreatorStyle,
    skipDecision,
    hasUnsavedDraftReferent,
    modeledBatchContinuation,
    pendingAskOnly,
    clientTimezone,
    now,
    explicitMessageDraftCount,
  } = input;

  let resolvedGenerationConfig: ResolvedGenerationConfig =
    input.resolvedGenerationConfig ??
    resolveGenerationConfig({
      selected: requestedGenerationConfig,
      explicitMessageDraftCount: explicitMessageDraftCount(preclaimInstruction),
    });

  const preclaimPartialSpec = compileDirectPartialTextSpec(preclaimInstruction);
  const fallbackPreclaimPostCount = requestedBasePostCount(
    preclaimInstruction,
    Boolean(modelSourceId),
  );
  const hasAuthoritativeDraftCount =
    resolvedGenerationConfig.draftCountSource === "ui" ||
    generationConfigRestoredFromRetry;
  const composerTaskSelection: ComposerTaskSelection = {
    ...(currentTurnOperation?.kind === "create_post"
      ? { commandKind: "create" as const }
      : currentTurnOperation?.kind === "ask"
        ? { commandKind: "ask" as const }
        : currentTurnOperation?.kind === "edit_artifact"
          ? { commandKind: "edit" as const }
          : {}),
    ...(composerStarterId ? { starterId: composerStarterId } : {}),
    ...(hasAuthoritativeDraftCount
      ? { selectedDraftCount: resolvedGenerationConfig.draftCount }
      : {}),
    ...(modelSourceId ? { selectedSourceId: modelSourceId } : {}),
  };
  const composerTaskContext = resolveComposerTaskContext({
    ...composerTaskSelection,
    fallbackPostCount: fallbackPreclaimPostCount,
    explicitMessagePostCount: requestedExplicitBasePostCount(preclaimInstruction),
  });
  const preclaimBasePostCount =
    composerTaskContext.kind === "post"
      ? composerTaskContext.expectedDraftCount
      : null;
  const activeDraftCountOverride =
    hasAuthoritativeDraftCount && preclaimBasePostCount !== null
      ? resolvedGenerationConfig.draftCount
      : undefined;
  const preclaimRoutingInput = {
    userInstruction: preclaimInstruction,
    ...(activeDraftCountOverride
      ? { draftCountOverride: activeDraftCountOverride }
      : {}),
    isRefine: skipDecision,
    hasModelSource: Boolean(modelSourceId),
    hasAttachments: attachmentCount > 0,
    hasLeadMagnet: hasLeadMagnetSelection,
    hasCreatorStyle,
    composerTaskContext,
    hasUnsavedDraftReferent,
    clientTimezone,
  };
  const preclaimActionRoute = modeledBatchContinuation
    ? null
    : (input.normalizedActionRoute ??
      compileActionOrchestratorRoute(preclaimRoutingInput, now()));
  const preclaimReadOnlyRoute =
    modeledBatchContinuation?.route ??
    compileReadOnlyOrchestratorReserveRoute(preclaimRoutingInput);
  const preclaimModeledContinuation =
    continuationForModeledDraftRoute(preclaimReadOnlyRoute);
  const preclaimModeledRoute = Boolean(
    modeledBatchContinuation ||
      preclaimModeledContinuation ||
      (preclaimReadOnlyRoute &&
        compileModeledPostIntent(preclaimInstruction, {
          draftCountOverride: activeDraftCountOverride,
        }).kind !== "none"),
  );
  // Historical source recovery is reserved for an actual ask→answer
  // continuation. A completed writing turn cannot pin its source (or writer
  // lane) onto an unrelated later review, action, or question.
  const currentTurnModelSourceOwnership =
    pendingAskOnly && !currentTurnOperation && !skipDecision
      ? "historical_continuation"
      : "server_selected";
  const modeledBatchContractRequested = Boolean(preclaimModeledContinuation);
  const preclaimContractPlaceholder = resolveTurnContract({
    actionRoute: preclaimActionRoute,
    useActionOrchestrator: true,
    readOnlyRoute: preclaimReadOnlyRoute,
    useReadOnlyOrchestrator: true,
    hasPartialSpec: preclaimPartialSpec !== null,
    fallbackPostCount:
      preclaimBasePostCount !== null || skipDecision
        ? (activeDraftCountOverride ?? preclaimBasePostCount ?? 1)
        : null,
  });
  const preclaimPostDraftEstimate =
    preclaimContractPlaceholder.kind === "post"
      ? preclaimContractPlaceholder.expectedCount
      : null;
  if (
    preclaimPostDraftEstimate !== null &&
    preclaimPostDraftEstimate >= 1 &&
    !generationConfigRestoredFromRetry &&
    resolvedGenerationConfig.draftCountSource !== "ui"
  ) {
    const contractCount = resolveTurnCount({
      messageCount: preclaimPostDraftEstimate,
    });
    resolvedGenerationConfig = {
      ...resolvedGenerationConfig,
      draftCount: contractCount.count,
      draftCountSource:
        explicitMessageDraftCount(preclaimInstruction) !== null ||
        preclaimPostDraftEstimate !== 1
          ? "message"
          : "default",
    };
  }

  return {
    resolvedGenerationConfig,
    hasAuthoritativeDraftCount,
    composerTaskSelection,
    composerTaskContext,
    activeDraftCountOverride,
    normalizedActionRoute: preclaimActionRoute,
    preclaimReadOnlyRoute,
    preclaimModeledRoute,
    currentTurnModelSourceOwnership,
    modeledBatchContractRequested,
    preclaimContractPlaceholder,
    preclaimPostDraftEstimate,
  };
}

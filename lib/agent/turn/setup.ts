import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveGenerationConfig,
  type GenerationConfigV1,
  type ResolvedGenerationConfig,
} from "@/lib/generation-config";
import {
  INTERNAL_ERROR_MESSAGE,
  NoWorkspaceError,
} from "@/lib/workspace";
import {
  advanceActionOrchestratorClarification,
  compileActionOrchestratorRoute,
  compileReadOnlyOrchestratorReserveRoute,
  clarificationForAmbiguousContinuation,
  type ActionOrchestratorRoute,
} from "@/lib/agent/turn/compile";
import {
  resolveActionRetryRoot,
  type ActionRetryRepository,
} from "@/lib/agent/action-retry";
import {
  continuationForModeledDraftRoute,
  type ModeledDraftBatchContinuation,
} from "@/lib/agent/modeled-draft-continuation";
import { safeFilename } from "@/lib/agent/untrusted";
import { preflightUserPrompt } from "@/lib/agent/prompt-preflight";
import {
  hasPendingAskOnly,
  hasPendingActionAsk,
  hasUnsavedAssistantDraftReferent,
  validatePendingActionAnswer,
} from "@/lib/agent/turn-policy";
import {
  buildTurnContext,
  CREATOR_STYLE_CONTEXT_PERSISTENCE_ERROR,
  CREATOR_STYLE_RETRY_CONTEXT_VERSION,
  CREATOR_STYLE_SELECTION_REQUIRED_ERROR,
  CUSTOM_SKILL_RETRY_CONTEXT_VERSION,
  LEAD_MAGNET_SELECTION_REQUIRED_ERROR,
  requestedBasePostCount,
  requestedExplicitBasePostCount,
  type CreatorStyleRetryContext,
  type CustomSkillRetryContext,
  type FrozenCustomSkill,
  type ModelSourceReference,
  type ModelSourceRow,
} from "@/lib/agent/turn/context";
import {
  createCoworkTurnTelemetry,
  type CoworkTurnTelemetry,
} from "@/lib/agent/cowork-telemetry";
import {
  resolveTurnContract,
  resolveTurnCount,
  type TurnContract,
} from "@/lib/agent/turn/compile";
import {
  chatSetupDeadlines,
  createChatSetupDeadline,
  waitForChatSetup,
  type ChatSetupDeadline,
} from "@/lib/chat-stream-policy";
import { compileModeledPostIntent } from "@/lib/agent/modeled-post-intent";
import {
  compileDirectPartialTextSpec,
} from "@/lib/agent/direct-deliverable-policy";
import {
  composerStarterMarkerFromToolCalls,
  resolveComposerTaskContext,
  type ComposerStarterId,
  type ComposerTaskContext,
  type ComposerTaskSelection,
} from "@/lib/composer-task-context";
import { leadMagnetGenerateSchema } from "@/lib/lead-magnets";
import { requestsDurableOrAction } from "@/lib/agent/source-policy";
import {
  artifactSkillNames,
  buildArtifactIndex,
} from "@/lib/chat-artifact-policy";
import { resolveFreeTextArtifactIntent } from "@/lib/agent/turn/resolve-artifact-intent";
import { turnOperationToolCall } from "@/lib/agent/turn/operation-marker";
import { getSkillsByNames } from "@/lib/content-resource-operations";
import { SKILLS_PER_TURN_MAX } from "@/lib/custom-skills";
import { selectAllRows } from "@/lib/db-paginate";
import {
  chatContextPolicyToolCall,
  recoverLatestForcedNoModelFormatId,
  recoverLatestSelection,
  rowsAfterLatestContextClear,
  type ChatContextKind,
} from "@/lib/agent/turn/sticky-context";

import type { ContentFeedback } from "@/lib/content-feedback";
import type { ContentPreference } from "@/lib/preferences";
import type { RecentDraft } from "@/lib/recent-drafts";
import type { ChatMessage, ContentBlock, ToolCall } from "@/lib/openrouter";
import type { SourcePostImage } from "@/lib/lead-magnet-image-generation";
import type { AppliedLeadMagnet } from "@/lib/chat-hydration";
import { buildLeadMagnetCampaign } from "@/lib/lead-magnet-campaign";
import type { ToolResult } from "@/lib/agent/tools";
import type { NoModelFormat } from "@/lib/agent/no-model-formats";
import type { NoModelFormatId } from "@/lib/agent/no-model-format-catalog";
import type { Artifact, AskQuestion } from "@/lib/agent/contracts";

import type {
  ChatTurnDependencies,
  ChatTurnRequest,
  ChatTurnOperation,
  customSkillSelectionMarkerFromToolCalls,
  creatorStyleSelectionMarkerFromToolCalls,
  generationConfigSelectionMarkerFromToolCalls,
  modeledDraftBatchContinuationMarkerFromToolCalls,
  retryRootMarkerFromToolCalls,
  turnOperationMarkerFromToolCalls,
  isServerRecoverableToolCall,
  isRecentUnansweredUserMessage,
  explicitMessageDraftCount,
  jsonError,
} from "@/lib/agent/chat-turn";

/**
 * Turn setup extracted from executeChatTurn's pre-stream block
 * (PLAN-cowork-unification Phase 3, step 6).
 *
 * Everything that runs before the SSE stream is started — workspace/chat
 * resolution, request parsing, rate limits, duplicate guard, retry context,
 * claim, turn-context assembly, and user-row state writes — lives here so
 * executeChatTurn can focus on routing and execution.
 */

const CUSTOM_SKILL_CONTEXT_PERSISTENCE_ERROR =
  "I couldn’t save the selected custom-skill context safely, so no draft was created. Send the request again to retry.";
const GENERATION_CONFIG_CONTEXT_PERSISTENCE_ERROR =
  "I couldn’t save the draft-count setting safely, so no draft was created. Send the request again to retry.";
const TURN_OPERATION_CONTEXT_PERSISTENCE_ERROR =
  "I couldn’t save the turn operation safely, so the request was not executed. Send it again as a new message.";

type RecoverableMarker = {
  code: string | number;
  message: string;
  retryRootUserMessageId?: string;
  continuation?: ModeledDraftBatchContinuation;
};

export type TurnSetupDependencies = ChatTurnDependencies & {
  jsonError: typeof jsonError;
  logChatReject: (
    workspaceId: string,
    chatId: string,
    reason: string,
    status: number,
  ) => void;
  persistChatSetupFailure: (opts: {
    sb: SupabaseClient;
    chatId: string;
    workspaceId: string;
    content: string;
    recoverable?: RecoverableMarker;
  }) => Promise<void>;
  isRecentUnansweredUserMessage: typeof isRecentUnansweredUserMessage;
  isServerRecoverableToolCall: typeof isServerRecoverableToolCall;
  customSkillSelectionMarkerFromToolCalls: typeof customSkillSelectionMarkerFromToolCalls;
  creatorStyleSelectionMarkerFromToolCalls: typeof creatorStyleSelectionMarkerFromToolCalls;
  generationConfigSelectionMarkerFromToolCalls: typeof generationConfigSelectionMarkerFromToolCalls;
  modeledDraftBatchContinuationMarkerFromToolCalls: typeof modeledDraftBatchContinuationMarkerFromToolCalls;
  retryRootMarkerFromToolCalls: typeof retryRootMarkerFromToolCalls;
  turnOperationMarkerFromToolCalls: typeof turnOperationMarkerFromToolCalls;
  explicitMessageDraftCount: typeof explicitMessageDraftCount;
};

type Attachment = NonNullable<ChatTurnRequest["attachments"]>[number];

export type TurnSetupResult = {
  workspaceId: string;
  sbRaw: SupabaseClient;
  userText: string;
  currentTurnOperation: ChatTurnOperation | null;
  attachments: Attachment[];
  modelSourceId: string | undefined;
  skipDecision: boolean;
  refineTargetId: string | undefined;
  refineInstruction: string | undefined;
  trustedRefineTarget: Artifact | null;
  skillIds: string[];
  customSkillRetryContext: CustomSkillRetryContext | null;
  resolvedCustomSkills: FrozenCustomSkill[];
  forcedNoModelFormatId: NoModelFormatId | undefined;
  creatorStyleId: string | undefined;
  creatorStyleRetryContext: CreatorStyleRetryContext | null;
  leadMagnetId: string | undefined;
  createLeadMagnet: z.infer<typeof leadMagnetGenerateSchema> | undefined;
  requestedGenerationConfig: GenerationConfigV1 | null;
  resolvedGenerationConfig: ResolvedGenerationConfig | null;
  generationConfigRestoredFromRetry: boolean;
  activeDraftCountOverride: number | undefined;
  composerStarterId: ComposerStarterId | undefined;
  composerTaskContext: ComposerTaskContext | null;
  composerTaskSelection: ComposerTaskSelection;
  hasAuthoritativeDraftCount: boolean;
  hookOnly: boolean;
  hookOnlyOriginalBody: string | undefined;
  hasModelSource: boolean;
  customSkillBodies: string[];
  customSkillNames: string[];
  turnClaimed: boolean;
  turnCostOperationKey: string | null;
  claimedTurnStartedAt: string | null;
  claimedUserMessageId: string | null;
  actionTurnMessageId: string | null;
  resolvedActionInstruction: string | null;
  normalizedActionRoute: ActionOrchestratorRoute | null;
  confirmedActionTargetIds: string[];
  actionRetryRepository: ActionRetryRepository | null;
  persistedActionContinuation: boolean;
  pendingActionAsk: boolean;
  pendingAskOnly: boolean;
  fallthroughClarification: AskQuestion | null;
  modeledBatchContinuation: ModeledDraftBatchContinuation | null;
  modeledBatchContractRequested: boolean;
  currentTurnModelSourceOwnership: "historical_continuation" | "server_selected";
  setupDeadline: ChatSetupDeadline | null;
  setupSignal: AbortSignal;
  preclaimContractPlaceholder: TurnContract;
  preclaimPostDraftEstimate: number | null;
  postClarificationPostCount: number | null;
  coworkTelemetry: CoworkTurnTelemetry;
  history: ChatMessage[];
  effectiveUserInstruction: string;
  orchestratorAttachmentBlocks: ContentBlock[];
  currentModelSource: ModelSourceRow | null;
  modelSourceReference: ModelSourceReference | null;
  modelSourceImage: SourcePostImage | null;
  modelSourceImageSkipReason: string | null;
  modelSourceImageSourcePostId: string | null;
  citedSourceImage: SourcePostImage | null;
  citedSourceImageSkipReason: string | null;
  citedSourceImageSourcePostId: string | null;
  appliedNoModelFormat: {
    id: NoModelFormatId;
    label: string;
    forced: boolean;
  } | null;
  selectedNoModelFormat: NoModelFormat | null;
  leadMagnetBlock: string;
  appliedLeadMagnet: (AppliedLeadMagnet & { id: string }) | null;
  shouldAttachLeadMagnet: boolean;
  activeLeadMagnetCampaign: ReturnType<typeof buildLeadMagnetCampaign> | null;
  imageGenerationAuthor: { name: string | null } | null;
  creatorStyleBlock: string;
  appliedCreatorStyle: {
    id: string;
    name: string;
    creatorName: string;
  } | null;
  feedbackMemory: ContentFeedback[];
  postPerformanceBlock: string;
  preferences: ContentPreference[];
  priorPostDrafts: RecentDraft[];
  preloadedVoiceResult: ToolResult | null;
  structureMatch: import("@/lib/structure-match").StructureMatchResult | null;
  estimatedContractKind: () => TurnContract["kind"];
  turnError: (
    message: string,
    status: number,
    extraHeaders?: Record<string, string>,
  ) => Response;
  disarmSetupGuards: () => void;
};

export async function setupChatTurn(
  input: {
    chatId: string;
    userId: string;
    body: ChatTurnRequest;
    signal: AbortSignal;
  },
  deps: TurnSetupDependencies,
): Promise<TurnSetupResult | Response> {
  const { chatId, userId, body, signal } = input;

  // Resolve workspace + validate the chat up front (outside the stream) so auth
  // / not-found errors come back as normal JSON, not a half-open SSE stream.
  let workspaceId: string;
  let sbRaw: SupabaseClient;
  let userText: string;
  let currentTurnOperation: ChatTurnOperation | null = null;
  let attachments: Attachment[] = [];
  let modelSourceId: string | undefined;
  let currentModelSource: ModelSourceRow | null = null;
  let skipDecision = false;
  let refineTargetId: string | undefined;
  let refineInstruction: string | undefined;
  let trustedRefineTarget: Artifact | null = null;
  let canonicalConversationArtifacts: Artifact[] = [];
  let skillIds: string[] = [];
  let customSkillRetryContext: CustomSkillRetryContext | null = null;
  let resolvedCustomSkills: FrozenCustomSkill[] = [];
  let forcedNoModelFormatId: NoModelFormatId | undefined;
  let creatorStyleId: string | undefined;
  let creatorStyleRetryContext: CreatorStyleRetryContext | null = null;
  let leadMagnetId: string | undefined;
  let createLeadMagnet: z.infer<typeof leadMagnetGenerateSchema> | undefined;
  let requestedGenerationConfig: GenerationConfigV1 | null = null;
  let resolvedGenerationConfig: ResolvedGenerationConfig | null = null;
  let generationConfigRestoredFromRetry = false;
  let activeDraftCountOverride: number | undefined;
  let composerStarterId: ComposerStarterId | undefined;
  let composerTaskContext: ComposerTaskContext | null = null;
  let composerTaskSelection: ComposerTaskSelection = {};
  let hasAuthoritativeDraftCount = false;
  let hookOnly = false;
  let hookOnlyOriginalBody: string | undefined;
  let hasModelSource = false;
  let customSkillBodies: string[] = [];
  let customSkillNames: string[] = [];
  let turnClaimed = false;
  let turnCostOperationKey: string | null = null;
  let claimedTurnStartedAt: string | null = null;
  let claimedUserMessageId: string | null = null;
  let actionTurnMessageId: string | null = null;
  let resolvedActionInstruction: string | null = null;
  let normalizedActionRoute: ActionOrchestratorRoute | null = null;
  let confirmedActionTargetIds: string[] = [];
  let actionRetryRepository: ActionRetryRepository | null = null;
  let persistedActionContinuation = false;
  let pendingActionAsk = false;
  let pendingAskOnly = false;
  let fallthroughClarification: AskQuestion | null = null;
  let modeledBatchContinuation: ModeledDraftBatchContinuation | null = null;
  let modeledBatchContractRequested = false;
  let currentTurnModelSourceOwnership:
    | "historical_continuation"
    | "server_selected" = "historical_continuation";
  let setupDeadline: ChatSetupDeadline | null = null;
  let setupSignal: AbortSignal = signal;
  let preclaimContractPlaceholder: TurnContract = {
    kind: "answer",
    expectedCount: 1,
  };
  let preclaimPostDraftEstimate: number | null = null;
  let postClarificationPostCount: number | null = null;
  const estimatedContractKind = (): TurnContract["kind"] =>
    postClarificationPostCount !== null
      ? "post"
      : preclaimContractPlaceholder.kind;
  const applyTurnOperation = (operation: ChatTurnOperation | null) => {
    currentTurnOperation = operation;
    hookOnly = false;
    hookOnlyOriginalBody = undefined;
    if (!operation) return;
    skipDecision = operation.kind === "edit_artifact";
    refineTargetId =
      operation.kind === "edit_artifact" || operation.kind === "review_artifact"
        ? operation.artifactId
        : undefined;
    refineInstruction =
      operation.kind === "edit_artifact" ? operation.instruction : undefined;
    hookOnly =
      operation.kind === "edit_artifact" && operation.editMode === "hook_only";
  };
  let coworkTelemetry!: CoworkTurnTelemetry;
  const disarmSetupGuards = () => {
    setupDeadline?.stop();
  };
  const turnError = (
    message: string,
    status: number,
    extraHeaders?: Record<string, string>,
  ) => {
    if (status === 500) console.error("[api:chat-setup]", message);
    return deps.jsonError(status === 500 ? INTERNAL_ERROR_MESSAGE : message, status, {
      ...(extraHeaders ?? {}),
      ...(claimedUserMessageId
        ? { "X-User-Message-Id": claimedUserMessageId }
        : {}),
      ...(claimedTurnStartedAt
        ? { "X-Turn-Started-At": claimedTurnStartedAt }
        : {}),
    });
  };

  try {
    const sb = await deps.scopedSupabase();
    workspaceId = sb.workspaceId;
    sbRaw = sb.raw;
    userText = body.message;
    currentTurnOperation = body.operation ?? null;
    attachments = body.attachments ?? [];
    modelSourceId = body.modelSourceId;
    skipDecision = body.skipDecision ?? false;
    refineTargetId = body.refineTargetId;
    refineInstruction = body.refineInstruction;
    // A typed operation is authoritative. Legacy refine fields remain accepted
    // only when no typed operation is present; normalize their complete shape
    // into the same persisted operation so every client surface gets identical
    // target validation, skill inheritance, execution, and retry semantics.
    if (currentTurnOperation) {
      applyTurnOperation(currentTurnOperation);
    } else if (
      body.skipDecision === true &&
      body.refineTargetId &&
      body.refineInstruction
    ) {
      applyTurnOperation({
        kind: "edit_artifact",
        artifactId: body.refineTargetId,
        instruction: body.refineInstruction,
        ...(body.hookOnly ? { editMode: "hook_only" } : {}),
      });
    } else if (
      body.skipDecision === true ||
      body.refineTargetId ||
      body.refineInstruction ||
      body.hookOnly !== undefined ||
      body.hookOnlyOriginalBody !== undefined
    ) {
      return turnError("The legacy refine request is incomplete.", 400);
    }
    skillIds = body.skillIds ?? [];
    forcedNoModelFormatId = body.forcedNoModelFormatId;
    creatorStyleId = body.creatorStyleId;
    leadMagnetId = body.leadMagnetId;
    createLeadMagnet = body.createLeadMagnet;
    requestedGenerationConfig = body.generationConfig ?? null;
    composerStarterId = body.starterId;
    const { data: chat, error } = await sbRaw
      .from("chats")
      .select("id, title")
      .eq("id", chatId)
      .eq("workspace_id", workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!chat) {
      return turnError("Chat not found", 404);
    }
    const promptCheck = preflightUserPrompt(userText);
    if (!promptCheck.ok) {
      deps.logChatReject(
        workspaceId,
        chatId,
        `prompt_${promptCheck.reason}`,
        promptCheck.status,
      );
      return turnError(promptCheck.message, promptCheck.status);
    }

    const cost = await deps.checkChatRateLimit(workspaceId);
    if (!cost.ok) {
      deps.logChatReject(workspaceId, chatId, cost.reason ?? "cost_cap", 429);
      return turnError(
        cost.message,
        429,
        cost.retryAfterSec
          ? { "Retry-After": String(cost.retryAfterSec) }
          : undefined,
      );
    }

    const fileNote = attachments.length
      ? `\n\n📎 Attached: ${attachments.map((a) => safeFilename(a.filename)).join(", ")}`
      : "";
    const turnContent = userText + fileNote;

    const { data: recentMessages, error: recentMessagesError } = await sbRaw
      .from("chat_messages")
      .select(
        "id, role, content, created_at, tool_calls, artifacts, terminal_reason, user_stop_requested_at, applied_skills, no_model_format_id, creator_style_context, lead_magnet_id, composer_starter_id, generation_config, recoverable_error",
      )
      .eq("chat_id", chatId)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(64);
    if (recentMessagesError) throw recentMessagesError;
    const lastMsg = recentMessages?.[0];
    if (lastMsg?.role === "user") {
      if (deps.isRecentUnansweredUserMessage(lastMsg)) {
        deps.logChatReject(workspaceId, chatId, "duplicate_turn", 409);
        return turnError(
          "That message is already being processed — please wait for the reply before sending again.",
          409,
        );
      }
    }

    const actionLaneEnabled = deps.actionOrchestratorEnabledForWorkspace();
    actionRetryRepository = deps.createActionRetryRepository(sbRaw);
    const recentMessageWindow = (recentMessages ?? []) as Array<{
      id: string;
      role: ChatMessage["role"];
      tool_calls: ToolCall[] | null;
      artifacts: Artifact[] | null;
      terminal_reason:
        | "done"
        | "ask"
        | "cancelled"
        | "deadline"
        | "error"
        | null;
      user_stop_requested_at: string | null;
      applied_skills?: unknown;
      no_model_format_id?: string | null;
      creator_style_context?: unknown;
      lead_magnet_id?: string | null;
      composer_starter_id?: string | null;
      generation_config?: unknown;
      recoverable_error?: unknown;
    }>;
    // The database query is newest-first because pending/retry resolution needs
    // the most recent message at index 0. Draft and sticky-context helpers have
    // the opposite, explicit contract (oldest -> newest) and scan backward.
    // Passing the query result directly made them resolve the oldest draft or
    // selection in the window. Keep both orderings named at this boundary so a
    // caller cannot silently invert "latest" again.
    const chronologicalRecentMessageWindow = [...recentMessageWindow].reverse();
    canonicalConversationArtifacts = chronologicalRecentMessageWindow.flatMap(
      (message) => message.artifacts ?? [],
    );
    let canonicalArtifactHistoryLoaded = recentMessageWindow.length < 64;
    const ensureCanonicalConversationArtifacts = async (): Promise<Artifact[]> => {
      if (canonicalArtifactHistoryLoaded) return canonicalConversationArtifacts;
      const rows = await selectAllRows<{ artifacts: Artifact[] | null }>(() =>
        sbRaw
          .from("chat_messages")
          .select("artifacts")
          .eq("chat_id", chatId)
          .eq("workspace_id", workspaceId)
          .eq("role", "assistant")
          .order("created_at", { ascending: true })
          .abortSignal(setupSignal),
      );
      canonicalConversationArtifacts = rows.flatMap(
        (message) => message.artifacts ?? [],
      );
      canonicalArtifactHistoryLoaded = true;
      return canonicalConversationArtifacts;
    };
    pendingAskOnly = hasPendingAskOnly(recentMessageWindow);
    pendingActionAsk = hasPendingActionAsk(recentMessageWindow);
    const actionAnswer = validatePendingActionAnswer(
      recentMessageWindow,
      userText,
      body.actionSelectionIds,
    );
    if (!actionAnswer.ok) {
      return turnError(
        `Choose exactly ${actionAnswer.expected} saved drafts before continuing.`,
        400,
      );
    }
    let preclaimInstruction = userText;
    if (actionAnswer.cancelled && pendingActionAsk) {
      persistedActionContinuation = true;
      normalizedActionRoute = {
        kind: "no_action",
        noActionReason: "cancelled",
      };
      resolvedActionInstruction = userText;
    } else if (body.retryOfUserMessageId) {
      const retryUserIndex = recentMessageWindow.findIndex(
        (message) =>
          message.role === "user" &&
          message.id === body.retryOfUserMessageId,
      );
      const retryUser =
        retryUserIndex >= 0 ? recentMessageWindow[retryUserIndex] : undefined;
      const pairedTurnOperation =
        deps.turnOperationMarkerFromToolCalls(retryUser);
      if (pairedTurnOperation.kind === "invalid") {
        return turnError(
          "The saved turn operation failed its integrity check. Send the request again as a new message.",
          409,
        );
      }
      if (pairedTurnOperation.kind === "valid") {
        // Retry means exact replay. Restore the server-persisted operation even
        // if a newer client heuristic now points at another visible Artifact.
        applyTurnOperation(pairedTurnOperation.operation);
      }
      const pairedCustomSkillMarker =
        deps.customSkillSelectionMarkerFromToolCalls(retryUser);
      if (pairedCustomSkillMarker.kind === "invalid") {
        return turnError(
          "The saved custom-skill selection failed its integrity check. Send the request again as a new message.",
          409,
        );
      }
      if (pairedCustomSkillMarker.kind === "unfrozen") {
        return turnError(
          "That Retry does not contain frozen custom-skill context. Send the request again as a new message.",
          409,
        );
      }
      if (pairedCustomSkillMarker.kind === "valid") {
        const frozenSkillIds = pairedCustomSkillMarker.context.skills.map(
          (skill) => skill.id,
        );
        if (
          skillIds.length > 0 &&
          (skillIds.length !== frozenSkillIds.length ||
            skillIds.some((id, index) => id !== frozenSkillIds[index]))
        ) {
          return turnError(
            "That Retry no longer matches the custom skills used by the original task. Send a new request instead.",
            409,
          );
        }
        skillIds = frozenSkillIds;
        customSkillRetryContext = pairedCustomSkillMarker.context;
      } else if (skillIds.length > 0) {
        return turnError(
          "That Retry adds custom skills that were not part of the original task. Send it as a new request instead.",
          409,
        );
      }
      const pairedCreatorStyleMarker =
        deps.creatorStyleSelectionMarkerFromToolCalls(retryUser);
      if (pairedCreatorStyleMarker.kind === "invalid") {
        return turnError(
          "The saved creator-style selection failed its integrity check. Send the request again as a new message.",
          409,
        );
      }
      if (pairedCreatorStyleMarker.kind === "unfrozen") {
        return turnError(
          "That Retry does not contain a frozen creator-style context. Send the request again as a new message.",
          409,
        );
      }
      if (pairedCreatorStyleMarker.kind === "valid") {
        const frozenStyle = pairedCreatorStyleMarker.context;
        if (creatorStyleId && creatorStyleId !== frozenStyle.id) {
          return turnError(
            "That Retry no longer matches the creator style used by the original task. Send a new request instead.",
            409,
          );
        }
        creatorStyleId = frozenStyle.id;
        creatorStyleRetryContext = frozenStyle;
      } else if (creatorStyleId) {
        return turnError(
          "That Retry adds a creator style that was not part of the original task. Send it as a new request instead.",
          409,
        );
      }
      const pairedGenerationConfigMarker =
        deps.generationConfigSelectionMarkerFromToolCalls(retryUser);
      if (pairedGenerationConfigMarker.kind === "invalid") {
        return turnError(
          "The saved draft-count setting failed its integrity check. Send the request again as a new message.",
          409,
        );
      }
      if (pairedGenerationConfigMarker.kind === "valid") {
        if (
          requestedGenerationConfig &&
          requestedGenerationConfig.draftCount !==
            pairedGenerationConfigMarker.config.draftCount
        ) {
          return turnError(
            "That Retry no longer matches the draft count used by the original task. Send a new request instead.",
            409,
          );
        }
        resolvedGenerationConfig = pairedGenerationConfigMarker.config;
        generationConfigRestoredFromRetry = true;
      } else if (requestedGenerationConfig) {
        return turnError(
          "That Retry adds a draft-count setting that was not part of the original task. Send it as a new request instead.",
          409,
        );
      }
      const pairedStarterMarker = composerStarterMarkerFromToolCalls(
        retryUser,
      );
      if (pairedStarterMarker.kind === "invalid") {
        return turnError(
          "The saved starter context failed its integrity check. Send the request again as a new message.",
          409,
        );
      }
      if (pairedStarterMarker.kind === "valid") {
        if (
          composerStarterId &&
          composerStarterId !== pairedStarterMarker.starterId
        ) {
          return turnError(
            "That Retry no longer matches the starter used by the original task. Send a new request instead.",
            409,
          );
        }
        composerStarterId = pairedStarterMarker.starterId;
      } else if (composerStarterId) {
        return turnError(
          "That Retry adds a starter context that was not part of the original task. Send it as a new request instead.",
          409,
        );
      }
      const pairedAssistant =
        retryUserIndex >= 0
          ? recentMessageWindow
              .slice(0, retryUserIndex)
              .find((message) => message.role === "assistant")
          : undefined;
      const pairedModeledBatchMarker =
        deps.modeledDraftBatchContinuationMarkerFromToolCalls(pairedAssistant);
      const pairedRetryRootMarker = deps.retryRootMarkerFromToolCalls(
        pairedAssistant,
      );
      if (
        pairedModeledBatchMarker.kind === "invalid" ||
        pairedRetryRootMarker.kind === "invalid"
      ) {
        return turnError(
          "The saved modeled-set continuation failed its integrity check. Send the request again as a new message.",
          409,
        );
      }
      const retry = await resolveActionRetryRoot(
        {
          workspaceId,
          chatId,
          retryOfUserMessageId: body.retryOfUserMessageId,
          submittedContent: turnContent,
          pairedAssistantTerminalReason: pairedAssistant
            ? pairedAssistant.terminal_reason ?? "done"
            : null,
          pairedAssistantRecoverable: Boolean(
            pairedAssistant &&
              (pairedAssistant.recoverable_error !== undefined &&
              pairedAssistant.recoverable_error !== null
                ? true
                : pairedAssistant.tool_calls?.some(
                    deps.isServerRecoverableToolCall,
                  )),
          ),
          pairedAssistantRetryRootUserMessageId:
            pairedRetryRootMarker.kind === "valid"
              ? pairedRetryRootMarker.rootUserMessageId
              : undefined,
          pairedUserStopped: Boolean(retryUser?.user_stop_requested_at),
          signal: setupSignal,
        },
        actionRetryRepository,
      );
      if (!retry.ok) {
        if (retry.reason === "cancelled") {
          return turnError(
            "That stopped board action is permanently cancelled and cannot be resumed. Send a new request if you still want the change.",
            409,
          );
        }
        if (retry.reason === "completed") {
          return turnError(
            "That turn already completed successfully. Refresh the chat to see its result.",
            409,
          );
        }
        return turnError(
          "That Retry action is stale or no longer matches the original task. Send a new request instead.",
          409,
        );
      }
      actionTurnMessageId = retry.turnMessageId;
      resolvedActionInstruction = retry.effectiveInstruction;
      normalizedActionRoute = retry.route;
      persistedActionContinuation = Boolean(retry.route);
      modeledBatchContinuation =
        pairedModeledBatchMarker.kind === "valid"
          ? pairedModeledBatchMarker.continuation
          : null;
      confirmedActionTargetIds = retry.confirmedTargetIds;
      preclaimInstruction = retry.effectiveInstruction;
    } else if (pendingActionAsk) {
      persistedActionContinuation = true;
      const context = await actionRetryRepository.latestContext({
        workspaceId,
        chatId,
        signal: setupSignal,
      });
      if (!context?.route || context.cancelled) {
        return turnError(
          "That action clarification expired. Send the board request again.",
          409,
        );
      }
      resolvedActionInstruction = `${context.effectiveInstruction}\n\nClarification answer: ${userText}`;
      preclaimInstruction = resolvedActionInstruction;
      confirmedActionTargetIds = actionAnswer.selectedTargetIds ?? [];
      normalizedActionRoute =
        confirmedActionTargetIds.length > 0
          ? context.route
          : context.route.kind === "clarify_action"
            ? advanceActionOrchestratorClarification(
                context.route,
                userText,
                deps.now(),
                body.clientTimezone,
              )
            : context.route;
    }

    // Explicit chat-context inheritance: selections are current-turn-only by
    // default. A client may opt a specific context kind into inheritance; an
    // explicit clear marker prevents older selections from being revived later.
    // The persisted markers already carry the
    // fully-resolved payloads (applied_skills.retryContext.skills = full bodies;
    // creator_style_context.resolvedBlock), reused verbatim via the same parsers
    // the Retry path uses — no DB re-fetch. Scope/guards:
    //   • an explicit selection this turn always wins (only recover when empty),
    //   • inheritance must be named in contextPolicy for this turn,
    //   • not on retry / action-continuation turns (those own their context),
    //   • newest-first, first bearing row wins → the user's most recent choice,
    //     and a turn that changes/clears the selection supersedes older ones,
    //   • only frozen/valid markers are reused (a legacy names-only skill row or
    //     an unparseable style is skipped rather than half-applied).
    // Deliberately NOT the retry path's strict 409 guards: those protect a
    // durable batch rebind; a normal follow-up just inherits, and an explicit
    // new selection overrides.
    if (!body.retryOfUserMessageId && !persistedActionContinuation) {
      const inheritedContext = new Set(body.contextPolicy?.inherit ?? []);
      const clearedContext = new Set(body.contextPolicy?.clear ?? []);
      const inheritedRowsFor = (kind: ChatContextKind) =>
        inheritedContext.has(kind) && !clearedContext.has(kind)
          ? rowsAfterLatestContextClear(chronologicalRecentMessageWindow, kind)
          : null;

      const inheritedSkillRows = inheritedRowsFor("skills");
      if (skillIds.length === 0 && inheritedSkillRows) {
        const recovered = recoverLatestSelection(
          inheritedSkillRows,
          deps.customSkillSelectionMarkerFromToolCalls,
        );
        if (recovered) {
          skillIds = recovered.skills.map((skill) => skill.id);
          customSkillRetryContext = recovered;
        }
      }
      const inheritedCreatorStyleRows = inheritedRowsFor("creator_style");
      if (!creatorStyleId && inheritedCreatorStyleRows) {
        const recovered = recoverLatestSelection(
          inheritedCreatorStyleRows,
          deps.creatorStyleSelectionMarkerFromToolCalls,
        );
        if (recovered) {
          creatorStyleId = recovered.id;
          creatorStyleRetryContext = recovered;
        }
      }
      const inheritedPostFormatRows = inheritedRowsFor("post_format");
      if (!forcedNoModelFormatId && inheritedPostFormatRows) {
        forcedNoModelFormatId =
          recoverLatestForcedNoModelFormatId(inheritedPostFormatRows) ??
          undefined;
      }
    }

    // Deterministic action and ambiguity rules run before the model fallback.
    // The fallback classifier is useful only for true fallthroughs; letting it
    // reinterpret "Move this draft to Ready" as an edit grants the writer the
    // wrong authority, while letting it reinterpret "Another angle" guesses at
    // an intentionally ambiguous request.
    if (
      !currentTurnOperation &&
      !refineTargetId &&
      !modelSourceId &&
      !body.retryOfUserMessageId &&
      !persistedActionContinuation &&
      !pendingActionAsk &&
      requestsDurableOrAction(userText)
    ) {
      normalizedActionRoute ??= compileActionOrchestratorRoute(
        {
          userInstruction: userText,
          isRefine: false,
          hasModelSource: false,
          hasAttachments: attachments.length > 0,
          hasLeadMagnet: Boolean(leadMagnetId || createLeadMagnet),
          hasCreatorStyle: Boolean(creatorStyleId),
          hasUnsavedDraftReferent:
            hasUnsavedAssistantDraftReferent(recentMessageWindow),
          clientTimezone: body.clientTimezone,
        },
        deps.now(),
      );
    }
    if (
      !currentTurnOperation &&
      !refineTargetId &&
      !modelSourceId &&
      !body.retryOfUserMessageId &&
      !persistedActionContinuation &&
      !pendingActionAsk
    ) {
      fallthroughClarification ??=
        clarificationForAmbiguousContinuation(userText);
    }

    // Free-text Artifact intent has one owner: the server. The browser may
    // identify the visibly selected card as context, but only this compiler can
    // turn ordinary language into edit/review authority. It resolves labels
    // and identity through the same Artifact index the UI uses, persists the
    // resulting typed operation, and fails closed when the target is missing.
    // Explicit UI operations, retries, modeled turns, and actions already have
    // stronger contracts and therefore bypass this compiler.
    const implicitRefineGuardsPass =
      !refineTargetId &&
      !currentTurnOperation &&
      !modelSourceId &&
      !body.retryOfUserMessageId &&
      !persistedActionContinuation &&
      !pendingActionAsk &&
      !normalizedActionRoute &&
      !fallthroughClarification;
    if (implicitRefineGuardsPass) {
      const conversationArtifacts = await ensureCanonicalConversationArtifacts();
      const artifactIntent = resolveFreeTextArtifactIntent({
        message: userText,
        artifacts: conversationArtifacts,
        selectedArtifactId: body.selectedArtifactId ?? null,
      });
      if (artifactIntent.kind === "operation") {
        applyTurnOperation(artifactIntent.operation);
      } else if (artifactIntent.kind === "clarification") {
        fallthroughClarification = artifactIntent.clarification;
      }
    }

    // Every edit surface converges here after its operation is known. The
    // server validates identity against the complete transcript and inherits
    // the target's Custom Skills unless this turn explicitly selected others.
    if (refineTargetId) {
      await ensureCanonicalConversationArtifacts();
    }
    const editOperation =
      currentTurnOperation?.kind === "edit_artifact"
        ? currentTurnOperation
        : null;
    if (editOperation && skillIds.length === 0 && !customSkillRetryContext) {
      const target = buildArtifactIndex(canonicalConversationArtifacts).entries.find(
        (entry) => entry.artifactId === editOperation.artifactId,
      )?.artifact;
      const inheritedNames = target
        ? artifactSkillNames(target).slice(0, SKILLS_PER_TURN_MAX)
        : [];
      if (inheritedNames.length > 0) {
        const inheritedSkills = await getSkillsByNames({
          db: sbRaw,
          workspaceId,
          names: inheritedNames,
        });
        const idsByName = new Map(
          inheritedSkills.map((skill) => [skill.name, skill.id]),
        );
        skillIds = inheritedNames
          .map((name) => idsByName.get(name))
          .filter((id): id is string => Boolean(id));
      }
    }

    if (!resolvedGenerationConfig) {
      resolvedGenerationConfig = resolveGenerationConfig({
        selected: requestedGenerationConfig,
        explicitMessageDraftCount:
          deps.explicitMessageDraftCount(preclaimInstruction),
      });
    }
    const preclaimPartialSpec = compileDirectPartialTextSpec(
      preclaimInstruction,
    );
    const fallbackPreclaimPostCount = requestedBasePostCount(
      preclaimInstruction,
      Boolean(modelSourceId),
    );
    hasAuthoritativeDraftCount =
      resolvedGenerationConfig.draftCountSource === "ui" ||
      generationConfigRestoredFromRetry;
    composerTaskSelection = {
      ...(composerStarterId ? { starterId: composerStarterId } : {}),
      ...(hasAuthoritativeDraftCount
        ? { selectedDraftCount: resolvedGenerationConfig.draftCount }
        : {}),
      ...(modelSourceId ? { selectedSourceId: modelSourceId } : {}),
    };
    composerTaskContext = resolveComposerTaskContext({
      ...composerTaskSelection,
      fallbackPostCount: fallbackPreclaimPostCount,
      explicitMessagePostCount: requestedExplicitBasePostCount(
        preclaimInstruction,
      ),
    });
    const preclaimBasePostCount =
      composerTaskContext.kind === "post"
        ? composerTaskContext.expectedDraftCount
        : null;
    activeDraftCountOverride =
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
      hasAttachments: attachments.length > 0,
      hasLeadMagnet: Boolean(leadMagnetId || createLeadMagnet),
      hasCreatorStyle: Boolean(creatorStyleId),
      composerTaskContext,
      hasUnsavedDraftReferent:
        hasUnsavedAssistantDraftReferent(recentMessageWindow),
      clientTimezone: body.clientTimezone,
    };
    const preclaimActionRoute = modeledBatchContinuation
      ? null
      : normalizedActionRoute ??
        compileActionOrchestratorRoute(preclaimRoutingInput, deps.now());
    normalizedActionRoute = preclaimActionRoute;
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
    currentTurnModelSourceOwnership =
      pendingAskOnly && !currentTurnOperation && !skipDecision
        ? "historical_continuation"
        : "server_selected";
    modeledBatchContractRequested = Boolean(preclaimModeledContinuation);
    preclaimContractPlaceholder = resolveTurnContract({
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
    preclaimPostDraftEstimate =
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
          deps.explicitMessageDraftCount(preclaimInstruction) !== null ||
          preclaimPostDraftEstimate !== 1
            ? "message"
            : "default",
      };
    }
    const claim = await deps.claimChatTurn(workspaceId, chatId, turnContent, {
      clientTurnId: body.clientTurnId,
      readOnlyOrchestrator: Boolean(
        (preclaimActionRoute?.kind === "action_management" &&
          (actionLaneEnabled || persistedActionContinuation)) ||
          (pendingActionAsk && persistedActionContinuation) ||
          ((preclaimReadOnlyRoute || (pendingAskOnly && !pendingActionAsk)) &&
            (preclaimModeledRoute ||
              Boolean(
                continuationForModeledDraftRoute(preclaimReadOnlyRoute),
              ) ||
              deps.readOnlyOrchestratorEnabledForWorkspace())),
      ),
    });
    if (!claim.ok) {
      const status = claim.reason === "turn_active" ? 409 : 429;
      deps.logChatReject(
        workspaceId,
        chatId,
        claim.reason ?? "claim_failed",
        status,
      );
      return turnError(
        claim.message,
        status,
        claim.retryAfterSec
          ? { "Retry-After": String(claim.retryAfterSec) }
          : undefined,
      );
    }
    turnClaimed = true;
    turnCostOperationKey = claim.operationKey;
    coworkTelemetry = createCoworkTurnTelemetry(
      {
        traceId: chatId,
        workspaceId,
        route: "setup",
        requestedContract: preclaimContractPlaceholder,
      },
      deps.coworkTelemetrySink,
    );

    if (signal.aborted) {
      const message = "The chat request was cancelled before it started.";
      await deps.persistChatSetupFailure({
        sb: sbRaw,
        chatId,
        workspaceId,
        content: `⚠️ ${message}`,
      });
      await coworkTelemetry.finish({
        deliveredContract: {
          kind: estimatedContractKind(),
          deliveredCount: 0,
        },
        provenanceStatus: "not_required",
        terminalOutcome: "cancelled",
      });
      await deps.releaseChatTurn(workspaceId, chatId, turnCostOperationKey);
      turnClaimed = false;
      return turnError(message, 499);
    }
    const deadlines = chatSetupDeadlines({
      hasImageAttachment: attachments.some(
        (attachment) => attachment.kind === "image",
      ),
      createsLeadMagnet: Boolean(createLeadMagnet),
    });
    setupDeadline = createChatSetupDeadline(deadlines.serverMs);
    setupSignal = AbortSignal.any([signal, setupDeadline.signal]);

    const { data: claimedUserMessage, error: claimedUserMessageError } =
      await waitForChatSetup(
        sbRaw
          .from("chat_messages")
          .select("id")
          .eq("chat_id", chatId)
          .eq("workspace_id", workspaceId)
          .eq("role", "user")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        setupSignal,
      );
    if (claimedUserMessageError) throw claimedUserMessageError;
    if (typeof claimedUserMessage?.id !== "string") {
      throw new Error("The claimed chat message could not be identified.");
    }
    claimedUserMessageId = claimedUserMessage.id;
    coworkTelemetry.configure({ traceId: claimedUserMessageId });

    if (chat.title === "New chat") {
      const title = userText.replace(/\s+/g, " ").slice(0, 60).trim();
      if (title) {
        let titleUpdate = sbRaw
          .from("chats")
          .update({ title, updated_at: new Date().toISOString() })
          .eq("id", chatId)
          .eq("workspace_id", workspaceId)
          .eq("title", "New chat");
        if (turnCostOperationKey) {
          titleUpdate = titleUpdate.eq(
            "turn_cost_operation_key",
            turnCostOperationKey,
          );
        }
        await waitForChatSetup(titleUpdate, setupSignal);
      }
    }

    let clearCancel = sbRaw
      .from("chats")
      .update({ cancel_requested_at: null })
      .eq("id", chatId)
      .eq("workspace_id", workspaceId);
    if (turnCostOperationKey) {
      clearCancel = clearCancel.eq(
        "turn_cost_operation_key",
        turnCostOperationKey,
      );
    }
    const { data: claimedTurn, error: clearCancelError } =
      await waitForChatSetup(
        clearCancel.select("turn_started_at").maybeSingle(),
        setupSignal,
      );
    if (clearCancelError) throw clearCancelError;
    claimedTurnStartedAt =
      typeof claimedTurn?.turn_started_at === "string"
        ? claimedTurn.turn_started_at
        : null;
    if (!claimedTurnStartedAt) {
      throw new Error("The active chat turn could not be identified.");
    }
  } catch (e) {
    const setupExpired = setupDeadline?.didExpire() ?? false;
    const requestAborted = signal.aborted;
    disarmSetupGuards();
    if (turnClaimed) {
      const persistedMessage = setupExpired
        ? "Cowork took too long to prepare this turn. Please retry."
        : requestAborted
          ? "The chat request was cancelled before it started."
          : "Something went wrong starting this turn. Please try again.";
      await deps.persistChatSetupFailure({
        sb: sbRaw!,
        chatId,
        workspaceId: workspaceId!,
        content: `⚠️ ${persistedMessage}`,
        ...(setupExpired
          ? {
              recoverable: {
                code: "stream_stalled",
                message: persistedMessage,
              },
            }
          : {}),
      });
      await coworkTelemetry.finish({
        deliveredContract: {
          kind: estimatedContractKind(),
          deliveredCount: 0,
        },
        provenanceStatus: "not_required",
        terminalOutcome: setupExpired
          ? "recoverable_error"
          : requestAborted
            ? "cancelled"
            : "hard_failure",
      });
      await deps.releaseChatTurn(workspaceId!, chatId, turnCostOperationKey);
      turnClaimed = false;
    }
    if (e instanceof NoWorkspaceError) return turnError(e.message, 401);
    if (e instanceof z.ZodError) return turnError("Invalid request body", 400);
    if (setupExpired || requestAborted) {
      const message = setupExpired
        ? "Cowork took too long to prepare this turn. Please retry."
        : "The chat request was cancelled before it started.";
      return turnError(message, setupExpired ? 504 : 499);
    }
    return turnError((e as Error)?.message ?? "Unexpected error", 500);
  }

  let history: ChatMessage[];
  let effectiveUserInstruction = userText;
  const orchestratorAttachmentBlocks: ContentBlock[] = [];
  let appliedNoModelFormat: {
    id: NoModelFormatId;
    label: string;
    forced: boolean;
  } | null = null;
  let selectedNoModelFormat: NoModelFormat | null = null;
  let leadMagnetBlock = "";
  let appliedLeadMagnet: (AppliedLeadMagnet & { id: string }) | null = null;
  let shouldAttachLeadMagnet = false;
  let activeLeadMagnetCampaign: ReturnType<
    typeof buildLeadMagnetCampaign
  > | null = null;
  let modelSourceImage: SourcePostImage | null = null;
  let modelSourceImageSkipReason: string | null = null;
  let modelSourceImageSourcePostId: string | null = null;
  const citedSourceImage: SourcePostImage | null = null;
  const citedSourceImageSkipReason: string | null = null;
  const citedSourceImageSourcePostId: string | null = null;
  let modelSourceReference: ModelSourceReference | null = null;
  let imageGenerationAuthor: { name: string | null } | null = null;
  let creatorStyleBlock = "";
  let appliedCreatorStyle: {
    id: string;
    name: string;
    creatorName: string;
  } | null = null;
  let feedbackMemory: ContentFeedback[] = [];
  let postPerformanceBlock = "";
  let preferences: ContentPreference[] = [];
  let priorPostDrafts: RecentDraft[] = [];
  let preloadedVoiceResult: ToolResult | null = null;
  let structureMatch: import("@/lib/structure-match").StructureMatchResult | null = null;

  try {
    const turnContext = await buildTurnContext({
      sbRaw,
      workspaceId,
      chatId,
      userId,
      userText,
      attachments,
      modelSourceId,
      skipDecision,
      refineTargetId,
      refineInstruction,
      canonicalArtifacts: canonicalConversationArtifacts,
      leadMagnetId,
      createLeadMagnet,
      forcedNoModelFormatId,
      creatorStyleId,
      creatorStyleRetryContext,
      customSkillRetryContext,
      skillIds,
      composerTaskContext,
      composerTaskSelection,
      activeDraftCountOverride,
      resolvedGenerationConfig,
      hasAuthoritativeDraftCount,
      resolvedActionInstruction,
      currentTurnModelSourceOwnership,
      setupSignal,
      cancellationReason: () =>
        setupDeadline?.didExpire() ? "deadline" : "cancelled",
      coworkTelemetry,
      deps: {
        fetchRecentPostDrafts: deps.fetchRecentPostDrafts,
        generateLeadMagnetResource: deps.generateLeadMagnetResource,
        completeChat: deps.completeChat,
      },
    });
    history = turnContext.history;
    effectiveUserInstruction = turnContext.effectiveUserInstruction;
    orchestratorAttachmentBlocks.push(...turnContext.attachmentBlocks);
    trustedRefineTarget = turnContext.trustedRefineTarget;
    if (
      currentTurnOperation?.kind === "edit_artifact" &&
      currentTurnOperation.editMode === "hook_only" &&
      trustedRefineTarget?.kind === "post"
    ) {
      // The operation freezes only the edit mode and target identity. Re-read
      // the canonical body from this chat so retries never trust or replay a
      // stale client-provided body snapshot.
      hookOnlyOriginalBody = trustedRefineTarget.body;
    }
    currentModelSource = turnContext.currentModelSource;
    const currentModelEnvelope = turnContext.currentModelEnvelope;
    modelSourceReference = turnContext.modelSourceReference;
    modelSourceImage = turnContext.modelSourceImage;
    modelSourceImageSkipReason = turnContext.modelSourceImageSkipReason;
    modelSourceImageSourcePostId = turnContext.modelSourceImageSourcePostId;
    hasModelSource = turnContext.hasModelSource;
    composerTaskContext = turnContext.composerTaskContext;
    activeDraftCountOverride = turnContext.activeDraftCountOverride;
    postClarificationPostCount = turnContext.postClarificationPostCount;
    preloadedVoiceResult = turnContext.voiceResult;
    selectedNoModelFormat = turnContext.selectedNoModelFormat;
    appliedNoModelFormat = turnContext.appliedNoModelFormat;
    shouldAttachLeadMagnet = turnContext.shouldAttachLeadMagnet;
    leadMagnetBlock = turnContext.leadMagnetBlock;
    appliedLeadMagnet = turnContext.appliedLeadMagnet;
    activeLeadMagnetCampaign = turnContext.activeLeadMagnetCampaign;
    imageGenerationAuthor = turnContext.imageGenerationAuthor;
    creatorStyleBlock = turnContext.creatorStyleBlock;
    appliedCreatorStyle = turnContext.appliedCreatorStyle;
    feedbackMemory = turnContext.feedbackMemory;
    postPerformanceBlock = turnContext.postPerformanceBlock;
    preferences = turnContext.preferences;
    priorPostDrafts = turnContext.priorPostDrafts;
    resolvedCustomSkills = turnContext.resolvedCustomSkills;
    customSkillBodies = turnContext.customSkillBodies;
    customSkillNames = turnContext.customSkillNames;
    structureMatch = turnContext.structureMatch;

    const userColumnPatch: Record<string, unknown> = {};
    const currentTurnMarkers: ToolCall[] = [];
    if (currentTurnOperation) {
      currentTurnMarkers.push(turnOperationToolCall(currentTurnOperation));
    }
    if (body.contextPolicy) {
      currentTurnMarkers.push(chatContextPolicyToolCall(body.contextPolicy));
    }
    if (currentTurnMarkers.length > 0) {
      userColumnPatch.tool_calls = currentTurnMarkers;
    }
    if (modelSourceId && currentModelEnvelope) {
      userColumnPatch.model_source_id = modelSourceId;
    }
    if (customSkillNames.length > 0) {
      userColumnPatch.applied_skills = {
        names: customSkillNames,
        retryContext: {
          version: CUSTOM_SKILL_RETRY_CONTEXT_VERSION,
          skills: resolvedCustomSkills,
        },
      };
    }
    if (appliedNoModelFormat?.forced) {
      userColumnPatch.no_model_format_id = appliedNoModelFormat.id;
    }
    if (appliedCreatorStyle) {
      userColumnPatch.creator_style_context = {
        ...appliedCreatorStyle,
        retryContext: {
          version: CREATOR_STYLE_RETRY_CONTEXT_VERSION,
          resolvedBlock: creatorStyleBlock,
        },
      };
    }
    if (appliedLeadMagnet) {
      userColumnPatch.lead_magnet_id = appliedLeadMagnet.id;
    }
    if (composerStarterId) {
      userColumnPatch.composer_starter_id = composerStarterId;
    }
    const stampsGenerationConfig =
      resolvedGenerationConfig !== null &&
      (postClarificationPostCount !== null ||
        activeDraftCountOverride !== undefined ||
        skipDecision);
    if (stampsGenerationConfig && resolvedGenerationConfig) {
      userColumnPatch.generation_config = resolvedGenerationConfig;
    }
    let userStateWriteFailed = false;
    if (Object.keys(userColumnPatch).length > 0) {
      if (claimedUserMessageId) {
        const {
          data: updatedUserMessage,
          error: userStateWriteError,
        } = await waitForChatSetup(
          sbRaw
            .from("chat_messages")
            .update(userColumnPatch)
            .eq("id", claimedUserMessageId)
            .eq("workspace_id", workspaceId)
            .select("id")
            .maybeSingle(),
          setupSignal,
        );
        userStateWriteFailed =
          Boolean(userStateWriteError) ||
          updatedUserMessage?.id !== claimedUserMessageId;
      }
    }
    if (
      currentTurnOperation &&
      (!claimedUserMessageId || userStateWriteFailed)
    ) {
      throw new Error(TURN_OPERATION_CONTEXT_PERSISTENCE_ERROR);
    }
    if (
      appliedCreatorStyle &&
      (!claimedUserMessageId || userStateWriteFailed)
    ) {
      throw new Error(CREATOR_STYLE_CONTEXT_PERSISTENCE_ERROR);
    }
    if (
      modeledBatchContractRequested &&
      resolvedCustomSkills.length > 0 &&
      (!claimedUserMessageId || userStateWriteFailed)
    ) {
      throw new Error(CUSTOM_SKILL_CONTEXT_PERSISTENCE_ERROR);
    }
    if (
      stampsGenerationConfig &&
      (!claimedUserMessageId || userStateWriteFailed)
    ) {
      throw new Error(GENERATION_CONFIG_CONTEXT_PERSISTENCE_ERROR);
    }
    if (turnContext.attachmentBlocks.length > 0 && claimedUserMessageId) {
      try {
        await waitForChatSetup(
          sbRaw
            .from("chat_messages")
            .update({ content_blocks: turnContext.attachmentBlocks })
            .eq("id", claimedUserMessageId)
            .eq("workspace_id", workspaceId)
            .select("id")
            .maybeSingle(),
          setupSignal,
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            attachment_blocks_persistence_failed: {
              workspaceId,
              chatId,
              userMessageId: claimedUserMessageId,
              error: (error as Error)?.message ?? String(error),
            },
          }),
        );
      }
    }
  } catch (e) {
    const setupExpired = setupDeadline?.didExpire() ?? false;
    const requestAborted = signal.aborted;
    disarmSetupGuards();
    const setupError = setupExpired
      ? "Cowork took too long to prepare this turn. Please retry."
      : ((e as Error)?.message ?? "Failed to start the turn");
    const assistantError =
      setupError === LEAD_MAGNET_SELECTION_REQUIRED_ERROR ||
      setupError === CREATOR_STYLE_SELECTION_REQUIRED_ERROR ||
      setupError === CREATOR_STYLE_CONTEXT_PERSISTENCE_ERROR ||
      setupError === CUSTOM_SKILL_CONTEXT_PERSISTENCE_ERROR ||
      setupError === GENERATION_CONFIG_CONTEXT_PERSISTENCE_ERROR ||
      setupError === TURN_OPERATION_CONTEXT_PERSISTENCE_ERROR
        ? setupError
        : "⚠️ Something went wrong starting this turn. Please try again.";
    await deps.persistChatSetupFailure({
      sb: sbRaw,
      chatId,
      workspaceId,
      content: assistantError,
      ...(setupExpired
        ? {
            recoverable: {
              code: "stream_stalled",
              message: setupError,
            },
          }
        : {}),
    });
    await coworkTelemetry.finish({
      deliveredContract: {
        kind: estimatedContractKind(),
        deliveredCount: 0,
      },
      provenanceStatus: "not_required",
      terminalOutcome: setupExpired
        ? "recoverable_error"
        : requestAborted
          ? "cancelled"
          : "hard_failure",
    });
    await deps
      .releaseChatTurn(workspaceId, chatId, turnCostOperationKey)
      .catch(() => {});
    turnClaimed = false;
    return turnError(
      setupError,
      setupExpired
        ? 504
        : requestAborted
          ? 499
          : setupError === LEAD_MAGNET_SELECTION_REQUIRED_ERROR ||
              setupError === CREATOR_STYLE_SELECTION_REQUIRED_ERROR
            ? 409
            : setupError === CREATOR_STYLE_CONTEXT_PERSISTENCE_ERROR ||
                setupError === CUSTOM_SKILL_CONTEXT_PERSISTENCE_ERROR ||
                setupError === GENERATION_CONFIG_CONTEXT_PERSISTENCE_ERROR ||
                setupError === TURN_OPERATION_CONTEXT_PERSISTENCE_ERROR
              ? 503
              : 500,
    );
  }

  const setupExpired = setupDeadline?.didExpire() ?? false;
  disarmSetupGuards();
  if (setupExpired || signal.aborted) {
    const message = setupExpired
      ? "Cowork took too long to prepare this turn. Please retry."
      : "The chat request was cancelled before it started.";
    await deps.persistChatSetupFailure({
      sb: sbRaw,
      chatId,
      workspaceId,
      content: `⚠️ ${message}`,
      ...(setupExpired
        ? {
            recoverable: {
              code: "stream_stalled",
              message,
            },
          }
        : {}),
    });
    await coworkTelemetry.finish({
      deliveredContract: {
        kind: estimatedContractKind(),
        deliveredCount: 0,
      },
      provenanceStatus: "not_required",
      terminalOutcome: setupExpired ? "recoverable_error" : "cancelled",
    });
    await deps
      .releaseChatTurn(workspaceId, chatId, turnCostOperationKey)
      .catch(() => {});
    turnClaimed = false;
    return turnError(message, setupExpired ? 504 : 499);
  }

  return {
    workspaceId,
    sbRaw,
    userText,
    currentTurnOperation,
    attachments,
    modelSourceId,
    skipDecision,
    refineTargetId,
    refineInstruction,
    trustedRefineTarget,
    skillIds,
    customSkillRetryContext,
    resolvedCustomSkills,
    forcedNoModelFormatId,
    creatorStyleId,
    creatorStyleRetryContext,
    leadMagnetId,
    createLeadMagnet,
    requestedGenerationConfig,
    resolvedGenerationConfig,
    generationConfigRestoredFromRetry,
    activeDraftCountOverride,
    composerStarterId,
    composerTaskContext,
    composerTaskSelection,
    hasAuthoritativeDraftCount,
    hookOnly,
    hookOnlyOriginalBody,
    hasModelSource,
    customSkillBodies,
    customSkillNames,
    turnClaimed,
    turnCostOperationKey,
    claimedTurnStartedAt,
    claimedUserMessageId,
    actionTurnMessageId,
    resolvedActionInstruction,
    normalizedActionRoute,
    confirmedActionTargetIds,
    actionRetryRepository,
    persistedActionContinuation,
    pendingActionAsk,
    pendingAskOnly,
    fallthroughClarification,
    modeledBatchContinuation,
    modeledBatchContractRequested,
    currentTurnModelSourceOwnership,
    setupDeadline,
    setupSignal,
    preclaimContractPlaceholder,
    preclaimPostDraftEstimate,
    postClarificationPostCount,
    coworkTelemetry,
    history,
    effectiveUserInstruction,
    orchestratorAttachmentBlocks,
    currentModelSource,
    modelSourceReference,
    modelSourceImage,
    modelSourceImageSkipReason,
    modelSourceImageSourcePostId,
    citedSourceImage,
    citedSourceImageSkipReason,
    citedSourceImageSourcePostId,
    appliedNoModelFormat,
    selectedNoModelFormat,
    leadMagnetBlock,
    appliedLeadMagnet,
    shouldAttachLeadMagnet,
    activeLeadMagnetCampaign,
    imageGenerationAuthor,
    creatorStyleBlock,
    appliedCreatorStyle,
    feedbackMemory,
    postPerformanceBlock,
    preferences,
    priorPostDrafts,
    preloadedVoiceResult,
    structureMatch,
    estimatedContractKind,
    turnError,
    disarmSetupGuards,
  };
}

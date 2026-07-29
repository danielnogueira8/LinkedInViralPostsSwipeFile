import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  GenerationConfigV1,
  ResolvedGenerationConfig,
} from "@/lib/generation-config";
import type {
  CreatorStyleRetryContext,
  CustomSkillRetryContext,
  FrozenCustomSkill,
  ModelSourceReference,
  ModelSourceRow,
} from "@/lib/agent/turn/context";
import type { ModeledDraftBatchContinuation } from "@/lib/agent/modeled-draft-continuation";
import type { ActionRetryRepository } from "@/lib/agent/action-retry";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import type { ChatSetupDeadline } from "@/lib/chat-stream-policy";
import type {
  ComposerStarterId,
  ComposerTaskContext,
  ComposerTaskSelection,
} from "@/lib/composer-task-context";
import type { leadMagnetGenerateSchema } from "@/lib/lead-magnets";
import type { ContentFeedback } from "@/lib/content-feedback";
import type { ContentPreference } from "@/lib/preferences";
import type { RecentDraft } from "@/lib/recent-drafts";
import type { ChatMessage, ContentBlock } from "@/lib/openrouter";
import type { SourcePostImage } from "@/lib/lead-magnet-image-generation";
import type { AppliedLeadMagnet } from "@/lib/chat-hydration";
import type { buildLeadMagnetCampaign } from "@/lib/lead-magnet-campaign";
import type { ToolResult } from "@/lib/agent/tools";
import type { NoModelFormat } from "@/lib/agent/no-model-formats";
import type { NoModelFormatId } from "@/lib/agent/no-model-format-catalog";
import type { Artifact, AskQuestion } from "@/lib/agent/contracts";
import type { StructureMatchResult } from "@/lib/structure-match";
import type { AppliedWorkspaceKnowledge } from "@/lib/knowledge-sources/context";
import type { ChatTurnOperation } from "@/lib/agent/turn/operation-marker";
import type {
  ActionOrchestratorRoute,
  ChatTurnAttachment,
  TurnContract,
} from "@/lib/agent/turn/protocol";

/** Complete state produced once by setup; only the orchestrator owns this type. */
export type TurnSetupState = {
  workspaceId: string;
  sbRaw: SupabaseClient;
  userText: string;
  currentTurnOperation: ChatTurnOperation | null;
  attachments: ChatTurnAttachment[];
  modelSourceId: string | undefined;
  skipDecision: boolean;
  refineTargetId: string | undefined;
  refineInstruction: string | undefined;
  trustedRefineTarget: Artifact | null;
  existingArtifactIds: string[];
  skillIds: string[];
  customSkillRetryContext: CustomSkillRetryContext | null;
  resolvedCustomSkills: FrozenCustomSkill[];
  forcedNoModelFormatId: NoModelFormatId | undefined;
  creatorStyleId: string | undefined;
  workspaceKnowledge: AppliedWorkspaceKnowledge;
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
  artifactClarification: AskQuestion | null;
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
  workspaceLearningBlock: string;
  preferences: ContentPreference[];
  priorPostDrafts: RecentDraft[];
  preloadedVoiceResult: ToolResult | null;
  structureMatch: StructureMatchResult | null;
  estimatedContractKind: () => TurnContract["kind"];
  turnError: (
    message: string,
    status: number,
    extraHeaders?: Record<string, string>,
  ) => Response;
  disarmSetupGuards: () => void;
};

export type TurnCompileContext = Pick<
  TurnSetupState,
  | "workspaceId"
  | "sbRaw"
  | "attachments"
  | "modelSourceId"
  | "skipDecision"
  | "refineInstruction"
  | "trustedRefineTarget"
  | "existingArtifactIds"
  | "creatorStyleId"
  | "hasModelSource"
  | "turnCostOperationKey"
  | "claimedUserMessageId"
  | "actionTurnMessageId"
  | "normalizedActionRoute"
  | "confirmedActionTargetIds"
  | "actionRetryRepository"
  | "persistedActionContinuation"
  | "pendingAskOnly"
  | "artifactClarification"
  | "fallthroughClarification"
  | "modeledBatchContinuation"
  | "modeledBatchContractRequested"
  | "setupDeadline"
  | "setupSignal"
  | "postClarificationPostCount"
  | "coworkTelemetry"
  | "currentModelSource"
  | "modelSourceReference"
  | "effectiveUserInstruction"
  | "currentTurnOperation"
  | "composerTaskContext"
  | "activeDraftCountOverride"
  | "shouldAttachLeadMagnet"
  | "appliedLeadMagnet"
  | "activeLeadMagnetCampaign"
  | "leadMagnetBlock"
  | "creatorStyleBlock"
  | "preloadedVoiceResult"
  | "resolvedGenerationConfig"
  | "turnError"
  | "structureMatch"
>;

export type TurnExecuteContext = Pick<
  TurnSetupState,
  | "workspaceId"
  | "sbRaw"
  | "attachments"
  | "history"
  | "effectiveUserInstruction"
  | "orchestratorAttachmentBlocks"
  | "modelSourceImage"
  | "modelSourceImageSkipReason"
  | "modelSourceImageSourcePostId"
  | "citedSourceImage"
  | "citedSourceImageSkipReason"
  | "citedSourceImageSourcePostId"
  | "appliedNoModelFormat"
  | "selectedNoModelFormat"
  | "leadMagnetBlock"
  | "appliedLeadMagnet"
  | "shouldAttachLeadMagnet"
  | "activeLeadMagnetCampaign"
  | "creatorStyleBlock"
  | "appliedCreatorStyle"
  | "feedbackMemory"
  | "workspaceLearningBlock"
  | "preferences"
  | "priorPostDrafts"
  | "resolvedGenerationConfig"
  | "preloadedVoiceResult"
  | "claimedTurnStartedAt"
  | "claimedUserMessageId"
  | "actionTurnMessageId"
  | "confirmedActionTargetIds"
  | "coworkTelemetry"
  | "customSkillBodies"
  | "customSkillNames"
  | "skillIds"
  | "modelSourceId"
  | "workspaceKnowledge"
  | "structureMatch"
  | "imageGenerationAuthor"
  | "refineInstruction"
  | "hookOnly"
  | "hookOnlyOriginalBody"
  | "currentTurnOperation"
  | "trustedRefineTarget"
>;

export type TurnFinalizeContext = Pick<
  TurnSetupState,
  | "workspaceId"
  | "sbRaw"
  | "turnCostOperationKey"
  | "claimedTurnStartedAt"
  | "claimedUserMessageId"
  | "coworkTelemetry"
>;

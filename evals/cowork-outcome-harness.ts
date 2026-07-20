import {
  createChatStreamPost,
} from "@/app/api/chats/[id]/stream/route";
import {
  executeChatTurn,
  type ChatTurnDependencies,
  type ChatTurnRequest,
} from "@/lib/agent/chat-turn";
import type { Artifact } from "@/lib/agent/contracts";
import type { ChatTurnTerminal } from "@/lib/agent/chat-turn-lifecycle";
import {
  type CoworkRoute,
  type CoworkTurnTelemetryRecord,
} from "@/lib/agent/cowork-telemetry";
import {
  parseChatSseFrame,
  type ChatSseFrame,
} from "@/lib/transport/contracts";
import {
  ScriptedProviderSession,
  type ScriptedProviderScenario,
} from "@/evals/cowork-scripted-provider";
import {
  CoworkHarnessStore,
  type PersistedHarnessDraft,
  type PersistedHarnessMessage,
  type PersistedHarnessUsage,
} from "@/evals/cowork-harness-store";
import type { SourceFidelityVerdict } from "@/lib/agent/specialists/source-fidelity";
import { runDraftEngine } from "@/lib/agent/draft-engine";
import type { DraftEngineGroundedSource } from "@/lib/agent/draft-engine";
import type {
  DraftWriterAdapter,
  DraftWriterRequest,
  DraftWriterResponse,
} from "@/lib/agent/draft-writer";
import {
  logOpenRouterUsage,
  type Usage,
} from "@/lib/openrouter";
import {
  runReadOnlyOrchestrator,
  type ReadOnlyOrchestratorAdapter,
  type ReadOnlyPlannerRequest,
} from "@/lib/agent/read-only-orchestrator";
import {
  actionOperationKey,
  runActionOrchestrator,
  type ActionOrchestratorAdapter,
  type ActionPlannerRequest,
  type MutationAction,
} from "@/lib/agent/action-orchestrator";
import {
  compileActionOrchestratorRoute,
  compileReadOnlyOrchestratorRoute,
} from "@/lib/agent/turn/compile";
import { continuationForModeledDraftRoute } from "@/lib/agent/modeled-draft-continuation";
import { runTool as runAgentTool } from "@/lib/agent/tools";
import { AdapterHealthRegistry } from "@/lib/agent/adapter-health";
import {
  executeModeledDraftBatch,
  type AcquiredModeledDraftBatch,
  type ModeledDraftBatchRepository,
  type ModeledDraftBatchSource,
  type ModeledDraftSlotCheckpoint,
  type ModeledPostArtifact,
} from "@/lib/agent/modeled-draft-batch";
import { runModeledDraftSlot } from "@/lib/agent/modeled-draft-slot-runner";

export type CoworkOutcomeScenario = {
  id: string;
  request: ChatTurnRequest;
  retryLatestUser?: boolean;
  model: {
    provider: ScriptedProviderScenario;
    creatorStyleMarkerPersistenceFails?: boolean;
    creatorStyleMarkerTargetMissing?: boolean;
    sourceFidelity?: SourceFidelityVerdict[];
    directWriter?: Array<
      | DraftWriterResponse
      | { cancelViaDatabase: true; response?: DraftWriterResponse }
    >;
    readOnlyOrchestrator?: {
      plans: Array<{
        model: string;
        toolArgs: Record<string, unknown> | null;
        usage?: Usage;
      }>;
      toolResults?: Partial<
        Record<
          "search_news" | "search_viral_posts",
          Array<Record<string, unknown>>
        >
      >;
      attachmentSources?: DraftEngineGroundedSource[];
      retryModeledBatch?: boolean;
      malformedModeledRetry?: "root" | "continuation" | "root_only";
      disabled?: boolean;
      voiceUnavailable?: boolean;
      frozenModeledSources?: ModeledDraftBatchSource[];
      allowNoModel?: boolean;
      modeledBatchOutcome?: "busy";
    };
    actionOrchestrator?: {
      plans: Array<{
        model: string;
        toolArgs?: Record<string, unknown> | null;
        usage?: Usage;
        error?: string;
      }>;
      precommitFirstMutation?: boolean;
      retryEffectiveInstruction?: string;
      historicalIdenticalCheckpointBeforeRetry?: boolean;
      cancelAfterMutationCount?: number;
      allowNoModel?: boolean;
      failRetryContextSave?: boolean;
      disabled?: boolean;
    };
  };
  seed?: {
    customSkill?: {
      id: string;
      name: string;
      body: string;
    };
    creatorStyle?: {
      id: string;
      name: string;
      creatorName: string;
      promptBlock: string;
      status?: "ready" | "pending" | "failed";
    };
    messageArtifact?: Artifact;
    // A completed earlier user→assistant exchange, seeded before the scenario
    // request so the turn's history window has a prior conversation.
    priorTurn?: {
      user: string;
      assistant: string;
    };
    attachmentTurn?: {
      user: string;
      contentBlocks: PersistedHarnessMessage["content_blocks"];
      assistant: string;
    };
    bookmarkModelSource?: {
      id: string;
      sourcePostId: string;
      postText: string;
      postUrl: string;
    };
    historicalBookmarkModelSource?: {
      id: string;
      sourcePostId: string;
      postText: string;
      postUrl: string;
    };
    draft?: {
      id: string;
      title: string;
      body: string;
      status?: "idea" | "drafting" | "ready";
      meta?: Record<string, unknown>;
      mediaAttachments?: Artifact["media_attachments"];
    };
    drafts?: Array<{
      id: string;
      title: string;
      body: string;
      status?: "idea" | "drafting" | "ready";
      meta?: Record<string, unknown>;
      mediaAttachments?: Artifact["media_attachments"];
    }>;
    // Pre-seed the chat's pinned Cowork lane. Use this to assert that a turn
    // stays in a pinned lane even when its wording would normally route elsewhere.
    pinnedCoworkRoute?: CoworkRoute | null;
  };
  negativeControl?: {
    duplicatePersistedArtifact?: boolean;
  };
  expected: {
    terminal: ChatTurnTerminal;
    artifactBodies: string[];
    actionNames: string[];
    httpStatus?: number;
    assistantContents?: string[];
    sourcePostIds?: string[];
    sourceReferences?: Array<{ id: string; url: string }>;
    route?: CoworkRoute;
  };
};

export type CoworkOutcomeFailureCode =
  | "http_status"
  | "terminal"
  | "route"
  | "deliverable_count"
  | "draft_body"
  | "action_count"
  | "action_name"
  | "action_persistence"
  | "assistant_content"
  | "provenance"
  | "duplicate_artifact"
  | "duplicate_action"
  | "model_usage"
  | "transport_terminal"
  | "empty_turn";

export type CoworkObservedAction = {
  id: string;
  name: string;
  arguments: string;
  operationKey: string;
};

export type CoworkOutcomeReport = {
  pass: boolean;
  failureCodes: CoworkOutcomeFailureCode[];
  safe: {
    id: string;
    status: number;
    terminal: ChatTurnTerminal;
    messageCount: number;
    artifactCount: number;
    actionCount: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedInputTokens: number;
    fallbackUsed: boolean;
    latencyMs: number;
    costUsd: number;
    route: CoworkRoute;
    modelStages: Array<{ kind: string; model: string }>;
  };
  persisted: {
    messages: PersistedHarnessMessage[];
    artifacts: Artifact[];
    actions: CoworkObservedAction[];
    drafts: PersistedHarnessDraft[];
    usage: PersistedHarnessUsage[];
  };
  observed: {
    actions: CoworkObservedAction[];
    agentProviderRounds: number;
    directWriterRequests: DraftWriterRequest[];
    savedPostReads: number;
    readOnlyPlannerRequests: ReadOnlyPlannerRequest[];
    readOnlyTools: Array<{ name: string; args: Record<string, unknown> }>;
    modeledBatchOperationKeys: string[];
    actionPlannerRequests: ActionPlannerRequest[];
    actionTools: Array<{ name: string; args: Record<string, unknown> }>;
  };
  frames: ChatSseFrame[];
};

function parseFrames(raw: string): ChatSseFrame[] {
  const frames: ChatSseFrame[] = [];
  for (const record of raw.split("\n\n")) {
    const event = record
      .split("\n")
      .find((line) => line.startsWith("event: "))
      ?.slice("event: ".length);
    const dataText = record
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (!event || !dataText) continue;
    try {
      const frame = parseChatSseFrame(event, JSON.parse(dataText));
      if (frame) frames.push(frame);
    } catch {
      // Malformed transport is observable as a missing expected terminal frame.
    }
  }
  return frames;
}

function sameStrings(actual: readonly string[], expected: readonly string[]) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function duplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function duplicateOutcomeFailureCodes(input: {
  artifacts: readonly Artifact[];
  actions: readonly CoworkObservedAction[];
}): CoworkOutcomeFailureCode[] {
  const failureCodes: CoworkOutcomeFailureCode[] = [];
  if (
    duplicates(input.artifacts.map((artifact) => artifact.id)) ||
    duplicates(
      input.artifacts.map((artifact) => `${artifact.kind}:${artifact.body}`),
    )
  ) {
    failureCodes.push("duplicate_artifact");
  }
  if (duplicates(input.actions.map((action) => action.operationKey))) {
    failureCodes.push("duplicate_action");
  }
  return failureCodes;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function observedAction(input: {
  id: string;
  name: string;
  arguments?: string;
}): CoworkObservedAction {
  const argumentsText = input.arguments ?? "{}";
  let normalizedArguments = argumentsText;
  try {
    normalizedArguments = canonicalJson(JSON.parse(argumentsText));
  } catch {
    // Malformed arguments remain byte-comparable and fail the tool contract.
  }
  return {
    id: input.id,
    name: input.name,
    arguments: argumentsText,
    operationKey: `${input.name}:${normalizedArguments}`,
  };
}

class HarnessDraftWriter implements DraftWriterAdapter {
  readonly requests: DraftWriterRequest[] = [];

  constructor(
    private readonly responses: Array<
      | DraftWriterResponse
      | { cancelViaDatabase: true; response?: DraftWriterResponse }
    >,
    private readonly store: CoworkHarnessStore,
  ) {}

  async write(request: DraftWriterRequest): Promise<DraftWriterResponse> {
    this.requests.push(request);
    const step = this.responses.shift();
    if (!step) throw new Error("Direct-writer script exhausted.");
    if (!("cancelViaDatabase" in step)) return step;

    this.store.requestCancellation();
    if (step.response) return step.response;
    return await new Promise<DraftWriterResponse>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Stopped", "AbortError"));
      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

class HarnessReadOnlyPlanner implements ReadOnlyOrchestratorAdapter {
  readonly requests: ReadOnlyPlannerRequest[] = [];

  constructor(
    readonly model: string,
    private readonly response: {
      toolArgs: Record<string, unknown> | null;
      usage?: Usage;
    },
  ) {}

  async createPlan(request: ReadOnlyPlannerRequest) {
    this.requests.push(request);
    return this.response;
  }
}

class HarnessActionPlanner implements ActionOrchestratorAdapter {
  readonly requests: ActionPlannerRequest[] = [];

  constructor(
    readonly model: string,
    private readonly response: {
      toolArgs?: Record<string, unknown> | null;
      usage?: Usage;
      error?: string;
    },
  ) {}

  async createPlan(request: ActionPlannerRequest) {
    this.requests.push(request);
    if (this.response.error) throw new Error(this.response.error);
    return {
      toolArgs: this.response.toolArgs ?? null,
      usage: this.response.usage,
    };
  }
}

/**
 * Route-harness repository for the modeled-batch contract. PostgreSQL owns the
 * production implementation; this small in-memory adapter lets the authenticated
 * HTTP test exercise the same coordinator without making unit tests depend on a
 * database process.
 */
class HarnessModeledDraftBatchRepository
  implements ModeledDraftBatchRepository
{
  private checkpoint: AcquiredModeledDraftBatch | null = null;
  private leased = false;
  private completedArtifacts: readonly ModeledPostArtifact[] | null = null;
  private busyOnNextAcquire = false;

  constructor(
    private frozenSources: readonly ModeledDraftBatchSource[] = [],
  ) {}

  setFrozenSources(sources: readonly ModeledDraftBatchSource[] = []): void {
    if (!this.checkpoint && sources.length > 0) this.frozenSources = sources;
  }

  prepareBusyAcquire(): void {
    this.busyOnNextAcquire = true;
  }

  expireLease(): void {
    this.leased = false;
  }

  async acquire(
    input: Parameters<ModeledDraftBatchRepository["acquire"]>[0],
  ): ReturnType<ModeledDraftBatchRepository["acquire"]> {
    if (this.checkpoint) {
      if (
        this.checkpoint.requestHash !== input.requestHash ||
        this.checkpoint.requestedCount !== input.requestedCount
      ) {
        return { kind: "conflict" };
      }
      if (this.completedArtifacts) {
        return {
          kind: "complete",
          batchId: this.checkpoint.batchId,
          artifacts: this.completedArtifacts,
        };
      }
      if (this.leased || this.busyOnNextAcquire) {
        this.busyOnNextAcquire = false;
        this.leased = true;
        return { kind: "busy", batchId: this.checkpoint.batchId };
      }
      this.leased = true;
      return { kind: "acquired", checkpoint: this.checkpoint };
    }
    const sourcePool =
      input.sources.length > 0 ? input.sources : this.frozenSources;
    if (sourcePool.length < input.requestedCount) {
      return { kind: "insufficient_sources" };
    }
    const batchId = "00000000-0000-4000-8000-000000000701";
    this.checkpoint = {
      batchId,
      leaseToken: "00000000-0000-4000-8000-000000000702",
      requestHash: input.requestHash,
      requestedCount: input.requestedCount,
      sources: [...sourcePool],
      slots: Array.from({ length: input.requestedCount }, (_, index) => ({
        index,
        state: "assigned" as const,
        sourceIndex: index,
        sourceHistory: [index],
        replacements: 0,
      })),
    };
    this.leased = true;
    if (this.busyOnNextAcquire) {
      this.busyOnNextAcquire = false;
      return { kind: "busy", batchId };
    }
    return { kind: "acquired", checkpoint: this.checkpoint };
  }

  async acceptSlot(
    input: Parameters<ModeledDraftBatchRepository["acceptSlot"]>[0],
  ): Promise<boolean> {
    const checkpoint = this.checkpoint;
    const slot = checkpoint?.slots.find(
      (candidate) => candidate.index === input.slotIndex,
    );
    if (
      !checkpoint ||
      checkpoint.batchId !== input.batchId ||
      checkpoint.leaseToken !== input.leaseToken ||
      !slot ||
      slot.state !== "assigned" ||
      slot.sourceIndex !== input.sourceIndex
    ) {
      return false;
    }
    this.updateSlot(input.slotIndex, {
      ...slot,
      state: "accepted",
      artifact: input.artifact,
    });
    return true;
  }

  async replaceSlotSource(
    input: Parameters<ModeledDraftBatchRepository["replaceSlotSource"]>[0],
  ): Promise<boolean> {
    const checkpoint = this.checkpoint;
    const slot = checkpoint?.slots.find(
      (candidate) => candidate.index === input.slotIndex,
    );
    if (
      !checkpoint ||
      checkpoint.batchId !== input.batchId ||
      checkpoint.leaseToken !== input.leaseToken ||
      !slot ||
      slot.state !== "assigned" ||
      slot.replacements >= 1 ||
      checkpoint.slots.some((candidate) =>
        candidate.sourceHistory.includes(input.sourceIndex),
      )
    ) {
      return false;
    }
    this.updateSlot(input.slotIndex, {
      ...slot,
      sourceIndex: input.sourceIndex,
      sourceHistory: [...slot.sourceHistory, input.sourceIndex],
      replacements: slot.replacements + 1,
      lastFailureCode: input.failureCode,
    });
    return true;
  }

  async complete(
    input: Parameters<ModeledDraftBatchRepository["complete"]>[0],
  ): ReturnType<ModeledDraftBatchRepository["complete"]> {
    const checkpoint = this.checkpoint;
    if (
      !checkpoint ||
      checkpoint.batchId !== input.batchId ||
      checkpoint.leaseToken !== input.leaseToken
    ) {
      return { kind: "lease_lost" };
    }
    const artifacts = [...checkpoint.slots]
      .sort((left, right) => left.index - right.index)
      .flatMap((slot) =>
        slot.state === "accepted" && slot.artifact ? [slot.artifact] : [],
      );
    if (artifacts.length !== checkpoint.requestedCount) {
      return { kind: "incomplete" };
    }
    this.completedArtifacts = artifacts;
    this.leased = false;
    return { kind: "complete", artifacts };
  }

  async release(
    input: Parameters<ModeledDraftBatchRepository["release"]>[0],
  ): Promise<void> {
    if (
      this.checkpoint?.batchId === input.batchId &&
      this.checkpoint.leaseToken === input.leaseToken
    ) {
      this.leased = false;
    }
  }

  private updateSlot(
    slotIndex: number,
    next: ModeledDraftSlotCheckpoint,
  ): void {
    if (!this.checkpoint) return;
    this.checkpoint = {
      ...this.checkpoint,
      slots: this.checkpoint.slots.map((slot) =>
        slot.index === slotIndex ? next : slot,
      ),
    };
  }
}

async function runCoworkOutcomeScenarioWithStore(
  store: CoworkHarnessStore,
  scenario: CoworkOutcomeScenario,
  sharedModeledBatchRepository?: HarnessModeledDraftBatchRepository,
): Promise<CoworkOutcomeReport> {
  let terminalPromise: Promise<{ terminal: ChatTurnTerminal }> | null = null;
  const requestController = new AbortController();
  store.failCreatorStyleMarkerUpdate =
    scenario.model.creatorStyleMarkerPersistenceFails === true;
  store.missCreatorStyleMarkerUpdateTarget =
    scenario.model.creatorStyleMarkerTargetMissing === true;
  if (scenario.seed?.bookmarkModelSource) {
    store.seedBookmarkModelSource(scenario.seed.bookmarkModelSource);
  }
  if (scenario.seed?.historicalBookmarkModelSource) {
    store.seedHistoricalBookmarkModelSource(
      scenario.seed.historicalBookmarkModelSource,
    );
  }
  if (scenario.seed?.customSkill) {
    store.seedCustomSkill(scenario.seed.customSkill);
  }
  if (scenario.seed?.creatorStyle) {
    store.seedCreatorStyleProfile(scenario.seed.creatorStyle);
  }
  if (scenario.seed?.draft) {
    store.seedDraft(scenario.seed.draft);
  }
  for (const draft of scenario.seed?.drafts ?? []) {
    store.seedDraft(draft);
  }
  if (typeof scenario.seed?.pinnedCoworkRoute === "string") {
    store.seedPinnedCoworkRoute(scenario.seed.pinnedCoworkRoute);
  }
  if (scenario.seed?.messageArtifact) {
    store.seedMessageArtifact(scenario.seed.messageArtifact);
  }
  if (scenario.seed?.priorTurn) {
    store.seedConversationTurn(
      scenario.seed.priorTurn.user,
      scenario.seed.priorTurn.assistant,
    );
  }
  if (scenario.seed?.attachmentTurn) {
    store.seedAttachmentTurn(
      scenario.seed.attachmentTurn.user,
      scenario.seed.attachmentTurn.contentBlocks,
      scenario.seed.attachmentTurn.assistant,
    );
  }
  let requestBody = { ...scenario.request };
  if (scenario.retryLatestUser) {
    const latestUser = [...store.messages()]
      .reverse()
      .find((message) => message.role === "user");
    if (!latestUser) {
      throw new Error("Retry fixture requires a prior user message.");
    }
    requestBody = {
      ...requestBody,
      retryOfUserMessageId: latestUser.id,
    };
  }
  let retryRootId: string | null = null;
  const firstPlan = scenario.model.actionOrchestrator?.plans.find(
    (plan) => plan.toolArgs,
  )?.toolArgs;
  const firstAction = Array.isArray(firstPlan?.actions)
    ? (firstPlan.actions[0] as MutationAction | undefined)
    : undefined;
  if (
    scenario.model.actionOrchestrator?.historicalIdenticalCheckpointBeforeRetry &&
    firstAction
  ) {
    const historicalRootId = store.seedRetryableActionTurn(
      scenario.request.message,
    );
    const actionArguments =
      firstAction.type === "move_on_board"
        ? { id: firstAction.draftId, status: firstAction.status }
        : { id: firstAction.draftId, date: firstAction.date };
    store.seedCommittedActionCheckpoint({
      chatId: store.chatId,
      turnMessageId: historicalRootId,
      operationKey: actionOperationKey(historicalRootId, firstAction),
      actionType: firstAction.type,
      targetId: firstAction.draftId,
      arguments: actionArguments,
    });
    if (firstAction.type === "move_on_board") {
      store.resetDraftStatus(
        firstAction.draftId,
        scenario.seed?.draft?.status ?? "drafting",
      );
    }
    retryRootId = store.seedRetryableActionTurn(scenario.request.message);
    requestBody = { ...requestBody, retryOfUserMessageId: retryRootId };
  }
  if (scenario.model.actionOrchestrator?.retryEffectiveInstruction) {
    retryRootId = store.seedRetryableActionTurn(scenario.request.message);
    store.seedActionRetryContext({
      userMessageId: retryRootId,
      rootTurnMessageId: retryRootId,
      effectiveInstruction:
        scenario.model.actionOrchestrator.retryEffectiveInstruction,
      route: compileActionOrchestratorRoute({
        userInstruction:
          scenario.model.actionOrchestrator.retryEffectiveInstruction,
        isRefine: false,
        hasModelSource: false,
        hasAttachments: false,
        hasLeadMagnet: false,
        hasCreatorStyle: false,
      }) ?? { kind: "clarify_action", clarificationReason: "action" },
    });
    requestBody = { ...requestBody, retryOfUserMessageId: retryRootId };
  }
  if (scenario.model.actionOrchestrator?.precommitFirstMutation) {
    if (firstAction) {
      retryRootId ??= store.seedRetryableActionTurn(scenario.request.message);
      const actionArguments =
        firstAction.type === "move_on_board"
          ? { id: firstAction.draftId, status: firstAction.status }
          : { id: firstAction.draftId, date: firstAction.date };
      store.seedCommittedActionCheckpoint({
        chatId: store.chatId,
        turnMessageId: retryRootId,
        operationKey: actionOperationKey(retryRootId, firstAction),
        actionType: firstAction.type,
        targetId: firstAction.draftId,
        arguments: actionArguments,
      });
      requestBody = {
        ...requestBody,
        retryOfUserMessageId: retryRootId,
      };
    }
  }
  if (
    scenario.model.readOnlyOrchestrator?.retryModeledBatch ||
    scenario.model.readOnlyOrchestrator?.malformedModeledRetry
  ) {
    const route = compileReadOnlyOrchestratorRoute({
      userInstruction: scenario.request.message,
      isRefine: false,
      hasModelSource: false,
      hasAttachments: false,
      hasLeadMagnet: false,
      hasCreatorStyle: false,
    });
    const continuation = continuationForModeledDraftRoute(route);
    if (!continuation) {
      throw new Error("Modeled Retry fixture requires a one-to-one batch route.");
    }
    retryRootId = store.seedRetryableModeledTurn(
      scenario.request.message,
      continuation,
      scenario.model.readOnlyOrchestrator.malformedModeledRetry,
    );
    requestBody = { ...requestBody, retryOfUserMessageId: retryRootId };
  }
  const messageOffset = store.messages().length;
  const usageOffset = store.usages().length;
  const directWriter = scenario.model.directWriter
    ? new HarnessDraftWriter([...scenario.model.directWriter], store)
    : null;
  if (
    directWriter &&
    !scenario.model.readOnlyOrchestrator?.voiceUnavailable
  ) {
    store.seedVoiceProfile();
  }
  const readOnlyPlannerAdapters = (
    scenario.model.readOnlyOrchestrator?.plans ?? []
  ).map(
    (plan) =>
      new HarnessReadOnlyPlanner(plan.model, {
        toolArgs: plan.toolArgs,
        usage: plan.usage,
      }),
  );
  const readOnlyTools: Array<{
    name: string;
    args: Record<string, unknown>;
  }> = [];
  const modeledBatchOperationKeys: string[] = [];
  const readOnlyToolResults = Object.fromEntries(
    Object.entries(
      scenario.model.readOnlyOrchestrator?.toolResults ?? {},
    ).map(([name, results]) => [name, [...(results ?? [])]]),
  ) as Record<string, Array<Record<string, unknown>>>;
  const actionPlannerAdapters = (
    scenario.model.actionOrchestrator?.plans ?? []
  ).map(
    (plan) =>
      new HarnessActionPlanner(plan.model, {
        toolArgs: plan.toolArgs,
        usage: plan.usage,
        error: plan.error,
      }),
  );
  const actionTools: Array<{
    name: string;
    args: Record<string, unknown>;
  }> = [];
  let completedMutationCount = 0;
  store.onActionCheckpointExecuted = () => {
    completedMutationCount += 1;
    if (
      completedMutationCount ===
      scenario.model.actionOrchestrator?.cancelAfterMutationCount
    ) {
      store.requestActionCancellation();
    }
  };
  store.failActionRetryContextSave =
    scenario.model.actionOrchestrator?.failRetryContextSave === true;
  const providerSession = new ScriptedProviderSession(
    scenario.model.provider,
    () => requestController.abort(),
  );
  const sourceFidelity = [...(scenario.model.sourceFidelity ?? [])];
  const telemetryRecords: CoworkTurnTelemetryRecord[] = [];
  const draftAdapterHealth = new AdapterHealthRegistry();
  const modeledBatchRepository =
    sharedModeledBatchRepository ??
    new HarnessModeledDraftBatchRepository(
      scenario.model.readOnlyOrchestrator?.frozenModeledSources,
    );
  modeledBatchRepository.setFrozenSources(
    scenario.model.readOnlyOrchestrator?.frozenModeledSources,
  );
  const harnessRunDraftEngine: ChatTurnDependencies["runDraftEngine"] =
    directWriter
      ? (input) =>
          runDraftEngine(input, {
            writer: directWriter,
            recordUsage: logOpenRouterUsage,
            cancelPollMs: 1,
            adapterHealth: draftAdapterHealth,
          })
      : runDraftEngine;

  const dependencies: Partial<ChatTurnDependencies> = {
    now: () => new Date("2026-07-14T23:30:00.000Z"),
    scopedSupabase: (async () => ({
      workspaceId: store.workspaceId,
      raw: store.client,
    })) as unknown as ChatTurnDependencies["scopedSupabase"],
    checkChatRateLimit: async () => ({ ok: true }),
    claimChatTurn: async (_workspaceId, _chatId, content) =>
      store.claim(content),
    releaseChatTurn: async () => store.release(),
    completeChat: (async () => ({
      text: "",
      toolArgs: null,
      finishReason: "stop",
      usage: undefined,
      model: "openai/gpt-5.6-luna",
      citations: [],
    })) as ChatTurnDependencies["completeChat"],
    fetchRecentPostDrafts: async () => [],
    generateLeadMagnetResource: (async () => {
      throw new Error("Lead-magnet generation is not scripted for this scenario.");
    }) as ChatTurnDependencies["generateLeadMagnetResource"],
    coworkTelemetrySink: (record) => {
      telemetryRecords.push(record);
    },
    draftFinalizerSpecialists: {
      reviewSourceFidelity: async () =>
        sourceFidelity.shift() ?? { outcome: "verified" },
    },
    ...(directWriter
      ? {
          runDraftEngine: harnessRunDraftEngine,
        }
      : {}),
    ...(scenario.model.readOnlyOrchestrator
      ? {
          readOnlyOrchestratorEnabledForWorkspace: () =>
            !scenario.model.readOnlyOrchestrator?.disabled,
          runReadOnlyOrchestrator: (input, runtimeDependencies) =>
            runReadOnlyOrchestrator(input, {
              adapters: readOnlyPlannerAdapters,
              runTool: async (name, args) => {
                readOnlyTools.push({ name, args });
                const result = readOnlyToolResults[name]?.shift();
                return (
                  result ?? {
                    ok: false,
                    error: `No scripted ${name} result.`,
                  }
                );
              },
              runDraftEngine: harnessRunDraftEngine,
              executeModeledDraftBatch: async (input) => {
                modeledBatchOperationKeys.push(input.operationKey);
                if (
                  scenario.model.readOnlyOrchestrator?.modeledBatchOutcome ===
                  "busy"
                ) {
                  modeledBatchRepository.prepareBusyAcquire();
                } else {
                  modeledBatchRepository.expireLease();
                }
                return executeModeledDraftBatch(input, {
                  repository: modeledBatchRepository,
                  runSlot: (slotInput) =>
                    runModeledDraftSlot(slotInput, {
                      runDraftEngine: (engineInput) =>
                        harnessRunDraftEngine(engineInput),
                    }),
                  now: () => new Date("2026-07-14T12:00:00.000Z").getTime(),
                });
              },
              inspectAttachments: async () => ({
                sources:
                  scenario.model.readOnlyOrchestrator?.attachmentSources ?? [],
                attempts: [],
                complete: true,
              }),
              recordUsage: logOpenRouterUsage,
              now: () => new Date("2026-07-14T12:00:00.000Z"),
              ...runtimeDependencies,
            }),
        }
      : {
          readOnlyOrchestratorEnabledForWorkspace: () => false,
        }),
    ...(scenario.model.actionOrchestrator
      ? {
          actionOrchestratorEnabledForWorkspace: () =>
            !scenario.model.actionOrchestrator?.disabled,
          runActionOrchestrator: (input, runtimeDependencies) => {
            return runActionOrchestrator(input, {
              adapters: actionPlannerAdapters,
              runTool: async (name, args, workspaceId, toolSignal) => {
                actionTools.push({ name, args });
                return runAgentTool(
                  name,
                  args,
                  workspaceId,
                  toolSignal,
                );
              },
              recordUsage: logOpenRouterUsage,
              cancelPollMs: 1,
              ...runtimeDependencies,
            });
          },
        }
      : {
          actionOrchestratorEnabledForWorkspace: () => false,
        }),
  };

  const handler = createChatStreamPost({
    authenticate: async () => ({ userId: store.userId }),
    execute: (async (input) => {
      const result = await executeChatTurn(input, dependencies);
      if (!(result instanceof Response)) terminalPromise = result.terminal;
      return result;
    }) as typeof executeChatTurn,
  });

  const startedAt = performance.now();
  const { response, raw, terminal } = await store.run(() =>
    providerSession.run(async () => {
      const response = await handler(
        new Request(`http://test.local/api/chats/${store.chatId}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: requestController.signal,
        }),
        { params: Promise.resolve({ id: store.chatId }) },
      );
      const raw = await response.text();
      const settledTerminal = terminalPromise as Promise<{
        terminal: ChatTurnTerminal;
      }> | null;
      const terminal = settledTerminal
        ? (await settledTerminal).terminal
        : "failure";
      return { response, raw, terminal };
    }),
  );
  const latencyMs = Math.max(0, performance.now() - startedAt);
  if (scenario.negativeControl?.duplicatePersistedArtifact) {
    store.duplicateLastPersistedArtifact();
  }
  const messages = store.messages().slice(messageOffset);
  const assistantMessages = messages.filter(
    (message) => message.role === "assistant",
  );
  const artifacts = assistantMessages.flatMap(
    (message) => message.artifacts ?? [],
  );
  const frames = parseFrames(raw);
  const providerCallsById = new Map(
    providerSession.toolCallRecords().map((call) => [call.id, call]),
  );
  const streamedActions = frames
    .filter((frame) => frame.event === "tool_start")
    .map((frame) => {
      const providerCall = providerCallsById.get(frame.data.id);
      return observedAction(
        providerCall ?? {
          id: frame.data.id,
          name: frame.data.name,
          arguments:
            typeof frame.data.args === "string" ? frame.data.args : "{}",
        },
      );
    });
  const streamedActionIds = new Set(streamedActions.map((action) => action.id));
  const persistedOnlyActions = assistantMessages.flatMap((message) =>
    (message.tool_calls ?? [])
      .filter((call) => !streamedActionIds.has(call.id))
      .map((call) =>
        observedAction({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        }),
      ),
  );
  // The stream proves which normal actions were dispatched across all rounds;
  // the provider trace enriches those actions with exact arguments. Canonical
  // persistence adds intercepted/finalizer actions such as plans and ask_user.
  const actions = [...streamedActions, ...persistedOnlyActions].filter(
    (action) => !action.name.startsWith("_"),
  );
  const persistedActions = assistantMessages.flatMap((message) =>
    (message.tool_calls ?? []).map((call) =>
      observedAction({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }),
    ),
  );
  const persistedDomainActions = persistedActions.filter(
    (action) => !action.name.startsWith("_"),
  );
  const persistedToolMessageIds = messages.flatMap((message) =>
    message.role === "tool" && message.tool_call_id
      ? [message.tool_call_id]
      : [],
  );
  const usage = store.usages().slice(usageOffset);
  const assistantInputTokens = assistantMessages.reduce(
    (total, message) => total + (message.input_tokens ?? 0),
    0,
  );
  const assistantOutputTokens = assistantMessages.reduce(
    (total, message) => total + (message.output_tokens ?? 0),
    0,
  );
  const inputTokens = usage.reduce(
    (total, row) => total + row.input_tokens,
    0,
  );
  const outputTokens = usage.reduce(
    (total, row) => total + row.output_tokens,
    0,
  );
  const reasoningTokens = usage.reduce((total, row) => {
    const value = row.meta?.reasoning_tokens;
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
  const cachedInputTokens = usage.reduce((total, row) => {
    const value = row.meta?.cached_input_tokens;
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
  const fallbackUsed = usage.some((row) => row.meta?.stage === "fallback");
  const costUsd = Number(
    usage.reduce((total, row) => total + row.cost_usd, 0).toFixed(6),
  );
  const modelStages = usage.map(({ kind, model }) => ({ kind, model }));
  const route: CoworkRoute =
    telemetryRecords.at(-1)?.route ?? ("unknown" as CoworkRoute);
  const failureCodes: CoworkOutcomeFailureCode[] = [];
  if (response.status !== (scenario.expected.httpStatus ?? 200)) {
    failureCodes.push("http_status");
  }
  if (terminal !== scenario.expected.terminal) failureCodes.push("terminal");
  const actualArtifactBodies = artifacts.map((artifact) => artifact.body);
  if (artifacts.length !== scenario.expected.artifactBodies.length) {
    failureCodes.push("deliverable_count");
  } else if (!sameStrings(actualArtifactBodies, scenario.expected.artifactBodies)) {
    failureCodes.push("draft_body");
  }
  const actualActionNames = persistedDomainActions.map((action) => action.name);
  if (persistedDomainActions.length !== scenario.expected.actionNames.length) {
    failureCodes.push("action_count");
  } else if (!sameStrings(actualActionNames, scenario.expected.actionNames)) {
    failureCodes.push("action_name");
  }
  if (
    persistedDomainActions
      .some(
        (action) =>
          persistedToolMessageIds.filter((id) => id === action.id).length !== 1,
      ) ||
    persistedToolMessageIds.some(
      (id) => !persistedActions.some((action) => action.id === id),
    )
  ) {
    failureCodes.push("action_persistence");
  }
  if (scenario.expected.assistantContents) {
    const actualContents = assistantMessages.map((message) => message.content);
    if (!sameStrings(actualContents, scenario.expected.assistantContents)) {
      failureCodes.push("assistant_content");
    }
  }
  if (scenario.expected.sourcePostIds) {
    const sourcePostIds = artifacts.map((artifact) => {
      const value = artifact.meta?.source_post_id ?? artifact.meta?.sourcePostId;
      return typeof value === "string" ? value : "";
    });
    if (!sameStrings(sourcePostIds, scenario.expected.sourcePostIds)) {
      failureCodes.push("provenance");
    }
  }
  if (scenario.expected.sourceReferences) {
    const referencesAreCanonical = artifacts.every((artifact, index) => {
      const expected = scenario.expected.sourceReferences?.[index];
      if (!expected) return false;
      const meta = artifact.meta as
        | {
            source_post_id?: unknown;
            source_url?: unknown;
            research_provenance?: unknown;
          }
        | undefined;
      const provenance = meta?.research_provenance as
        | { sources?: unknown }
        | undefined;
      const sources = provenance?.sources;
      if (!Array.isArray(sources) || sources.length !== 1) return false;
      const source = sources[0] as { id?: unknown; url?: unknown };
      return (
        meta?.source_post_id === expected.id &&
        meta?.source_url === expected.url &&
        source.id === expected.id &&
        source.url === expected.url
      );
    });
    if (
      artifacts.length !== scenario.expected.sourceReferences.length ||
      !referencesAreCanonical
    ) {
      failureCodes.push("provenance");
    }
  }
  if (scenario.expected.route !== undefined && route !== scenario.expected.route) {
    failureCodes.push("route");
  }
  failureCodes.push(
    ...duplicateOutcomeFailureCodes({ artifacts, actions }),
  );
  if (
    (terminal === "done" &&
      modelStages.length === 0 &&
      !scenario.model.actionOrchestrator?.allowNoModel &&
      !scenario.model.readOnlyOrchestrator?.allowNoModel) ||
    usage.some(
      (row) =>
        row.provider !== "openrouter" ||
        row.workspace_id !== store.workspaceId,
    ) ||
    assistantInputTokens !== inputTokens ||
    assistantOutputTokens !== outputTokens
  ) {
    failureCodes.push("model_usage");
  }
  if (
    terminal !== "failure" &&
    !frames.some((frame) => frame.event === "done")
  ) {
    failureCodes.push("transport_terminal");
  }
  if (
    terminal === "done" &&
    assistantMessages.every(
      (message) =>
        message.content.trim().length === 0 &&
        (message.artifacts?.length ?? 0) === 0,
    )
  ) {
    failureCodes.push("empty_turn");
  }

  return {
    pass: failureCodes.length === 0,
    failureCodes,
    safe: {
      id: scenario.id,
      status: response.status,
      terminal,
      messageCount: messages.length,
      artifactCount: artifacts.length,
      actionCount: persistedDomainActions.length,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedInputTokens,
      fallbackUsed,
      latencyMs: Number(latencyMs.toFixed(3)),
      costUsd,
      route,
      modelStages,
    },
    persisted: {
      messages,
      artifacts,
      actions: persistedDomainActions,
      drafts: store.drafts(),
      usage,
    },
    observed: {
      actions,
      agentProviderRounds: providerSession.roundCount(),
      directWriterRequests: directWriter?.requests ?? [],
      savedPostReads: store.readCount("saved_posts"),
      readOnlyPlannerRequests: readOnlyPlannerAdapters.flatMap(
        (adapter) => adapter.requests,
      ),
      readOnlyTools,
      modeledBatchOperationKeys,
      actionPlannerRequests: actionPlannerAdapters.flatMap(
        (adapter) => adapter.requests,
      ),
      actionTools,
    },
    frames,
  };
}

export async function runCoworkOutcomeScenario(
  scenario: CoworkOutcomeScenario,
): Promise<CoworkOutcomeReport> {
  return runCoworkOutcomeScenarioWithStore(
    new CoworkHarnessStore(),
    scenario,
  );
}

export async function runCoworkOutcomeSequence(
  scenarios: readonly CoworkOutcomeScenario[],
): Promise<{
  pass: boolean;
  recovered: boolean;
  attempts: CoworkOutcomeReport[];
}> {
  const store = new CoworkHarnessStore();
  const modeledBatchRepository = new HarnessModeledDraftBatchRepository();
  const attempts: CoworkOutcomeReport[] = [];
  for (const scenario of scenarios) {
    attempts.push(
      await runCoworkOutcomeScenarioWithStore(
        store,
        scenario,
        modeledBatchRepository,
      ),
    );
  }
  return {
    pass: attempts.every((attempt) => attempt.pass),
    recovered:
      attempts.length >= 2 &&
      attempts[0]?.safe.artifactCount === 0 &&
      (attempts.at(-1)?.safe.artifactCount ?? 0) > 0 &&
      ["done", "ask"].includes(attempts.at(-1)?.safe.terminal ?? "failure"),
    attempts,
  };
}

/** Serialize only the explicit safe projection; never stringify the report. */
export function safeCoworkReportLine(report: CoworkOutcomeReport): string {
  return JSON.stringify(report.safe);
}

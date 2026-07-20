import { isCancelRequested } from "@/lib/agent/cancel";
import {
  observeCoworkTurn,
  type CoworkTurnTelemetry,
} from "@/lib/agent/cowork-telemetry";
import type { AgentEvent, Artifact, PlanStep } from "@/lib/agent/contracts";
import {
  runAgentTurn,
  ACTION_ORCHESTRATOR_DEADLINE_MS,
} from "@/lib/agent/execute/agent";
import {
  runWriterTurn,
  WRITER_TURN_BUDGET_MS,
  type WriterInput,
} from "@/lib/agent/execute/writer";
import { isExclusiveHookRefine } from "@/lib/agent/direct-refine-policy";
import { safeFilename } from "@/lib/agent/untrusted";
import { loadCitedSwipePostImage } from "@/lib/agent/turn/context";
import type { TurnPlan } from "@/lib/agent/turn/compile";
import type { TurnSetupResult } from "@/lib/agent/turn/setup";
import type { DraftFinalizerSpecialists } from "@/lib/agent/finalize/finalizer";
import { splicePreservedBody } from "@/lib/hook-splice";
import {
  campaignImageContext,
  enforceLeadMagnetCampaignCta,
  hasLeadMagnetResourceOverlap,
} from "@/lib/lead-magnet-campaign";
import { enqueueLeadMagnetImageJob } from "@/lib/lead-magnet-image-jobs";
import {
  AUTOMATIC_LEAD_MAGNET_IMAGE_GENERATION_ENABLED,
  shouldGenerateLeadMagnetImage,
  type LeadMagnetImageContext,
  type SourcePostImage,
} from "@/lib/lead-magnet-image-generation";
import {
  CHAT_MODEL,
  logOpenRouterUsage,
  streamChat,
  type ChatMessage,
  type Usage,
} from "@/lib/openrouter";
import { stampDraftFormat } from "@/lib/markdown/mode";
import {
  applyCiteSourceToDraftArtifacts,
  isDraftArtifact,
  modelSourceStructureSkeleton,
  sourceReferenceFromCiteArtifact,
  sourceReferenceFromCiteArtifacts,
  tagArtifactWithCreatorStyle,
  tagArtifactWithLeadMagnet,
  tagArtifactWithModelSourceReference,
  tagArtifactWithNoModelFormat,
  tagArtifactWithSkills,
  withGeneratedImageMeta,
  withLeadMagnetImagePlanStep,
} from "@/lib/agent/turn/artifact-tags";

export type TurnExecuteDependencies = {
  runWriterTurn: typeof runWriterTurn;
  runAgentTurn: typeof runAgentTurn;
  now: () => Date;
  draftFinalizerSpecialists?: Partial<DraftFinalizerSpecialists>;
};

export type ExecuteTurnHandlers = {
  signal: AbortSignal;
  onModelUsed(model: string): void;
};

export type ExecuteTurnPlanResult = {
  run: (handlers: ExecuteTurnHandlers) => AsyncIterable<AgentEvent>;
};

/**
 * Build the execution stream for a compiled turn plan.
 *
 * This isolates the "what to run" dispatch (direct writer, action orchestrator,
 * read-only orchestrator, deterministic answer lane) and the event-stream mapping
 * (artifact tagging, cite-source backfill, lead-magnet image generation) from the
 * SSE framing and persistence finalizer that lives in `finalize.ts`.
 */
export function executeTurnPlan(
  plan: TurnPlan,
  setup: TurnSetupResult,
  chatId: string,
  deps: TurnExecuteDependencies,
): ExecuteTurnPlanResult {
  return {
    run: (handlers) => runTurnPlan(plan, setup, chatId, deps, handlers),
  };
}

async function* runTurnPlan(
  plan: TurnPlan,
  setup: TurnSetupResult,
  chatId: string,
  deps: TurnExecuteDependencies,
  handlers: ExecuteTurnHandlers,
): AsyncGenerator<AgentEvent> {
  const {
    contract: turnContract,
    useDirectWriter,
    directWriterTask,
    useDirectLeadMagnet,
    useDirectCreatorStyle,
    useActionOrchestrator,
    actionOrchestratorRoute,
    useReadOnlyOrchestrator,
    readOnlyOrchestratorRoute,
    modeledBatchContinuation,
    modelSourceReference,
  } = plan;

  const {
    workspaceId,
    sbRaw,
    attachments,
    history,
    effectiveUserInstruction,
    orchestratorAttachmentBlocks,
    currentModelSource,
    modelSourceImage,
    modelSourceImageSkipReason,
    modelSourceImageSourcePostId,
    citedSourceImage: initialCitedSourceImage,
    citedSourceImageSkipReason: initialCitedSourceImageSkipReason,
    citedSourceImageSourcePostId: initialCitedSourceImageSourcePostId,
    appliedNoModelFormat,
    selectedNoModelFormat,
    leadMagnetBlock,
    appliedLeadMagnet,
    shouldAttachLeadMagnet,
    activeLeadMagnetCampaign,
    creatorStyleBlock,
    appliedCreatorStyle,
    feedbackMemory,
    preferences,
    priorPostDrafts,
    preloadedVoiceResult,
    claimedTurnStartedAt,
    claimedUserMessageId,
    actionTurnMessageId,
    confirmedActionTargetIds,
    coworkTelemetry,
    customSkillBodies,
    customSkillNames,
  } = setup;

  let citedSourceImage = initialCitedSourceImage;
  let citedSourceImageSkipReason = initialCitedSourceImageSkipReason;
  let citedSourceImageSourcePostId = initialCitedSourceImageSourcePostId;

  let responseModel = CHAT_MODEL;
  const recordResponseModel = (model: string) => {
    responseModel = model;
    handlers.onModelUsed(model);
  };

  const artifacts: Artifact[] = [];
  const pendingCiteArtifacts: Artifact[] = [];
  let movedCiteSourceToDraft = false;
  let leadMagnetImageGeneratedThisTurn = false;
  let pendingImageDraft: {
    artifact: Artifact;
    leadMagnet: LeadMagnetImageContext;
  } | null = null;
  let latestPlanSteps: PlanStep[] = [];

  const transformDraftCandidate = createTransformDraftCandidate(setup, plan);

  const turnStartedAtMs = Date.parse(claimedTurnStartedAt!);
  const cancellationProbe = (probeSignal: AbortSignal) =>
    isCancelRequested(chatId, turnStartedAtMs, probeSignal);

  const writerInput: Omit<WriterInput, "task"> = {
    workspaceId,
    userInstruction: effectiveUserInstruction,
    voiceResult: preloadedVoiceResult!,
    preferences,
    feedbackMemory,
    priorPostDrafts,
    format: selectedNoModelFormat,
    customSkillBodies,
    customSkillNames,
    signal: handlers.signal,
    cancellationProbe,
    finalizerSpecialists: deps.draftFinalizerSpecialists,
    transformCandidate: transformDraftCandidate,
    finalTransformCandidate: transformDraftCandidate,
    telemetry: coworkTelemetry,
    onModelUsed: recordResponseModel,
    dependencies: {
      now: () => deps.now().getTime(),
    },
    ...(shouldAttachLeadMagnet && leadMagnetBlock.trim()
      ? { leadMagnetBlock }
      : {}),
    ...(creatorStyleBlock.trim() ? { creatorStyleBlock } : {}),
  };

  let rawStream: AsyncGenerator<AgentEvent>;

  if (useDirectWriter) {
    rawStream = deps.runWriterTurn({
      ...writerInput,
      sessionId: chatId,
      history,
      task: directWriterTask,
      deadlineAtMs: turnStartedAtMs + WRITER_TURN_BUDGET_MS,
      enableStructureGate: Boolean(
        currentModelSource && modelSourceStructureSkeleton(currentModelSource),
      ),
      ...(useDirectLeadMagnet ? { leadMagnetBlock } : {}),
      ...(useDirectCreatorStyle ? { creatorStyleBlock } : {}),
    });
  } else if (useActionOrchestrator && actionOrchestratorRoute) {
    rawStream = deps.runAgentTurn({
      workspaceId,
      chatId,
      turnMessageId: actionTurnMessageId ?? claimedUserMessageId!,
      userInstruction: effectiveUserInstruction,
      history,
      task: { kind: "action", route: actionOrchestratorRoute },
      confirmedActionTargetIds,
      signal: handlers.signal,
      cancellationProbe,
      telemetry: coworkTelemetry,
      onModelUsed: recordResponseModel,
      writerInput,
      deadlineAtMs: turnStartedAtMs + ACTION_ORCHESTRATOR_DEADLINE_MS,
    });
  } else if (useReadOnlyOrchestrator && readOnlyOrchestratorRoute) {
    rawStream = deps.runAgentTurn({
      workspaceId,
      chatId,
      turnMessageId: actionTurnMessageId ?? claimedUserMessageId!,
      userInstruction: effectiveUserInstruction,
      history,
      task: { kind: "research", route: readOnlyOrchestratorRoute },
      ...(modeledBatchContinuation ? { modeledBatchContinuation } : {}),
      attachmentNames: attachments.map((attachment) =>
        safeFilename(attachment.filename),
      ),
      attachmentBlocks: orchestratorAttachmentBlocks,
      cancellationProbe,
      writerInput,
      signal: handlers.signal,
      telemetry: coworkTelemetry,
      onModelUsed: recordResponseModel,
      deadlineAtMs: turnStartedAtMs + WRITER_TURN_BUDGET_MS,
    });
  } else {
    rawStream = executeAnswerTurn(setup, chatId, handlers.signal, recordResponseModel);
  }

  const observedStream = observeCoworkTurn({
    stream: rawStream,
    telemetry: coworkTelemetry,
    contract: turnContract,
    signal: handlers.signal,
    deferFinish: true,
  });

  for await (const ev of observedStream) {
    switch (ev.type) {
      case "text":
      case "tool_start":
      case "tool_end":
      case "ask":
      case "preference_saved":
      case "plan":
        yield ev;
        break;
      case "plan_update":
        latestPlanSteps = ev.steps;
        yield ev;
        break;
      case "artifact": {
        if (ev.artifact.kind === "cite") {
          pendingCiteArtifacts.push(ev.artifact);
          const updatedDrafts = applyCiteSourceToDraftArtifacts(artifacts, [
            ev.artifact,
          ]);
          if (updatedDrafts.length > 0) {
            movedCiteSourceToDraft = true;
            for (const draft of updatedDrafts) {
              yield { type: "artifact", artifact: draft };
            }
          }

          // Lead-magnet image retry: a draft that arrived before this cite had
          // no source image yet. Now that the cite has landed, try to resolve its
          // image retroactively.
          if (
            pendingImageDraft &&
            !leadMagnetImageGeneratedThisTurn &&
            !modelSourceImage &&
            !citedSourceImage
          ) {
            const citeSourceRefForRetry = sourceReferenceFromCiteArtifact(
              ev.artifact,
            );
            if (citeSourceRefForRetry) {
              const citedSourceImageDecision = await loadCitedSwipePostImage({
                sbRaw,
                workspaceId,
                sourceRef: citeSourceRefForRetry,
                signal: handlers.signal,
              });
              citedSourceImage = citedSourceImageDecision.image;
              citedSourceImageSkipReason = citedSourceImageDecision.skipReason;
              citedSourceImageSourcePostId =
                citedSourceImageDecision.sourcePostId;
            }
          }
          if (
            pendingImageDraft &&
            !leadMagnetImageGeneratedThisTurn &&
            (modelSourceImage ?? citedSourceImage)
          ) {
            const {
              artifact: pendingArtifact,
              leadMagnet: pendingLeadMagnet,
            } = pendingImageDraft;
            pendingImageDraft = null;
            const attempt = await attemptLeadMagnetImageEvents(
              pendingArtifact,
              pendingLeadMagnet,
              latestPlanSteps,
              modelSourceImage ?? citedSourceImage,
              modelSourceImageSourcePostId ?? citedSourceImageSourcePostId,
              appliedLeadMagnet?.title ??
                pendingLeadMagnet.title ??
                "Lead magnet",
              setup,
              chatId,
            );
            if (attempt.fired) {
              leadMagnetImageGeneratedThisTurn = true;
              const idx = artifacts.findIndex(
                (a) => a.id === attempt.artifact.id,
              );
              if (idx !== -1) artifacts[idx] = attempt.artifact;
            }
            for (const event of attempt.events) yield event;
            yield { type: "artifact", artifact: attempt.artifact };
          }
          break;
        }

        // Stamp the active custom skills / format / source / lead magnet /
        // creator style into the artifact's meta. cite artifacts are passthrough
        // references and were handled above.
        let tagged = tagArtifactWithCreatorStyle(
          tagArtifactWithLeadMagnet(
            tagArtifactWithModelSourceReference(
              tagArtifactWithNoModelFormat(
                tagArtifactWithSkills(ev.artifact, customSkillNames),
                appliedNoModelFormat,
              ),
              modelSourceReference,
            ),
            appliedLeadMagnet,
          ),
          appliedCreatorStyle,
        );
        if (isDraftArtifact(tagged) && turnContract.kind === "post") {
          tagged = {
            ...tagged,
            meta: stampDraftFormat(tagged.meta, responseModel),
          };
        }

        const citeSourceRef = modelSourceReference
          ? null
          : sourceReferenceFromCiteArtifacts(pendingCiteArtifacts);
        if (citeSourceRef) {
          tagged = tagArtifactWithModelSourceReference(tagged, citeSourceRef);
          movedCiteSourceToDraft = true;
          if (
            AUTOMATIC_LEAD_MAGNET_IMAGE_GENERATION_ENABLED &&
            !modelSourceImage &&
            !citedSourceImage
          ) {
            const citedSourceImageDecision = await loadCitedSwipePostImage({
              sbRaw,
              workspaceId,
              sourceRef: citeSourceRef,
              signal: handlers.signal,
            });
            citedSourceImage = citedSourceImageDecision.image;
            citedSourceImageSkipReason = citedSourceImageDecision.skipReason;
            citedSourceImageSourcePostId =
              citedSourceImageDecision.sourcePostId;
          }
        } else if (
          pendingCiteArtifacts.length > 0 &&
          isDraftArtifact(tagged)
        ) {
          movedCiteSourceToDraft = true;
        }

        const sourceImageForLeadMagnet = modelSourceImage ?? citedSourceImage;
        const sourceImageSkipReason =
          modelSourceImageSkipReason ?? citedSourceImageSkipReason;
        const sourceImageSourcePostId =
          modelSourceImageSourcePostId ?? citedSourceImageSourcePostId;
        const imageLeadMagnetContext = activeLeadMagnetCampaign
          ? campaignImageContext(activeLeadMagnetCampaign)
          : null;
        const imageLeadMagnetTitle =
          appliedLeadMagnet?.title ??
          imageLeadMagnetContext?.title ??
          "Lead magnet";

        if (
          AUTOMATIC_LEAD_MAGNET_IMAGE_GENERATION_ENABLED &&
          !leadMagnetImageGeneratedThisTurn &&
          imageLeadMagnetContext
        ) {
          const attempt = await attemptLeadMagnetImageEvents(
            tagged,
            imageLeadMagnetContext,
            latestPlanSteps,
            sourceImageForLeadMagnet,
            sourceImageSourcePostId,
            imageLeadMagnetTitle,
            setup,
            chatId,
          );
          tagged = attempt.artifact;
          latestPlanSteps = attempt.latestPlanSteps;
          if (attempt.fired) {
            leadMagnetImageGeneratedThisTurn = true;
          } else if (isDraftArtifact(tagged) && !sourceImageForLeadMagnet) {
            if (sourceImageSkipReason) {
              // A decision REJECTED the source image (wrong media type, fetch
              // failure, etc.) — record why, nothing left to wait for.
              leadMagnetImageGeneratedThisTurn = true;
              latestPlanSteps = withLeadMagnetImagePlanStep(
                latestPlanSteps,
                "done",
              );
              tagged = withGeneratedImageMeta(tagged, {
                status: "skipped",
                reason: sourceImageSkipReason,
                source_post_id: sourceImageSourcePostId,
                lead_magnet_id: imageLeadMagnetContext.id ?? null,
                lead_magnet_title: imageLeadMagnetTitle,
              });
              yield {
                type: "plan_update",
                steps: latestPlanSteps,
              };
            } else {
              // No source image yet — stash the draft so a later cite arrival
              // can retroactively fire generation.
              pendingImageDraft = {
                artifact: tagged,
                leadMagnet: imageLeadMagnetContext,
              };
            }
          }
          for (const event of attempt.events) yield event;
        }

        artifacts.push(tagged);
        yield { type: "artifact", artifact: tagged };
        break;
      }
      case "done": {
        if (
          pendingCiteArtifacts.length > 0 &&
          !movedCiteSourceToDraft &&
          !artifacts.some(isDraftArtifact)
        ) {
          for (const citeArtifact of pendingCiteArtifacts) {
            artifacts.push(citeArtifact);
            yield { type: "artifact", artifact: citeArtifact };
          }
        }
        yield ev;
        break;
      }
      case "error":
        yield ev;
        break;
    }
  }
}

async function attemptLeadMagnetImageEvents(
  artifact: Artifact,
  leadMagnetContext: LeadMagnetImageContext,
  latestPlanSteps: PlanStep[],
  sourceImageForLeadMagnet: SourcePostImage | null,
  sourceImageSourcePostId: string | null,
  imageLeadMagnetTitle: string,
  setup: TurnSetupResult,
  chatId: string,
): Promise<{
  artifact: Artifact;
  fired: boolean;
  events: AgentEvent[];
  latestPlanSteps: PlanStep[];
}> {
  if (!AUTOMATIC_LEAD_MAGNET_IMAGE_GENERATION_ENABLED) {
    return { artifact, fired: false, events: [], latestPlanSteps };
  }
  if (
    !shouldGenerateLeadMagnetImage({
      artifact,
      leadMagnet: leadMagnetContext,
      sourceImage: sourceImageForLeadMagnet,
    })
  ) {
    return { artifact, fired: false, events: [], latestPlanSteps };
  }

  const imageToolId = `lead_magnet_image_${artifact.id}`;
  let steps = withLeadMagnetImagePlanStep(latestPlanSteps, "active");
  const events: AgentEvent[] = [{ type: "plan_update", steps }];
  events.push({
    type: "tool_start",
    id: imageToolId,
    name: "generate_lead_magnet_image",
    args: JSON.stringify({ leadMagnet: leadMagnetContext.title }),
  });

  let tagged = artifact;
  try {
    const queued = await enqueueLeadMagnetImageJob({
      sb: setup.sbRaw,
      workspaceId: setup.workspaceId,
      target: {
        kind: "chat_message_artifact",
        chatId,
        artifactId: artifact.id,
      },
      sourceImage: sourceImageForLeadMagnet as SourcePostImage,
      leadMagnet: leadMagnetContext,
      artifact,
      author: setup.imageGenerationAuthor,
    });
    tagged = withGeneratedImageMeta(artifact, queued.queuedMeta);
    events.push({
      type: "tool_end",
      id: imageToolId,
      name: "generate_lead_magnet_image",
      ok: true,
      summary: "Image queued",
    });
  } catch (e) {
    tagged = withGeneratedImageMeta(artifact, {
      status: "failed",
      reason: (e as Error)?.message || "Image could not be queued.",
      source_post_id: (sourceImageForLeadMagnet as SourcePostImage).postId,
      lead_magnet_id: leadMagnetContext.id ?? null,
      lead_magnet_title: leadMagnetContext.title,
    });
    events.push({
      type: "tool_end",
      id: imageToolId,
      name: "generate_lead_magnet_image",
      ok: false,
      summary: "Image could not be queued",
    });
  }

  steps = withLeadMagnetImagePlanStep(steps, "done");
  events.push({ type: "plan_update", steps });

  return { artifact: tagged, fired: true, events, latestPlanSteps: steps };
}

function createTransformDraftCandidate(
  setup: TurnSetupResult,
  plan: TurnPlan,
): (
  body: string,
) => { ok: false; message: string } | { ok: true; body: string } {
  return (body: string) => {
    if (
      setup.activeLeadMagnetCampaign &&
      !hasLeadMagnetResourceOverlap(body, setup.activeLeadMagnetCampaign)
    ) {
      return {
        ok: false,
        message:
          "The generated post did not match the selected lead magnet, so no draft was saved. Please try again.",
      };
    }
    let transformedBody = setup.activeLeadMagnetCampaign
      ? enforceLeadMagnetCampaignCta(body, setup.activeLeadMagnetCampaign)
      : body;
    const legacyHookOnlyAllowed =
      !setup.refineInstruction || isExclusiveHookRefine(setup.refineInstruction);
    if (
      !plan.useDirectRefine &&
      setup.hookOnly &&
      setup.hookOnlyOriginalBody &&
      legacyHookOnlyAllowed
    ) {
      transformedBody = splicePreservedBody(
        setup.hookOnlyOriginalBody,
        transformedBody,
      );
    }
    return { ok: true, body: transformedBody };
  };
}

async function* executeAnswerTurn(
  setup: TurnSetupResult,
  chatId: string,
  signal: AbortSignal,
  onModelUsed: (model: string) => void,
): AsyncGenerator<AgentEvent> {
  const telemetry: CoworkTurnTelemetry = setup.coworkTelemetry;
  const startedAt = Date.now();
  const systemMessage: ChatMessage = {
    role: "system",
    content:
      "You are Cowork, a LinkedIn content assistant. Answer the user's question or brainstorming request helpfully and concisely. Do not write a LinkedIn post draft unless the user explicitly asks for one.",
  };
  const messages: ChatMessage[] = [systemMessage, ...setup.history];
  const stream = streamChat({
    model: CHAT_MODEL,
    messages,
    signal,
    sessionId: chatId,
  });
  let text = "";
  let model = CHAT_MODEL;
  let usage: Usage | undefined;
  try {
    for await (const delta of stream) {
      if (delta.model) {
        model = delta.model;
        onModelUsed(model);
      }
      if (delta.text) {
        text += delta.text;
        yield { type: "text", delta: delta.text };
      }
      if (delta.usage) usage = delta.usage;
    }
  } catch (error) {
    telemetry.recordAttempt({
      stage: "answer",
      attempt: 1,
      model,
      provider: "openrouter",
      outcome: "failed",
      reasonCode:
        error instanceof Error
          ? error.name === "AbortError"
            ? "cancelled"
            : error.message
          : String(error),
      latencyMs: Date.now() - startedAt,
      usage,
    });
    throw error;
  }
  const latencyMs = Date.now() - startedAt;
  onModelUsed(model);
  telemetry.recordAttempt({
    stage: "answer",
    attempt: 1,
    model,
    provider: "openrouter",
    outcome: "accepted",
    latencyMs,
    usage,
  });
  await logOpenRouterUsage(
    "cowork_answer",
    model,
    usage,
    setup.workspaceId,
    {
      chat_id: chatId,
      reasoning_tokens:
        usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      cached_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  );
  yield {
    type: "done",
    message: {
      content: text,
      tool_calls: null,
      artifacts: [],
      toolMessages: [],
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    },
  };
}

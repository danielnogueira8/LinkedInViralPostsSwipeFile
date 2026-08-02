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
import { executeInterviewTurn } from "@/lib/agent/turn/execute-interview";
import type { TurnExecuteContext } from "@/lib/agent/turn/state";
import { enforceTurnOutcome } from "@/lib/agent/turn/outcome-guard";
import type { DraftFinalizerSpecialists } from "@/lib/agent/finalize/finalizer";
import { splicePreservedBody } from "@/lib/hook-splice";
import {
  campaignImageContext,
  transformLeadMagnetCampaignDraft,
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
import { routesToNativeOpenAI } from "@/lib/openai";
import { stampDraftFormat } from "@/lib/markdown/mode";
import {
  savedDraftParentId,
  tagArtifactWithGenerationLineage,
} from "@/lib/content-learning/generation-lineage";
import { explorationLaneSchema } from "@/lib/content-learning/contracts";
import {
  applyCiteSourceToDraftArtifacts,
  isDraftArtifact,
  sourceReferenceFromCiteArtifact,
  sourceReferenceFromCiteArtifacts,
  tagArtifactWithCreatorStyle,
  tagArtifactWithLinkedInNativeGuidance,
  tagArtifactWithLeadMagnet,
  tagArtifactWithModelSourceReference,
  tagArtifactWithNoModelFormat,
  tagArtifactWithSkills,
  withGeneratedImageMeta,
  withLeadMagnetImagePlanStep,
} from "@/lib/agent/turn/artifact-tags";
import { buildAnswerSystemPrompt } from "@/lib/agent/prompt-guidance";
import { tagArtifactWithKnowledgeSources } from "@/lib/knowledge-sources/context";
import { originalTemplateReferenceFromMatch } from "@/lib/agent/original-template-reference";

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
  setup: TurnExecuteContext,
  chatId: string,
  deps: TurnExecuteDependencies,
): ExecuteTurnPlanResult {
  return {
    run: (handlers) =>
      enforceTurnOutcome(
        plan,
        runTurnPlan(plan, setup, chatId, deps, handlers),
      ),
  };
}

async function* runTurnPlan(
  plan: TurnPlan,
  setup: TurnExecuteContext,
  chatId: string,
  deps: TurnExecuteDependencies,
  handlers: ExecuteTurnHandlers,
): AsyncGenerator<AgentEvent> {
  const {
    contract: turnContract,
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
    modelSourceImage,
    modelSourceImageSkipReason,
    modelSourceImageSourcePostId,
    citedSourceImage: initialCitedSourceImage,
    citedSourceImageSkipReason: initialCitedSourceImageSkipReason,
    citedSourceImageSourcePostId: initialCitedSourceImageSourcePostId,
    appliedNoModelFormat,
    selectedNoModelFormat,
    linkedinNativeGuidance,
    leadMagnetBlock,
    appliedLeadMagnet,
    shouldAttachLeadMagnet,
    activeLeadMagnetCampaign,
    creatorStyleBlock,
    appliedCreatorStyle,
    feedbackMemory,
    workspaceLearningBlock,
    preferences,
    priorPostDrafts,
    resolvedGenerationConfig,
    preloadedVoiceResult,
    claimedTurnStartedAt,
    claimedUserMessageId,
    actionTurnMessageId,
    confirmedActionTargetIds,
    coworkTelemetry,
    customSkillBodies,
    customSkillNames,
    skillIds,
    modelSourceId,
    currentTurnOperation,
    trustedRefineTarget,
    structureMatch,
    workspaceKnowledge,
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

  const structureMatchPreamble: PlanStep[] | undefined = setup.structureMatch
    ? [
        {
          id: "structure_match",
          label: `Picked a ${setup.structureMatch.candidate.structureType} structure from ${setup.structureMatch.candidate.title}`,
          status: "done",
        },
      ]
    : undefined;

  const turnStartedAtMs = Date.parse(claimedTurnStartedAt!);
  const cancellationProbe = (probeSignal: AbortSignal) =>
    isCancelRequested(chatId, turnStartedAtMs, probeSignal);

  const writerInput: Omit<WriterInput, "task"> = {
    workspaceId,
    userInstruction: effectiveUserInstruction,
    voiceResult: preloadedVoiceResult!,
    preferences,
    feedbackMemory,
    workspaceLearningBlock,
    workspaceKnowledgeBlock: workspaceKnowledge.promptBlock,
    priorPostDrafts,
    explorationLane: resolvedGenerationConfig?.explorationLane,
    originalTemplateReference:
      originalTemplateReferenceFromMatch(structureMatch) ?? undefined,
    format: selectedNoModelFormat,
    linkedinNativeGuidance,
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
    ...(structureMatchPreamble ? { planPreambleSteps: structureMatchPreamble } : {}),
    ...(shouldAttachLeadMagnet && leadMagnetBlock.trim()
      ? { leadMagnetBlock }
      : {}),
    ...(creatorStyleBlock.trim() ? { creatorStyleBlock } : {}),
  };

  let rawStream: AsyncGenerator<AgentEvent>;

  switch (plan.kind) {
    case "write":
      rawStream = deps.runWriterTurn({
        ...writerInput,
        sessionId: chatId,
        history,
        task: plan.task,
        // No orchestrator narrates this lane — the writer shows its own steps.
        narratePlan: true,
        deadlineAtMs: turnStartedAtMs + WRITER_TURN_BUDGET_MS,
        ...(plan.usesLeadMagnet ? { leadMagnetBlock } : {}),
        ...(plan.usesCreatorStyle ? { creatorStyleBlock } : {}),
      });
      break;
    case "action":
      rawStream = deps.runAgentTurn({
        workspaceId,
        chatId,
        turnMessageId: actionTurnMessageId ?? claimedUserMessageId!,
        userInstruction: effectiveUserInstruction,
        history,
        task: { kind: "action", route: plan.actionRoute },
        confirmedActionTargetIds,
        signal: handlers.signal,
        cancellationProbe,
        telemetry: coworkTelemetry,
        onModelUsed: recordResponseModel,
        writerInput,
        deadlineAtMs: turnStartedAtMs + ACTION_ORCHESTRATOR_DEADLINE_MS,
      });
      break;
    case "research":
      rawStream = deps.runAgentTurn({
        workspaceId,
        chatId,
        turnMessageId: actionTurnMessageId ?? claimedUserMessageId!,
        userInstruction: effectiveUserInstruction,
        history,
        task: { kind: "research", route: plan.researchRoute },
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
      break;
    case "clarify":
      rawStream = executeClarificationTurn(plan.ask);
      break;
    case "interview":
      rawStream = executeInterviewTurn(
        setup,
        chatId,
        handlers.signal,
        recordResponseModel,
      );
      break;
    case "answer":
      rawStream = executeAnswerTurn(
        setup,
        chatId,
        handlers.signal,
        recordResponseModel,
      );
      break;
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
        let tagged = tagArtifactWithKnowledgeSources(
          tagArtifactWithCreatorStyle(
            tagArtifactWithLeadMagnet(
              tagArtifactWithModelSourceReference(
                tagArtifactWithNoModelFormat(
                  tagArtifactWithLinkedInNativeGuidance(
                    tagArtifactWithSkills(ev.artifact, customSkillNames),
                    linkedinNativeGuidance,
                  ),
                  appliedNoModelFormat,
                ),
                modelSourceReference,
              ),
              appliedLeadMagnet,
            ),
            appliedCreatorStyle,
          ),
          workspaceKnowledge.sources,
        );
        if (isDraftArtifact(tagged) && turnContract.kind === "post") {
          tagged = {
            ...tagged,
            meta: stampDraftFormat(tagged.meta, responseModel),
          };
        }
        if (isDraftArtifact(tagged) && claimedUserMessageId) {
          const parentArtifactId =
            currentTurnOperation?.kind === "edit_artifact"
              ? savedDraftParentId(trustedRefineTarget)
              : null;
          tagged = tagArtifactWithGenerationLineage(tagged, {
            schemaVersion: 1,
            sourceArtifactId: tagged.id,
            userMessageId: claimedUserMessageId,
            coworkCommand:
              currentTurnOperation?.kind === "edit_artifact"
                ? "edit"
                : "create",
            parentArtifactId,
            modelSourceId: modelSourceId ?? null,
            contentTemplateId:
              structureMatch?.candidate.kind === "template" ||
              structureMatch?.candidate.kind === "builtin"
                ? structureMatch.candidate.id
                : null,
            creatorStyleId: appliedCreatorStyle?.id ?? null,
            customSkillIds: skillIds.slice(0, 20),
            leadMagnetId: appliedLeadMagnet?.id ?? null,
            voiceProfileRevision: (() => {
              if (
                !preloadedVoiceResult ||
                typeof preloadedVoiceResult !== "object"
              ) {
                return null;
              }
              const voice = (preloadedVoiceResult as {
                voice?: { generated_at?: unknown };
              }).voice;
              return typeof voice?.generated_at === "string" &&
                voice.generated_at.trim()
                ? voice.generated_at
                : null;
            })(),
            explorationLane:
              currentTurnOperation?.kind !== "edit_artifact"
                ? (explorationLaneSchema.safeParse(
                    tagged.meta?.exploration_lane,
                  ).data ?? null)
                : null,
            generationModel: responseModel,
            generatedAt: claimedTurnStartedAt!,
            knowledgeSources: workspaceKnowledge.sources.map((source) => ({
              sourceId: source.sourceId,
              sourceRevisionId: source.sourceRevisionId,
              chunkIds: source.chunkIds,
            })),
          });
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
  setup: TurnExecuteContext,
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
  setup: TurnExecuteContext,
  plan: TurnPlan,
): (
  body: string,
) => { ok: true; body: string } | { ok: false; message: string } {
  return (body: string) => {
    const campaignTransform = setup.activeLeadMagnetCampaign
      ? transformLeadMagnetCampaignDraft(
          body,
          setup.activeLeadMagnetCampaign,
          setup.effectiveUserInstruction,
        )
      : { ok: true as const, body };
    if (!campaignTransform.ok) return campaignTransform;
    let transformedBody = campaignTransform.body;
    const legacyHookOnlyAllowed =
      !setup.refineInstruction || isExclusiveHookRefine(setup.refineInstruction);
    if (
      !(plan.kind === "write" && plan.isDirectRefine) &&
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

async function* executeClarificationTurn(
  ask: import("@/lib/agent/contracts").AskQuestion,
): AsyncGenerator<AgentEvent> {
  const askId = crypto.randomUUID();
  const args = JSON.stringify({
    question: ask.question,
    options: ask.options,
    allowOther: ask.allowOther,
    ...(ask.choiceIds ? { choiceIds: ask.choiceIds } : {}),
    ...(ask.doneOption ? { doneOption: ask.doneOption } : {}),
  });
  const call = {
    id: askId,
    type: "function" as const,
    function: { name: "ask_user", arguments: args },
  };
  yield { type: "tool_start", id: askId, name: "ask_user", args };
  yield { type: "ask", ask };
  yield { type: "tool_end", id: askId, name: "ask_user", ok: true };
  yield {
    type: "done",
    terminalReason: "ask",
    message: {
      content: ask.question,
      tool_calls: [call],
      artifacts: [],
      toolMessages: [
        {
          role: "tool",
          tool_call_id: askId,
          content: JSON.stringify({ ok: true, answer_pending: true }),
        },
      ],
      inputTokens: 0,
      outputTokens: 0,
    },
  };
}

async function* executeAnswerTurn(
  setup: TurnExecuteContext,
  chatId: string,
  signal: AbortSignal,
  onModelUsed: (model: string) => void,
): AsyncGenerator<AgentEvent> {
  const telemetry: CoworkTurnTelemetry = setup.coworkTelemetry;
  const startedAt = Date.now();
  // The answer executor has zero artifact authority. Edits are compiled into a
  // write plan (or a typed clarification) before execution; this prompt must
  // never compensate for a routing miss by returning draft-shaped text.
  const systemMessage: ChatMessage = {
    role: "system",
    content: buildAnswerSystemPrompt(
      setup.currentTurnOperation?.kind === "review_artifact" ||
      (setup.currentTurnOperation?.kind === "ask" &&
        setup.currentTurnOperation.artifactId)
        ? "review"
        : "answer",
    ),
  };
  const messages: ChatMessage[] = [systemMessage, ...setup.history];
  const stream = streamChat({
    // No prompt caching: measured 0 reads: the system prompt here is two sentences (below the
    // cacheable minimum) while the real bulk — the chat history — is not
    // cached at all, so every call wrote an entry nobody could use.
    cachePrompt: false,
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
      provider: routesToNativeOpenAI(model) ? "openai" : "openrouter",
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
    provider: routesToNativeOpenAI(model) ? "openai" : "openrouter",
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

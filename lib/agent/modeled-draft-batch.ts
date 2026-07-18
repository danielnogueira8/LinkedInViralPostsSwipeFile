import { createHash } from "node:crypto";
import type { Artifact } from "@/lib/agent/contracts";
import type { DraftEngineInput } from "@/lib/agent/draft-engine";
import {
  runModeledDraftSlot,
  type CanonicalWorkspaceModelingSource,
  type ModeledDraftSlotInput,
  type ModeledDraftSlotOutcome,
} from "@/lib/agent/modeled-draft-slot-runner";
import { RENDER_POST_MAX_CHARS } from "@/lib/agent/tools";
import { UsagePersistenceError } from "@/lib/openrouter";
import {
  areDraftsNearDuplicate,
  normalizeDraftKey,
} from "@/lib/agent/specialists/nets";

const MAX_MODELED_DRAFTS = 5;
const MAX_RESERVE_SOURCES = 5;
const MAX_SOURCE_TEXT_CHARS = 20_000;
const MAX_SOURCE_REPLACEMENTS_PER_SLOT = 1;
const MODELED_DRAFT_CONCURRENCY = 2;

export type ModeledDraftBatchSource = CanonicalWorkspaceModelingSource;
export type ModeledPostArtifact = Artifact & { kind: "post" };

export type ModeledDraftSlotCheckpoint = Readonly<{
  index: number;
  state: "assigned" | "candidate" | "accepted";
  sourceIndex: number;
  sourceHistory: readonly number[];
  replacements: number;
  candidateBody?: string;
  artifact?: ModeledPostArtifact;
  lastFailureCode?: string;
}>;

export type AcquiredModeledDraftBatch = Readonly<{
  batchId: string;
  leaseToken: string;
  requestHash: string;
  requestedCount: number;
  sources: readonly ModeledDraftBatchSource[];
  slots: readonly ModeledDraftSlotCheckpoint[];
}>;

export type ModeledDraftBatchAcquireResult =
  | { kind: "acquired"; checkpoint: AcquiredModeledDraftBatch }
  | {
      kind: "complete";
      batchId: string;
      artifacts: readonly ModeledPostArtifact[];
    }
  | { kind: "busy" }
  | { kind: "conflict" }
  | { kind: "unavailable" };

export interface ModeledDraftBatchRepository {
  acquire(input: {
    workspaceId: string;
    operationKey: string;
    requestHash: string;
    requestedCount: number;
    sources: readonly ModeledDraftBatchSource[];
  }): Promise<ModeledDraftBatchAcquireResult>;
  acceptSlot(input: {
    batchId: string;
    leaseToken: string;
    slotIndex: number;
    sourceIndex: number;
    expectedState: "assigned" | "candidate";
    artifact: ModeledPostArtifact;
  }): Promise<boolean>;
  replaceSlotSource(input: {
    batchId: string;
    leaseToken: string;
    slotIndex: number;
    sourceIndex: number;
    failureCode: string;
  }): Promise<boolean>;
  complete(input: {
    batchId: string;
    leaseToken: string;
  }): Promise<
    | { kind: "complete"; artifacts: readonly ModeledPostArtifact[] }
    | { kind: "incomplete" }
    | { kind: "lease_lost" }
  >;
  release(input: {
    batchId: string;
    leaseToken: string;
    reason: ModeledDraftBatchIncompleteReason;
  }): Promise<void>;
}

export type ModeledDraftBatchIncompleteReason =
  | "busy"
  | "cancelled"
  | "deadline"
  | "reviewer_unavailable"
  | "writer_unavailable"
  | "slot_exhausted"
  | "source_pool_exhausted"
  | "protocol_error"
  | "store_unavailable";

export type ModeledDraftBatchResult =
  | {
      kind: "complete";
      batchId: string;
      artifacts: ModeledPostArtifact[];
      usage: { inputTokens: number; outputTokens: number };
    }
  | {
      kind: "incomplete";
      batchId?: string;
      reason: ModeledDraftBatchIncompleteReason;
      preservedSlots: number;
      requestedCount: number;
      usage: { inputTokens: number; outputTokens: number };
    }
  | {
      kind: "failed";
      reason:
        | "invalid_request"
        | "insufficient_sources"
        | "state_conflict"
        | "state_corrupt";
      usage: { inputTokens: number; outputTokens: number };
    };

export type ExecuteModeledDraftBatchInput = Readonly<{
  operationKey: string;
  workspaceId: string;
  instruction: string;
  count: number;
  sources: readonly ModeledDraftBatchSource[];
  engineInput: Omit<DraftEngineInput, "task">;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>;

export type ModeledDraftBatchDependencies = Readonly<{
  repository: ModeledDraftBatchRepository;
  runSlot: (
    input: ModeledDraftSlotInput,
  ) => Promise<ModeledDraftSlotOutcome>;
  now: () => number;
}>;

function requestHash(input: ExecuteModeledDraftBatchInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        workspaceId: input.workspaceId,
        instruction: input.instruction,
        count: input.count,
      }),
    )
    .digest("hex");
}

function validSourcePool(
  sources: readonly ModeledDraftBatchSource[],
  maximum: number,
): boolean {
  if (sources.length > maximum) return false;
  const ids = new Set<string>();
  return sources.every((source) => {
    const id = source.id.trim();
    const text = source.text.trim();
    if (
      !id ||
      id !== source.id ||
      id.length > 200 ||
      ids.has(id) ||
      !text ||
      source.text.length > MAX_SOURCE_TEXT_CHARS ||
      (source.url !== undefined &&
        (source.url !== source.url.trim() ||
          source.url.length > 2_048 ||
          !/^https?:\/\//i.test(source.url)))
    ) {
      return false;
    }
    ids.add(id);
    return true;
  });
}

function validRequest(input: ExecuteModeledDraftBatchInput): boolean {
  if (
    !input.workspaceId.trim() ||
    !input.operationKey.trim() ||
    input.operationKey.length > 200 ||
    !input.instruction.trim() ||
    input.instruction.length > 50_000 ||
    !Number.isInteger(input.count) ||
    input.count < 2 ||
    input.count > MAX_MODELED_DRAFTS ||
    input.engineInput.workspaceId !== input.workspaceId
  ) {
    return false;
  }
  return validSourcePool(input.sources, input.count + MAX_RESERVE_SOURCES);
}

function replayArtifactIsCanonical(
  artifact: ModeledPostArtifact,
  batchId: string,
  slotIndex: number,
): boolean {
  const meta = artifact.meta as Record<string, unknown> | undefined;
  const sourceId = meta?.source_post_id;
  const provenance = recordOf(meta?.research_provenance);
  const provenanceSources = Array.isArray(provenance?.sources)
    ? provenance.sources
    : [];
  const provenanceSource = recordOf(provenanceSources[0]);
  return (
    meta?.modeled_draft_slot_id === `${batchId}:slot-${slotIndex}` &&
    meta.modeled_draft_slot_index === slotIndex &&
    meta.source === "model_source" &&
    typeof sourceId === "string" &&
    provenanceSources.length === 1 &&
    provenanceSource?.id === sourceId &&
    provenanceSource.kind === "workspace_post" &&
    (typeof meta.source_url !== "string" ||
      provenanceSource.url === meta.source_url)
  );
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function orderedArtifacts(
  requestedCount: number,
  slots: readonly ModeledDraftSlotCheckpoint[],
): ModeledPostArtifact[] | null {
  if (slots.length !== requestedCount) return null;
  const artifacts: ModeledPostArtifact[] = [];
  const ids = new Set<string>();
  const bodies = new Set<string>();
  for (let index = 0; index < requestedCount; index += 1) {
    const slot = slots.find((candidate) => candidate.index === index);
    if (!slot || slot.state !== "accepted" || !slot.artifact) return null;
    const bodyKey = normalizeDraftKey(slot.artifact.body);
    if (!slot.artifact.id || ids.has(slot.artifact.id) || !bodyKey || bodies.has(bodyKey)) {
      return null;
    }
    ids.add(slot.artifact.id);
    bodies.add(bodyKey);
    artifacts.push(slot.artifact);
  }
  return artifacts;
}

function canonicalArtifactForSlot(input: {
  artifact: ModeledPostArtifact;
  batchId: string;
  slotIndex: number;
  source: ModeledDraftBatchSource;
}): boolean {
  const meta = input.artifact.meta as Record<string, unknown> | undefined;
  if (
    meta?.modeled_draft_slot_id !== `${input.batchId}:slot-${input.slotIndex}` ||
    meta?.modeled_draft_slot_index !== input.slotIndex ||
    meta?.source !== "model_source" ||
    meta?.source_post_id !== input.source.id ||
    (input.source.url
      ? meta.source_url !== input.source.url
      : typeof meta.source_url === "string")
  ) {
    return false;
  }
  const provenance = meta.research_provenance;
  if (!provenance || typeof provenance !== "object") return false;
  const provenanceSources = (provenance as { sources?: unknown }).sources;
  return (
    Array.isArray(provenanceSources) &&
    provenanceSources.length === 1 &&
    provenanceSources[0] !== null &&
    typeof provenanceSources[0] === "object" &&
    (provenanceSources[0] as { id?: unknown }).id === input.source.id &&
    (provenanceSources[0] as { kind?: unknown }).kind === "workspace_post" &&
    (input.source.url
      ? (provenanceSources[0] as { url?: unknown }).url === input.source.url
      : typeof (provenanceSources[0] as { url?: unknown }).url !== "string")
  );
}

function acquiredCheckpointIsCanonical(
  checkpoint: AcquiredModeledDraftBatch,
  expectedRequestHash: string,
  expectedCount: number,
): boolean {
  if (
    !checkpoint.batchId.trim() ||
    !checkpoint.leaseToken.trim() ||
    checkpoint.requestHash !== expectedRequestHash ||
    checkpoint.requestedCount !== expectedCount ||
    checkpoint.sources.length < expectedCount ||
    checkpoint.sources.length > expectedCount + MAX_RESERVE_SOURCES ||
    checkpoint.slots.length !== expectedCount
  ) {
    return false;
  }

  if (!validSourcePool(checkpoint.sources, expectedCount + MAX_RESERVE_SOURCES)) {
    return false;
  }

  const slotIndexes = new Set<number>();
  const sourceHistory = new Set<number>();
  const acceptedBodies: string[] = [];
  for (const slot of checkpoint.slots) {
    if (
      !Number.isInteger(slot.index) ||
      slot.index < 0 ||
      slot.index >= expectedCount ||
      slotIndexes.has(slot.index) ||
      !Number.isInteger(slot.sourceIndex) ||
      slot.sourceIndex < 0 ||
      slot.sourceIndex >= checkpoint.sources.length ||
      !Array.isArray(slot.sourceHistory) ||
      slot.sourceHistory.length !== slot.replacements + 1 ||
      slot.sourceHistory.length < 1 ||
      slot.sourceHistory.length > 2 ||
      !Number.isInteger(slot.replacements) ||
      slot.replacements < 0 ||
      slot.replacements > MAX_SOURCE_REPLACEMENTS_PER_SLOT ||
      slot.sourceHistory.at(-1) !== slot.sourceIndex
    ) {
      return false;
    }
    slotIndexes.add(slot.index);
    for (const sourceIndex of slot.sourceHistory) {
      if (
        !Number.isInteger(sourceIndex) ||
        sourceIndex < 0 ||
        sourceIndex >= checkpoint.sources.length ||
        sourceHistory.has(sourceIndex)
      ) {
        return false;
      }
      sourceHistory.add(sourceIndex);
    }

    if (slot.state === "assigned") {
      if (slot.candidateBody !== undefined || slot.artifact !== undefined) {
        return false;
      }
      continue;
    }
    if (slot.state === "candidate") {
      if (
        typeof slot.candidateBody !== "string" ||
        !slot.candidateBody.trim() ||
        slot.candidateBody.length > RENDER_POST_MAX_CHARS ||
        slot.artifact !== undefined
      ) {
        return false;
      }
      continue;
    }
    if (
      slot.state !== "accepted" ||
      !slot.artifact ||
      slot.artifact.kind !== "post" ||
      !slot.artifact.body.trim() ||
      slot.artifact.body.length > RENDER_POST_MAX_CHARS ||
      !canonicalArtifactForSlot({
        artifact: slot.artifact,
        batchId: checkpoint.batchId,
        slotIndex: slot.index,
        source: checkpoint.sources[slot.sourceIndex],
      }) ||
      acceptedBodies.some((body) =>
        areDraftsNearDuplicate(body, slot.artifact!.body),
      )
    ) {
      return false;
    }
    acceptedBodies.push(slot.artifact.body);
  }
  return true;
}

function preservedCount(slots: readonly ModeledDraftSlotCheckpoint[]): number {
  return slots.filter((slot) => slot.state === "accepted").length;
}

function nextReserveSourceIndex(
  checkpoint: AcquiredModeledDraftBatch,
  slots: readonly ModeledDraftSlotCheckpoint[],
): number | null {
  const consumed = new Set(slots.flatMap((slot) => [...slot.sourceHistory]));
  for (
    let index = checkpoint.requestedCount;
    index < checkpoint.sources.length;
    index += 1
  ) {
    if (!consumed.has(index)) return index;
  }
  return null;
}

function outcomeReason(
  outcome: Exclude<ModeledDraftSlotOutcome, { kind: "accepted" | "rejected" }>,
): ModeledDraftBatchIncompleteReason {
  if (outcome.kind === "cancelled") return "cancelled";
  if (outcome.kind === "deadline") return "deadline";
  if (outcome.kind === "reviewer_unavailable") return "reviewer_unavailable";
  if (outcome.kind === "writer_error") return "writer_unavailable";
  return "protocol_error";
}

function isUsagePersistenceError(error: unknown): boolean {
  return (
    error instanceof UsagePersistenceError ||
    (error instanceof Error && error.name === "UsagePersistenceError")
  );
}

export async function executeModeledDraftBatch(
  input: ExecuteModeledDraftBatchInput,
  dependencies: ModeledDraftBatchDependencies,
): Promise<ModeledDraftBatchResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  if (!validRequest(input)) {
    return { kind: "failed", reason: "invalid_request", usage };
  }
  if (input.sources.length < input.count) {
    return { kind: "failed", reason: "insufficient_sources", usage };
  }

  let acquired: ModeledDraftBatchAcquireResult;
  try {
    acquired = await dependencies.repository.acquire({
      workspaceId: input.workspaceId,
      operationKey: input.operationKey,
      requestHash: requestHash(input),
      requestedCount: input.count,
      sources: input.sources,
    });
  } catch {
    return {
      kind: "incomplete",
      reason: "store_unavailable",
      preservedSlots: 0,
      requestedCount: input.count,
      usage,
    };
  }
  if (acquired.kind === "conflict") {
    return { kind: "failed", reason: "state_conflict", usage };
  }
  if (acquired.kind === "unavailable") {
    return {
      kind: "incomplete",
      reason: "store_unavailable",
      preservedSlots: 0,
      requestedCount: input.count,
      usage,
    };
  }
  if (acquired.kind === "busy") {
    return {
      kind: "incomplete",
      reason: "busy",
      preservedSlots: 0,
      requestedCount: input.count,
      usage,
    };
  }
  if (acquired.kind === "complete") {
    if (
      acquired.artifacts.some(
        (artifact, index) =>
          !replayArtifactIsCanonical(artifact, acquired.batchId, index),
      )
    ) {
      return { kind: "failed", reason: "state_corrupt", usage };
    }
    const slots = acquired.artifacts.map((artifact, index) => ({
      index,
      state: "accepted" as const,
      sourceIndex: index,
      sourceHistory: [index],
      replacements: 0,
      artifact,
    }));
    const artifacts = orderedArtifacts(input.count, slots);
    return artifacts
      ? { kind: "complete", batchId: acquired.batchId, artifacts, usage }
      : { kind: "failed", reason: "state_corrupt", usage };
  }

  const checkpoint = acquired.checkpoint;
  const expectedRequestHash = requestHash(input);
  if (!acquiredCheckpointIsCanonical(checkpoint, expectedRequestHash, input.count)) {
    return { kind: "failed", reason: "state_corrupt", usage };
  }
  let slots = checkpoint.slots.map((slot) => ({ ...slot }));

  const deadlineController = new AbortController();
  const fatalController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  if (input.deadlineAtMs !== undefined) {
    const remaining = input.deadlineAtMs - dependencies.now();
    if (remaining <= 0) deadlineController.abort();
    else deadlineTimer = setTimeout(() => deadlineController.abort(), remaining);
  }
  const signals = [
    input.signal,
    input.engineInput.signal,
    deadlineController.signal,
    fatalController.signal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = AbortSignal.any(signals);

  const incomplete = async (
    reason: ModeledDraftBatchIncompleteReason,
  ): Promise<ModeledDraftBatchResult> => {
    await dependencies.repository
      .release({
        batchId: checkpoint.batchId,
        leaseToken: checkpoint.leaseToken,
        reason,
      })
      .catch(() => {});
    return {
      kind: "incomplete",
      batchId: checkpoint.batchId,
      reason,
      preservedSlots: preservedCount(slots),
      requestedCount: input.count,
      usage,
    };
  };

  try {
    while (slots.some((slot) => slot.state !== "accepted")) {
      if (signal.aborted) {
        return incomplete(
          deadlineController.signal.aborted && !input.signal?.aborted
            ? "deadline"
            : "cancelled",
        );
      }
      const acceptedBodies = slots.flatMap((slot) =>
        slot.state === "accepted" && slot.artifact ? [slot.artifact.body] : [],
      );
      const pending = slots
        .filter((slot) => slot.state !== "accepted")
        .sort((left, right) => left.index - right.index)
        .slice(0, MODELED_DRAFT_CONCURRENCY);
      const outcomes = await Promise.all(
        pending.map(async (slot): Promise<ModeledDraftSlotOutcome> => {
          const source = checkpoint.sources[slot.sourceIndex];
          const slotIdentity = {
            id: `${checkpoint.batchId}:slot-${slot.index}`,
            index: slot.index,
          };
          try {
            return await dependencies.runSlot({
              slot: slotIdentity,
              source,
              batch: {
                count: input.count,
                previousBodies: acceptedBodies,
              },
              engineInput: {
                ...input.engineInput,
                userInstruction: input.instruction,
                finalizationProfile: "modeled_batch",
                priorPostDrafts: [
                  ...input.engineInput.priorPostDrafts,
                  ...acceptedBodies.map((body, index) => ({
                    id: `${checkpoint.batchId}:accepted-${index}`,
                    body,
                    createdAt: new Date(index).toISOString(),
                  })),
                ],
                signal,
              },
            });
          } catch (error) {
            if (isUsagePersistenceError(error)) {
              fatalController.abort();
              throw error;
            }
            const kind = signal.aborted
              ? deadlineController.signal.aborted && !input.signal?.aborted
                ? "deadline"
                : "cancelled"
              : "writer_error";
            return {
              kind,
              slot: slotIdentity,
              inputTokens: 0,
              outputTokens: 0,
            };
          }
        }),
      );

      let stopReason: ModeledDraftBatchIncompleteReason | null = null;
      for (const outcome of outcomes.sort((left, right) => left.slot.index - right.slot.index)) {
        usage.inputTokens += outcome.inputTokens;
        usage.outputTokens += outcome.outputTokens;
        const slot = slots.find((candidate) => candidate.index === outcome.slot.index);
        if (!slot || slot.state === "accepted") {
          return { kind: "failed", reason: "state_corrupt", usage };
        }
        if (outcome.kind === "accepted") {
          const source = checkpoint.sources[slot.sourceIndex];
          const duplicate = slots.some(
            (candidate) =>
              candidate.state === "accepted" &&
              candidate.artifact &&
              areDraftsNearDuplicate(candidate.artifact.body, outcome.artifact.body),
          );
          if (
            !duplicate &&
            canonicalArtifactForSlot({
              artifact: outcome.artifact,
              batchId: checkpoint.batchId,
              slotIndex: slot.index,
              source,
            })
          ) {
            const saved = await dependencies.repository
              .acceptSlot({
                batchId: checkpoint.batchId,
                leaseToken: checkpoint.leaseToken,
                slotIndex: slot.index,
                sourceIndex: slot.sourceIndex,
                expectedState:
                  slot.state === "candidate" ? "candidate" : "assigned",
                artifact: outcome.artifact,
              })
              .catch(() => false);
            if (!saved) {
              stopReason = "store_unavailable";
              continue;
            }
            slots = slots.map((candidate) =>
              candidate.index === slot.index
                ? { ...candidate, state: "accepted" as const, artifact: outcome.artifact }
                : candidate,
            );
            continue;
          }
          if (!duplicate) {
            stopReason = "protocol_error";
            continue;
          }
        } else if (outcome.kind !== "rejected") {
          stopReason = outcomeReason(outcome);
          continue;
        }

        if (slot.replacements >= MAX_SOURCE_REPLACEMENTS_PER_SLOT) {
          stopReason = "slot_exhausted";
          continue;
        }
        const reserveIndex = nextReserveSourceIndex(checkpoint, slots);
        if (reserveIndex === null) {
          stopReason = "source_pool_exhausted";
          continue;
        }
        const failureCode =
          outcome.kind === "rejected" ? outcome.code : "duplicate";
        const replaced = await dependencies.repository
          .replaceSlotSource({
            batchId: checkpoint.batchId,
            leaseToken: checkpoint.leaseToken,
            slotIndex: slot.index,
            sourceIndex: reserveIndex,
            failureCode,
          })
          .catch(() => false);
        if (!replaced) {
          stopReason = "store_unavailable";
          continue;
        }
        slots = slots.map((candidate) =>
          candidate.index === slot.index
            ? {
                ...candidate,
                state: "assigned" as const,
                sourceIndex: reserveIndex,
                sourceHistory: [...candidate.sourceHistory, reserveIndex],
                replacements: candidate.replacements + 1,
                lastFailureCode: failureCode,
                artifact: undefined,
              }
            : candidate,
        );
      }
      if (stopReason) return incomplete(stopReason);
    }

    const localArtifacts = orderedArtifacts(input.count, slots);
    if (!localArtifacts) {
      return { kind: "failed", reason: "state_corrupt", usage };
    }
    const completed = await dependencies.repository
      .complete({
        batchId: checkpoint.batchId,
        leaseToken: checkpoint.leaseToken,
      })
      .catch(() => ({ kind: "incomplete" as const }));
    if (completed.kind !== "complete") {
      return incomplete("store_unavailable");
    }
    const persistedSlots = completed.artifacts.map((artifact, index) => ({
      index,
      state: "accepted" as const,
      sourceIndex: index,
      sourceHistory: [index],
      replacements: 0,
      artifact,
    }));
    const artifacts = orderedArtifacts(input.count, persistedSlots);
    if (
      artifacts?.some(
        (artifact, index) =>
          !replayArtifactIsCanonical(artifact, checkpoint.batchId, index),
      )
    ) {
      return { kind: "failed", reason: "state_corrupt", usage };
    }
    return artifacts
      ? {
          kind: "complete",
          batchId: checkpoint.batchId,
          artifacts,
          usage,
        }
      : { kind: "failed", reason: "state_corrupt", usage };
  } catch (error) {
    fatalController.abort();
    await dependencies.repository
      .release({
        batchId: checkpoint.batchId,
        leaseToken: checkpoint.leaseToken,
        reason: "store_unavailable",
      })
      .catch(() => {});
    throw error;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

export const productionModeledDraftBatchDependencies = {
  runSlot: runModeledDraftSlot,
};

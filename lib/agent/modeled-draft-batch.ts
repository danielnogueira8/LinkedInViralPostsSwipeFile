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
const MODELED_DRAFT_BATCH_MAX_DURATION_MS = 240_000;
const MODELED_DRAFT_STORE_CLEANUP_MS = 5_000;
const MAX_GENERATION_CONTEXT_CHARS = 250_000;

export type ModeledDraftBatchSource = Omit<
  CanonicalWorkspaceModelingSource,
  "url"
> &
  Readonly<{ url: string }>;
export type ModeledPostArtifact = Artifact & { kind: "post" };

type ModeledDraftSlotBase = Readonly<{
  index: number;
  sourceIndex: number;
  sourceHistory: readonly number[];
  replacements: number;
  lastFailureCode?: string;
}>;

export type ModeledDraftSlotCheckpoint = ModeledDraftSlotBase &
  Readonly<
    | { state: "assigned"; artifact?: never }
    | { state: "accepted"; artifact: ModeledPostArtifact }
  >;

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
  | { kind: "busy"; batchId: string }
  | { kind: "conflict" }
  | { kind: "insufficient_sources" }
  | { kind: "unavailable" };

export interface ModeledDraftBatchRepository {
  acquire(input: {
    workspaceId: string;
    operationKey: string;
    requestHash: string;
    requestedCount: number;
    sources: readonly ModeledDraftBatchSource[];
    signal: AbortSignal;
  }): Promise<ModeledDraftBatchAcquireResult>;
  acceptSlot(input: {
    batchId: string;
    leaseToken: string;
    slotIndex: number;
    sourceIndex: number;
    artifact: ModeledPostArtifact;
    signal: AbortSignal;
  }): Promise<boolean>;
  replaceSlotSource(input: {
    batchId: string;
    leaseToken: string;
    slotIndex: number;
    sourceIndex: number;
    failureCode: string;
    signal: AbortSignal;
  }): Promise<boolean>;
  complete(input: {
    batchId: string;
    leaseToken: string;
    signal: AbortSignal;
  }): Promise<
    | { kind: "complete"; artifacts: readonly ModeledPostArtifact[] }
    | { kind: "incomplete" }
    | { kind: "lease_lost" }
  >;
  release(input: {
    batchId: string;
    leaseToken: string;
    reason: ModeledDraftBatchReleaseReason;
    signal: AbortSignal;
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

export type ModeledDraftBatchReleaseReason = Exclude<
  ModeledDraftBatchIncompleteReason,
  "busy"
>;

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

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite context number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Cyclic generation context");
    seen.add(value);
    const serialized = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (seen.has(record)) throw new TypeError("Cyclic generation context");
    seen.add(record);
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`,
      );
    seen.delete(record);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError("Unsupported generation context value");
}

function requestHash(input: ExecuteModeledDraftBatchInput): string | null {
  try {
    const context = canonicalJson({
      version: 2,
      workspaceId: input.workspaceId,
      instruction: input.instruction,
      count: input.count,
      generation: {
        voiceResult: input.engineInput.voiceResult,
        preferences: input.engineInput.preferences,
        feedbackMemory: input.engineInput.feedbackMemory,
        priorPostDrafts: input.engineInput.priorPostDrafts,
        format: input.engineInput.format ?? null,
        customSkillBodies: input.engineInput.customSkillBodies ?? [],
        customSkillNames: input.engineInput.customSkillNames ?? [],
        leadMagnetBlock: input.engineInput.leadMagnetBlock ?? null,
        creatorStyleBlock: input.engineInput.creatorStyleBlock ?? null,
        lean: input.engineInput.lean ?? false,
      },
    });
    if (context.length > MAX_GENERATION_CONTEXT_CHARS) return null;
    return createHash("sha256").update(context).digest("hex");
  } catch {
    return null;
  }
}

function validSourcePool(
  sources: readonly ModeledDraftBatchSource[],
  maximum: number,
): boolean {
  if (sources.length > maximum) return false;
  const ids = new Set<string>();
  return sources.every((source) => {
    if (
      source === null ||
      typeof source !== "object" ||
      typeof source.id !== "string" ||
      typeof source.text !== "string"
    ) {
      return false;
    }
    const id = source.id.trim();
    const text = source.text.trim();
    if (
      !id ||
      id !== source.id ||
      id.length > 200 ||
      ids.has(id) ||
      !text ||
      source.text.length > MAX_SOURCE_TEXT_CHARS ||
      !isCanonicalModeledSourceUrl(source.url)
    ) {
      return false;
    }
    ids.add(id);
    return true;
  });
}

export function isCanonicalModeledSourceUrl(
  value: unknown,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim()
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.href === value
    );
  } catch {
    return false;
  }
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
    (input.deadlineAtMs !== undefined &&
      !Number.isFinite(input.deadlineAtMs)) ||
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
  const sourceUrl = meta?.source_url;
  const provenanceUrl = provenanceSource?.url;
  return (
    meta?.modeled_draft_slot_id === `${batchId}:slot-${slotIndex}` &&
    meta.modeled_draft_slot_index === slotIndex &&
    meta.source === "model_source" &&
    typeof sourceId === "string" &&
    provenance?.route === "workspace_research" &&
    provenanceSources.length === 1 &&
    provenanceSource?.id === sourceId &&
    provenanceSource.kind === "workspace_post" &&
    isCanonicalModeledSourceUrl(sourceUrl) &&
    provenanceUrl === sourceUrl
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
  const bodies: string[] = [];
  for (let index = 0; index < requestedCount; index += 1) {
    const slot = slots.find((candidate) => candidate.index === index);
    if (!slot || slot.state !== "accepted" || !slot.artifact) return null;
    const bodyKey = normalizeDraftKey(slot.artifact.body);
    if (
      !slot.artifact.id ||
      ids.has(slot.artifact.id) ||
      !bodyKey ||
      bodies.some((body) => areDraftsNearDuplicate(body, slot.artifact.body))
    ) {
      return null;
    }
    ids.add(slot.artifact.id);
    bodies.push(slot.artifact.body);
    artifacts.push(slot.artifact);
  }
  return artifacts;
}

export function artifactMatchesModeledDraftSlotContract(input: {
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
    meta.source_url !== input.source.url
  ) {
    return false;
  }
  const provenance = recordOf(meta.research_provenance);
  if (provenance?.route !== "workspace_research") return false;
  const provenanceSources = provenance.sources;
  const provenanceSource = Array.isArray(provenanceSources)
    ? recordOf(provenanceSources[0])
    : null;
  return (
    Array.isArray(provenanceSources) &&
    provenanceSources.length === 1 &&
    provenanceSource?.id === input.source.id &&
    provenanceSource.kind === "workspace_post" &&
    provenanceSource.url === input.source.url
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
      if (slot.artifact !== undefined) return false;
      continue;
    }
    if (
      slot.state !== "accepted" ||
      !slot.artifact ||
      slot.artifact.kind !== "post" ||
      !slot.artifact.body.trim() ||
      slot.artifact.body.length > RENDER_POST_MAX_CHARS ||
      !artifactMatchesModeledDraftSlotContract({
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
): ModeledDraftBatchReleaseReason {
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

class ModeledBatchAbortError extends Error {
  constructor() {
    super("Modeled draft batch operation aborted");
    this.name = "AbortError";
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ModeledBatchAbortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ModeledBatchAbortError());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function interruptionReason(input: {
  deadlineController: AbortController;
  deadlineAtMs?: number;
  now: () => number;
}): "cancelled" | "deadline" {
  return input.deadlineController.signal.aborted ||
    (input.deadlineAtMs !== undefined && input.now() >= input.deadlineAtMs)
    ? "deadline"
    : "cancelled";
}

export async function executeModeledDraftBatch(
  input: ExecuteModeledDraftBatchInput,
  dependencies: ModeledDraftBatchDependencies,
): Promise<ModeledDraftBatchResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const expectedRequestHash = requestHash(input);
  if (!validRequest(input) || !expectedRequestHash) {
    return { kind: "failed", reason: "invalid_request", usage };
  }
  const deadlineController = new AbortController();
  const fatalController = new AbortController();
  const now = dependencies.now();
  const requestedRemaining =
    input.deadlineAtMs === undefined
      ? MODELED_DRAFT_BATCH_MAX_DURATION_MS
      : input.deadlineAtMs - now;
  const remaining = Math.min(
    MODELED_DRAFT_BATCH_MAX_DURATION_MS,
    requestedRemaining,
  );
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  if (remaining <= 0) deadlineController.abort();
  else deadlineTimer = setTimeout(() => deadlineController.abort(), remaining);

  const stopSignal = AbortSignal.any(
    [input.signal, input.engineInput.signal, deadlineController.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    ),
  );
  const runSignal = AbortSignal.any([stopSignal, fatalController.signal]);
  const stoppedReason = (): "cancelled" | "deadline" =>
    interruptionReason({
      deadlineController,
      deadlineAtMs: input.deadlineAtMs,
      now: dependencies.now,
    });
  const unacquiredIncomplete = (
    reason: ModeledDraftBatchIncompleteReason,
    batchId?: string,
    preservedSlots = 0,
  ): ModeledDraftBatchResult => ({
    kind: "incomplete",
    ...(batchId ? { batchId } : {}),
    reason,
    preservedSlots,
    requestedCount: input.count,
    usage,
  });

  try {
    if (stopSignal.aborted) return unacquiredIncomplete(stoppedReason());

    let acquired: ModeledDraftBatchAcquireResult;
    try {
      acquired = await abortable(
        dependencies.repository.acquire({
          workspaceId: input.workspaceId,
          operationKey: input.operationKey,
          requestHash: expectedRequestHash,
          requestedCount: input.count,
          sources: input.sources,
          signal: stopSignal,
        }),
        stopSignal,
      );
    } catch {
      return unacquiredIncomplete(
        stopSignal.aborted ? stoppedReason() : "store_unavailable",
      );
    }

    const releaseCheckpoint = async (
      checkpoint: AcquiredModeledDraftBatch,
      reason: ModeledDraftBatchReleaseReason,
    ): Promise<void> => {
      const cleanupSignal = AbortSignal.timeout(MODELED_DRAFT_STORE_CLEANUP_MS);
      await abortable(
        dependencies.repository.release({
          batchId: checkpoint.batchId,
          leaseToken: checkpoint.leaseToken,
          reason,
          signal: cleanupSignal,
        }),
        cleanupSignal,
      ).catch(() => {});
    };

    if (stopSignal.aborted) {
      if (acquired.kind === "acquired") {
        await releaseCheckpoint(acquired.checkpoint, stoppedReason());
        return unacquiredIncomplete(
          stoppedReason(),
          acquired.checkpoint.batchId,
          preservedCount(acquired.checkpoint.slots),
        );
      }
      const knownBatchId =
        acquired.kind === "complete" || acquired.kind === "busy"
          ? acquired.batchId
          : undefined;
      return unacquiredIncomplete(
        stoppedReason(),
        knownBatchId,
        acquired.kind === "complete" ? acquired.artifacts.length : 0,
      );
    }
    if (acquired.kind === "conflict") {
      return { kind: "failed", reason: "state_conflict", usage };
    }
    if (acquired.kind === "insufficient_sources") {
      return { kind: "failed", reason: "insufficient_sources", usage };
    }
    if (acquired.kind === "unavailable") {
      return unacquiredIncomplete("store_unavailable");
    }
    if (acquired.kind === "busy") {
      return unacquiredIncomplete("busy", acquired.batchId);
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
      const replaySlots = acquired.artifacts.map((artifact, index) => ({
        index,
        state: "accepted" as const,
        sourceIndex: index,
        sourceHistory: [index],
        replacements: 0,
        artifact,
      }));
      const artifacts = orderedArtifacts(input.count, replaySlots);
      if (stopSignal.aborted) {
        return unacquiredIncomplete(
          stoppedReason(),
          acquired.batchId,
          artifacts?.length ?? 0,
        );
      }
      return artifacts
        ? { kind: "complete", batchId: acquired.batchId, artifacts, usage }
        : { kind: "failed", reason: "state_corrupt", usage };
    }

    const checkpoint = acquired.checkpoint;
    if (
      !acquiredCheckpointIsCanonical(
        checkpoint,
        expectedRequestHash,
        input.count,
      )
    ) {
      await releaseCheckpoint(checkpoint, "protocol_error");
      return { kind: "failed", reason: "state_corrupt", usage };
    }
    let slots = checkpoint.slots.map((slot) => ({ ...slot }));

    const incomplete = async (
      reason: ModeledDraftBatchReleaseReason,
    ): Promise<ModeledDraftBatchResult> => {
      await releaseCheckpoint(checkpoint, reason);
      return unacquiredIncomplete(
        reason,
        checkpoint.batchId,
        preservedCount(slots),
      );
    };

    let fatalError: unknown = null;
    let stateCorrupt = false;
    let mutationTail: Promise<void> = Promise.resolve();
    const enqueueMutation = (mutation: () => Promise<void>): Promise<void> => {
      const current = mutationTail.then(mutation, mutation);
      mutationTail = current.catch(() => {});
      return current;
    };

    while (slots.some((slot) => slot.state !== "accepted")) {
      if (stopSignal.aborted) return incomplete(stoppedReason());
      const acceptedBodies = slots.flatMap((slot) =>
        slot.state === "accepted" ? [slot.artifact.body] : [],
      );
      const pending = slots
        .filter((slot) => slot.state !== "accepted")
        .sort((left, right) => left.index - right.index)
        .slice(0, MODELED_DRAFT_CONCURRENCY);
      const stopReasons: Array<{
        slotIndex: number;
        reason: ModeledDraftBatchReleaseReason;
      }> = [];

      const processOutcome = async (
        outcome: ModeledDraftSlotOutcome,
      ): Promise<void> => {
        usage.inputTokens += outcome.inputTokens;
        usage.outputTokens += outcome.outputTokens;
        if (stopSignal.aborted) return;
        const slot = slots.find(
          (candidate) => candidate.index === outcome.slot.index,
        );
        if (!slot || slot.state === "accepted") {
          stateCorrupt = true;
          return;
        }
        if (outcome.kind === "accepted") {
          const source = checkpoint.sources[slot.sourceIndex];
          const duplicate = slots.some(
            (candidate) =>
              candidate.state === "accepted" &&
              areDraftsNearDuplicate(
                candidate.artifact.body,
                outcome.artifact.body,
              ),
          );
          if (
            !duplicate &&
            artifactMatchesModeledDraftSlotContract({
              artifact: outcome.artifact,
              batchId: checkpoint.batchId,
              slotIndex: slot.index,
              source,
            })
          ) {
            if (stopSignal.aborted) return;
            let saved = false;
            try {
              saved = await abortable(
                dependencies.repository.acceptSlot({
                  batchId: checkpoint.batchId,
                  leaseToken: checkpoint.leaseToken,
                  slotIndex: slot.index,
                  sourceIndex: slot.sourceIndex,
                  artifact: outcome.artifact,
                  signal: stopSignal,
                }),
                stopSignal,
              );
            } catch {
              if (!stopSignal.aborted) {
                stopReasons.push({
                  slotIndex: slot.index,
                  reason: "store_unavailable",
                });
              }
              return;
            }
            if (!saved) {
              stopReasons.push({
                slotIndex: slot.index,
                reason: "store_unavailable",
              });
              return;
            }
            slots = slots.map((candidate) =>
              candidate.index === slot.index
                ? {
                    ...candidate,
                    state: "accepted" as const,
                    artifact: outcome.artifact,
                  }
                : candidate,
            );
            return;
          }
          if (!duplicate) {
            stopReasons.push({
              slotIndex: slot.index,
              reason: "protocol_error",
            });
            return;
          }
        } else if (outcome.kind !== "rejected") {
          stopReasons.push({
            slotIndex: slot.index,
            reason: outcomeReason(outcome),
          });
          return;
        }

        if (slot.replacements >= MAX_SOURCE_REPLACEMENTS_PER_SLOT) {
          stopReasons.push({
            slotIndex: slot.index,
            reason: "slot_exhausted",
          });
          return;
        }
        const reserveIndex = nextReserveSourceIndex(checkpoint, slots);
        if (reserveIndex === null) {
          stopReasons.push({
            slotIndex: slot.index,
            reason: "source_pool_exhausted",
          });
          return;
        }
        const failureCode =
          outcome.kind === "rejected" ? outcome.code : "duplicate";
        if (stopSignal.aborted) return;
        let replaced = false;
        try {
          replaced = await abortable(
            dependencies.repository.replaceSlotSource({
              batchId: checkpoint.batchId,
              leaseToken: checkpoint.leaseToken,
              slotIndex: slot.index,
              sourceIndex: reserveIndex,
              failureCode,
              signal: stopSignal,
            }),
            stopSignal,
          );
        } catch {
          if (!stopSignal.aborted) {
            stopReasons.push({
              slotIndex: slot.index,
              reason: "store_unavailable",
            });
          }
          return;
        }
        if (!replaced) {
          stopReasons.push({
            slotIndex: slot.index,
            reason: "store_unavailable",
          });
          return;
        }
        slots = slots.map((candidate) =>
          candidate.index === slot.index
            ? {
                index: candidate.index,
                state: "assigned" as const,
                sourceIndex: reserveIndex,
                sourceHistory: [...candidate.sourceHistory, reserveIndex],
                replacements: candidate.replacements + 1,
                lastFailureCode: failureCode,
              }
            : candidate,
        );
      };

      const workers = pending.map(async (slot): Promise<void> => {
        const source = checkpoint.sources[slot.sourceIndex];
        const slotIdentity = {
          id: `${checkpoint.batchId}:slot-${slot.index}`,
          index: slot.index,
        };
        let outcome: ModeledDraftSlotOutcome;
        try {
          outcome = await abortable(
            dependencies.runSlot({
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
                signal: runSignal,
              },
            }),
            runSignal,
          );
        } catch (error) {
          if (isUsagePersistenceError(error)) {
            fatalError ??= error;
            fatalController.abort();
            return;
          }
          if (runSignal.aborted) return;
          outcome = {
            kind: "writer_error",
            slot: slotIdentity,
            inputTokens: 0,
            outputTokens: 0,
          };
        }
        await enqueueMutation(() => processOutcome(outcome));
      });
      const settled = await Promise.allSettled(workers);
      for (const worker of settled) {
        if (worker.status === "rejected") {
          fatalError ??= worker.reason;
          fatalController.abort();
        }
      }
      await mutationTail;
      if (fatalError) {
        await releaseCheckpoint(checkpoint, "store_unavailable");
        throw fatalError;
      }
      if (stateCorrupt) {
        await releaseCheckpoint(checkpoint, "protocol_error");
        return { kind: "failed", reason: "state_corrupt", usage };
      }
      if (stopSignal.aborted) return incomplete(stoppedReason());
      const stopReason = stopReasons.sort(
        (left, right) => left.slotIndex - right.slotIndex,
      )[0]?.reason;
      if (stopReason) return incomplete(stopReason);
    }

    if (stopSignal.aborted) return incomplete(stoppedReason());
    const localArtifacts = orderedArtifacts(input.count, slots);
    if (!localArtifacts) {
      await releaseCheckpoint(checkpoint, "protocol_error");
      return { kind: "failed", reason: "state_corrupt", usage };
    }
    let completed: Awaited<
      ReturnType<ModeledDraftBatchRepository["complete"]>
    >;
    try {
      completed = await abortable(
        dependencies.repository.complete({
          batchId: checkpoint.batchId,
          leaseToken: checkpoint.leaseToken,
          signal: stopSignal,
        }),
        stopSignal,
      );
    } catch {
      return incomplete(
        stopSignal.aborted ? stoppedReason() : "store_unavailable",
      );
    }
    if (stopSignal.aborted) return incomplete(stoppedReason());
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
    if (stopSignal.aborted) return incomplete(stoppedReason());
    return artifacts
      ? {
          kind: "complete",
          batchId: checkpoint.batchId,
          artifacts,
          usage,
        }
      : { kind: "failed", reason: "state_corrupt", usage };
  } finally {
    fatalController.abort();
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

export const productionModeledDraftBatchDependencies = {
  runSlot: runModeledDraftSlot,
};

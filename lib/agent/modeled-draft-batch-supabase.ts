import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import {
  executeModeledDraftBatch,
  productionModeledDraftBatchDependencies,
  type AcquiredModeledDraftBatch,
  type ExecuteModeledDraftBatchInput,
  type ModeledDraftBatchRepository,
  type ModeledDraftBatchSource,
  type ModeledDraftSlotCheckpoint,
  type ModeledPostArtifact,
} from "@/lib/agent/modeled-draft-batch";

const LEASE_SECONDS = 270;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSourceJson(source: ModeledDraftBatchSource) {
  return {
    id: source.id,
    text: source.text,
    url: source.url ?? null,
    title: source.title ?? null,
    published_at: source.publishedAt ?? null,
    hash: textHash(source.text),
  };
}

function parseSource(value: unknown): ModeledDraftBatchSource | null {
  const source = recordOf(value);
  if (
    typeof source?.id !== "string" ||
    typeof source.text !== "string" ||
    typeof source.hash !== "string" ||
    textHash(source.text) !== source.hash
  ) {
    return null;
  }
  return {
    id: source.id,
    text: source.text,
    ...(typeof source.url === "string" ? { url: source.url } : {}),
    ...(typeof source.title === "string" ? { title: source.title } : {}),
    ...(typeof source.published_at === "string"
      ? { publishedAt: source.published_at }
      : {}),
  };
}

function parseArtifact(
  acceptedValue: unknown,
  source: ModeledDraftBatchSource,
  slotIndex: number,
): ModeledPostArtifact | null {
  const accepted = recordOf(acceptedValue);
  const provenance = recordOf(accepted?.provenance);
  const artifactData = recordOf(provenance?.artifact);
  const meta = recordOf(artifactData?.meta);
  const body = typeof accepted?.body === "string" ? accepted.body : "";
  if (
    !body ||
    typeof accepted?.hash !== "string" ||
    textHash(body) !== accepted.hash ||
    provenance?.kind !== "modeled" ||
    provenance.source_id !== source.id ||
    provenance.source_hash !== textHash(source.text) ||
    typeof artifactData?.id !== "string" ||
    typeof artifactData.title !== "string" ||
    meta?.modeled_draft_slot_index !== slotIndex ||
    meta.source_post_id !== source.id
  ) {
    return null;
  }
  return {
    id: artifactData.id,
    kind: "post",
    title: artifactData.title,
    body,
    meta,
  };
}

function parseCheckpoint(value: unknown): AcquiredModeledDraftBatch | null {
  const root = recordOf(value);
  const rawSources = Array.isArray(root?.sources) ? root.sources : [];
  const sources = rawSources.map(parseSource);
  if (
    typeof root?.batch_id !== "string" ||
    typeof root.lease_token !== "string" ||
    typeof root.request_hash !== "string" ||
    !Number.isInteger(root.expected_count) ||
    sources.length !== rawSources.length ||
    sources.some((source) => source === null) ||
    !Array.isArray(root.slots)
  ) {
    return null;
  }
  const canonicalSources = sources as ModeledDraftBatchSource[];
  const sourceIndexes = new Map(
    canonicalSources.map((source, index) => [source.id, index]),
  );
  const slots: ModeledDraftSlotCheckpoint[] = [];
  for (const rawSlot of root.slots) {
    const slot = recordOf(rawSlot);
    if (!slot) return null;
    const source = parseSource(slot?.source);
    const slotIndex = slot?.slot_index;
    const sourceIndex = source ? sourceIndexes.get(source.id) : undefined;
    const state = slot?.state;
    const historyIds = Array.isArray(slot?.source_history)
      ? slot.source_history
      : source
        ? [source.id]
        : [];
    const sourceHistory = historyIds.map((id) =>
      typeof id === "string" ? sourceIndexes.get(id) : undefined,
    );
    if (
      !Number.isInteger(slotIndex) ||
      (state !== "assigned" && state !== "candidate" && state !== "accepted") ||
      sourceIndex === undefined ||
      sourceHistory.some((index) => index === undefined)
    ) {
      return null;
    }
    const artifact =
      state === "accepted"
        ? parseArtifact(slot.accepted, canonicalSources[sourceIndex], slotIndex as number)
        : undefined;
    if (state === "accepted" && !artifact) return null;
    const candidate = recordOf(slot.candidate);
    slots.push({
      index: slotIndex as number,
      state,
      sourceIndex,
      sourceHistory: sourceHistory as number[],
      replacements:
        typeof slot.replacement_count === "number"
          ? slot.replacement_count
          : Math.max(0, sourceHistory.length - 1),
      ...(candidate && typeof candidate.body === "string"
        ? { candidateBody: candidate.body }
        : {}),
      ...(artifact ? { artifact } : {}),
      ...(typeof slot.rejection_code === "string"
        ? { lastFailureCode: slot.rejection_code }
        : {}),
    });
  }
  return {
    batchId: root.batch_id,
    leaseToken: root.lease_token,
    requestHash: root.request_hash,
    requestedCount: root.expected_count as number,
    sources: canonicalSources,
    slots,
  };
}

function artifactsFromCompleted(value: unknown): ModeledPostArtifact[] | null {
  const root = recordOf(value);
  const checkpoint = parseCheckpoint({
    ...root,
    lease_token:
      typeof root?.lease_token === "string"
        ? root.lease_token
        : "00000000-0000-0000-0000-000000000000",
    request_hash:
      typeof root?.request_hash === "string" ? root.request_hash : "completed",
  });
  if (!checkpoint) return null;
  const artifacts = [...checkpoint.slots]
    .sort((left, right) => left.index - right.index)
    .flatMap((slot) => (slot.state === "accepted" && slot.artifact ? [slot.artifact] : []));
  return artifacts.length === checkpoint.requestedCount ? artifacts : null;
}

class SupabaseModeledDraftBatchRepository
  implements ModeledDraftBatchRepository
{
  private readonly sourcePools = new Map<string, readonly ModeledDraftBatchSource[]>();
  private readonly workspaces = new Map<string, string>();

  async acquire(input: Parameters<ModeledDraftBatchRepository["acquire"]>[0]) {
    const { data, error } = await supabaseAdmin().rpc(
      "claim_modeled_draft_batch",
      {
        p_workspace_id: input.workspaceId,
        p_operation_key: input.operationKey,
        p_request_hash: input.requestHash,
        p_expected_count: input.requestedCount,
        p_sources: input.sources.map(canonicalSourceJson),
        p_lease_seconds: LEASE_SECONDS,
      },
    );
    if (error) {
      return error.code === "22023" && /conflict/i.test(error.message)
        ? ({ kind: "conflict" } as const)
        : ({ kind: "unavailable" } as const);
    }
    const root = recordOf(data);
    if (!root || typeof root.status !== "string") {
      return { kind: "unavailable" } as const;
    }
    if (root.status === "busy") return { kind: "busy" } as const;
    if (root.status === "completed") {
      const artifacts = artifactsFromCompleted(root);
      return artifacts && typeof root.batch_id === "string"
        ? ({
            kind: "complete",
            batchId: root.batch_id,
            artifacts,
          } as const)
        : ({ kind: "unavailable" } as const);
    }
    if (root.status !== "created" && root.status !== "resumed") {
      return { kind: "unavailable" } as const;
    }
    const checkpoint = parseCheckpoint(root);
    if (!checkpoint) return { kind: "unavailable" } as const;
    this.sourcePools.set(checkpoint.batchId, checkpoint.sources);
    this.workspaces.set(checkpoint.batchId, input.workspaceId);
    return { kind: "acquired", checkpoint } as const;
  }

  async acceptSlot(
    input: Parameters<ModeledDraftBatchRepository["acceptSlot"]>[0],
  ): Promise<boolean> {
    const source = this.sourcePools.get(input.batchId)?.[input.sourceIndex];
    const workspaceId = this.workspaces.get(input.batchId);
    if (!source || !workspaceId) return false;
    const { data, error } = await supabaseAdmin().rpc(
      "checkpoint_modeled_draft_slot",
      {
        p_workspace_id: workspaceId,
        p_batch_id: input.batchId,
        p_lease_token: input.leaseToken,
        p_slot_index: input.slotIndex,
        p_expected_state: input.expectedState,
        p_next_state: "accepted",
        p_source_id: source.id,
        p_body: input.artifact.body,
        p_provenance: {
          kind: "modeled",
          source_id: source.id,
          source_url: source.url ?? null,
          source_hash: textHash(source.text),
          artifact: {
            id: input.artifact.id,
            title: input.artifact.title,
            meta: input.artifact.meta ?? {},
          },
        },
        p_rejection_code: null,
        p_attempt_increment: 1,
        p_lease_seconds: LEASE_SECONDS,
      },
    );
    return !error && recordOf(data)?.state === "accepted";
  }

  async replaceSlotSource(
    input: Parameters<ModeledDraftBatchRepository["replaceSlotSource"]>[0],
  ): Promise<boolean> {
    const source = this.sourcePools.get(input.batchId)?.[input.sourceIndex];
    const workspaceId = this.workspaces.get(input.batchId);
    if (!source || !workspaceId) return false;
    const { data, error } = await supabaseAdmin().rpc(
      "checkpoint_modeled_draft_slot",
      {
        p_workspace_id: workspaceId,
        p_batch_id: input.batchId,
        p_lease_token: input.leaseToken,
        p_slot_index: input.slotIndex,
        p_expected_state: "assigned",
        p_next_state: "assigned",
        p_source_id: source.id,
        p_body: null,
        p_provenance: null,
        p_rejection_code: input.failureCode,
        p_attempt_increment: 1,
        p_lease_seconds: LEASE_SECONDS,
      },
    );
    return !error && recordOf(data)?.state === "assigned";
  }

  async complete(
    input: Parameters<ModeledDraftBatchRepository["complete"]>[0],
  ) {
    const workspaceId = this.workspaces.get(input.batchId);
    if (!workspaceId) return { kind: "lease_lost" as const };
    const { data, error } = await supabaseAdmin().rpc(
      "complete_modeled_draft_batch",
      {
        p_workspace_id: workspaceId,
        p_batch_id: input.batchId,
        p_lease_token: input.leaseToken,
      },
    );
    if (error) return { kind: "lease_lost" as const };
    const artifacts = artifactsFromCompleted(data);
    return artifacts
      ? ({ kind: "complete", artifacts } as const)
      : ({ kind: "incomplete" } as const);
  }

  async release(
    input: Parameters<ModeledDraftBatchRepository["release"]>[0],
  ): Promise<void> {
    const workspaceId = this.workspaces.get(input.batchId);
    if (!workspaceId) return;
    await supabaseAdmin().rpc("release_modeled_draft_batch", {
      p_workspace_id: workspaceId,
      p_batch_id: input.batchId,
      p_lease_token: input.leaseToken,
      p_reason: input.reason,
    });
  }
}

export function createSupabaseModeledDraftBatchRepository(): ModeledDraftBatchRepository {
  return new SupabaseModeledDraftBatchRepository();
}

export async function executeProductionModeledDraftBatch(
  input: ExecuteModeledDraftBatchInput,
) {
  return executeModeledDraftBatch(input, {
    repository: createSupabaseModeledDraftBatchRepository(),
    runSlot: productionModeledDraftBatchDependencies.runSlot,
    now: Date.now,
  });
}

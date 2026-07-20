import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSupabaseModeledDraftBatchRepository } from "@/lib/agent/modeled-draft-batch-supabase";
import type {
  ModeledDraftBatchSource,
  ModeledPostArtifact,
} from "@/lib/agent/execute/writer";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({ rpc: mocks.rpc }),
}));

const batchId = "00000000-0000-4000-8000-000000000801";
const leaseToken = "00000000-0000-4000-8000-000000000802";
const requestHash = "a".repeat(64);
const sources: ModeledDraftBatchSource[] = [
  {
    id: "source-1",
    text: "Source one has a clear hook, explanatory middle, and practical close.",
    url: "https://linkedin.com/posts/source-1",
    title: "Source one title",
    publishedAt: "2026-07-17T09:00:00.000Z",
  },
  {
    id: "source-2",
    text: "Source two opens with contrast, develops one argument, and closes directly.",
    url: "https://linkedin.com/posts/source-2",
    title: "Source two title",
    publishedAt: "2026-07-16T09:00:00.000Z",
  },
];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mockRpcResult(result: unknown): void {
  mocks.rpc.mockReturnValueOnce({
    abortSignal: vi.fn().mockResolvedValue(result),
  });
}

function sourceJson(source: ModeledDraftBatchSource) {
  return {
    id: source.id,
    text: source.text,
    url: source.url,
    title: source.title,
    published_at: source.publishedAt,
    hash: hash(source.text),
  };
}

function artifact(slotIndex: number): ModeledPostArtifact {
  const source = sources[slotIndex];
  return {
    id: `artifact-${slotIndex}`,
    kind: "post",
    title: `Draft ${slotIndex + 1}`,
    body: `Original modeled draft ${slotIndex + 1} with a complete argument and close.`,
    meta: {
      modeled_draft_slot_id: `${batchId}:slot-${slotIndex}`,
      modeled_draft_slot_index: slotIndex,
      source: "model_source",
      source_post_id: source.id,
      source_url: source.url,
      research_provenance: {
        route: "workspace_research",
        sources: [
          {
            id: source.id,
            kind: "workspace_post",
            url: source.url,
          },
        ],
      },
    },
  };
}

function slotJson(slotIndex: number, acceptedArtifact?: ModeledPostArtifact) {
  const source = sources[slotIndex];
  return {
    batch_id: batchId,
    slot_index: slotIndex,
    state: acceptedArtifact ? "accepted" : "assigned",
    source: sourceJson(source),
    source_history: [source.id],
    replacement_count: 0,
    accepted: acceptedArtifact
      ? {
          body: acceptedArtifact.body,
          hash: hash(acceptedArtifact.body),
          provenance: {
            kind: "modeled",
            source_id: source.id,
            source_url: source.url,
            source_hash: hash(source.text),
            artifact: {
              id: acceptedArtifact.id,
              title: acceptedArtifact.title,
              meta: acceptedArtifact.meta,
            },
          },
        }
      : null,
    attempt_count: acceptedArtifact ? 1 : 0,
    rejection_code: null,
  };
}

async function acquiredRepository() {
  mockRpcResult({
    data: {
      status: "created",
      batch_id: batchId,
      request_hash: requestHash,
      lease_token: leaseToken,
      expected_count: 2,
      sources: sources.map(sourceJson),
      slots: [slotJson(0), slotJson(1)],
    },
    error: null,
  });
  const repository = createSupabaseModeledDraftBatchRepository();
  await expect(
    repository.acquire({
      workspaceId: "workspace-1",
      operationKey: "root-message-1",
      requestHash,
      requestedCount: 2,
      sources,
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({ kind: "acquired" });
  return repository;
}

describe("SupabaseModeledDraftBatchRepository", () => {
  beforeEach(() => mocks.rpc.mockReset());

  test("round-trips the migration 107 claim and nested accepted provenance shape", async () => {
    mockRpcResult({
      data: {
        status: "created",
        batch_id: batchId,
        request_hash: requestHash,
        lease_token: leaseToken,
        expected_count: 2,
        sources: sources.map(sourceJson),
        slots: [slotJson(0), slotJson(1)],
      },
      error: null,
    });
    const repository = createSupabaseModeledDraftBatchRepository();
    const acquired = await repository.acquire({
      workspaceId: "workspace-1",
      operationKey: "root-message-1",
      requestHash,
      requestedCount: 2,
      sources,
      signal: new AbortController().signal,
    });

    expect(acquired).toMatchObject({
      kind: "acquired",
      checkpoint: {
        batchId,
        requestHash,
        requestedCount: 2,
      },
    });
    expect(
      acquired.kind === "acquired" ? acquired.checkpoint.sources[0] : null,
    ).toMatchObject({
      title: "Source one title",
      publishedAt: "2026-07-17T09:00:00.000Z",
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      "claim_modeled_draft_batch",
      expect.objectContaining({
        p_operation_key: "root-message-1",
        p_request_hash: requestHash,
        p_expected_count: 2,
      }),
    );

    mockRpcResult({ data: { state: "accepted" }, error: null });
    expect(
      await repository.acceptSlot({
        batchId,
        leaseToken,
        slotIndex: 0,
        sourceIndex: 0,
        artifact: artifact(0),
        signal: new AbortController().signal,
      }),
    ).toBe(true);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "checkpoint_modeled_draft_slot",
      expect.objectContaining({
        p_slot_index: 0,
        p_source_id: "source-1",
        p_provenance: expect.objectContaining({
          source_id: "source-1",
          artifact: expect.objectContaining({ id: "artifact-0" }),
        }),
      }),
    );

    const completedArtifacts = [artifact(0), artifact(1)];
    mockRpcResult({
      data: {
        status: "completed",
        batch_id: batchId,
        expected_count: 2,
        sources: sources.map(sourceJson),
        slots: completedArtifacts.map((item, index) => slotJson(index, item)),
      },
      error: null,
    });
    const completed = await repository.complete({
      batchId,
      leaseToken,
      signal: new AbortController().signal,
    });

    expect(completed).toMatchObject({ kind: "complete" });
    expect(completed.kind === "complete" ? completed.artifacts : []).toEqual(
      completedArtifacts,
    );
  });

  test("sends the exact fenced source-replacement and release RPC contracts", async () => {
    const repository = await acquiredRepository();

    mockRpcResult({ data: { state: "assigned" }, error: null });
    await expect(
      repository.replaceSlotSource({
        batchId,
        leaseToken,
        slotIndex: 1,
        sourceIndex: 0,
        failureCode: "source_fidelity",
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "checkpoint_modeled_draft_slot", {
      p_workspace_id: "workspace-1",
      p_batch_id: batchId,
      p_lease_token: leaseToken,
      p_slot_index: 1,
      p_expected_state: "assigned",
      p_next_state: "assigned",
      p_source_id: "source-1",
      p_body: null,
      p_provenance: null,
      p_rejection_code: "source_fidelity",
      p_attempt_increment: 1,
      p_lease_seconds: 270,
    });

    mockRpcResult({
      data: { status: "paused", reason: "reviewer_unavailable" },
      error: null,
    });
    await repository.release({
      batchId,
      leaseToken,
      reason: "reviewer_unavailable",
      signal: new AbortController().signal,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, "release_modeled_draft_batch", {
      p_workspace_id: "workspace-1",
      p_batch_id: batchId,
      p_lease_token: leaseToken,
      p_reason: "reviewer_unavailable",
    });
  });

  test("normalizes replacement and completion storage errors without accepting work", async () => {
    const repository = await acquiredRepository();

    mockRpcResult({ data: null, error: { code: "08006", message: "offline" } });
    await expect(
      repository.replaceSlotSource({
        batchId,
        leaseToken,
        slotIndex: 1,
        sourceIndex: 0,
        failureCode: "duplicate",
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(false);

    mockRpcResult({ data: null, error: { code: "40001", message: "lease lost" } });
    await expect(
      repository.complete({
        batchId,
        leaseToken,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "lease_lost" });

    mockRpcResult({ data: { status: "running" }, error: null });
    await expect(
      repository.complete({
        batchId,
        leaseToken,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "incomplete" });
  });

  test("fails closed when a claim omits the request hash required for replay safety", async () => {
    mockRpcResult({
      data: {
        status: "created",
        batch_id: batchId,
        lease_token: leaseToken,
        expected_count: 2,
        sources: sources.map(sourceJson),
        slots: [slotJson(0), slotJson(1)],
      },
      error: null,
    });

    const result = await createSupabaseModeledDraftBatchRepository().acquire({
      workspaceId: "workspace-1",
      operationKey: "root-message-1",
      requestHash,
      requestedCount: 2,
      sources,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  test("fails closed when a claimed frozen source omits its required chip URL", async () => {
    const claimedSources = sources.map(sourceJson);
    const claimedSlots = [slotJson(0), slotJson(1)];
    const sourceWithoutUrl: Partial<(typeof claimedSources)[number]> = {
      ...claimedSources[0],
    };
    delete sourceWithoutUrl.url;
    claimedSources[0] = sourceWithoutUrl as (typeof claimedSources)[number];
    claimedSlots[0] = {
      ...claimedSlots[0],
      source: sourceWithoutUrl,
    } as (typeof claimedSlots)[number];
    mockRpcResult({
      data: {
        status: "created",
        batch_id: batchId,
        request_hash: requestHash,
        lease_token: leaseToken,
        expected_count: 2,
        sources: claimedSources,
        slots: claimedSlots,
      },
      error: null,
    });

    const result = await createSupabaseModeledDraftBatchRepository().acquire({
      workspaceId: "workspace-1",
      operationKey: "root-message-1",
      requestHash,
      requestedCount: 2,
      sources,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  test("rejects completed replay when artifact metadata drops the frozen source URL", async () => {
    const first = artifact(0);
    const second = artifact(1);
    const metaWithoutSourceUrl = { ...(second.meta ?? {}) };
    delete metaWithoutSourceUrl.source_url;
    const corruptedSecond = { ...second, meta: metaWithoutSourceUrl };
    mockRpcResult({
      data: {
        status: "completed",
        batch_id: batchId,
        expected_count: 2,
        sources: sources.map(sourceJson),
        slots: [slotJson(0, first), slotJson(1, corruptedSecond)],
      },
      error: null,
    });

    const result = await createSupabaseModeledDraftBatchRepository().acquire({
      workspaceId: "workspace-1",
      operationKey: "root-message-1",
      requestHash,
      requestedCount: 2,
      sources,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  test("rejects self-consistent forged provenance that disagrees with the frozen source slot", async () => {
    const first = artifact(0);
    const second = artifact(1);
    const forgedUrl = "https://linkedin.com/posts/forged-source";
    const forgedMeta = {
      ...(second.meta ?? {}),
      source_post_id: "forged-source",
      source_url: forgedUrl,
      research_provenance: {
        route: "workspace_research",
        sources: [
          { id: "forged-source", kind: "workspace_post", url: forgedUrl },
        ],
      },
    };
    const forgedSlot = slotJson(1, { ...second, meta: forgedMeta });
    if (!forgedSlot.accepted) throw new Error("expected accepted fixture");
    forgedSlot.accepted.provenance.source_id = "forged-source";
    forgedSlot.accepted.provenance.source_url = forgedUrl;
    mockRpcResult({
      data: {
        status: "completed",
        batch_id: batchId,
        expected_count: 2,
        sources: sources.map(sourceJson),
        slots: [slotJson(0, first), forgedSlot],
      },
      error: null,
    });

    const result = await createSupabaseModeledDraftBatchRepository().acquire({
      workspaceId: "workspace-1",
      operationKey: "root-message-1",
      requestHash,
      requestedCount: 2,
      sources,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  test("classifies a missing creation pool without masking storage failures", async () => {
    mockRpcResult({
      data: null,
      error: {
        code: "22023",
        message: "invalid modeled draft source pool",
      },
    });

    const result = await createSupabaseModeledDraftBatchRepository().acquire({
      workspaceId: "workspace-1",
      operationKey: "root-message-1",
      requestHash,
      requestedCount: 2,
      sources: [],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "insufficient_sources" });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_modeled_draft_batch",
      expect.objectContaining({ p_sources: [] }),
    );
  });

  test("preserves the durable batch identity for a busy claimant", async () => {
    mockRpcResult({
      data: {
        status: "busy",
        batch_id: batchId,
      },
      error: null,
    });

    const result = await createSupabaseModeledDraftBatchRepository().acquire({
      workspaceId: "workspace-1",
      operationKey: "root-message-1",
      requestHash,
      requestedCount: 2,
      sources,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "busy", batchId });
  });
});

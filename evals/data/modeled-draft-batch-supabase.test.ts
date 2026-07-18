import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSupabaseModeledDraftBatchRepository } from "@/lib/agent/modeled-draft-batch-supabase";
import type {
  ModeledDraftBatchSource,
  ModeledPostArtifact,
} from "@/lib/agent/modeled-draft-batch";

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
  },
  {
    id: "source-2",
    text: "Source two opens with contrast, develops one argument, and closes directly.",
    url: "https://linkedin.com/posts/source-2",
  },
];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceJson(source: ModeledDraftBatchSource) {
  return {
    id: source.id,
    text: source.text,
    url: source.url,
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
    candidate: acceptedArtifact
      ? { body: acceptedArtifact.body, hash: hash(acceptedArtifact.body) }
      : null,
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

describe("SupabaseModeledDraftBatchRepository", () => {
  beforeEach(() => mocks.rpc.mockReset());

  test("round-trips the migration 107 claim and nested accepted provenance shape", async () => {
    mocks.rpc.mockResolvedValueOnce({
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
    });

    expect(acquired).toMatchObject({
      kind: "acquired",
      checkpoint: {
        batchId,
        requestHash,
        requestedCount: 2,
      },
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

    mocks.rpc.mockResolvedValueOnce({ data: { state: "accepted" }, error: null });
    expect(
      await repository.acceptSlot({
        batchId,
        leaseToken,
        slotIndex: 0,
        sourceIndex: 0,
        expectedState: "assigned",
        artifact: artifact(0),
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
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: "completed",
        batch_id: batchId,
        expected_count: 2,
        sources: sources.map(sourceJson),
        slots: completedArtifacts.map((item, index) => slotJson(index, item)),
      },
      error: null,
    });
    const completed = await repository.complete({ batchId, leaseToken });

    expect(completed).toMatchObject({ kind: "complete" });
    expect(completed.kind === "complete" ? completed.artifacts : []).toEqual(
      completedArtifacts,
    );
  });

  test("fails closed when a claim omits the request hash required for replay safety", async () => {
    mocks.rpc.mockResolvedValueOnce({
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
    });

    expect(result).toEqual({ kind: "unavailable" });
  });
});

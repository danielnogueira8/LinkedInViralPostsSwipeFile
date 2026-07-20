import { describe, expect, test, vi } from "vitest";
import type { AgentEvent, Artifact } from "@/lib/agent/contracts";
import type { DraftEngineInput } from "@/lib/agent/draft-engine";
import { UsagePersistenceError } from "@/lib/openrouter";
import {
  runModeledDraftSlot,
  type ModeledDraftSlotInput,
  type ModeledDraftSlotRunner,
} from "@/lib/agent/modeled-draft-slot-runner";

const POST: Artifact & { kind: "post" } = {
  id: "draft-1",
  kind: "post",
  title: "A useful draft",
  body: "A useful draft keeps every structural beat while changing the subject matter.",
  meta: { existing: "kept" },
};

const engineInput: Omit<DraftEngineInput, "task"> = {
  workspaceId: "workspace-1",
  userInstruction: "Model one source post in my voice.",
  voiceResult: { ok: true },
  preferences: [],
  feedbackMemory: [],
  priorPostDrafts: [],
};

const slotInput: ModeledDraftSlotInput = {
  slot: { id: "batch-7:slot-2", index: 2 },
  source: {
    id: "source-2",
    text: "A canonical workspace source with a repeatable structure.",
    url: "https://linkedin.com/posts/source-2",
    title: "Source two",
    publishedAt: "2026-07-17T09:00:00.000Z",
  },
  engineInput,
};

function done(
  inputTokens = 123,
  outputTokens = 45,
  terminalReason: Extract<AgentEvent, { type: "done" }>["terminalReason"] =
    "done",
): Extract<AgentEvent, { type: "done" }> {
  return {
    type: "done",
    terminalReason,
    message: {
      content: "Your draft is ready.",
      tool_calls: null,
      artifacts: [],
      toolMessages: [],
      inputTokens,
      outputTokens,
    },
  };
}

function scriptedRunner(
  events: AgentEvent[],
  before?: (input: DraftEngineInput) => void,
): ModeledDraftSlotRunner {
  return async function* (input) {
    before?.(input);
    for (const event of events) yield event;
  };
}

describe("runModeledDraftSlot", () => {
  test("returns one canonical source-tagged artifact with the terminal usage", async () => {
    const inspectInput = vi.fn<(input: DraftEngineInput) => void>();
    const result = await runModeledDraftSlot(
      {
        ...slotInput,
        batch: {
          count: 4,
          previousBodies: ["One concurrently accepted post."],
        },
      },
      {
        runDraftEngine: scriptedRunner(
          [{ type: "artifact", artifact: POST }, done()],
          inspectInput,
        ),
      },
    );

    expect(inspectInput).toHaveBeenCalledWith(
      expect.objectContaining({
        task: {
          kind: "source",
          source: {
            id: "source-2",
            text: "A canonical workspace source with a repeatable structure.",
          },
          variation: {
            index: 3,
            count: 4,
            previousBodies: ["One concurrently accepted post."],
          },
        },
        enableStructureGate: true,
      }),
    );
    expect(result).toEqual({
      kind: "accepted",
      slot: { id: "batch-7:slot-2", index: 2 },
      artifact: {
        ...POST,
        meta: {
          existing: "kept",
          modeled_draft_slot_id: "batch-7:slot-2",
          modeled_draft_slot_index: 2,
          source: "model_source",
          source_post_id: "source-2",
          source_url: "https://linkedin.com/posts/source-2",
          research_provenance: {
            route: "workspace_research",
            sources: [
              {
                id: "source-2",
                kind: "workspace_post",
                title: "Source two",
                url: "https://linkedin.com/posts/source-2",
                published_at: "2026-07-17T09:00:00.000Z",
              },
            ],
          },
        },
      },
      inputTokens: 123,
      outputTokens: 45,
    });
  });

  test.each([
    ["a non-integer count", { count: 3.5, previousBodies: ["one", "two"] }],
    ["a count above the batch limit", { count: 7, previousBodies: ["one", "two"] }],
    ["an out-of-range slot", { count: 2, previousBodies: ["one", "two"] }],
    [
      "too many preceding drafts",
      { count: 4, previousBodies: ["one", "two", "three", "four"] },
    ],
    [
      "duplicate preceding drafts",
      { count: 4, previousBodies: ["same", " same "] },
    ],
    [
      "an oversized preceding draft",
      { count: 4, previousBodies: ["x".repeat(3_501), "two"] },
    ],
  ] as const)("rejects bounded batch context with %s", async (_name, batch) => {
    const runner = vi.fn<ModeledDraftSlotRunner>();

    await expect(
      runModeledDraftSlot({ ...slotInput, batch }, { runDraftEngine: runner }),
    ).rejects.toThrow(/batch context/i);
    expect(runner).not.toHaveBeenCalled();
  });

  test.each([-1, 1.5, 6])(
    "rejects invalid standalone slot index %s before invoking the engine",
    async (index) => {
      const runner = vi.fn<ModeledDraftSlotRunner>();

      await expect(
        runModeledDraftSlot(
          { ...slotInput, slot: { id: `invalid-slot-${index}`, index } },
          { runDraftEngine: runner },
        ),
      ).rejects.toThrow(/slot index/i);
      expect(runner).not.toHaveBeenCalled();
    },
  );

  test("replaces artifact-supplied provenance with the canonical source", async () => {
    const result = await runModeledDraftSlot(
      {
        ...slotInput,
        source: { id: "canonical-source", text: "Canonical source text." },
      },
      {
        runDraftEngine: scriptedRunner([
          {
            type: "artifact",
            artifact: {
              ...POST,
              meta: {
                existing: "kept",
                source: "untrusted",
                source_post_id: "spoofed-source",
                source_url: "https://attacker.invalid/spoofed-source",
                research_provenance: { route: "untrusted" },
              },
            },
          },
          done(),
        ]),
      },
    );

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.artifact.meta).toEqual({
      existing: "kept",
      modeled_draft_slot_id: "batch-7:slot-2",
      modeled_draft_slot_index: 2,
      source: "model_source",
      source_post_id: "canonical-source",
      research_provenance: {
        route: "workspace_research",
        sources: [{ id: "canonical-source", kind: "workspace_post" }],
      },
    });
  });

  test("returns the final allowlisted content rejection without leaking model prose", async () => {
    const observeDecision = vi.fn();
    const runner = scriptedRunner(
      [
        {
          type: "error",
          code: "draft_engine_exhausted",
          message: "raw model-facing repair prose",
          recovery: "continue",
        },
        done(210, 95),
      ],
      (input) => {
        input.onFinalizerDecision?.({
          origin: "direct_writer",
          outcome: "rejected",
          rejectionCode: "structure_mismatch",
          sourceVerified: true,
          edited: false,
          repaired: false,
          samenessRewrote: false,
        });
      },
    );

    await expect(
      runModeledDraftSlot(
        {
          ...slotInput,
          engineInput: {
            ...slotInput.engineInput,
            onFinalizerDecision: observeDecision,
          },
        },
        { runDraftEngine: runner },
      ),
    ).resolves.toEqual({
      kind: "rejected",
      slot: slotInput.slot,
      code: "structure_mismatch",
      inputTokens: 210,
      outputTokens: 95,
    });
    expect(observeDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "rejected",
        rejectionCode: "structure_mismatch",
      }),
    );
  });

  test("keeps reviewer unavailability distinct from content rejection", async () => {
    const runner = scriptedRunner(
      [
        {
          type: "error",
          code: "draft_engine_source_fidelity_unavailable",
          message: "Both reviewers were unavailable.",
          recovery: "continue",
        },
        done(180, 72),
      ],
      (input) => {
        input.onFinalizerDecision?.({
          origin: "direct_writer",
          outcome: "rejected",
          rejectionCode: "source_fidelity_unavailable",
          sourceVerified: true,
          edited: false,
          repaired: false,
          samenessRewrote: false,
        });
      },
    );

    await expect(
      runModeledDraftSlot(slotInput, { runDraftEngine: runner }),
    ).resolves.toEqual({
      kind: "reviewer_unavailable",
      slot: slotInput.slot,
      inputTokens: 180,
      outputTokens: 72,
    });
  });

  test("returns a writer error when the engine exhausts without a content verdict", async () => {
    const runner = scriptedRunner([
      {
        type: "error",
        code: "draft_engine_exhausted",
        message: "Writer transports failed.",
        recovery: "continue",
      },
      done(70, 0),
    ]);

    await expect(
      runModeledDraftSlot(slotInput, { runDraftEngine: runner }),
    ).resolves.toEqual({
      kind: "writer_error",
      slot: slotInput.slot,
      inputTokens: 70,
      outputTokens: 0,
    });
  });

  test("returns a writer error when the engine stream throws before its terminal", async () => {
    const runner: ModeledDraftSlotRunner = async function* () {
      throw new Error("writer transport failed");
    };

    await expect(
      runModeledDraftSlot(slotInput, { runDraftEngine: runner }),
    ).resolves.toEqual({
      kind: "writer_error",
      slot: slotInput.slot,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  test.each([
    ["deadline", "deadline"],
    ["cancelled", "cancelled"],
  ] as const)("returns %s as its own typed outcome", async (kind, terminal) => {
    await expect(
      runModeledDraftSlot(slotInput, {
        runDraftEngine: scriptedRunner([done(41, 12, terminal)]),
      }),
    ).resolves.toEqual({
      kind,
      slot: slotInput.slot,
      inputTokens: 41,
      outputTokens: 12,
    });
  });

  test.each([
    ["zero artifacts", [done()], "missing_artifact"],
    [
      "multiple artifacts",
      [
        { type: "artifact", artifact: POST },
        { type: "artifact", artifact: { ...POST, id: "draft-2" } },
        done(),
      ],
      "multiple_artifacts",
    ],
    [
      "an artifact and an error",
      [
        { type: "artifact", artifact: POST },
        {
          type: "error",
          code: "draft_engine_exhausted",
          message: "failed",
          recovery: "continue",
        },
        done(),
      ],
      "artifact_with_error",
    ],
    [
      "a missing terminal",
      [{ type: "artifact", artifact: POST }],
      "missing_terminal",
    ],
    [
      "multiple terminals",
      [{ type: "artifact", artifact: POST }, done(), done()],
      "multiple_terminals",
    ],
    [
      "a non-post artifact",
      [
        {
          type: "artifact",
          artifact: { ...POST, kind: "hook" as const },
        },
        done(),
      ],
      "mismatched_artifact_kind",
    ],
  ] satisfies Array<[string, AgentEvent[], string]>)(
    "rejects %s as protocol error %s",
    async (_name, events, code) => {
      const result = await runModeledDraftSlot(slotInput, {
        runDraftEngine: scriptedRunner(events),
      });

      expect(result).toMatchObject({
        kind: "protocol_error",
        slot: slotInput.slot,
        code,
      });
    },
  );

  test("rethrows authoritative usage persistence failures", async () => {
    const runner: ModeledDraftSlotRunner = async function* () {
      throw new UsagePersistenceError("usage insert failed");
    };

    await expect(
      runModeledDraftSlot(slotInput, { runDraftEngine: runner }),
    ).rejects.toThrow(UsagePersistenceError);
  });
});

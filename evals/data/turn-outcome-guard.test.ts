import { describe, expect, test } from "vitest";
import type { AgentEvent, Artifact } from "@/lib/agent/contracts";
import type { TurnPlan } from "@/lib/agent/turn/compile";
import {
  enforceTurnOutcome,
  TurnOutcomeInvariantError,
} from "@/lib/agent/turn/outcome-guard";
import { persistedFailureContent } from "@/lib/agent/turn/finalize";

const target: Artifact & { kind: "post" } = {
  id: "draft-current",
  kind: "post",
  title: "Current",
  body: "Current draft.",
};

function common(contract: TurnPlan["contract"]) {
  return {
    contract,
    existingArtifactIds: [],
    atomicDraftSet: false,
    modeledBatchContinuation: null,
    activeModeledBatchContinuation: null,
    modeledBatchRetryRootUserMessageId: undefined,
    directPostCount: null,
    modelSourceReference: null,
  };
}

function done(artifacts: Artifact[] = []): AgentEvent {
  return {
    type: "done",
    message: {
      content: "Done",
      tool_calls: null,
      artifacts,
      toolMessages: [],
      inputTokens: 0,
      outputTokens: 0,
    },
  };
}

async function* events(...items: AgentEvent[]) {
  yield* items;
}

async function collect(stream: AsyncIterable<AgentEvent>) {
  const result: AgentEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

describe("turn outcome guard", () => {
  test("an answer operation cannot emit an artifact", async () => {
    const plan: TurnPlan = {
      ...common({ kind: "answer", expectedCount: 1 }),
      kind: "answer",
      route: "answer",
    };

    await expect(
      collect(
        enforceTurnOutcome(
          plan,
          events({ type: "artifact", artifact: target }, done([target])),
        ),
      ),
    ).rejects.toBeInstanceOf(TurnOutcomeInvariantError);
  });

  test("an edit cannot change artifact identity", async () => {
    const plan: TurnPlan = {
      ...common({ kind: "post", expectedCount: 1 }),
      kind: "write",
      route: "direct_writer",
      task: {
        kind: "refine",
        instruction: "Make it sharper.",
        focus: "general",
        target,
      },
      isDirectRefine: false,
      usesLeadMagnet: false,
      usesCreatorStyle: false,
    };
    const replacement = { ...target, id: "draft-new" };

    await expect(
      collect(
        enforceTurnOutcome(
          plan,
          events({ type: "artifact", artifact: replacement }, done()),
        ),
      ),
    ).rejects.toThrow("different artifact id");
  });

  test("a create operation cannot reuse an existing post identity", async () => {
    const plan: TurnPlan = {
      ...common({ kind: "post", expectedCount: 1 }),
      existingArtifactIds: [target.id],
      kind: "write",
      route: "direct_writer",
      task: { kind: "original" },
      isDirectRefine: false,
      usesLeadMagnet: false,
      usesCreatorStyle: false,
    };

    await expect(
      collect(
        enforceTurnOutcome(
          plan,
          events({ type: "artifact", artifact: target }, done([target])),
        ),
      ),
    ).rejects.toThrow("create operation attempted to reuse an existing artifact id");
  });

  test("authorized artifacts are released only with a valid successful terminal", async () => {
    const plan: TurnPlan = {
      ...common({ kind: "post", expectedCount: 1 }),
      kind: "write",
      route: "direct_writer",
      task: { kind: "original" },
      isDirectRefine: false,
      usesLeadMagnet: false,
      usesCreatorStyle: false,
    };

    const output = await collect(
      enforceTurnOutcome(
        plan,
        events({ type: "artifact", artifact: target }, done([target])),
      ),
    );
    expect(output.map((event) => event.type)).toEqual(["artifact", "done"]);
  });

  test("an explicit Create discards a recoverable partial set", async () => {
    const plan: TurnPlan = {
      ...common({ kind: "post", expectedCount: 2 }),
      atomicDraftSet: true,
      kind: "write",
      route: "direct_writer",
      task: { kind: "original" },
      isDirectRefine: false,
      usesLeadMagnet: false,
      usesCreatorStyle: false,
    };
    const output = await collect(
      enforceTurnOutcome(
        plan,
        events(
          { type: "artifact", artifact: target },
          {
            type: "error",
            code: "partial_batch",
            message: "One slot could not be completed.",
            recovery: "continue",
          },
          {
            type: "done",
            terminalReason: "error",
            message: {
              content: "Done",
              tool_calls: null,
              artifacts: [target],
              toolMessages: [],
              inputTokens: 0,
              outputTokens: 0,
            },
          },
        ),
      ),
    );

    expect(output.some((event) => event.type === "artifact")).toBe(false);
    const terminal = output.find((event) => event.type === "done");
    expect(terminal?.type === "done" ? terminal.message.artifacts : null).toEqual([]);
  });

  test("a Create Post contract rejects Hook artifacts", async () => {
    const plan: TurnPlan = {
      ...common({ kind: "post", expectedCount: 1 }),
      atomicDraftSet: true,
      kind: "write",
      route: "direct_writer",
      task: { kind: "original" },
      isDirectRefine: false,
      usesLeadMagnet: false,
      usesCreatorStyle: false,
    };
    const hook: Artifact = { ...target, kind: "hook" };

    await expect(
      collect(
        enforceTurnOutcome(
          plan,
          events({ type: "artifact", artifact: hook }, done([hook])),
        ),
      ),
    ).rejects.toThrow("non-Post artifact");
  });

  test("invariant failures cannot persist streamed draft text as an answer", () => {
    const leakedDraft = "This unauthorized replacement must not survive.";
    const persisted = persistedFailureContent(
      new TurnOutcomeInvariantError("answer emitted a draft"),
      leakedDraft,
    );

    expect(persisted).not.toContain(leakedDraft);
    expect(persisted).toContain("Nothing was changed");
  });
});

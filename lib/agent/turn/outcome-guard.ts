import type { AgentEvent, Artifact } from "@/lib/agent/contracts";
import { isBoardMutationToolName } from "@/lib/agent/tool-capabilities";
import type { TurnPlan } from "@/lib/agent/turn/compile";

export class TurnOutcomeInvariantError extends Error {
  readonly code = "turn_outcome_invariant";

  constructor(message: string) {
    super(message);
    this.name = "TurnOutcomeInvariantError";
  }
}

function assertArtifactAuthorized(plan: TurnPlan, artifact: Artifact): void {
  if (artifact.kind === "cite") {
    if (plan.kind !== "research") {
      throw new TurnOutcomeInvariantError(
        `${plan.kind} operation emitted an unauthorized citation artifact`,
      );
    }
    return;
  }

  if (plan.kind === "answer" || plan.kind === "clarify" || plan.kind === "action") {
    throw new TurnOutcomeInvariantError(
      `${plan.kind} operation emitted an unauthorized draft artifact`,
    );
  }
  if (plan.kind === "write" && plan.task.kind === "partial") {
    throw new TurnOutcomeInvariantError(
      "partial writing operation emitted a draft artifact",
    );
  }
  if (
    artifact.kind !== "post" &&
    plan.contract.kind === "post" &&
    (plan.kind === "research" ||
      (plan.kind === "write" && plan.task.kind !== "refine"))
  ) {
    throw new TurnOutcomeInvariantError(
      "create operation emitted a non-Post artifact",
    );
  }
  if (plan.kind === "write" && plan.task.kind === "refine") {
    if (artifact.id !== plan.task.target.id) {
      throw new TurnOutcomeInvariantError(
        "edit operation attempted to create a different artifact id",
      );
    }
    if (artifact.kind !== plan.task.target.kind) {
      throw new TurnOutcomeInvariantError(
        "edit operation attempted to change the artifact kind",
      );
    }
  }
  if (
    (plan.kind === "research" ||
      (plan.kind === "write" && plan.task.kind !== "refine")) &&
    plan.existingArtifactIds.includes(artifact.id)
  ) {
    throw new TurnOutcomeInvariantError(
      "create operation attempted to reuse an existing artifact id",
    );
  }
}

function assertSuccessfulCount(
  plan: TurnPlan,
  drafts: ReadonlyMap<string, Artifact>,
): void {
  const mustDeliverDrafts =
    plan.contract.kind === "post" &&
    (plan.kind === "write" || plan.kind === "research");
  if (!mustDeliverDrafts) {
    if (drafts.size > 0) {
      throw new TurnOutcomeInvariantError(
        `${plan.contract.kind} contract emitted ${drafts.size} draft artifacts`,
      );
    }
    return;
  }
  if (drafts.size !== plan.contract.expectedCount) {
    throw new TurnOutcomeInvariantError(
      `post contract expected ${plan.contract.expectedCount} artifacts but received ${drafts.size}`,
    );
  }
}

/**
 * Final authority boundary between executors and persistence.
 *
 * Draft/citation artifacts are buffered until a successful terminal event, so
 * a contract or identity violation cannot be partially persisted or rendered.
 */
export async function* enforceTurnOutcome(
  plan: TurnPlan,
  stream: AsyncIterable<AgentEvent>,
): AsyncGenerator<AgentEvent> {
  const buffered = new Map<string, Extract<AgentEvent, { type: "artifact" }>>();
  let sawRecoverableError = false;

  for await (const event of stream) {
    if (event.type === "error" && event.recovery === "continue") {
      sawRecoverableError = true;
    }
    if (
      event.type === "tool_start" &&
      isBoardMutationToolName(event.name) &&
      plan.kind !== "action"
    ) {
      throw new TurnOutcomeInvariantError(
        `${plan.kind} operation attempted an unauthorized board mutation`,
      );
    }

    if (event.type === "artifact") {
      assertArtifactAuthorized(plan, event.artifact);
      buffered.set(`${event.artifact.kind}:${event.artifact.id}`, event);
      continue;
    }

    if (event.type === "done") {
      for (const artifact of event.message.artifacts) {
        assertArtifactAuthorized(plan, artifact);
        const key = `${artifact.kind}:${artifact.id}`;
        if (!buffered.has(key)) {
          buffered.set(key, { type: "artifact", artifact });
        }
      }
      const successful =
        event.terminalReason === undefined || event.terminalReason === "done";

      // Explicit Create is an atomic product command: either the complete,
      // validated set crosses the persistence boundary or none of it does.
      // Legacy turns keep their resumable subset checkpoint behavior during
      // the compatibility window.
      if (plan.atomicDraftSet && (!successful || sawRecoverableError)) {
        buffered.clear();
        sawRecoverableError = false;
        yield {
          ...event,
          message: { ...event.message, artifacts: [] },
        };
        continue;
      }
      if (successful && !sawRecoverableError) {
        const drafts = new Map<string, Artifact>();
        for (const bufferedEvent of buffered.values()) {
          if (bufferedEvent.artifact.kind !== "cite") {
            drafts.set(bufferedEvent.artifact.id, bufferedEvent.artifact);
          }
        }
        assertSuccessfulCount(plan, drafts);
      }
      // Recoverable turns may intentionally checkpoint a strict subset (for
      // example slot 1 of a 3-draft batch). Identity/authorization checks still
      // apply, but exact-count validation belongs to the eventual resumed turn.
      if (successful || sawRecoverableError) {
        for (const bufferedEvent of buffered.values()) yield bufferedEvent;
      }
      buffered.clear();
      sawRecoverableError = false;
    }

    yield event;
  }
}

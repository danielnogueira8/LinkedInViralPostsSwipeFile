import type { ActionOrchestratorRoute } from "@/lib/agent/action-orchestrator-routing";
import type { ReadOnlyOrchestratorRoute } from "@/lib/agent/read-only-orchestrator-routing";

/**
 * The ONE draft-count rule for a turn (PLAN-cowork-unification Phase 1,
 * step 2 COMPILE): every turn resolves to 1-6 drafts, with priority
 * UI override > explicit message count > default 1. Resolution is
 * structural — this function is the only place the priority and the
 * clamp live, and every caller routes through it.
 */
export type TurnCountSource = "ui" | "message" | "default";

export type TurnDraftCount = 1 | 2 | 3 | 4 | 5 | 6;

export const MIN_TURN_DRAFT_COUNT = 1;
export const MAX_TURN_DRAFT_COUNT = 6;

/**
 * A candidate count participates only when it is a finite integer; junk
 * (NaN, Infinity, fractions, non-numbers) falls through to the next
 * source. Valid integers clamp into the 1-6 range instead of being
 * dropped, so "write 10 posts" yields 6, not a silent reset to 1.
 */
function clampedCount(
  value: number | null | undefined,
): TurnDraftCount | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < MIN_TURN_DRAFT_COUNT) return MIN_TURN_DRAFT_COUNT;
  if (value > MAX_TURN_DRAFT_COUNT) return MAX_TURN_DRAFT_COUNT;
  return value as TurnDraftCount;
}

export function resolveTurnCount(input: {
  uiDraftCount?: number | null;
  messageCount?: number | null;
}): { count: TurnDraftCount; source: TurnCountSource } {
  const uiCount = clampedCount(input.uiDraftCount);
  if (uiCount !== null) return { count: uiCount, source: "ui" };
  const messageCount = clampedCount(input.messageCount);
  if (messageCount !== null) return { count: messageCount, source: "message" };
  return { count: MIN_TURN_DRAFT_COUNT, source: "default" };
}

/**
 * The ONE deliverable contract for a turn (PLAN-cowork-unification Phase 1,
 * step 3 COMPILE): the authoritative contract is resolved exactly once per
 * turn, AFTER clarification, from the same post-clarification instruction the
 * executors consume. The pre-claim path builds only a telemetry placeholder
 * through this same builder (never a divergent implementation) plus a
 * count-only estimate for the generation-config stamp and cost-reservation
 * headroom.
 */
export type TurnContractKind =
  | "post"
  | "partial"
  | "research"
  | "saved_draft_action"
  | "answer";

export type TurnContract = {
  kind: TurnContractKind;
  expectedCount: number;
};

/**
 * Structural view of the direct-writer task: the contract only reads the task
 * kind and, for multi-draft tasks, the slot count. Kept structural (instead
 * of importing DraftEngineTask) so the compile module stays free of executor
 * dependencies while the full TurnPlan type lands in later steps.
 */
export type TurnContractDirectTask = {
  kind: string;
  expectedCount?: number;
};

function actionTurnContract(route: ActionOrchestratorRoute): TurnContract {
  return {
    kind: "saved_draft_action",
    expectedCount:
      route.kind === "action_management"
        ? route.targetCount * route.requirements.length
        : 0,
  };
}

function readOnlyTurnContract(route: ReadOnlyOrchestratorRoute): TurnContract {
  return route.expectsDraft
    ? { kind: "post", expectedCount: route.expectedDrafts ?? 1 }
    : { kind: "research", expectedCount: 1 };
}

/**
 * Resolve the turn's single deliverable contract. The priority mirrors the
 * executor that will actually serve the turn:
 *   direct writer > served action route > served read-only route >
 *   unrouted action route > unrouted read-only route > answer lane.
 * When none of the v2 executors claim the turn and the instruction is not a
 * post/partial/refine/source/action/research request, it resolves to the
 * deterministic "answer" contract (kind: "answer", expectedCount: 1).
 * `fallbackPostCount` is the post-clarification post count (UI override >
 * composer task count > refine default), null when the turn is not
 * post-shaped.
 */
export function resolveTurnContract(input: {
  directWriterTask?: TurnContractDirectTask | null;
  actionRoute?: ActionOrchestratorRoute | null;
  useActionOrchestrator?: boolean;
  readOnlyRoute?: ReadOnlyOrchestratorRoute | null;
  useReadOnlyOrchestrator?: boolean;
  hasPartialSpec?: boolean;
  fallbackPostCount?: number | null;
}): TurnContract {
  const directWriterTask = input.directWriterTask ?? null;
  if (directWriterTask) {
    if (directWriterTask.kind === "partial") {
      return { kind: "partial", expectedCount: 1 };
    }
    if (directWriterTask.kind === "multi") {
      return {
        kind: "post",
        expectedCount: directWriterTask.expectedCount ?? 1,
      };
    }
    return { kind: "post", expectedCount: 1 };
  }
  const actionContract = input.actionRoute
    ? actionTurnContract(input.actionRoute)
    : null;
  if (input.useActionOrchestrator && actionContract) return actionContract;
  const readOnlyContract = input.readOnlyRoute
    ? readOnlyTurnContract(input.readOnlyRoute)
    : null;
  if (input.useReadOnlyOrchestrator && readOnlyContract) {
    return readOnlyContract;
  }
  if (actionContract) return actionContract;
  if (readOnlyContract) return readOnlyContract;
  if (input.fallbackPostCount != null) {
    return { kind: "post", expectedCount: input.fallbackPostCount };
  }
  if (input.hasPartialSpec) return { kind: "partial", expectedCount: 1 };
  return { kind: "answer", expectedCount: 1 };
}

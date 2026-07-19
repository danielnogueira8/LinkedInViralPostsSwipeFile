import { openRouterUsageCost, type Usage } from "@/lib/openrouter";
import type { AgentEvent } from "@/lib/agent/contracts";
import { recordCoworkRolloutHealth } from "@/lib/agent/cowork-rollout-health";
import { costEquivalentCredits } from "@/lib/agent/rate-limit";
import type {
  CoworkTurnUsageWire,
  CoworkUsageStageKind,
} from "@/lib/cowork-turn-usage";
import type { TurnOutcome } from "@/lib/agent/turn/outcome";
import type { TurnContract } from "@/lib/agent/turn/compile";

export type CoworkRoute =
  | "setup"
  | "direct_writer"
  | "read_only_orchestrator"
  | "action_orchestrator"
  | "legacy_agent";
// Canonical home is lib/agent/turn/outcome.ts; kept as an alias so existing
// telemetry call sites keep compiling without churn.
export type CoworkTerminalOutcome = TurnOutcome;
export type CoworkProvenanceStatus =
  | "not_required"
  | "verified"
  | "missing"
  | "rejected";
export type CoworkAttemptOutcome =
  | "accepted"
  | "rejected"
  | "failed"
  | "skipped";

// Canonical home is lib/agent/turn/compile.ts; kept as an alias so existing
// telemetry call sites keep compiling without churn.
export type CoworkContract = TurnContract;
export type CoworkDeliveredContract = {
  kind: CoworkContract["kind"];
  deliveredCount: number;
};

export type CoworkTelemetryAttempt = {
  stage: string;
  attempt: number;
  model?: string;
  requestedModel?: string;
  provider?: "openrouter" | "database" | "server";
  outcome: CoworkAttemptOutcome;
  reasonCode?: string;
  fallbackReason?: string;
  latencyMs: number;
  usage?: Usage;
};

type SafeAttempt = {
  stage: string;
  attempt: number;
  model?: string;
  requested_model?: string;
  provider?: "openrouter" | "database" | "server";
  outcome: CoworkAttemptOutcome;
  reason_code?: string;
  fallback_reason?: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  charged_cost_usd: number;
};

export type CoworkTurnTelemetryRecord = {
  trace_id: string;
  workspace_id: string;
  route: CoworkRoute;
  requested_contract: { kind: CoworkContract["kind"]; expected_count: number };
  delivered_contract: {
    kind: CoworkDeliveredContract["kind"];
    delivered_count: number;
  };
  stage_attempts: SafeAttempt[];
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  charged_cost_usd: number;
  provenance_status: CoworkProvenanceStatus;
  terminal_outcome: CoworkTerminalOutcome;
  rollout_mode?: "baseline" | "served_v2" | "dark";
  shadow_candidate_route?: Exclude<CoworkRoute, "setup" | "legacy_agent">;
};

export type CoworkTelemetrySink = (
  record: CoworkTurnTelemetryRecord,
) => unknown | Promise<unknown>;
const MAX_DETAILED_ATTEMPTS = 96;

function safeCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9:_-]+/g, "_")
    .replace(/(?:prompt|body|credential|reasoning|secret)/g, "redacted")
    .replace(/(?:_?redacted){2,}/g, "_redacted")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || undefined;
}

function boundedInteger(value: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.round(value)));
}

function boundedModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/[^a-zA-Z0-9._:/-]+/g, "_").slice(0, 128);
}

const USAGE_STAGE_PREFIXES: ReadonlyArray<{
  kind: CoworkUsageStageKind;
  prefixes: readonly string[];
}> = [
  { kind: "planning", prefixes: ["orchestrator_", "planner_"] },
  {
    kind: "research",
    prefixes: ["research_", "news_", "search_", "inspect_", "freshness_"],
  },
  {
    kind: "writing",
    prefixes: [
      "writer",
      "finalizer",
      "repair_",
      "sameness_",
      "source_fidelity_",
      "backstory_",
      "ai_tell_",
    ],
  },
];

function usageStageKind(stage: string): CoworkUsageStageKind {
  return (
    USAGE_STAGE_PREFIXES.find((rule) =>
      rule.prefixes.some((prefix) => stage.startsWith(prefix)),
    )?.kind ?? "other"
  );
}

export function defaultCoworkTelemetrySink(
  record: CoworkTurnTelemetryRecord,
): void | Promise<void> {
  console.log(JSON.stringify({ cowork_turn_v2: record }));
  if (process.env.NODE_ENV === "test") return;
  return recordCoworkRolloutHealth(record).then(() => undefined);
}

export type CoworkTurnTelemetry = ReturnType<typeof createCoworkTurnTelemetry>;

export function createCoworkTurnTelemetry(
  initial: {
    traceId: string;
    workspaceId: string;
    route: CoworkRoute;
    requestedContract: CoworkContract;
  },
  sink: CoworkTelemetrySink = defaultCoworkTelemetrySink,
  now: () => number = () => Date.now(),
) {
  let base = { ...initial };
  const startedAt = now();
  const attempts: SafeAttempt[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cachedInputTokens = 0;
  let chargedCostUsd = 0;
  const usageByStage = new Map<
    CoworkUsageStageKind,
    { cost: number; models: string[] }
  >();
  let finished = false;
  let latestProvenanceStatus: CoworkProvenanceStatus = "not_required";
  let rolloutMode: CoworkTurnTelemetryRecord["rollout_mode"];
  let shadowCandidateRoute: CoworkTurnTelemetryRecord["shadow_candidate_route"];
  let stagedFinish: {
    deliveredContract: CoworkDeliveredContract;
    provenanceStatus: CoworkProvenanceStatus;
    terminalOutcome: CoworkTerminalOutcome;
  } | null = null;

  return {
    configure(input: {
      traceId?: string;
      route?: CoworkRoute;
      requestedContract?: CoworkContract;
      rolloutMode?: CoworkTurnTelemetryRecord["rollout_mode"];
      shadowCandidateRoute?: CoworkTurnTelemetryRecord["shadow_candidate_route"];
    }): void {
      if (finished) return;
      if (input.rolloutMode) rolloutMode = input.rolloutMode;
      if (input.shadowCandidateRoute) {
        shadowCandidateRoute = input.shadowCandidateRoute;
      }
      base = {
        ...base,
        ...input,
        ...(input.requestedContract
          ? { requestedContract: { ...input.requestedContract } }
          : {}),
      };
    },
    recordAttempt(attempt: CoworkTelemetryAttempt): void {
      if (finished) return;
      const usage = openRouterUsageCost(attempt.model ?? "", attempt.usage);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      reasoningTokens += usage.reasoningTokens;
      cachedInputTokens += usage.cachedInputTokens;
      chargedCostUsd += usage.costUsd;
      if (usage.costUsd > 0) {
        const kind = usageStageKind(safeCode(attempt.stage) ?? "unknown");
        const current = usageByStage.get(kind) ?? { cost: 0, models: [] };
        current.cost += usage.costUsd;
        const model = boundedModel(attempt.model);
        if (model && !current.models.includes(model)) current.models.push(model);
        usageByStage.set(kind, current);
      }
      // Keep the emitted line bounded without losing the authoritative usage
      // totals for long multi-draft turns.
      if (attempts.length >= MAX_DETAILED_ATTEMPTS) return;
      attempts.push({
        stage: safeCode(attempt.stage) ?? "unknown",
        attempt: boundedInteger(attempt.attempt, 100),
        ...(boundedModel(attempt.model)
          ? { model: boundedModel(attempt.model) }
          : {}),
        ...(boundedModel(attempt.requestedModel) &&
        boundedModel(attempt.requestedModel) !== boundedModel(attempt.model)
          ? { requested_model: boundedModel(attempt.requestedModel) }
          : {}),
        ...(attempt.provider ? { provider: attempt.provider } : {}),
        outcome: attempt.outcome,
        ...(safeCode(attempt.reasonCode)
          ? { reason_code: safeCode(attempt.reasonCode) }
          : {}),
        ...(safeCode(attempt.fallbackReason)
          ? { fallback_reason: safeCode(attempt.fallbackReason) }
          : {}),
        latency_ms: boundedInteger(attempt.latencyMs, 600_000),
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        reasoning_tokens: usage.reasoningTokens,
        cached_input_tokens: usage.cachedInputTokens,
        charged_cost_usd: usage.costUsd,
      });
    },
    snapshotUsage(): CoworkTurnUsageWire {
      const order = ["planning", "research", "writing", "other"] as const;
      const totalCredits = costEquivalentCredits(chargedCostUsd);
      const stageRows = order.flatMap((kind) => {
        const stage = usageByStage.get(kind);
        if (!stage) return [];
        return [
          {
            kind,
            cost_usd: Number(stage.cost.toFixed(8)),
            models: stage.models.slice(0, 8),
          },
        ];
      });
      const rawCredits = stageRows.map((stage) =>
        chargedCostUsd > 0
          ? (stage.cost_usd / chargedCostUsd) * totalCredits
          : 0,
      );
      const stageCredits = rawCredits.map(Math.floor);
      let remaining =
        totalCredits - stageCredits.reduce((sum, value) => sum + value, 0);
      const remainderOrder = rawCredits
        .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
        .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
      for (const item of remainderOrder) {
        if (remaining <= 0) break;
        stageCredits[item.index] += 1;
        remaining -= 1;
      }
      return {
        total_credits: totalCredits,
        total_cost_usd: Number(chargedCostUsd.toFixed(8)),
        stages: stageRows.map((stage, index) => ({
          ...stage,
          credits: stageCredits[index],
        })),
      };
    },
    recordFinalizer(input: {
      outcome: "accepted" | "rejected";
      reasonCode?: string;
      provenanceStatus: CoworkProvenanceStatus;
      latencyMs?: number;
    }): void {
      latestProvenanceStatus = input.provenanceStatus;
      this.recordAttempt({
        stage: "finalizer",
        attempt: attempts.filter((attempt) => attempt.stage === "finalizer").length + 1,
        provider: "server",
        outcome: input.outcome,
        reasonCode: input.reasonCode,
        latencyMs: input.latencyMs ?? 0,
      });
    },
    provenanceStatus(): CoworkProvenanceStatus {
      return latestProvenanceStatus;
    },
    setProvenanceStatus(status: CoworkProvenanceStatus): void {
      if (!finished) latestProvenanceStatus = status;
    },
    stageFinish(input: {
      deliveredContract: CoworkDeliveredContract;
      provenanceStatus: CoworkProvenanceStatus;
      terminalOutcome: CoworkTerminalOutcome;
    }): void {
      if (!finished) stagedFinish = input;
    },
    stagedTerminalOutcome(): CoworkTerminalOutcome | null {
      return stagedFinish?.terminalOutcome ?? null;
    },
    async finishStaged(
      terminalOverride?: CoworkTerminalOutcome,
      discardDelivered = false,
    ): Promise<void> {
      const pending = stagedFinish ?? {
        deliveredContract: {
          kind: base.requestedContract.kind,
          deliveredCount: 0,
        },
        provenanceStatus: latestProvenanceStatus,
        terminalOutcome: "hard_failure" as const,
      };
      await this.finish({
        ...pending,
        ...(terminalOverride
          ? {
              terminalOutcome: terminalOverride,
              ...(discardDelivered
                ? {
                    deliveredContract: {
                      ...pending.deliveredContract,
                      deliveredCount: 0,
                    },
                  }
                : {}),
            }
          : {}),
      });
    },
    async finish(input: {
      deliveredContract: CoworkDeliveredContract;
      provenanceStatus: CoworkProvenanceStatus;
      terminalOutcome: CoworkTerminalOutcome;
    }): Promise<void> {
      if (finished) return;
      finished = true;
      const record: CoworkTurnTelemetryRecord = {
        trace_id: boundedModel(base.traceId) ?? "unknown",
        workspace_id: boundedModel(base.workspaceId) ?? "unknown",
        route: base.route,
        requested_contract: {
          kind: base.requestedContract.kind,
          expected_count: boundedInteger(base.requestedContract.expectedCount, 6),
        },
        delivered_contract: {
          kind: input.deliveredContract.kind,
          delivered_count: boundedInteger(input.deliveredContract.deliveredCount, 6),
        },
        stage_attempts: attempts,
        duration_ms: boundedInteger(now() - startedAt, 600_000),
        input_tokens: boundedInteger(inputTokens),
        output_tokens: boundedInteger(outputTokens),
        reasoning_tokens: boundedInteger(reasoningTokens),
        cached_input_tokens: boundedInteger(cachedInputTokens),
        charged_cost_usd: Number(chargedCostUsd.toFixed(8)),
        provenance_status: input.provenanceStatus,
        terminal_outcome: input.terminalOutcome,
        ...(rolloutMode ? { rollout_mode: rolloutMode } : {}),
        ...(shadowCandidateRoute
          ? { shadow_candidate_route: shadowCandidateRoute }
          : {}),
      };
      try {
        await sink(record);
      } catch {
        // Telemetry is operational evidence, never part of the user contract.
        // A broken log transport must not turn a completed Cowork response into
        // a failed or replayed turn.
        console.error(JSON.stringify({ cowork_telemetry_emit_failed: true }));
      }
    },
  };
}

const MUTATING_TOOL_NAMES = new Set([
  "move_on_board",
  "schedule_post",
]);

export async function* observeCoworkTurn(input: {
  stream: AsyncGenerator<AgentEvent>;
  telemetry: CoworkTurnTelemetry;
  contract: CoworkContract;
  signal?: AbortSignal;
  deferFinish?: boolean;
}): AsyncGenerator<AgentEvent> {
  let artifactCount = 0;
  let partialTextDelivered = false;
  let answerTextDelivered = false;
  let committedActionCount = 0;
  let sawAsk = false;
  let sawRecoverableError = false;
  let terminalReason: Extract<AgentEvent, { type: "done" }>["terminalReason"];
  let sawTerminal = false;
  let streamFailed = false;

  try {
    for await (const event of input.stream) {
      if (event.type === "artifact") artifactCount += 1;
      if (event.type === "text" && event.delta.trim()) {
        partialTextDelivered = true;
      }
      if (
        event.type === "tool_end" &&
        event.ok &&
        MUTATING_TOOL_NAMES.has(event.name)
      ) {
        committedActionCount += 1;
      }
      if (event.type === "ask") sawAsk = true;
      if (event.type === "error" && event.recovery === "continue") {
        sawRecoverableError = true;
      }
      if (event.type === "done") {
        sawTerminal = true;
        terminalReason = event.terminalReason;
        if (event.message.content.trim()) answerTextDelivered = true;
      }
      yield event;
    }
  } catch (error) {
    streamFailed = true;
    throw error;
  } finally {
    const observedDeliveredCount =
      input.contract.kind === "saved_draft_action"
        ? committedActionCount
        : input.contract.kind === "partial"
          ? partialTextDelivered
            ? 1
            : 0
          : input.contract.kind === "answer"
            ? sawTerminal &&
              !sawAsk &&
              !sawRecoverableError &&
              (terminalReason === undefined || terminalReason === "done") &&
              (partialTextDelivered || answerTextDelivered)
              ? 1
              : 0
            : input.contract.kind === "research"
            ? sawTerminal && terminalReason === "done" && !sawRecoverableError
              ? 1
              : 0
            : artifactCount;
    const deliveredCount =
      sawTerminal && !streamFailed ? observedDeliveredCount : 0;
    const terminalOutcome: CoworkTerminalOutcome = streamFailed
      ? input.signal?.aborted
        ? "cancelled"
        : "hard_failure"
      : !sawTerminal
        ? input.signal?.aborted
          ? "cancelled"
          : "hard_failure"
        : sawAsk
          ? "clarified"
        : terminalReason === "cancelled"
          ? "cancelled"
          : terminalReason === "ask"
            ? "clarified"
            : terminalReason === "deadline" ||
                terminalReason === "error" ||
                sawRecoverableError
              ? "recoverable_error"
              : deliveredCount > 0
                ? "delivered"
                : "clarified";

    const completion = {
      deliveredContract: { kind: input.contract.kind, deliveredCount },
      provenanceStatus: input.telemetry.provenanceStatus(),
      terminalOutcome,
    };
    if (input.deferFinish) input.telemetry.stageFinish(completion);
    else await input.telemetry.finish(completion);
  }
}

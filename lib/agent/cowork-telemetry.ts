import { openRouterUsageCost, type Usage } from "@/lib/openrouter";
import type { AgentEvent } from "@/lib/agent/contracts";

export type CoworkRoute =
  | "setup"
  | "direct_writer"
  | "read_only_orchestrator"
  | "action_orchestrator"
  | "legacy_agent";
export type CoworkTerminalOutcome =
  | "delivered"
  | "clarified"
  | "cancelled"
  | "recoverable_error"
  | "hard_failure";
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

export type CoworkContract = {
  kind: "post" | "partial" | "research" | "saved_draft_action" | "answer";
  expectedCount: number;
};
export type CoworkDeliveredContract = {
  kind: CoworkContract["kind"];
  deliveredCount: number;
};

export type CoworkTelemetryAttempt = {
  stage: string;
  attempt: number;
  model?: string;
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
  provider?: "openrouter" | "database" | "server";
  outcome: CoworkAttemptOutcome;
  reason_code?: string;
  fallback_reason?: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
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
  cached_input_tokens: number;
  charged_cost_usd: number;
  provenance_status: CoworkProvenanceStatus;
  terminal_outcome: CoworkTerminalOutcome;
};

export type CoworkTelemetrySink = (record: CoworkTurnTelemetryRecord) => void;
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

export function defaultCoworkTelemetrySink(
  record: CoworkTurnTelemetryRecord,
): void {
  console.log(JSON.stringify({ cowork_turn_v2: record }));
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
  let cachedInputTokens = 0;
  let chargedCostUsd = 0;
  let finished = false;
  let latestProvenanceStatus: CoworkProvenanceStatus = "not_required";
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
    }): void {
      if (finished) return;
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
      cachedInputTokens += usage.cachedInputTokens;
      chargedCostUsd += usage.costUsd;
      // Keep the emitted line bounded without losing the authoritative usage
      // totals for long multi-draft turns.
      if (attempts.length >= MAX_DETAILED_ATTEMPTS) return;
      attempts.push({
        stage: safeCode(attempt.stage) ?? "unknown",
        attempt: boundedInteger(attempt.attempt, 100),
        ...(boundedModel(attempt.model)
          ? { model: boundedModel(attempt.model) }
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
        cached_input_tokens: usage.cachedInputTokens,
        charged_cost_usd: usage.costUsd,
      });
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
    finishStaged(
      terminalOverride?: CoworkTerminalOutcome,
      discardDelivered = false,
    ): void {
      const pending = stagedFinish ?? {
        deliveredContract: {
          kind: base.requestedContract.kind,
          deliveredCount: 0,
        },
        provenanceStatus: latestProvenanceStatus,
        terminalOutcome: "hard_failure" as const,
      };
      this.finish({
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
    finish(input: {
      deliveredContract: CoworkDeliveredContract;
      provenanceStatus: CoworkProvenanceStatus;
      terminalOutcome: CoworkTerminalOutcome;
    }): void {
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
        cached_input_tokens: boundedInteger(cachedInputTokens),
        charged_cost_usd: Number(chargedCostUsd.toFixed(8)),
        provenance_status: input.provenanceStatus,
        terminal_outcome: input.terminalOutcome,
      };
      try {
        sink(record);
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
    else input.telemetry.finish(completion);
  }
}

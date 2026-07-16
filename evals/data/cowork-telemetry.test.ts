import { describe, expect, test, vi } from "vitest";
import {
  createCoworkTurnTelemetry,
  observeCoworkTurn,
} from "@/lib/agent/cowork-telemetry";

describe("Cowork v2 structured telemetry", () => {
  test("records the full safe turn contract, attempts, charged cost, provenance, and terminal outcome", () => {
    let now = 1_000;
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "turn-1",
        workspaceId: "ws-1",
        route: "direct_writer",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      sink,
      () => now,
    );
    telemetry.configure({
      rolloutMode: "dark",
      shadowCandidateRoute: "direct_writer",
    });
    now = 1_120;
    telemetry.recordAttempt({
      stage: "writer_primary",
      attempt: 1,
      model: "qwen/qwen3.7-plus",
      provider: "openrouter",
      outcome: "rejected",
      reasonCode: "length_truncated",
      latencyMs: 120,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 12 },
        cost: 0.012,
      },
    });
    telemetry.recordAttempt({
      stage: "writer_fallback",
      attempt: 2,
      model: "z-ai/glm-5.2",
      provider: "openrouter",
      outcome: "accepted",
      fallbackReason: "primary_rejected",
      latencyMs: 80,
      usage: { prompt_tokens: 90, completion_tokens: 30, cost: 0.008 },
    });
    telemetry.recordFinalizer({
      outcome: "accepted",
      provenanceStatus: "verified",
    });
    expect(telemetry.snapshotUsage()).toEqual({
      total_credits: 4,
      total_cost_usd: 0.02,
      stages: [
        {
          kind: "writing",
          credits: 4,
          cost_usd: 0.02,
          models: ["qwen/qwen3.7-plus", "z-ai/glm-5.2"],
        },
      ],
    });
    now = 1_250;
    telemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 1 },
      provenanceStatus: "verified",
      terminalOutcome: "delivered",
    });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({
      trace_id: "turn-1",
      workspace_id: "ws-1",
      route: "direct_writer",
      requested_contract: { kind: "post", expected_count: 1 },
      delivered_contract: { kind: "post", delivered_count: 1 },
      duration_ms: 250,
      input_tokens: 190,
      output_tokens: 50,
      reasoning_tokens: 12,
      cached_input_tokens: 40,
      charged_cost_usd: 0.02,
      provenance_status: "verified",
      terminal_outcome: "delivered",
      rollout_mode: "dark",
      shadow_candidate_route: "direct_writer",
    });
    expect(sink.mock.calls[0][0].stage_attempts).toHaveLength(3);
  });

  test("is idempotent and never accepts prompt, draft, credential, or reasoning fields", () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "turn-2",
        workspaceId: "ws-2",
        route: "action_orchestrator",
        requestedContract: { kind: "saved_draft_action", expectedCount: 2 },
      },
      sink,
      () => 5_000,
    );
    telemetry.recordAttempt({
      stage: "orchestrator_primary",
      attempt: 1,
      model: "anthropic/claude-sonnet-5",
      provider: "openrouter",
      outcome: "failed",
      reasonCode: "schema_invalid; secret prompt body",
      latencyMs: 12,
    });
    telemetry.finish({
      deliveredContract: { kind: "saved_draft_action", deliveredCount: 0 },
      provenanceStatus: "not_required",
      terminalOutcome: "recoverable_error",
    });
    telemetry.finish({
      deliveredContract: { kind: "saved_draft_action", deliveredCount: 99 },
      provenanceStatus: "not_required",
      terminalOutcome: "hard_failure",
    });

    const serialized = JSON.stringify(sink.mock.calls[0][0]);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(serialized).not.toContain("secret prompt body");
    expect(serialized).not.toMatch(
      /prompt|draft_body|credential|reasoning_(?:text|content)|reasoning_details/i,
    );
    expect(sink.mock.calls[0][0].stage_attempts[0].reason_code).toBe(
      "schema_invalid_redacted",
    );
  });

  test("records a hard failure when a stream is abandoned before its terminal", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "turn-abandoned",
        workspaceId: "ws-2",
        route: "direct_writer",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      sink,
    );
    async function* source() {
      yield {
        type: "artifact" as const,
        artifact: {
          id: "draft-1",
          kind: "post" as const,
          title: "Draft",
          body: "Not durably complete yet.",
        },
      };
      await new Promise(() => undefined);
    }
    const observed = observeCoworkTurn({
      stream: source(),
      telemetry,
      contract: { kind: "post", expectedCount: 1 },
    });
    await observed.next();
    await observed.return(undefined);

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        delivered_contract: { kind: "post", delivered_count: 0 },
        terminal_outcome: "hard_failure",
      }),
    );
  });

  test("a telemetry sink failure cannot fail a completed user turn", () => {
    const sink = vi.fn(() => {
      throw new Error("log transport unavailable");
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "turn-safe-sink",
        workspaceId: "ws-2",
        route: "direct_writer",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      sink,
    );

    expect(() =>
      telemetry.finish({
        deliveredContract: { kind: "post", deliveredCount: 1 },
        provenanceStatus: "not_required",
        terminalOutcome: "delivered",
      }),
    ).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({ cowork_telemetry_emit_failed: true }),
    );
    consoleError.mockRestore();
  });

  test("a persistence failure overrides a staged delivery before telemetry commits", () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "turn-persist-failed",
        workspaceId: "ws-2",
        route: "direct_writer",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      sink,
    );
    telemetry.stageFinish({
      deliveredContract: { kind: "post", deliveredCount: 1 },
      provenanceStatus: "not_required",
      terminalOutcome: "delivered",
    });

    telemetry.finishStaged("hard_failure", true);

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        delivered_contract: { kind: "post", delivered_count: 0 },
        terminal_outcome: "hard_failure",
      }),
    );
  });

  test("keeps complete usage and cost totals when detailed attempts are capped", () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "turn-many-attempts",
        workspaceId: "ws-2",
        route: "direct_writer",
        requestedContract: { kind: "post", expectedCount: 6 },
      },
      sink,
    );
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      telemetry.recordAttempt({
        stage: "writer",
        attempt,
        model: "qwen/qwen3.7-plus",
        provider: "openrouter",
        outcome: "accepted",
        latencyMs: 1,
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      });
    }
    telemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 6 },
      provenanceStatus: "not_required",
      terminalOutcome: "delivered",
    });

    expect(sink.mock.calls[0][0].stage_attempts).toHaveLength(96);
    expect(sink.mock.calls[0][0]).toMatchObject({
      input_tokens: 1_000,
      output_tokens: 500,
      charged_cost_usd: 0.1,
    });
    expect(telemetry.snapshotUsage()).toMatchObject({
      total_credits: 20,
      stages: [{ kind: "writing", credits: 20, cost_usd: 0.1 }],
    });
  });

  test("exposes a staged recoverable outcome so lifecycle completion does not inflate hard failures", () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "turn-recoverable",
        workspaceId: "ws-2",
        route: "action_orchestrator",
        requestedContract: {
          kind: "saved_draft_action",
          expectedCount: 1,
        },
      },
      sink,
    );
    telemetry.stageFinish({
      deliveredContract: { kind: "saved_draft_action", deliveredCount: 0 },
      provenanceStatus: "not_required",
      terminalOutcome: "recoverable_error",
    });

    expect(telemetry.stagedTerminalOutcome()).toBe("recoverable_error");
    telemetry.finishStaged();
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ terminal_outcome: "recoverable_error" }),
    );
  });

  test("counts a successful plain-text legacy answer as delivered", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "legacy-answer",
        workspaceId: "ws-2",
        route: "legacy_agent",
        requestedContract: { kind: "answer", expectedCount: 1 },
      },
      sink,
    );
    async function* answer() {
      yield { type: "text" as const, delta: "Here is the answer." };
      yield {
        type: "done" as const,
        message: {
          content: "Here is the answer.",
          tool_calls: null,
          artifacts: [],
          toolMessages: [],
          inputTokens: 10,
          outputTokens: 5,
        },
      };
    }
    for await (const event of observeCoworkTurn({
      stream: answer(),
      telemetry,
      contract: { kind: "answer", expectedCount: 1 },
    })) {
      void event;
    }

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        requested_contract: { kind: "answer", expected_count: 1 },
        delivered_contract: { kind: "answer", delivered_count: 1 },
        terminal_outcome: "delivered",
      }),
    );
  });

  test("does not count clarification text as a delivered answer", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "legacy-ask",
        workspaceId: "ws-2",
        route: "legacy_agent",
        requestedContract: { kind: "answer", expectedCount: 1 },
      },
      sink,
    );
    async function* clarification() {
      yield {
        type: "ask" as const,
        ask: {
          question: "Which audience?",
          options: ["Founders", "Creators"],
          allowOther: true,
        },
      };
      yield {
        type: "done" as const,
        message: {
          content: "Which audience?",
          tool_calls: null,
          artifacts: [],
          toolMessages: [],
          inputTokens: 0,
          outputTokens: 0,
        },
      };
    }
    for await (const event of observeCoworkTurn({
      stream: clarification(),
      telemetry,
      contract: { kind: "answer", expectedCount: 1 },
    })) {
      void event;
    }

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        delivered_contract: { kind: "answer", delivered_count: 0 },
        terminal_outcome: "clarified",
      }),
    );
  });

  test("does not count a recoverable error message as a delivered answer", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "legacy-recoverable",
        workspaceId: "ws-2",
        route: "legacy_agent",
        requestedContract: { kind: "answer", expectedCount: 1 },
      },
      sink,
    );
    async function* recoverable() {
      yield {
        type: "error" as const,
        message: "The provider timed out. Please retry.",
        code: "timeout",
        recovery: "continue" as const,
      };
      yield {
        type: "done" as const,
        terminalReason: "error" as const,
        message: {
          content: "The provider timed out. Please retry.",
          tool_calls: null,
          artifacts: [],
          toolMessages: [],
          inputTokens: 0,
          outputTokens: 0,
        },
      };
    }
    for await (const event of observeCoworkTurn({
      stream: recoverable(),
      telemetry,
      contract: { kind: "answer", expectedCount: 1 },
    })) {
      void event;
    }

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        delivered_contract: { kind: "answer", delivered_count: 0 },
        terminal_outcome: "recoverable_error",
      }),
    );
  });

  test("retains paid setup attempts when the final route and contract are configured", () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "chat-before-row",
        workspaceId: "ws-2",
        route: "setup",
        requestedContract: { kind: "answer", expectedCount: 1 },
      },
      sink,
    );
    telemetry.recordAttempt({
      stage: "setup_vision",
      attempt: 1,
      model: "anthropic/claude-sonnet-5",
      provider: "openrouter",
      outcome: "accepted",
      latencyMs: 20,
      usage: { prompt_tokens: 30, completion_tokens: 5, cost: 0.002 },
    });
    telemetry.configure({
      traceId: "claimed-user-row",
      route: "direct_writer",
      requestedContract: { kind: "post", expectedCount: 1 },
    });
    telemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 1 },
      provenanceStatus: "not_required",
      terminalOutcome: "delivered",
    });

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: "claimed-user-row",
        route: "direct_writer",
        requested_contract: { kind: "post", expected_count: 1 },
        input_tokens: 30,
        charged_cost_usd: 0.002,
        stage_attempts: [
          expect.objectContaining({ stage: "setup_vision" }),
        ],
      }),
    );
  });
});

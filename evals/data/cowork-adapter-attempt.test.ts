import { describe, expect, test, vi } from "vitest";
import { AdapterHealthRegistry } from "@/lib/agent/adapter-health";
import {
  providerModelAttribution,
  runCoworkAdapterAttempt,
} from "@/lib/agent/cowork-adapter-attempt";
import { createCoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";

function health() {
  return new AdapterHealthRegistry({
    minimumSamples: 1,
    failureRateToOpen: 1,
    slowRateToOpen: 1,
    openCooldownMs: 60_000,
  });
}

describe("Cowork adapter attempt boundary", () => {
  test("attributes provider aliases centrally", () => {
    expect(
      providerModelAttribution("requested/luna", "provider/luna-versioned"),
    ).toEqual({
      model: "provider/luna-versioned",
      metadata: { requested_model: "requested/luna" },
    });
    expect(providerModelAttribution("requested/luna", " ")).toEqual({
      model: "requested/luna",
      metadata: {},
    });
  });

  test("persists usage once and records an accepted validated response", async () => {
    const persistUsage = vi.fn(async () => undefined);
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "attempt-success",
        workspaceId: "ws-1",
        route: "direct_writer",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      sink,
    );
    const result = await runCoworkAdapterAttempt({
      registry: health(),
      adapterKey: "writer:model",
      call: async () => ({ text: "complete", usage: { prompt_tokens: 2 } }),
      validate: (response) => response.text.toUpperCase(),
      persistUsage,
      usage: (response) => response.usage,
      telemetry,
      stage: "writer_primary",
      attempt: 1,
      model: "model",
      rejectedReasonCode: "empty_output",
    });
    telemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 1 },
      provenanceStatus: "not_required",
      terminalOutcome: "delivered",
    });

    expect(result.value).toBe("COMPLETE");
    expect(persistUsage).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].stage_attempts[0]).toMatchObject({
      stage: "writer_primary",
      outcome: "accepted",
    });
  });

  test("records the provider-returned model while retaining the requested model", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "attempt-routed-model",
        workspaceId: "ws-1",
        route: "direct_writer",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      sink,
    );
    await runCoworkAdapterAttempt({
      registry: health(),
      adapterKey: "writer:luna",
      call: async () => ({
        text: "complete",
        model: "openai/gpt-5.6-luna-20260715",
        usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.001 },
      }),
      validate: (response) => response.text,
      persistUsage: async () => undefined,
      usage: (response) => response.usage,
      responseModel: (response) => response.model,
      telemetry,
      stage: "writer_primary",
      attempt: 1,
      model: "openai/gpt-5.6-luna",
      rejectedReasonCode: "empty_output",
    });
    await telemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 1 },
      provenanceStatus: "not_required",
      terminalOutcome: "delivered",
    });

    expect(sink.mock.calls[0][0].stage_attempts[0]).toMatchObject({
      model: "openai/gpt-5.6-luna-20260715",
      requested_model: "openai/gpt-5.6-luna",
    });
  });

  test("charges a rejected response once and opens the invalid adapter circuit", async () => {
    const registry = health();
    const persistUsage = vi.fn(async () => undefined);

    await expect(
      runCoworkAdapterAttempt({
        registry,
        adapterKey: "planner:model",
        call: async () => ({ toolArgs: null, usage: { prompt_tokens: 2 } }),
        validate: () => {
          throw new Error("invalid schema");
        },
        persistUsage,
        usage: (response) => response.usage,
        stage: "orchestrator_primary",
        attempt: 1,
        model: "model",
        rejectedReasonCode: "invalid_action_plan",
      }),
    ).rejects.toMatchObject({ name: "InvalidAdapterResponseError" });

    expect(persistUsage).toHaveBeenCalledTimes(1);
    expect(registry.snapshot("planner:model")).toMatchObject({
      state: "open",
      failureRate: 1,
    });
  });

  test("a hot circuit skips the call and cannot create usage", async () => {
    const registry = health();
    registry.recordFailure("writer:model", "provider_5xx", 1);
    const call = vi.fn(async () => ({ text: "unused" }));
    const persistUsage = vi.fn(async () => undefined);

    await expect(
      runCoworkAdapterAttempt({
        registry,
        adapterKey: "writer:model",
        call,
        validate: (response) => response,
        persistUsage,
        usage: () => undefined,
        stage: "writer_primary",
        attempt: 1,
        model: "model",
        rejectedReasonCode: "empty_output",
      }),
    ).rejects.toMatchObject({ code: "adapter_circuit_open" });

    expect(call).not.toHaveBeenCalled();
    expect(persistUsage).not.toHaveBeenCalled();
  });

  test("a paid attempt remains observable when usage persistence fails closed", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "attempt-ledger-failure",
        workspaceId: "ws-1",
        route: "direct_writer",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      sink,
    );
    const persistenceError = new Error("ledger unavailable");
    persistenceError.name = "UsagePersistenceError";

    await expect(
      runCoworkAdapterAttempt({
        registry: health(),
        adapterKey: "writer:model",
        call: async () => ({
          text: "complete",
          usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.004 },
        }),
        validate: (response) => response.text,
        persistUsage: async () => {
          throw persistenceError;
        },
        usage: (response) => response.usage,
        telemetry,
        stage: "writer_primary",
        attempt: 1,
        model: "model",
        rejectedReasonCode: "empty_output",
      }),
    ).rejects.toBe(persistenceError);
    telemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 0 },
      provenanceStatus: "not_required",
      terminalOutcome: "hard_failure",
    });

    expect(sink.mock.calls[0][0]).toMatchObject({
      input_tokens: 7,
      output_tokens: 3,
      charged_cost_usd: 0.004,
    });
    expect(sink.mock.calls[0][0].stage_attempts[0]).toMatchObject({
      stage: "writer_primary",
      outcome: "accepted",
    });
  });
});

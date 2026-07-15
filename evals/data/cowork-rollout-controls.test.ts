import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  coworkRolloutDecision,
  stableWorkspaceRolloutBucket,
} from "@/lib/agent/cowork-rollout";
import {
  CoworkRolloutHealthMonitor,
  coworkV2RolloutConfigured,
  loadCoworkRolloutHealth,
} from "@/lib/agent/cowork-rollout-health";
import type { CoworkTurnTelemetryRecord } from "@/lib/agent/cowork-telemetry";

function record(
  terminal: CoworkTurnTelemetryRecord["terminal_outcome"],
  route: CoworkTurnTelemetryRecord["route"] = "direct_writer",
): CoworkTurnTelemetryRecord {
  return {
    trace_id: "trace",
    workspace_id: "workspace",
    route,
    requested_contract: { kind: "post", expected_count: 1 },
    delivered_contract: {
      kind: "post",
      delivered_count: terminal === "delivered" ? 1 : 0,
    },
    stage_attempts: [],
    duration_ms: 100,
    input_tokens: 10,
    output_tokens: 20,
    reasoning_tokens: 0,
    cached_input_tokens: 0,
    charged_cost_usd: 0.001,
    provenance_status: "not_required",
    terminal_outcome: terminal,
  };
}

describe("Cowork v2 rollout controls", () => {
  test("preserves the legacy enabled plus allowlist behavior when no mode is set", () => {
    expect(
      coworkRolloutDecision("direct_writer", "ws-1", {
        COWORK_DIRECT_WRITER_ENABLED: "1",
        COWORK_DIRECT_WRITER_WORKSPACES: "ws-1,ws-2",
      }),
    ).toMatchObject({ serveV2: true, shadowV2: false, reason: "workspace" });
    expect(
      coworkRolloutDecision("direct_writer", "ws-3", {
        COWORK_DIRECT_WRITER_ENABLED: "1",
        COWORK_DIRECT_WRITER_WORKSPACES: "ws-1,ws-2",
      }).serveV2,
    ).toBe(false);
  });

  test("global and lane kill switches beat workspace, percentage, and global flags", () => {
    const enabled = {
      COWORK_V2_ENABLED: "1",
      COWORK_V2_ROLLOUT_MODE: "global",
      COWORK_V2_WORKSPACES: "ws-1",
      COWORK_DIRECT_WRITER_ENABLED: "1",
      COWORK_DIRECT_WRITER_WORKSPACES: "*",
    };
    expect(
      coworkRolloutDecision("direct_writer", "ws-1", {
        ...enabled,
        COWORK_V2_KILL_SWITCH: "1",
      }),
    ).toMatchObject({ serveV2: false, reason: "kill_switch" });
    expect(
      coworkRolloutDecision("direct_writer", "ws-1", {
        ...enabled,
        COWORK_DIRECT_WRITER_KILL_SWITCH: "1",
      }),
    ).toMatchObject({ serveV2: false, reason: "kill_switch" });
  });

  test("supports safe dark launch, deterministic sampling, explicit workspaces, and global rollout", () => {
    const common = { COWORK_V2_ENABLED: "1" };
    expect(
      coworkRolloutDecision("direct_writer", "ws-dark", {
        ...common,
        COWORK_V2_ROLLOUT_MODE: "dark",
      }),
    ).toMatchObject({ serveV2: false, shadowV2: true, reason: "dark_launch" });
    expect(
      coworkRolloutDecision("direct_writer", "ws-override", {
        ...common,
        COWORK_V2_ROLLOUT_MODE: "sample",
        COWORK_V2_ROLLOUT_PERCENT: "0",
        COWORK_V2_WORKSPACES: "ws-override",
      }),
    ).toMatchObject({ serveV2: true, reason: "workspace" });
    expect(
      coworkRolloutDecision("direct_writer", "ws-sampled", {
        ...common,
        COWORK_V2_ROLLOUT_MODE: "sample",
        COWORK_V2_ROLLOUT_PERCENT: "100",
      }),
    ).toMatchObject({ serveV2: true, reason: "percentage" });
    expect(
      coworkRolloutDecision("direct_writer", "ws-any", {
        ...common,
        COWORK_V2_ROLLOUT_MODE: "global",
      }),
    ).toMatchObject({ serveV2: true, reason: "global" });
  });

  test("sampling is stable and malformed percentages fail closed", () => {
    const bucket = stableWorkspaceRolloutBucket("direct_writer", "ws-stable");
    expect(bucket).toBe(stableWorkspaceRolloutBucket("direct_writer", "ws-stable"));
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(
      coworkRolloutDecision("direct_writer", "ws-stable", {
        COWORK_V2_ENABLED: "1",
        COWORK_V2_ROLLOUT_MODE: "sample",
        COWORK_V2_ROLLOUT_PERCENT: "not-a-number",
      }),
    ).toMatchObject({ serveV2: false, reason: "not_selected" });
  });

  test("disabled workspaces win in every rollout mode", () => {
    expect(
      coworkRolloutDecision("read_only_orchestrator", "ws-blocked", {
        COWORK_V2_ENABLED: "1",
        COWORK_V2_ROLLOUT_MODE: "global",
        COWORK_V2_DISABLED_WORKSPACES: "ws-blocked",
      }),
    ).toMatchObject({ serveV2: false, shadowV2: false, reason: "workspace_disabled" });
  });

  test("the runtime emergency brake overrides a selected workspace", () => {
    expect(
      coworkRolloutDecision(
        "action_orchestrator",
        "ws-selected",
        {
          COWORK_V2_ENABLED: "1",
          COWORK_V2_ROLLOUT_MODE: "global",
        },
        { isOpen: () => true },
      ),
    ).toMatchObject({ serveV2: false, reason: "runtime_rollback" });
  });
});

describe("Cowork v2 rolling hard-failure gate", () => {
  test("alerts at 0.5% and opens rollback at 1% over a meaningful window", () => {
    const monitor = new CoworkRolloutHealthMonitor({
      minimumSample: 200,
      windowSize: 200,
      alertRate: 0.005,
      rollbackRate: 0.01,
    });
    for (let index = 0; index < 198; index++) monitor.record(record("delivered"));
    monitor.record(record("hard_failure"));
    expect(monitor.snapshot()).toMatchObject({ state: "insufficient", sampleSize: 199 });
    monitor.record(record("delivered"));
    expect(monitor.snapshot()).toMatchObject({ state: "alert", hardFailures: 1 });

    monitor.record(record("hard_failure"));
    expect(monitor.snapshot()).toMatchObject({
      state: "rollback",
      sampleSize: 200,
      hardFailures: 2,
      hardFailureRate: 0.01,
    });
    expect(monitor.isOpen()).toBe(true);
  });

  test("ignores the baseline route and never counts cancellation as a hard failure", () => {
    const monitor = new CoworkRolloutHealthMonitor({ minimumSample: 2, windowSize: 2 });
    monitor.record(record("hard_failure", "legacy_agent"));
    monitor.record(record("cancelled"));
    monitor.record(record("recoverable_error"));
    expect(monitor.snapshot()).toMatchObject({
      state: "healthy",
      sampleSize: 2,
      hardFailures: 0,
    });
  });

  test("reads the shared fleet brake and fails closed when it is unavailable", async () => {
    const client = (result: { data: unknown; error: unknown }) =>
      ({
        from: () => ({
          select: () => ({
            eq: () => ({ maybeSingle: async () => result }),
          }),
        }),
      }) as unknown as SupabaseClient;
    const healthy = await loadCoworkRolloutHealth(
      client({
        data: {
          sample_size: 200,
          hard_failures: 0,
          hard_failure_rate: 0,
          state: "healthy",
          rollback_open: false,
        },
        error: null,
      }),
    );
    expect(healthy).toMatchObject({ source: "shared" });
    expect(healthy.isOpen()).toBe(false);

    const consoleError = console.error;
    console.error = () => undefined;
    try {
      const unavailable = await loadCoworkRolloutHealth(
        client({ data: null, error: { code: "network" } }),
      );
      expect(unavailable).toMatchObject({ source: "fail_closed" });
      expect(unavailable.isOpen()).toBe(true);
    } finally {
      console.error = consoleError;
    }
    expect(coworkV2RolloutConfigured({ COWORK_V2_ENABLED: "1" })).toBe(true);
    expect(
      coworkV2RolloutConfigured({
        COWORK_V2_ENABLED: "1",
        COWORK_V2_KILL_SWITCH: "1",
      }),
    ).toBe(false);
    expect(coworkV2RolloutConfigured({})).toBe(false);
  });

  test("fails closed on malformed or internally inconsistent shared health", async () => {
    const client = (data: unknown) =>
      ({
        from: () => ({
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data, error: null }) }),
          }),
        }),
      }) as unknown as SupabaseClient;
    const malformed = [
      {
        sample_size: 200,
        hard_failures: 0,
        hard_failure_rate: 0,
        state: "healthy",
        rollback_open: null,
      },
      {
        sample_size: 200,
        hard_failures: 2,
        hard_failure_rate: 0.01,
        state: "healthy",
        rollback_open: false,
      },
      {
        sample_size: 200,
        hard_failures: 1,
        hard_failure_rate: 0,
        state: "healthy",
        rollback_open: false,
      },
    ];
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      for (const row of malformed) {
        const gate = await loadCoworkRolloutHealth(client(row));
        expect(gate).toMatchObject({ source: "fail_closed" });
        expect(gate.isOpen()).toBe(true);
      }
    } finally {
      console.error = consoleError;
    }
  });
});

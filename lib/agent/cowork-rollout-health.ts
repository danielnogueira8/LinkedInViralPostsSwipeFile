import type { CoworkTurnTelemetryRecord } from "@/lib/agent/cowork-telemetry";
import { supabaseAdmin } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

export type CoworkRolloutHealthState =
  | "insufficient"
  | "healthy"
  | "alert"
  | "rollback";

export type CoworkRolloutHealthSnapshot = {
  state: CoworkRolloutHealthState;
  sampleSize: number;
  hardFailures: number;
  hardFailureRate: number;
  alertRate: number;
  rollbackRate: number;
  minimumSample: number;
};

export type CoworkRolloutHealthGate = {
  isOpen(): boolean;
  source: "local" | "shared" | "fail_closed";
  snapshot: CoworkRolloutHealthSnapshot;
};

type RolloutHealthOptions = {
  windowSize?: number;
  minimumSample?: number;
  alertRate?: number;
  rollbackRate?: number;
};

const V2_ROUTES = new Set<CoworkTurnTelemetryRecord["route"]>([
  "direct_writer",
  "read_only_orchestrator",
  "action_orchestrator",
]);
const SHARED_HEALTH_TIMEOUT_MS = 1_000;
let lastSharedHealthState: CoworkRolloutHealthState | undefined;

async function withinHealthDeadline<T>(operation: PromiseLike<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error("Cowork rollout health request timed out.");
          error.name = "CoworkRolloutHealthTimeoutError";
          reject(error);
        }, SHARED_HEALTH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Per-instance emergency brake for sampled Cowork v2 traffic. The shared
 * database latch is authoritative across the fleet; this monitor stops a hot
 * instance immediately before its next shared read.
 */
export class CoworkRolloutHealthMonitor {
  private readonly windowSize: number;
  private readonly minimumSample: number;
  private readonly alertRate: number;
  private readonly rollbackRate: number;
  private readonly outcomes: boolean[] = [];
  private opened = false;

  constructor(options: RolloutHealthOptions = {}) {
    this.windowSize = Math.max(1, Math.floor(options.windowSize ?? 200));
    this.minimumSample = Math.min(
      this.windowSize,
      Math.max(1, Math.floor(options.minimumSample ?? 200)),
    );
    this.alertRate = Math.max(0, options.alertRate ?? 0.005);
    this.rollbackRate = Math.max(
      this.alertRate,
      options.rollbackRate ?? 0.01,
    );
  }

  record(record: CoworkTurnTelemetryRecord): CoworkRolloutHealthSnapshot {
    if (!V2_ROUTES.has(record.route)) return this.snapshot();
    this.outcomes.push(record.terminal_outcome === "hard_failure");
    if (this.outcomes.length > this.windowSize) this.outcomes.shift();
    const snapshot = this.snapshot();
    if (
      snapshot.sampleSize >= this.minimumSample &&
      snapshot.hardFailureRate >= this.rollbackRate
    ) {
      this.opened = true;
    }
    return this.snapshot();
  }

  isOpen(): boolean {
    return this.opened;
  }

  trip(): void {
    this.opened = true;
  }

  snapshot(): CoworkRolloutHealthSnapshot {
    const sampleSize = this.outcomes.length;
    const hardFailures = this.outcomes.filter(Boolean).length;
    const hardFailureRate = sampleSize ? hardFailures / sampleSize : 0;
    const state: CoworkRolloutHealthState =
      sampleSize < this.minimumSample
        ? "insufficient"
        : this.opened || hardFailureRate >= this.rollbackRate
          ? "rollback"
          : hardFailureRate >= this.alertRate
            ? "alert"
            : "healthy";
    return {
      state,
      sampleSize,
      hardFailures,
      hardFailureRate,
      alertRate: this.alertRate,
      rollbackRate: this.rollbackRate,
      minimumSample: this.minimumSample,
    };
  }
}

export const coworkRolloutRuntimeHealth = new CoworkRolloutHealthMonitor();

function flagEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLocaleLowerCase("en-US") === "true";
}

export function coworkV2RolloutConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (flagEnabled(env.COWORK_V2_KILL_SWITCH)) return false;
  return [
    "COWORK_V2_ENABLED",
    "COWORK_DIRECT_WRITER_ENABLED",
    "COWORK_READ_ONLY_ORCHESTRATOR_ENABLED",
    "COWORK_ACTION_ORCHESTRATOR_ENABLED",
  ].some((key) => flagEnabled(env[key]));
}

function sharedSnapshot(
  value: unknown,
): { snapshot: CoworkRolloutHealthSnapshot; rollbackOpen: boolean } | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const sampleSize = record.sample_size;
  const hardFailures = record.hard_failures;
  const hardFailureRate = record.hard_failure_rate;
  const state = record.state;
  const rollbackOpen = record.rollback_open;
  if (
    typeof sampleSize !== "number" ||
    typeof hardFailures !== "number" ||
    typeof hardFailureRate !== "number" ||
    typeof state !== "string" ||
    typeof rollbackOpen !== "boolean" ||
    !Number.isFinite(sampleSize) ||
    !Number.isFinite(hardFailures) ||
    !Number.isFinite(hardFailureRate) ||
    !Number.isInteger(sampleSize) ||
    !Number.isInteger(hardFailures) ||
    sampleSize < 0 ||
    sampleSize > 200 ||
    hardFailures < 0 ||
    hardFailures > sampleSize ||
    hardFailureRate < 0 ||
    hardFailureRate > 1 ||
    !["insufficient", "healthy", "alert", "rollback"].includes(
      String(state),
    )
  ) {
    return null;
  }
  const expectedRate = sampleSize ? hardFailures / sampleSize : 0;
  const expectedState: CoworkRolloutHealthState = rollbackOpen
    ? "rollback"
    : sampleSize < 200
      ? "insufficient"
      : hardFailureRate >= 0.01
        ? "rollback"
        : hardFailureRate >= 0.005
          ? "alert"
          : "healthy";
  if (
    Math.abs(hardFailureRate - expectedRate) > 1e-12 ||
    state !== expectedState ||
    (state === "rollback" && !rollbackOpen)
  ) {
    return null;
  }
  return {
    rollbackOpen,
    snapshot: {
      state,
      sampleSize,
      hardFailures,
      hardFailureRate,
      alertRate: 0.005,
      rollbackRate: 0.01,
      minimumSample: 200,
    },
  };
}

/**
 * Read the latched fleet brake before routing a configured v2 turn. Any
 * missing/malformed/unavailable shared state fails closed to the baseline.
 */
export async function loadCoworkRolloutHealth(
  client: SupabaseClient = supabaseAdmin(),
): Promise<CoworkRolloutHealthGate> {
  if (coworkRolloutRuntimeHealth.isOpen()) {
    return {
      isOpen: () => true,
      source: "local",
      snapshot: coworkRolloutRuntimeHealth.snapshot(),
    };
  }
  let data: Record<string, unknown> | null = null;
  let error: { code?: string } | null = null;
  try {
    const result = await withinHealthDeadline(
      client
        .from("cowork_rollout_health")
        .select("sample_size,hard_failures,hard_failure_rate,state,rollback_open")
        .eq("singleton", true)
        .maybeSingle(),
    );
    data = result.data as Record<string, unknown> | null;
    error = result.error;
  } catch (cause) {
    error = {
      code: cause instanceof Error ? cause.name : "health_read_exception",
    };
  }
  const shared = sharedSnapshot(data);
  if (error || !shared) {
    console.error(
      JSON.stringify({
        cowork_v2_rollout_health_read_failed: true,
        code:
          typeof error?.code === "string" ? error.code.slice(0, 40) : undefined,
      }),
    );
    return {
      isOpen: () => true,
      source: "fail_closed",
      snapshot: { ...coworkRolloutRuntimeHealth.snapshot(), state: "rollback" },
    };
  }
  return {
    isOpen: () => shared.rollbackOpen,
    source: "shared",
    snapshot: shared.snapshot,
  };
}

/** Persist one safe terminal outcome and atomically recompute the fleet window. */
export async function recordCoworkRolloutHealth(
  record: CoworkTurnTelemetryRecord,
  client: SupabaseClient = supabaseAdmin(),
): Promise<CoworkRolloutHealthSnapshot> {
  const before = coworkRolloutRuntimeHealth.snapshot();
  const local = coworkRolloutRuntimeHealth.record(record);
  if (!V2_ROUTES.has(record.route)) return local;

  let data: unknown = null;
  let error: { code?: string } | null = null;
  try {
    const result = await withinHealthDeadline(
      client.rpc("record_cowork_rollout_health", {
        p_route: record.route,
        p_terminal_outcome: record.terminal_outcome,
      }),
    );
    data = result.data;
    error = result.error;
  } catch (cause) {
    error = {
      code: cause instanceof Error ? cause.name : "health_write_exception",
    };
  }
  const shared = sharedSnapshot(data);
  if (error || !shared) {
    coworkRolloutRuntimeHealth.trip();
    console.error(
      JSON.stringify({
        cowork_v2_rollout_health_write_failed: true,
        runtime_brake_open: true,
        code: typeof error?.code === "string" ? error.code.slice(0, 40) : undefined,
      }),
    );
    return { ...local, state: "rollback" };
  }
  const sharedTransition = shared.snapshot.state !== lastSharedHealthState;
  lastSharedHealthState = shared.snapshot.state;
  if (
    (sharedTransition &&
      (shared.snapshot.state === "alert" ||
        shared.snapshot.state === "rollback")) ||
    (local.state !== before.state && local.state === "alert")
  ) {
    console.warn(
      JSON.stringify({
        cowork_v2_rollout_health: shared.snapshot.state,
        sample_size: shared.snapshot.sampleSize,
        hard_failures: shared.snapshot.hardFailures,
        hard_failure_rate: shared.snapshot.hardFailureRate,
        fleet_brake_open: shared.rollbackOpen,
      }),
    );
  }
  if (shared.rollbackOpen) coworkRolloutRuntimeHealth.trip();
  return shared.snapshot;
}

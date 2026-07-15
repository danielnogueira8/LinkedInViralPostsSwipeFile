import { coworkRolloutRuntimeHealth } from "@/lib/agent/cowork-rollout-health";

export type CoworkRolloutLane =
  | "direct_writer"
  | "action_orchestrator"
  | "read_only_orchestrator";
export type CoworkRolloutMode = "off" | "dark" | "sample" | "global";
export type CoworkRolloutReason =
  | "missing_workspace"
  | "disabled"
  | "kill_switch"
  | "runtime_rollback"
  | "workspace_disabled"
  | "workspace"
  | "dark_launch"
  | "percentage"
  | "global"
  | "not_selected";

export type CoworkRolloutDecision = {
  mode: CoworkRolloutMode;
  serveV2: boolean;
  shadowV2: boolean;
  bucket: number | null;
  percentage: number;
  reason: CoworkRolloutReason;
};

type RolloutEnvironment = Record<string, string | undefined>;

const PREFIX: Record<CoworkRolloutLane, string> = {
  direct_writer: "COWORK_DIRECT_WRITER",
  action_orchestrator: "COWORK_ACTION_ORCHESTRATOR",
  read_only_orchestrator: "COWORK_READ_ONLY_ORCHESTRATOR",
};

function enabled(value: string | undefined): boolean {
  return value === "1" || value?.toLocaleLowerCase("en-US") === "true";
}

function workspaceSet(...values: Array<string | undefined>): Set<string> {
  return new Set(
    values
      .flatMap((value) => (value ?? "").split(","))
      .map((workspaceId) => workspaceId.trim())
      .filter(Boolean),
  );
}

function rolloutMode(value: string | undefined): CoworkRolloutMode | null {
  const normalized = value?.trim().toLocaleLowerCase("en-US");
  return normalized === "off" ||
    normalized === "dark" ||
    normalized === "sample" ||
    normalized === "global"
    ? normalized
    : null;
}

function rolloutPercentage(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 0;
}

/** Stable FNV-1a allocation. A workspace never bounces between cohorts. */
export function stableWorkspaceRolloutBucket(
  lane: CoworkRolloutLane,
  workspaceId: string,
): number {
  let hash = 0x811c9dc5;
  for (const character of `${lane}:${workspaceId}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 10_000) / 100;
}

function decision(
  mode: CoworkRolloutMode,
  percentage: number,
  reason: CoworkRolloutReason,
  options: { serveV2?: boolean; shadowV2?: boolean; bucket?: number | null } = {},
): CoworkRolloutDecision {
  return {
    mode,
    serveV2: options.serveV2 ?? false,
    shadowV2: options.shadowV2 ?? false,
    bucket: options.bucket ?? null,
    percentage,
    reason,
  };
}

/**
 * Resolve workspace, percentage, global, dark-launch, and kill-switch controls
 * through one fail-closed policy shared by every Cowork v2 lane.
 */
export function coworkRolloutDecision(
  lane: CoworkRolloutLane,
  workspaceId: string,
  env: RolloutEnvironment = process.env,
  runtimeHealth: Pick<typeof coworkRolloutRuntimeHealth, "isOpen"> =
    coworkRolloutRuntimeHealth,
): CoworkRolloutDecision {
  const prefix = PREFIX[lane];
  const rawMode = env[`${prefix}_ROLLOUT_MODE`] ?? env.COWORK_V2_ROLLOUT_MODE;
  const mode = rolloutMode(rawMode) ?? "off";
  const percentage = rolloutPercentage(
    env[`${prefix}_ROLLOUT_PERCENT`] ?? env.COWORK_V2_ROLLOUT_PERCENT,
  );
  if (!workspaceId) return decision(mode, percentage, "missing_workspace");
  if (
    enabled(env.COWORK_V2_KILL_SWITCH) ||
    enabled(env[`${prefix}_KILL_SWITCH`])
  ) {
    return decision(mode, percentage, "kill_switch");
  }
  if (runtimeHealth.isOpen()) {
    return decision(mode, percentage, "runtime_rollback");
  }

  const laneEnabled = enabled(env[`${prefix}_ENABLED`]);
  const globalEnabled = enabled(env.COWORK_V2_ENABLED);
  if (!laneEnabled && !globalEnabled) {
    return decision(mode, percentage, "disabled");
  }
  const disabled = workspaceSet(
    env[`${prefix}_DISABLED_WORKSPACES`],
    env.COWORK_V2_DISABLED_WORKSPACES,
  );
  if (disabled.has(workspaceId)) {
    return decision(mode, percentage, "workspace_disabled");
  }
  const laneWorkspaces = workspaceSet(env[`${prefix}_WORKSPACES`]);

  // Backward compatible until an explicit v2 rollout mode is configured.
  if (rawMode === undefined) {
    const selected =
      laneWorkspaces.has("*") || laneWorkspaces.has(workspaceId);
    return decision("off", percentage, selected ? "workspace" : "not_selected", {
      serveV2: selected,
    });
  }
  if (mode === "off") return decision(mode, percentage, "not_selected");
  if (mode === "dark") {
    return decision(mode, percentage, "dark_launch", { shadowV2: true });
  }

  const targeted = workspaceSet(
    env[`${prefix}_WORKSPACES`],
    env.COWORK_V2_WORKSPACES,
  );
  if (targeted.has(workspaceId)) {
    return decision(mode, percentage, "workspace", { serveV2: true });
  }
  if (mode === "global") {
    return decision(mode, percentage, "global", { serveV2: true });
  }
  const bucket = stableWorkspaceRolloutBucket(lane, workspaceId);
  const selected = bucket < percentage;
  return decision(
    mode,
    percentage,
    selected ? "percentage" : "not_selected",
    { serveV2: selected, bucket },
  );
}

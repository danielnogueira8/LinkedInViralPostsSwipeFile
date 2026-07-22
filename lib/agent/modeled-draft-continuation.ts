import type { ReadOnlyOrchestratorRoute } from "@/lib/agent/turn/compile";

const MODELED_DRAFT_BATCH_CONTINUATION_VERSION = 1;

type ModeledDraftCount = 2 | 3 | 4 | 5 | 6;

export type ModeledDraftBatchContinuation = Readonly<{
  kind: "modeled_draft_batch";
  version: typeof MODELED_DRAFT_BATCH_CONTINUATION_VERSION;
  route: Readonly<{
    kind: "workspace_research";
    expectsDraft: true;
    expectedDrafts: ModeledDraftCount;
    minimumSources: number;
    workspaceSearchMode: "diverse" | "strict_top";
    workspaceDraftSourceMode: "one_to_one";
    workspaceSince?: "1d" | "7d" | "30d";
    workspacePostType?: "regular" | "lead_magnet";
    authoritativeInstruction?: string;
  }>;
}>;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function modeledDraftCount(value: unknown): ModeledDraftCount | null {
  return Number.isInteger(value) && Number(value) >= 2 && Number(value) <= 6
    ? (Number(value) as ModeledDraftCount)
    : null;
}

/**
 * Freeze the server-compiled lane contract beside the recoverable marker.
 * A Retry reuses this value instead of asking a future routing implementation
 * whether the durable batch still exists.
 */
export function continuationForModeledDraftRoute(
  route: ReadOnlyOrchestratorRoute | null | undefined,
): ModeledDraftBatchContinuation | null {
  const legacyDraftRoute =
    route?.outcome === undefined && route?.expectsDraft === true;
  const expectedDrafts = modeledDraftCount(
    route?.outcome?.kind === "draft"
      ? route.outcome.expectedDrafts
      : legacyDraftRoute
        ? route?.expectedDrafts
        : undefined,
  );
  if (
    route?.kind !== "workspace_research" ||
    (route.outcome?.kind !== "draft" && !legacyDraftRoute) ||
    route.workspaceDraftSourceMode !== "one_to_one" ||
    !expectedDrafts ||
    !Number.isInteger(route.minimumSources) ||
    Number(route.minimumSources) < expectedDrafts ||
    Number(route.minimumSources) > 10 ||
    (route.workspaceSearchMode !== "diverse" &&
      route.workspaceSearchMode !== "strict_top") ||
    (route.workspaceSince !== undefined &&
      route.workspaceSince !== "1d" &&
      route.workspaceSince !== "7d" &&
      route.workspaceSince !== "30d") ||
    (route.workspacePostType !== undefined &&
      route.workspacePostType !== "regular" &&
      route.workspacePostType !== "lead_magnet") ||
    (route.authoritativeInstruction !== undefined &&
      (!route.authoritativeInstruction.trim() ||
        route.authoritativeInstruction.length > 50_000))
  ) {
    return null;
  }
  return {
    kind: "modeled_draft_batch",
    version: MODELED_DRAFT_BATCH_CONTINUATION_VERSION,
    route: {
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts,
      minimumSources: Number(route.minimumSources),
      workspaceSearchMode: route.workspaceSearchMode,
      workspaceDraftSourceMode: "one_to_one",
      ...(route.workspaceSince ? { workspaceSince: route.workspaceSince } : {}),
      ...(route.workspacePostType
        ? { workspacePostType: route.workspacePostType }
        : {}),
      ...(route.authoritativeInstruction
        ? { authoritativeInstruction: route.authoritativeInstruction }
        : {}),
    },
  };
}

/** Decode only the narrow, canonical route shape that the server persists. */
export function parseModeledDraftBatchContinuation(
  value: unknown,
): ModeledDraftBatchContinuation | null {
  const continuation = recordOf(value);
  const rawRoute = recordOf(continuation?.route);
  if (
    continuation?.kind !== "modeled_draft_batch" ||
    continuation.version !== MODELED_DRAFT_BATCH_CONTINUATION_VERSION ||
    !rawRoute
  ) {
    return null;
  }
  const allowedContinuationKeys = new Set(["kind", "version", "route"]);
  const allowedRouteKeys = new Set([
    "kind",
    "expectsDraft",
    "expectedDrafts",
    "minimumSources",
    "workspaceSearchMode",
    "workspaceDraftSourceMode",
    "workspaceSince",
    "workspacePostType",
    "authoritativeInstruction",
  ]);
  if (
    Object.keys(continuation).some((key) => !allowedContinuationKeys.has(key)) ||
    Object.keys(rawRoute).some((key) => !allowedRouteKeys.has(key))
  ) {
    return null;
  }
  const expectedDrafts = modeledDraftCount(rawRoute.expectedDrafts);
  if (
    rawRoute.kind !== "workspace_research" ||
    rawRoute.expectsDraft !== true ||
    rawRoute.workspaceDraftSourceMode !== "one_to_one" ||
    !expectedDrafts
  ) {
    return null;
  }
  return continuationForModeledDraftRoute({
    kind: "workspace_research",
    outcome: { kind: "draft", expectedDrafts },
    minimumSources: Number(rawRoute.minimumSources),
    workspaceSearchMode: rawRoute.workspaceSearchMode as
      | "diverse"
      | "strict_top",
    workspaceDraftSourceMode: "one_to_one",
    ...(typeof rawRoute.workspaceSince === "string"
      ? { workspaceSince: rawRoute.workspaceSince as "1d" | "7d" | "30d" }
      : {}),
    ...(typeof rawRoute.workspacePostType === "string"
      ? {
          workspacePostType: rawRoute.workspacePostType as
            | "regular"
            | "lead_magnet",
        }
      : {}),
    ...(typeof rawRoute.authoritativeInstruction === "string"
      ? { authoritativeInstruction: rawRoute.authoritativeInstruction }
      : {}),
  });
}

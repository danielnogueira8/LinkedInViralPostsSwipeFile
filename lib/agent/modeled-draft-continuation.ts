import {
  canonicalizeReadOnlyOrchestratorRoute,
  type ReadOnlyOrchestratorRoute,
} from "@/lib/agent/turn/compile";

const MODELED_DRAFT_BATCH_CONTINUATION_VERSION = 2;

type ModeledDraftCount = 2 | 3 | 4 | 5 | 6;

export type ModeledDraftBatchContinuation = Readonly<{
  kind: "modeled_draft_batch";
  version: typeof MODELED_DRAFT_BATCH_CONTINUATION_VERSION;
  route: Readonly<{
    kind: "workspace_research";
    outcome: Readonly<{ kind: "draft"; expectedDrafts: ModeledDraftCount }>;
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
  if (!route) return null;
  let canonicalRoute: ReadOnlyOrchestratorRoute;
  try {
    canonicalRoute = canonicalizeReadOnlyOrchestratorRoute(route);
  } catch {
    return null;
  }
  const expectedDrafts = modeledDraftCount(
    canonicalRoute.outcome?.kind === "draft"
      ? canonicalRoute.outcome.expectedDrafts
      : undefined,
  );
  if (
    canonicalRoute.kind !== "workspace_research" ||
    canonicalRoute.outcome?.kind !== "draft" ||
    canonicalRoute.workspaceDraftSourceMode !== "one_to_one" ||
    !expectedDrafts ||
    !Number.isInteger(canonicalRoute.minimumSources) ||
    Number(canonicalRoute.minimumSources) < expectedDrafts ||
    Number(canonicalRoute.minimumSources) > 10 ||
    (canonicalRoute.workspaceSearchMode !== "diverse" &&
      canonicalRoute.workspaceSearchMode !== "strict_top") ||
    (canonicalRoute.workspaceSince !== undefined &&
      canonicalRoute.workspaceSince !== "1d" &&
      canonicalRoute.workspaceSince !== "7d" &&
      canonicalRoute.workspaceSince !== "30d") ||
    (canonicalRoute.workspacePostType !== undefined &&
      canonicalRoute.workspacePostType !== "regular" &&
      canonicalRoute.workspacePostType !== "lead_magnet") ||
    (canonicalRoute.authoritativeInstruction !== undefined &&
      (!canonicalRoute.authoritativeInstruction.trim() ||
        canonicalRoute.authoritativeInstruction.length > 50_000))
  ) {
    return null;
  }
  return {
    kind: "modeled_draft_batch",
    version: MODELED_DRAFT_BATCH_CONTINUATION_VERSION,
    route: {
      kind: "workspace_research",
      outcome: { kind: "draft", expectedDrafts },
      minimumSources: Number(canonicalRoute.minimumSources),
      workspaceSearchMode: canonicalRoute.workspaceSearchMode,
      workspaceDraftSourceMode: "one_to_one",
      ...(canonicalRoute.workspaceSince
        ? { workspaceSince: canonicalRoute.workspaceSince }
        : {}),
      ...(canonicalRoute.workspacePostType
        ? { workspacePostType: canonicalRoute.workspacePostType }
        : {}),
      ...(canonicalRoute.authoritativeInstruction
        ? { authoritativeInstruction: canonicalRoute.authoritativeInstruction }
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
    (continuation.version !== 1 &&
      continuation.version !== MODELED_DRAFT_BATCH_CONTINUATION_VERSION) ||
    !rawRoute
  ) {
    return null;
  }
  const allowedContinuationKeys = new Set(["kind", "version", "route"]);
  const legacy = continuation.version === 1;
  const allowedRouteKeys = new Set([
    "kind",
    ...(legacy ? ["expectsDraft", "expectedDrafts"] : ["outcome"]),
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
  const rawOutcome = recordOf(rawRoute.outcome);
  if (
    !legacy &&
    (!rawOutcome ||
      Object.keys(rawOutcome).some(
        (key) => key !== "kind" && key !== "expectedDrafts",
      ))
  ) {
    return null;
  }
  const expectedDrafts = modeledDraftCount(
    legacy ? rawRoute.expectedDrafts : rawOutcome?.expectedDrafts,
  );
  if (
    rawRoute.kind !== "workspace_research" ||
    (legacy ? rawRoute.expectsDraft !== true : rawOutcome?.kind !== "draft") ||
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

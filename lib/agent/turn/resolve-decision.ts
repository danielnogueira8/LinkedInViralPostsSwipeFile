// Side-effect-free turn-decision resolver ("confirm before generating").
//
// Given a chat-turn request body + workspace, produce the RESOLVED routing
// decision the real turn will use — mode, count, niche, post type, source —
// WITHOUT claiming a turn, persisting a message, or running the model. It
// reuses the exact same resolvePreclaimRouting the live turn calls (see
// preclaim-routing.ts) plus the exact same compileServerReadOnlyPlan the
// read-only orchestrator runs for the niche, so the read-back a user confirms
// cannot describe one thing while the turn does another.
//
// Scope: the common turn (typed command + text, optional source/style/lead
// magnet/count). Retry and modeled-batch continuation resolve as their base
// case (empty markers, null continuation) — the confirm UI fires on a fresh
// composer send, never on a resumed operation.
import type { ChatTurnRequest } from "@/lib/agent/chat-turn";
import { explicitMessageDraftCount } from "@/lib/agent/chat-turn";
import { commandToTurnOperation } from "@/lib/cowork-command";
import {
  resolvePreclaimRouting,
  type PreclaimRouting,
} from "@/lib/agent/turn/preclaim-routing";
import { compileServerReadOnlyPlan } from "@/lib/agent/execute/agent";
import type { ReadOnlyOrchestratorRoute } from "@/lib/agent/turn/compile";
import { runTool } from "@/lib/agent/tools";

export type TurnDecisionMode = "ask" | "create" | "edit";

export type TurnDecision = {
  /** The composer mode the turn resolves to. */
  mode: TurnDecisionMode;
  /** How many posts/drafts the turn will produce (null when not a post turn). */
  postCount: number | null;
  /**
   * The account niche the source search will filter to, or null for
   * "all niches" (the safe default — never an invented niche).
   */
  niche: string | null;
  /** The resolved post type for a draft turn, when one is determined. */
  postType: "regular" | "lead_magnet" | null;
  /** Whether a model source post drives this turn's structure. */
  hasModelSource: boolean;
  /** Whether a creator style will be applied (only when no model source). */
  hasCreatorStyle: boolean;
  /** Whether a lead magnet was explicitly selected for this turn. */
  hasLeadMagnetSelection: boolean;
  /** The high-level task kind (post / ideas / answer / …) from the composer. */
  taskKind: string;
  /** Raw resolved route + contract, for conflict detection and debugging. */
  route: {
    readOnly: ReadOnlyOrchestratorRoute | null;
    contractKind: string;
  };
};

export type ResolveDecisionDeps = {
  listWorkspaceNiches: (workspaceId: string) => Promise<string[]>;
  now: () => Date;
};

export const productionResolveDecisionDeps: ResolveDecisionDeps = {
  listWorkspaceNiches: async (workspaceId: string) => {
    // Same read the orchestrator uses (agent.ts listWorkspaceNichesProduction),
    // duplicated here so the resolver has no dependency on generation internals.
    // Fails open to [] — a niche-lookup blip must never block a read-back.
    try {
      const result = await runTool("list_niches", {}, workspaceId);
      if (
        !result ||
        typeof result !== "object" ||
        (result as { ok?: unknown }).ok !== true
      ) {
        return [];
      }
      const niches = (result as { niches?: unknown }).niches;
      if (!Array.isArray(niches)) return [];
      return niches
        .map((entry) =>
          entry && typeof entry === "object"
            ? (entry as { niche?: unknown }).niche
            : undefined,
        )
        .filter(
          (niche): niche is string =>
            typeof niche === "string" && niche.length > 0,
        );
    } catch {
      return [];
    }
  },
  now: () => new Date(),
};

/** The composer command kind → resolved display mode. */
function decisionMode(operationKind: string | undefined): TurnDecisionMode {
  if (operationKind === "create_post") return "create";
  if (operationKind === "edit_artifact") return "edit";
  return "ask";
}

/**
 * Pull the resolved account niche out of a compiled read-only plan. The plan's
 * search_viral_posts action carries the niche compileServerReadOnlyPlan matched
 * against the workspace's real niches (or none, for "all niches").
 */
function resolvedNicheFromPlan(
  route: ReadOnlyOrchestratorRoute | null,
  authoritativeInstruction: string,
  knownNiches: string[],
): string | null {
  if (!route) return null;
  const plan = compileServerReadOnlyPlan(
    route,
    authoritativeInstruction,
    knownNiches,
  );
  const search = plan?.actions.find(
    (action) => action.type === "search_viral_posts",
  );
  if (search && "niche" in search && typeof search.niche === "string") {
    return search.niche;
  }
  return null;
}

/**
 * Resolve the truthful decision for a chat-turn request. Pure except for the
 * single injected list_niches read (only performed when the resolved route can
 * filter by niche).
 */
export async function resolveTurnDecision(
  body: ChatTurnRequest,
  workspaceId: string,
  deps: ResolveDecisionDeps = productionResolveDecisionDeps,
): Promise<TurnDecision> {
  const preclaimInstruction = body.message;
  const currentTurnOperation = body.command
    ? commandToTurnOperation(body.command, preclaimInstruction)
    : (body.operation ?? null);
  const requestedGenerationConfig =
    body.command?.kind === "create"
      ? ({ version: 1 as const, draftCount: body.command.count })
      : (body.generationConfig ?? null);

  const preclaim: PreclaimRouting = resolvePreclaimRouting({
    preclaimInstruction,
    resolvedGenerationConfig: null,
    requestedGenerationConfig,
    generationConfigRestoredFromRetry: false,
    currentTurnOperation,
    composerStarterId: body.starterId,
    modelSourceId: body.modelSourceId,
    attachmentCount: body.attachments?.length ?? 0,
    hasLeadMagnetSelection: Boolean(body.leadMagnetId || body.createLeadMagnet),
    hasCreatorStyle: Boolean(body.creatorStyleId),
    skipDecision: body.skipDecision ?? false,
    // A fresh composer send has no unresolved ask/draft continuation; the
    // confirm UI never fires on a resumed operation.
    hasUnsavedDraftReferent: false,
    normalizedActionRoute: null,
    modeledBatchContinuation: null,
    pendingAskOnly: false,
    clientTimezone: body.clientTimezone,
    now: deps.now,
    explicitMessageDraftCount,
  });

  const readOnlyRoute = preclaim.preclaimReadOnlyRoute;
  const needsNiche =
    readOnlyRoute?.kind === "workspace_research" ||
    readOnlyRoute?.kind === "file_inspection";
  const knownNiches = needsNiche
    ? await deps.listWorkspaceNiches(workspaceId)
    : [];
  const authoritativeInstruction =
    readOnlyRoute?.authoritativeInstruction ?? preclaimInstruction;
  const niche = needsNiche
    ? resolvedNicheFromPlan(readOnlyRoute, authoritativeInstruction, knownNiches)
    : null;

  const postCount =
    preclaim.preclaimContractPlaceholder.kind === "post"
      ? preclaim.preclaimContractPlaceholder.expectedCount
      : null;
  const postType =
    readOnlyRoute?.explicitPostType ?? readOnlyRoute?.workspacePostType ?? null;

  return {
    mode: decisionMode(currentTurnOperation?.kind),
    postCount,
    niche,
    postType,
    hasModelSource: Boolean(body.modelSourceId),
    hasCreatorStyle: Boolean(body.creatorStyleId),
    hasLeadMagnetSelection: Boolean(body.leadMagnetId || body.createLeadMagnet),
    taskKind: preclaim.composerTaskContext.kind,
    route: {
      readOnly: readOnlyRoute,
      contractKind: preclaim.preclaimContractPlaceholder.kind,
    },
  };
}

import {
  explicitlyForbidsSourceDiscovery,
  explicitlyRequestsSourceDiscovery,
  requestsDurableOrAction,
  requestsSourceModeling,
} from "@/lib/agent/source-policy";
import { requestedDirectPostCount } from "@/lib/agent/direct-deliverable-policy";
import { coworkRolloutDecision } from "@/lib/agent/cowork-rollout";
import type { coworkRolloutRuntimeHealth } from "@/lib/agent/cowork-rollout-health";
import type { PostType } from "@/lib/post-type";

export const READ_ONLY_ORCHESTRATOR_ROUTE_KINDS = [
  "news_research",
  "web_research",
  "workspace_research",
  "file_inspection",
  "ambiguous_read_only",
] as const;

export type ReadOnlyOrchestratorRouteKind =
  (typeof READ_ONLY_ORCHESTRATOR_ROUTE_KINDS)[number];

export type ReadOnlyOrchestratorRoute = {
  kind: ReadOnlyOrchestratorRouteKind;
  expectsDraft: boolean;
  expectedDrafts?: number;
  allowExternalSearch?: boolean;
  allowedSearchKinds?: Array<"news" | "web" | "workspace">;
  minimumSources?: number;
  workspaceSearchMode?: "diverse" | "strict_top";
  workspaceSince?: "1d" | "7d" | "30d";
  workspacePostType?: PostType;
  workspaceDraftSourceMode?: "one_to_one";
  clarificationReason?: "outcome" | "research_topic";
  authoritativeInstruction?: string;
};

export type ReadOnlyOrchestratorRoutingInput = {
  userInstruction: string;
  isRefine: boolean;
  hasModelSource: boolean;
  hasAttachments: boolean;
  hasLeadMagnet: boolean;
  hasCreatorStyle: boolean;
};

type ReadOnlyOrchestratorEnvironment = Record<string, string | undefined>;

/** Fail-closed shared rollout policy for the read-only orchestrator lane. */
export function readOnlyOrchestratorEnabledForWorkspace(
  workspaceId: string,
  env: ReadOnlyOrchestratorEnvironment = process.env,
  runtimeHealth?: Pick<typeof coworkRolloutRuntimeHealth, "isOpen">,
): boolean {
  return coworkRolloutDecision(
    "read_only_orchestrator",
    workspaceId,
    env,
    runtimeHealth,
  ).serveV2;
}

const FULL_POST_REQUEST_RE =
  /\b(?:write|draft|create|generate|make|produce|prepare|give\s+me|model|mimic|adapt|rewrite|rework|remix)\b[\s\S]{0,180}\b(?:linkedin\s+)?posts?\b|\b(?:linkedin\s+)?posts?\b[\s\S]{0,120}\b(?:write|draft|create|generate|make|produce|prepare|model|mimic|adapt|rewrite|rework|remix)\b/i;
const NEWS_RE =
  /\b(?:news(?:jack(?:ing)?)?|breaking|trending|latest|today(?:'s)?|current|recent)\b[\s\S]{0,100}\b(?:announcement|launch|release|development|update|story|coverage|news|trend)|\b(?:announcement|launch|release|development|update|story|coverage|news|trend)\b[\s\S]{0,100}\b(?:latest|today(?:'s)?|current|recent|breaking|trending)\b/i;
const EXPLICIT_NEWS_TOPIC_RE = /\b(?:news|newsjack(?:ing)?)\b/i;
const FIRST_PARTY_NEWS_CONTEXT_RE =
  /\b(?:our|my)(?:\s+(?:latest|recent|new|current))?(?:\s+(?:company|product|team|career|business))?\s+(?:news|announcement|launch|release|development|update)\b|\b(?:news|announcement|launch|release|development|update)\b(?:\s+[\p{L}\p{N}-]+){0,2}\s+(?:about|from|in|at)\s+(?:our|my)\s+(?:company|product|team|career|business)\b/iu;
const RESEARCH_RE =
  /\b(?:research|investigate|fact[ -]?check|verify|look\s+into|browse|search)\b/i;
const MULTI_SOURCE_RE =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|[2-9]|10|multiple|several)\b(?:(?![.!?]|\b(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b)[\s\S]){0,160}?\b(?:sources?|examples?|posts?|articles?|files?|documents?)\b|\b(?:compare|synthesi[sz]e|cross[ -]?check)\b[\s\S]{0,100}\b(?:sources?|examples?|posts?|articles?|files?|documents?)\b/iu;
const OUTPUT_FIRST_SOURCE_DISCOVERY_RE =
  /\b(?:after|using)\s+(?:finding|searching|researching|reviewing|comparing)\b[\s\S]{0,140}\b(?:viral|top|best|swipe\s+file|bookmarks?|examples?|sources?|posts?|articles?|files?|documents?)\b/i;
const FILE_INSPECTION_RE =
  /\b(?:attached|attachment|file|document|pdf|interview|transcript)\b|\b(?:inspect|analy[sz]e|review|read|compare|summari[sz]e|extract)\b/i;
const COMPLEX_READ_RE =
  /\b(?:research|investigate|fact[ -]?check|verify|compare|synthesi[sz]e|inspect|analy[sz]e|review|read|search|find)\b/i;
const EXPLICIT_NON_POST_OUTCOME_RE =
  /\b(?:summari[sz]e|compare|analy[sz]e|explain|tell\s+me|show\s+me|list|report|recommend|answer|give\s+me\s+(?:the\s+)?(?:findings|takeaways|results|lessons))\b/i;
const HISTORY_DEPENDENT_RESEARCH_RE =
  /\b(?:this|that|it|these|those|their|his|her|its|above|previous|earlier)\b/i;
const STRICT_TOP_SOURCE_RE =
  /\b(?:top|best|highest[-\s]?engagement|high[-\s]?performing)\b/i;
const SOURCE_COUNT_RE =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|[1-9]|10)\b(?:(?![.!?]|\b(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b)[\s\S]){0,160}?\b(?:sources?|examples?|posts?|articles?|files?|documents?)\b/giu;
const SOURCE_COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function requestedExplicitSourceCount(instruction: string): number | null {
  const explicitCounts = [...instruction.matchAll(SOURCE_COUNT_RE)].map(
    (match) => {
      const value = match[1]?.toLowerCase() ?? "";
      return Number(value) || SOURCE_COUNT_WORDS[value] || 0;
    },
  );
  return explicitCounts.length > 0 ? Math.max(...explicitCounts) : null;
}

function requestedSourceMinimum(instruction: string): number {
  // Requests can put the output first ("write one post after finding three
  // posts"). Taking the first match would undercount the research requirement.
  // The maximum is deliberately conservative: asking for one extra source is
  // preferable to drafting from fewer sources than the user explicitly asked
  // us to compare.
  const explicitCount = requestedExplicitSourceCount(instruction);
  // A one-to-one rewrite needs exactly one source. Requiring a second source
  // would turn a clear modeling request into an unnecessary synthesis task.
  if (explicitCount === 1) return 1;
  return Math.max(
    2,
    /\bseveral\b/i.test(instruction) ? 3 : 2,
    explicitCount ?? 0,
  );
}

function requestedTransformationDraftCount(
  instruction: string,
  researchClause: string,
): number | null {
  if (!requestsSourceModeling(instruction)) return null;
  return requestedExplicitSourceCount(researchClause);
}

function requestedWorkspacePostType(
  researchClause: string,
): PostType | undefined {
  if (/\blead[-\s]?magnet\s+posts?\b/i.test(researchClause)) {
    return "lead_magnet";
  }
  if (/\bregular\s+posts?\b/i.test(researchClause)) return "regular";
  return undefined;
}

function sourceResearchClause(instruction: string): string {
  const normalized = instruction.replace(/\s+/g, " ").trim();
  const outputFirst = normalized.match(
    /\b(?:after|using)\s+((?:finding|researching|searching|comparing|reviewing|inspecting)\b[\s\S]*)$/i,
  )?.[1];
  if (outputFirst) {
    return outputFirst
      .split(/[.!?](?:\s|$)/, 1)[0]
      .split(
        /\s*,?\s*\b(?:and|then)\s+(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b/i,
        1,
      )[0]
      .trim();
  }
  const directWritingTopic = normalized.match(
    /^(?:please\s+)?(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b[\s\S]{0,120}?\babout\s+([\s\S]+)$/i,
  )?.[1];
  if (directWritingTopic) {
    return directWritingTopic.split(/[.!?](?:\s|$)/, 1)[0].trim();
  }
  return normalized
    .split(
      /(?:\b(?:and|then)\s+|[.!?]\s*)(?:please\s+)?(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b/i,
    )[0]
    .trim();
}

const GENERIC_RESEARCH_TERMS = new Set([
  "a",
  "about",
  "an",
  "and",
  "announcement",
  "breaking",
  "browse",
  "coverage",
  "current",
  "development",
  "fact-check",
  "fact",
  "check",
  "for",
  "further",
  "investigate",
  "into",
  "latest",
  "launch",
  "look",
  "more",
  "news",
  "newsjack",
  "newsjacking",
  "of",
  "on",
  "please",
  "recent",
  "release",
  "research",
  "search",
  "story",
  "the",
  "this",
  "today",
  "trend",
  "trending",
  "update",
  "verify",
  "web",
]);

function hasConcreteResearchTopic(instruction: string): boolean {
  return (
    instruction
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}][\p{L}\p{N}-]+/gu)
      ?.some((term) => !GENERIC_RESEARCH_TERMS.has(term)) ?? false
  );
}

function requestedWorkspaceWindow(
  instruction: string,
): "1d" | "7d" | "30d" | undefined {
  if (/\b(?:today|last\s+24\s+hours?|past\s+24\s+hours?)\b/i.test(instruction)) {
    return "1d";
  }
  if (/\b(?:this\s+week|last\s+7\s+days?|past\s+7\s+days?)\b/i.test(instruction)) {
    return "7d";
  }
  if (
    /\b(?:this\s+month|last\s+30\s+days?|past\s+30\s+days?|latest|recent)\b/i.test(
      instruction,
    )
  ) {
    return "30d";
  }
  return undefined;
}

function clarificationFollowup(
  instruction: string,
): { original: string; answer: string } | null {
  const match = instruction.match(
    /^([\s\S]*?)\s+Clarification answer:\s*([^\n]+)\s*$/i,
  );
  const original = match?.[1]?.trim() ?? "";
  const answer = match?.[2]?.trim() ?? "";
  return original && answer ? { original, answer } : null;
}

function instructionWithResolvedResearchTopic(
  original: string,
  answer: string,
): string {
  if (
    /\b(?:news|announcement|launch|release|development|update|story|coverage|trend)\b/i.test(
      original,
    )
  ) {
    return original.replace(
      /\b(?:news|announcement|launch|release|development|update|story|coverage|trend)\b/i,
      (noun) => `${answer} ${noun}`,
    );
  }
  return original.replace(
    /\b(?:research|investigate|fact[ -]?check|verify|look\s+into|browse|search)\b/i,
    (verb) => `${verb} ${answer}`,
  );
}

const CLARIFIED_COUNT_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

// The clarifying question is model-generated ("How many LinkedIn posts?"),
// and a user answering naturally drops the word "LinkedIn" entirely ("3
// posts", "three posts") — even a bare count ("3", "three") is a normal
// answer to a "how many" question. Requiring the literal word "LinkedIn"
// silently failed the whole clarification resolution for these answers,
// falling the turn out of the orchestrator instead of completing it.
function clarifiedLinkedInPostCount(answer: string): number | null {
  const trimmed = answer.trim();
  const match =
    trimmed.match(
      /^(?:(a|an|one|two|three|four|five|six|[1-6])\s+)?(?:linkedin\s+)?posts?[.!]?$/i,
    ) ?? trimmed.match(/^(a|an|one|two|three|four|five|six|[1-6])[.!]?$/i);
  if (!match) return null;
  const value = match[1]?.toLocaleLowerCase("en-US") ?? "one";
  return Number(value) || CLARIFIED_COUNT_WORDS[value] || 1;
}

/**
 * Compile only the read-only journeys with materially different evidence
 * sequences. Common writing, refine, fixed-source, and durable-action turns
 * remain owned by their existing deterministic lanes.
 */
export function compileReadOnlyOrchestratorRoute(
  input: ReadOnlyOrchestratorRoutingInput,
): ReadOnlyOrchestratorRoute | null {
  const followup = clarificationFollowup(input.userInstruction);
  if (followup) {
    const originalRoute = compileReadOnlyOrchestratorRoute({
      ...input,
      userInstruction: followup.original,
    });
    let resolvedInstruction: string | null = null;
    const clarifiedPostCount = clarifiedLinkedInPostCount(followup.answer);
    if (
      originalRoute?.clarificationReason === "outcome" &&
      clarifiedPostCount !== null
    ) {
      resolvedInstruction = `${followup.original}\n\nWrite ${
        clarifiedPostCount === 1 ? "a" : clarifiedPostCount
      } LinkedIn ${clarifiedPostCount === 1 ? "post" : "posts"}.`;
    } else if (originalRoute?.clarificationReason === "research_topic") {
      resolvedInstruction = instructionWithResolvedResearchTopic(
        followup.original,
        followup.answer,
      );
    }
    if (resolvedInstruction) {
      const resolvedRoute = compileReadOnlyOrchestratorRoute({
        ...input,
        userInstruction: resolvedInstruction,
      });
      return resolvedRoute
        ? { ...resolvedRoute, authoritativeInstruction: resolvedInstruction }
        : null;
    }
    return null;
  }
  const instruction = input.userInstruction.trim();
  const forbidsDiscovery = explicitlyForbidsSourceDiscovery(instruction);
  if (
    !instruction ||
    input.isRefine ||
    input.hasModelSource ||
    input.hasLeadMagnet ||
    input.hasCreatorStyle ||
    requestsDurableOrAction(instruction) ||
    (forbidsDiscovery && !input.hasAttachments)
  ) {
    return null;
  }

  const explicitDraftCount = requestedDirectPostCount(instruction);
  const sourceModelingRequest = requestsSourceModeling(instruction);
  const researchClause = sourceResearchClause(instruction);
  const transformationDraftCount = requestedTransformationDraftCount(
    instruction,
    researchClause,
  );
  const workspacePostType = requestedWorkspacePostType(researchClause);
  const writingOutputClause = instruction.match(
    /\b(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b[\s\S]{0,180}?\b(?:linkedin\s+)?posts?\b/i,
  )?.[0] ?? "";
  const hasPluralPostTarget = /\b(?:linkedin\s+)?posts\b/i.test(
    writingOutputClause,
  );
  const unresolvedPluralDraftTarget =
    (FULL_POST_REQUEST_RE.test(instruction) || sourceModelingRequest) &&
    hasPluralPostTarget &&
    explicitDraftCount === null;
  const expectsDraft =
    (FULL_POST_REQUEST_RE.test(instruction) || sourceModelingRequest) &&
    (!hasPluralPostTarget || explicitDraftCount !== null);
  const expectedDrafts =
    explicitDraftCount ?? transformationDraftCount ?? 1;
  const workspaceDraftSourceMode =
    transformationDraftCount !== null &&
    expectedDrafts === transformationDraftCount
      ? ("one_to_one" as const)
      : undefined;
  const needsFileInspection =
    input.hasAttachments && FILE_INSPECTION_RE.test(instruction);
  const needsNews =
    !FIRST_PARTY_NEWS_CONTEXT_RE.test(instruction) &&
    (EXPLICIT_NEWS_TOPIC_RE.test(instruction) ||
      (NEWS_RE.test(instruction) && RESEARCH_RE.test(instruction)));
  const needsWorkspaceResearch =
    (explicitlyRequestsSourceDiscovery(instruction) ||
      OUTPUT_FIRST_SOURCE_DISCOVERY_RE.test(instruction)) &&
    (MULTI_SOURCE_RE.test(researchClause) ||
      workspaceDraftSourceMode === "one_to_one");
  const complexRead =
    needsFileInspection ||
    needsNews ||
    needsWorkspaceResearch ||
    COMPLEX_READ_RE.test(instruction);

  if (
    !needsFileInspection &&
    FIRST_PARTY_NEWS_CONTEXT_RE.test(instruction) &&
    RESEARCH_RE.test(researchClause)
  ) {
    return null;
  }

  if (
    !needsFileInspection &&
    (RESEARCH_RE.test(researchClause) || needsNews) &&
    HISTORY_DEPENDENT_RESEARCH_RE.test(researchClause)
  ) {
    return null;
  }

  if (!expectsDraft) {
    return unresolvedPluralDraftTarget ||
      (complexRead && !EXPLICIT_NON_POST_OUTCOME_RE.test(instruction))
      ? {
          kind: "ambiguous_read_only",
          expectsDraft: false,
          clarificationReason: "outcome",
        }
      : null;
  }
  if (needsFileInspection) {
    const allowedSearchKinds: Array<"news" | "web" | "workspace"> = [];
    if (!forbidsDiscovery) {
      if (needsNews) allowedSearchKinds.push("news");
      if (needsWorkspaceResearch) allowedSearchKinds.push("workspace");
      if (
        RESEARCH_RE.test(researchClause) &&
        !needsNews &&
        !needsWorkspaceResearch
      ) {
        allowedSearchKinds.push("web");
      }
    }
    return {
      kind: "file_inspection",
      expectsDraft: true,
      expectedDrafts,
      allowExternalSearch: allowedSearchKinds.length > 0,
      allowedSearchKinds,
      ...(needsWorkspaceResearch
        ? {
            minimumSources: requestedSourceMinimum(researchClause),
            workspaceSearchMode: STRICT_TOP_SOURCE_RE.test(researchClause)
              ? ("strict_top" as const)
              : ("diverse" as const),
            ...(requestedWorkspaceWindow(researchClause)
              ? { workspaceSince: requestedWorkspaceWindow(researchClause) }
              : {}),
            ...(workspacePostType ? { workspacePostType } : {}),
          }
        : {}),
    };
  }
  if (needsNews) {
    if (!hasConcreteResearchTopic(researchClause)) {
      return {
        kind: "ambiguous_read_only",
        expectsDraft: false,
        clarificationReason: "research_topic",
      };
    }
    return { kind: "news_research", expectsDraft: true, expectedDrafts };
  }
  if (needsWorkspaceResearch) {
    return {
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts,
      minimumSources: requestedSourceMinimum(researchClause),
      workspaceSearchMode: STRICT_TOP_SOURCE_RE.test(researchClause)
        ? "strict_top"
        : "diverse",
      ...(requestedWorkspaceWindow(researchClause)
        ? { workspaceSince: requestedWorkspaceWindow(researchClause) }
        : {}),
      ...(workspacePostType ? { workspacePostType } : {}),
      ...(workspaceDraftSourceMode ? { workspaceDraftSourceMode } : {}),
    };
  }
  if (RESEARCH_RE.test(instruction)) {
    if (!hasConcreteResearchTopic(researchClause)) {
      return {
        kind: "ambiguous_read_only",
        expectsDraft: false,
        clarificationReason: "research_topic",
      };
    }
    return { kind: "web_research", expectsDraft: true, expectedDrafts };
  }
  return null;
}

/**
 * Cost admission happens before optional resources are resolved. A selected
 * lead magnet can later be ignored for a neutral research request, so it must
 * not suppress the larger reserve at claim time. Over-reserving a turn that
 * ultimately uses a lead magnet is safe; under-reserving an orchestrated turn
 * is not.
 */
export function compileReadOnlyOrchestratorReserveRoute(
  input: ReadOnlyOrchestratorRoutingInput,
): ReadOnlyOrchestratorRoute | null {
  return compileReadOnlyOrchestratorRoute({
    ...input,
    hasLeadMagnet: false,
  });
}

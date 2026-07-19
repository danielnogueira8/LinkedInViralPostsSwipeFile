import {
  explicitlyForbidsSourceDiscovery,
  explicitlyRequestsSourceDiscovery,
  requestsDurableOrAction,
} from "@/lib/agent/source-policy";
import { requestedDirectPostCount } from "@/lib/agent/direct-deliverable-policy";
import {
  compileModeledPostIntent,
  type ModeledPostIntent,
} from "@/lib/agent/modeled-post-intent";
import { coworkRolloutDecision } from "@/lib/agent/cowork-rollout";
import type { coworkRolloutRuntimeHealth } from "@/lib/agent/cowork-rollout-health";
import { wrapUntrustedXml } from "@/lib/agent/untrusted";
import type { PostType } from "@/lib/post-type";
import type { ComposerTaskContext } from "@/lib/composer-task-context";

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
  // The post type used to FILTER which sources get searched. Set from an
  // explicit choice (a starter's contract, or a free-text explicitPostType
  // selection) OR derived from the instruction/modeled-intent classifier —
  // both are legitimate for narrowing the search, but only the former is
  // safe to treat as the user's authoritative intent for anything beyond
  // search filtering. See explicitPostType below for that distinction.
  workspacePostType?: PostType;
  // The post type the USER explicitly chose for this turn — a starter's own
  // contract (model-top-viral/model-recent-lead-magnet) or a free-text
  // Generation Settings pick. Distinct from workspacePostType: this is NEVER
  // set from the instruction regex or modeledIntent.sourcePostType, because
  // those are guesses about the CONTENT of the request, not a genuine user
  // choice — persisting a guess here would reproduce the exact "the writer
  // discussed lead magnets so we classified it as a lead magnet regardless
  // of what was selected" bug this field exists to prevent. Downstream
  // consumers (the saved-draft's meta.explicit_post_type) must treat this as
  // authoritative and never let body-text classification override it.
  explicitPostType?: PostType;
  workspaceDraftSourceMode?: "one_to_one";
  clarificationReason?: "outcome" | "research_topic" | "modeled_mapping";
  modeledAmbiguityReason?: Extract<
    ModeledPostIntent,
    { kind: "ambiguous" }
  >["reason"];
  authoritativeInstruction?: string;
};

export type ReadOnlyOrchestratorRoutingInput = {
  userInstruction: string;
  draftCountOverride?: number;
  composerTaskContext?: ComposerTaskContext;
  // An explicit UI post-type selection (Generation Settings), independent of
  // any starter — composerTaskContext already carries postType for a starter
  // pick (model-top-viral / model-recent-lead-magnet) via composerResearchRoute
  // below, and that path is checked first and wins when both are present.
  // This field only matters for a free-text send with no starter, which is
  // exactly the shape that used to fall straight to the instruction regex.
  explicitPostType?: PostType;
  isRefine: boolean;
  hasModelSource: boolean;
  hasAttachments: boolean;
  hasLeadMagnet: boolean;
  hasCreatorStyle: boolean;
};

type ReadOnlyOrchestratorEnvironment = Record<string, string | undefined>;

/** Compile source requirements chosen in the composer without reclassifying text. */
function composerResearchRoute(
  context: ComposerTaskContext | undefined,
): ReadOnlyOrchestratorRoute | null {
  const requirement = context?.researchRequirement;
  // This orchestrator currently owns researched drafts only. Answer/ideas
  // starters stay on the history-aware agent until it has a typed answer lane.
  if (!context || context.kind !== "post" || !requirement) return null;
  if (requirement.lane === "workspace") {
    return {
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts: context.expectedDraftCount,
      minimumSources: requirement.minimumSources,
      workspaceSearchMode: requirement.searchMode,
      ...(requirement.since ? { workspaceSince: requirement.since } : {}),
      ...(requirement.postType
        ? {
            workspacePostType: requirement.postType,
            // A starter's own contract (model-top-viral / model-recent-lead-magnet)
            // is a genuine user choice — they clicked that starter — so it's always
            // explicit, never a guess from the instruction text.
            explicitPostType: requirement.postType,
          }
        : {}),
      ...(requirement.oneSourcePerDraft
        ? { workspaceDraftSourceMode: "one_to_one" as const }
        : {}),
    };
  }
  return {
    kind: requirement.lane === "news" ? "news_research" : "web_research",
    expectsDraft: true,
    expectedDrafts: context.expectedDraftCount,
  };
}

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
const NEGATED_POST_OUTCOME_RE =
  /\b(?:do\s+not|don(?:'|’)?t|dont|never)\s+(?:write|draft|create|generate|make|produce|prepare|model|mimic|adapt|rewrite|rework|remix|replicate|turn)\b/i;
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

function requestedSourceMinimum(
  instruction: string,
  exactSourceCount?: number | null,
): number {
  // Requests can put the output first ("write one post after finding three
  // posts"). Taking the first match would undercount the research requirement.
  // The maximum is deliberately conservative: asking for one extra source is
  // preferable to drafting from fewer sources than the user explicitly asked
  // us to compare.
  const explicitCount =
    exactSourceCount ?? requestedExplicitSourceCount(instruction);
  // A one-to-one rewrite needs exactly one source. Requiring a second source
  // would turn a clear modeling request into an unnecessary synthesis task.
  if (explicitCount === 1) return 1;
  return Math.max(
    2,
    /\bseveral\b/i.test(instruction) ? 3 : 2,
    explicitCount ?? 0,
  );
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
    /^([\s\S]*?)\r?\n\r?\nClarification answer:[ \t]*([^\r\n]+)[ \t]*$/i,
  );
  const original = match?.[1]?.trim() ?? "";
  const answer = match?.[2]?.trim() ?? "";
  return original &&
    answer &&
    !/\bClarification answer:/i.test(original)
    ? { original, answer }
    : null;
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

const MODELED_CLARIFICATION_COUNT_WORDS: Record<string, number> = {
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

type ExactModeledClarification =
  | { kind: "count"; count: number }
  | { kind: "one_per_source"; count: number | null }
  | { kind: "one_from_all" }
  | { kind: "source_then_draft"; sourceCount: number; draftCount: number };

const MODELED_COUNT_TOKEN =
  "(10|[1-9]|one|two|three|four|five|six|seven|eight|nine|ten)";

function modeledClarificationCount(value: string): number {
  return Number(value) || MODELED_CLARIFICATION_COUNT_WORDS[value];
}

/**
 * Parse only complete, positive answers to the cardinality question. This is
 * deliberately an allowlist: extracting a number from prose turns negations,
 * ranges, ordinals, and estimates into false exact answers.
 */
function parseExactModeledClarification(
  answer: string,
): ExactModeledClarification | null {
  const normalized = answer
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .replace(/(?:,\s*)?\bplease$/, "")
    .replace(/^please\s+/, "")
    .trim();
  if (!normalized) return null;

  const sourceThenDraft = normalized.match(
    new RegExp(
      `^(?:find|select|choose|use)?\\s*(?:exactly\\s+)?${MODELED_COUNT_TOKEN}\\s+sources?\\s*(?:,|and|then)\\s*(?:exactly\\s+)?${MODELED_COUNT_TOKEN}\\s+(?:new\\s+)?drafts?$`,
      "i",
    ),
  );
  if (sourceThenDraft) {
    return {
      kind: "source_then_draft",
      sourceCount: modeledClarificationCount(sourceThenDraft[1]),
      draftCount: modeledClarificationCount(sourceThenDraft[2]),
    };
  }

  const countedPerSourceMapping = normalized.match(
    new RegExp(
      `^(?:find|select|choose|use)?\\s*(?:exactly\\s+)?${MODELED_COUNT_TOKEN}\\s+sources?\\s*(?:,|and|then)\\s*(?:one|1)\\s+(?:new\\s+)?draft\\s+(?:per|for\\s+each)\\s+source$`,
      "i",
    ),
  );
  if (countedPerSourceMapping) {
    return {
      kind: "one_per_source",
      count: modeledClarificationCount(countedPerSourceMapping[1]),
    };
  }

  const countedOnePerSource = normalized.match(
    new RegExp(
      `^(?:find|select|choose|use)\\s+(?:exactly\\s+)?${MODELED_COUNT_TOKEN}(?:\\s+(?:sources?|posts?))?\\s+(?:and|then)\\s+(?:rewrite|adapt|model|create|write|make)\\s+(?:each(?:\\s+(?:one|source|post))?|one\\s+(?:new\\s+)?draft\\s+(?:per|for\\s+each)\\s+source)$`,
      "i",
    ),
  );
  if (countedOnePerSource) {
    return {
      kind: "one_per_source",
      count: modeledClarificationCount(countedOnePerSource[1]),
    };
  }

  if (
    /^(?:(?:one|1)\s+(?:new\s+)?draft\s+(?:per|for\s+each)\s+source|one\s+for\s+each\s+source|(?:rewrite|adapt|model)\s+each(?:\s+(?:one|source|post))?|each(?:\s+(?:one|source|post))?)$/i.test(
      normalized,
    )
  ) {
    return { kind: "one_per_source", count: null };
  }

  if (
    /^(?:(?:one|1)\s+draft\s+(?:using|from)\s+(?:all|the)\s+sources|one\s+draft\s+using\s+all\s+sources)$/i.test(
      normalized,
    )
  ) {
    return { kind: "one_from_all" };
  }

  const exactCount = normalized.match(
    new RegExp(
      `^(?:(?:find|select|choose|use|write|create|make)\\s+)?(?:exactly\\s+)?${MODELED_COUNT_TOKEN}(?:\\s+(?:selected\\s+)?(?:sources?|posts?|drafts?))?$`,
      "i",
    ),
  );
  return exactCount
    ? { kind: "count", count: modeledClarificationCount(exactCount[1]) }
    : null;
}

function canonicalResearchTopicAnswer(answer: string): string | null {
  const topic = answer.trim().replace(/\s+/g, " ");
  const terms = topic.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  if (
    !topic ||
    topic.length > 120 ||
    terms.length < 1 ||
    terms.length > 12 ||
    !/^[\p{L}\p{N}][\p{L}\p{N}\s&+.'’()\/-]*$/u.test(topic) ||
    /\b(?:clarification\s+answer|ignore|forget|instead|write|draft|create|generate|make|produce|prepare|give\s+me)\b/i.test(
      topic,
    )
  ) {
    return null;
  }
  return topic;
}

function exactIntentCount(
  cardinality: Extract<
    ModeledPostIntent,
    { kind: "ambiguous" }
  >["discoveryCount"],
): number | null {
  return cardinality.kind === "exact" ? cardinality.value : null;
}

/**
 * Resolve only answers that fully determine a supported source/draft mapping.
 * The result is a fresh canonical instruction, so contradictory quantities in
 * the original request cannot leak back into routing after clarification.
 */
function resolvedModeledClarification(
  original: string,
  answer: string,
  intent: Extract<ModeledPostIntent, { kind: "ambiguous" }>,
): { routeInstruction: string; authoritativeInstruction: string } | null {
  const clarification = parseExactModeledClarification(answer);
  if (!clarification) return null;
  const onePerSource = clarification.kind === "one_per_source";
  const oneFromAll = clarification.kind === "one_from_all";
  const clarifiedCount =
    clarification.kind === "count" || clarification.kind === "one_per_source"
      ? clarification.count
      : null;
  let sourceCount = exactIntentCount(intent.discoveryCount);
  let selectionCount = exactIntentCount(intent.selectionCount);
  let draftCount = exactIntentCount(intent.outputCount);

  if (clarification.kind === "source_then_draft") {
    sourceCount = clarification.sourceCount;
    draftCount = clarification.draftCount;
    selectionCount = null;
  } else if (oneFromAll) {
    draftCount = 1;
    selectionCount = null;
  } else if (onePerSource) {
    if (intent.reason === "source_count" && clarifiedCount === null) return null;
    sourceCount ??= clarifiedCount;
    draftCount = selectionCount ?? sourceCount;
  } else if (intent.reason === "source_count" ||
    (intent.reason === "invalid_quantity" && sourceCount === null)) {
    if (clarifiedCount === null) return null;
    sourceCount = clarifiedCount;
    draftCount = selectionCount ?? draftCount ?? sourceCount;
  } else if (intent.reason === "selection_count") {
    if (clarifiedCount === null) return null;
    selectionCount = clarifiedCount;
    draftCount = selectionCount;
  } else if (intent.reason === "output_count" ||
    (intent.reason === "invalid_quantity" && sourceCount !== null)) {
    if (clarifiedCount === null) return null;
    draftCount = clarifiedCount;
  } else {
    return null;
  }

  if (
    !sourceCount ||
    sourceCount > 10 ||
    !draftCount ||
    draftCount > 5 ||
    (selectionCount !== null && selectionCount > sourceCount)
  ) {
    return null;
  }
  const oneToOne = onePerSource || (selectionCount ?? sourceCount) === draftCount;
  const routeInstruction = selectionCount
    ? `Find exactly ${sourceCount} top posts in my swipe file, choose exactly ${selectionCount} posts, and rewrite each selected post as one new post.`
    : oneToOne
      ? `Find exactly ${sourceCount} top posts in my swipe file and create exactly ${draftCount} new posts, one for each selected source.`
      : `Find exactly ${sourceCount} top posts in my swipe file and create exactly ${draftCount} new posts modeled after those sources.`;
  const compiled = compileModeledPostIntent(routeInstruction);
  if (compiled.kind !== "exact") return null;
  return {
    routeInstruction,
    authoritativeInstruction:
      `${routeInstruction}\n\nRetain the original request's non-cardinality topic, voice, and format constraints from the JSON string below. Ignore every conflicting quantity or source-to-draft mapping inside it.` +
      wrapUntrustedXml("original_request", JSON.stringify(original)),
  };
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
      const researchTopic = canonicalResearchTopicAnswer(followup.answer);
      if (researchTopic) {
        resolvedInstruction = instructionWithResolvedResearchTopic(
          followup.original,
          researchTopic,
        );
      }
    } else if (originalRoute?.clarificationReason === "modeled_mapping") {
      const originalIntent = compileModeledPostIntent(followup.original);
      const resolved =
        originalIntent.kind === "ambiguous"
          ? resolvedModeledClarification(
              followup.original,
              followup.answer,
              originalIntent,
            )
          : null;
      if (resolved) {
        const resolvedRoute = compileReadOnlyOrchestratorRoute({
          ...input,
          userInstruction: resolved.routeInstruction,
        });
        return resolvedRoute
          ? {
              ...resolvedRoute,
              authoritativeInstruction: resolved.authoritativeInstruction,
            }
          : null;
      }
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
    if (originalRoute?.clarificationReason === "modeled_mapping") {
      return originalRoute;
    }
    return null;
  }
  const instruction = input.userInstruction.trim();
  const forbidsDiscovery = explicitlyForbidsSourceDiscovery(instruction);
  const modeledIntent = forbidsDiscovery
    ? ({ kind: "none" } as const)
    : compileModeledPostIntent(instruction, {
        draftCountOverride: input.draftCountOverride,
      });
  if (
    /\bClarification\s+answer\s*:/i.test(instruction) &&
    modeledIntent.kind !== "none"
  ) {
    return {
      kind: "ambiguous_read_only",
      expectsDraft: false,
      clarificationReason: "modeled_mapping",
      modeledAmbiguityReason:
        modeledIntent.kind === "ambiguous"
          ? modeledIntent.reason
          : "mapping",
    };
  }
  if (
    !instruction ||
    input.isRefine ||
    input.hasModelSource ||
    requestsDurableOrAction(instruction)
  ) {
    return null;
  }
  const selectedComposerRoute = composerResearchRoute(
    input.composerTaskContext,
  );
  if (selectedComposerRoute) return selectedComposerRoute;
  if (
    ((input.hasLeadMagnet || input.hasCreatorStyle) &&
      modeledIntent.kind === "none") ||
    (forbidsDiscovery && !input.hasAttachments)
  ) {
    return null;
  }
  if (
    NEGATED_POST_OUTCOME_RE.test(instruction) &&
    EXPLICIT_NON_POST_OUTCOME_RE.test(instruction)
  ) {
    return null;
  }

  if (modeledIntent.kind === "ambiguous") {
    return {
      kind: "ambiguous_read_only",
      expectsDraft: false,
      clarificationReason: "modeled_mapping",
      modeledAmbiguityReason: modeledIntent.reason,
    };
  }
  const sourceModelingRequest = modeledIntent.kind === "exact";
  const researchClause = sourceResearchClause(instruction);
  const explicitDraftCount =
    input.draftCountOverride ??
    (sourceModelingRequest
      ? modeledIntent.expectedDrafts
      : requestedDirectPostCount(instruction));
  const explicitSourceCount = sourceModelingRequest
    ? modeledIntent.discoveryCount
    : null;
  // Precedence: an explicit UI selection always wins (the whole point of
  // this field — it's the user's own click, not a guess); otherwise fall
  // back to whatever the modeled-intent classifier or the instruction regex
  // derives, exactly as before this field existed.
  const workspacePostType =
    input.explicitPostType ??
    (sourceModelingRequest
      ? (modeledIntent.sourcePostType ??
        requestedWorkspacePostType(researchClause))
      : requestedWorkspacePostType(researchClause));
  // Only true when the FIRST branch of the precedence above is what actually
  // won — never when workspacePostType came from modeledIntent.sourcePostType
  // or the instruction regex, since those are guesses about the request's
  // content, not a genuine user choice. See explicitPostType's doc comment.
  const explicitPostType = input.explicitPostType;
  const writingOutputClause = instruction.match(
    /\b(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b[\s\S]{0,180}?\b(?:linkedin\s+)?posts?\b/i,
  )?.[0] ?? "";
  const hasPluralPostTarget = /\b(?:linkedin\s+)?posts\b/i.test(
    writingOutputClause,
  );
  const unresolvedPluralDraftTarget =
    !sourceModelingRequest &&
    FULL_POST_REQUEST_RE.test(instruction) &&
    hasPluralPostTarget &&
    explicitDraftCount === null;
  const expectsDraft =
    sourceModelingRequest ||
    (FULL_POST_REQUEST_RE.test(instruction) &&
      (!hasPluralPostTarget || explicitDraftCount !== null));
  const expectedDrafts = explicitDraftCount ?? 1;
  const workspaceDraftSourceMode =
    sourceModelingRequest &&
    modeledIntent.relation === "one_to_one" &&
    expectedDrafts <= 5
      ? ("one_to_one" as const)
      : undefined;
  const workspaceMinimumSources =
    sourceModelingRequest
      ? modeledIntent.minimumSources
      : requestedSourceMinimum(researchClause, explicitSourceCount);
  const needsFileInspection =
    input.hasAttachments && FILE_INSPECTION_RE.test(instruction);
  const needsNews =
    !FIRST_PARTY_NEWS_CONTEXT_RE.test(instruction) &&
    (EXPLICIT_NEWS_TOPIC_RE.test(instruction) ||
      (NEWS_RE.test(instruction) && RESEARCH_RE.test(instruction)));
  const needsWorkspaceResearch =
    sourceModelingRequest ||
    ((explicitlyRequestsSourceDiscovery(instruction) ||
      OUTPUT_FIRST_SOURCE_DISCOVERY_RE.test(instruction)) &&
    (MULTI_SOURCE_RE.test(researchClause) ||
      workspaceDraftSourceMode === "one_to_one"));
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
            minimumSources: workspaceMinimumSources,
            workspaceSearchMode: STRICT_TOP_SOURCE_RE.test(researchClause)
              ? ("strict_top" as const)
              : ("diverse" as const),
            ...(requestedWorkspaceWindow(researchClause)
              ? { workspaceSince: requestedWorkspaceWindow(researchClause) }
              : {}),
            ...(workspacePostType ? { workspacePostType } : {}),
            ...(explicitPostType ? { explicitPostType } : {}),
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
      minimumSources: workspaceMinimumSources,
      workspaceSearchMode: STRICT_TOP_SOURCE_RE.test(researchClause)
        ? "strict_top"
        : "diverse",
      ...(requestedWorkspaceWindow(researchClause)
        ? { workspaceSince: requestedWorkspaceWindow(researchClause) }
        : {}),
      ...(workspacePostType ? { workspacePostType } : {}),
      ...(explicitPostType ? { explicitPostType } : {}),
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

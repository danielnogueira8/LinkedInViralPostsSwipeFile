import { deriveDeliverableContract } from "@/lib/agent/deliverable-contract";
import {
  compileDirectPartialTextSpec,
  requestedDirectPostCount,
  requestsPartialTargetVariation,
} from "@/lib/agent/direct-deliverable-policy";
import {
  hasInvalidExplicitShortenPercentage,
  hasMixedDirectRefineFocuses,
  hasUnsupportedDirectShortenPercentage,
} from "@/lib/agent/direct-refine-policy";
import { isNoModelPostRequest } from "@/lib/agent/no-model-formats";
import { coworkRolloutDecision } from "@/lib/agent/cowork-rollout";
import type { coworkRolloutRuntimeHealth } from "@/lib/agent/cowork-rollout-health";
import {
  explicitlyForbidsSourceDiscovery,
  explicitlyRequestsSourceDiscovery,
  freeTextLayersOpenChoice,
  requestsDurableOrAction,
  requestsPartialTextDeliverable,
  requestsDirectSourceModeling,
  withoutSourceDiscoveryOptOut,
} from "@/lib/agent/source-policy";

type DirectWriterEnvironment = Record<string, string | undefined>;

/** Fail-closed shared rollout policy for the direct writer lane. */
export function directWriterEnabledForWorkspace(
  workspaceId: string,
  env: DirectWriterEnvironment = process.env,
  runtimeHealth?: Pick<typeof coworkRolloutRuntimeHealth, "isOpen">,
): boolean {
  return coworkRolloutDecision(
    "direct_writer",
    workspaceId,
    env,
    runtimeHealth,
  ).serveV2;
}

export type DirectOriginalPostEligibility = {
  userInstruction: string;
  enabled: boolean;
  hasModelSource: boolean;
  isRefine: boolean;
  hasAttachments: boolean;
  hasLeadMagnet: boolean;
  hasCreatorStyle: boolean;
  voiceResolved: boolean;
};

const LIVE_OR_SPECIALIZED_RE =
  /\b(?:news[ -]?jack(?:ing)?|brand[ -]?jack(?:ing)?|name[ -]?jack(?:ing)?|breaking|trending|today(?:'s)?\s+(?:news|announcement)|just\s+(?:launched|announced)|latest\s+(?:news|announcement))\b/i;
const RESEARCH_REQUIREMENT_RE =
  /\b(?:research|investigate|look\s+into|fact[ -]?check|verify)\b/i;
const MULTI_DELIVERABLE_RE =
  /\b(?:two|2|multiple|several)\s+(?:different\s+)?(?:posts?|variations?|versions?|rewrites?)\b|\b(?:plus|and)\s+(?:write\s+)?(?:another|a\s+second)\s+(?:posts?|variations?|versions?|rewrites?)\b/i;
const MIXED_POST_AND_PARTIAL_RE =
  /\bposts?\b[\s\S]{0,100}\b(?:and|plus|along\s+with)\b[\s\S]{0,60}\b(?:ideas?|angles?|outlines?|titles?|hooks?|openers?|opening\s+lines?)\b(?!\s+(?:style|structure|pattern|mechanics?|format|approach|framework))|\b(?:ideas?|angles?|outlines?|titles?|hooks?|openers?|opening\s+lines?)\b(?!\s+(?:style|structure|pattern|mechanics?|format|approach|framework))[\s\S]{0,100}\b(?:and|plus|along\s+with)\b[\s\S]{0,60}\bposts?\b/i;
const COMPOUND_NON_POST_DELIVERABLE_RE =
  /\b(?:and|plus|along\s+with)\s+(?:also\s+)?(?:an?\s+|\d+\s+)?(?:accompanying\s+)?(?:content\s+)?(?:plan|calendar|schedule|strategy|campaign|brief|analysis|summary|carousel|newsletter|email|comments?|direct\s+messages?|dms?|image|graphic|visual)\b/i;
const POST_WITH_VISUAL_RE =
  /\b(?:write|draft|create|generate|make|give\s+me)\b[\s\S]{0,80}\bposts?\b[\s\S]{0,100}\b(?:with|including|include)\s+(?:an?\s+|the\s+)?(?:image|graphic|visual)\b/i;
const COMPOUND_WRITING_AND_META_RE =
  /\b(?:explain|analy[sz]e|summarize|review|critique|compare|rank|select|recommend)\b[\s\S]{0,180}\b(?:then|and|plus)\b[\s\S]{0,100}\b(?:write|draft|create|generate|give|make|model|adapt|rewrite)\b|\b(?:write|draft|create|generate|give|make|model|adapt|rewrite)\b[\s\S]{0,180}\b(?:then|and|plus)\b[\s\S]{0,100}\b(?:explain|analy[sz]e|summarize|review|critique|compare|rank|select|recommend|strategy|analysis|summary|rationale)\b/i;
const COMPOUND_SECOND_ACTION_RE =
  /\b(?:write|draft|create|generate|give|make|model|adapt|rewrite|refine|shorten|tighten)\b[\s\S]{0,220}\b(?:and|then|plus)\s+(?:also\s+)?(?:(?:send|email|message|add|upload|export|share|move|copy|notify|submit|deliver)\b|(?:create|set|make)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:reminder|task)\b|(?:put|place|store)\b[\s\S]{0,50}\b(?:drafts?|library|board)\b)/i;
const UNRESOLVED_WORKSPACE_CONTEXT_RE =
  /\b(?:(?:use|search|find|review|check|scan|read|look\s+through|pull\s+from|draw\s+from|based\s+on)\s+(?:inside\s+|through\s+|in\s+|from\s+)?(?:(?:my|our|the)\s+(?:saved\s+(?:posts?|content)|bookmarks?|bookmarked\s+posts?|prior\s+drafts?|past\s+drafts?|previous\s+drafts?|draft\s+history|post\s+history|workspace\s+(?:files?|context|data|documents?)|knowledge\s+base|swipe\s+file|content\s+library|examples?|files?|documents?)|(?:the\s+)?posts?\s+(?:i|we)\s+(?:saved|bookmarked)|posts?\s+from\s+(?:my|our|the)\s+(?:swipe\s+file|content\s+library|bookmarks?))|(?:based\s+on|using|from)\s+(?:my|our|the)\s+(?:saved\s+content|saved\s+posts?|bookmarks?|examples?|content\s+library|swipe\s+file))\b/i;
const DIRECT_PARTIAL_REQUEST_RE =
  /\b(?:write|draft|create|generate|give|make)\s+(?:me\s+)?(?:a|an|one|\d+)?\s*(?:linkedin\s+)?(?:post\s+)?(?:ideas?|angles?|outlines?|titles?|hooks?|openers?)\b|\b(?:ideas?|angles?|outlines?|titles?|hooks?|openers?)\s+(?:for|to)\s+(?:a\s+)?(?:linkedin\s+)?post\b/i;
const AMBIGUOUS_POST_RE =
  /^\s*(?:please\s+)?(?:write|draft|create|make)(?:\s+me)?\s+(?:a|one)?\s*(?:linkedin\s+)?post[.!?]?\s*$/i;
const FULL_POST_REQUEST_RE =
  /\b(?:(?:write|draft|create|make|generate)\s+(?:me\s+)?|give\s+me\s+)(?:(?:a|an|one)\s+)?(?:(?:short|concise|brief|punchy|detailed|in-depth|long-form|long|original|complete|full)\s+){0,4}(?:linkedin\s+)?post\b/i;
const NEGATED_WRITING_RE =
  /\b(?:do\s+not|don(?:'|’)?t|dont|never|no\s+need\s+to)\s+(?:(?:please|just|actually|go\s+ahead\s+and)\s+|(?:want|need|ask)\s+(?:me|you|us|them)\s+to\s+){0,3}(?:write|draft|create|generate|give|make|produce|prepare|model|mimic|adapt|rewrite|rework|remix|turn|change|edit|refine|tighten|shorten|strengthen)\b|\bwithout\s+(?:writing|drafting|creating|generating|giving|modeling|modelling|adapting|rewriting|changing|editing|refining|tightening|shortening|strengthening)\b/i;
const META_WRITING_DISCUSSION_RE =
  /^\s*(?:why|how|what|when|where|who)\b[\s\S]{0,240}\b(?:write|draft|create|generate|give|make|model|adapt|rewrite)\b|^\s*(?:can|could|would|will)\s+you\s+(?:explain|describe|tell\s+me|show\s+me|walk\s+me\s+through)\b[\s\S]{0,160}\b(?:how|why|what|when|before|write|draft|create|generate|give|make|model|adapt|rewrite)\b|^\s*(?:is|are|was|were|do|does|did)\b[\s\S]{0,200}\b(?:write|draft|create|generate|give|make|model|adapt|rewrite)\b[\s\S]{0,120}\b(?:good|bad|clear|effective|specific|prompt|instruction|request)\b|\b(?:prompt|instruction|request|command|button|feature|workflow)\b[\s\S]{0,100}\b(?:says?|contains?|includes?|uses?|mentions?|write|draft|create|generate|give|make|model|adapt|rewrite)\b/i;
const ADVICE_ABOUT_WRITING_RE =
  /^\s*(?:(?:should|can|could|would)\s+(?:i|we|you|they)\s+(?:write|draft|create|make|rewrite|refine|shorten|tighten)|do\s+you\s+(?:think|believe)\b[\s\S]{0,80}\b(?:i|we|you|they)\s+should\s+(?:write|draft|create|make|rewrite|refine|shorten|tighten)|(?:do|would|could|can)\s+you\s+recommend\b[\s\S]{0,80}\b(?:i|we|you|they)\s+(?:write|draft|create|make|rewrite|refine|shorten|tighten)|is\s+it\s+worth(?:\s+it)?\b[\s\S]{0,80}\b(?:write|draft|create|make|rewrite|refine|shorten|tighten)|tell\s+me\s+whether\b[\s\S]{0,100}\b(?:write|draft|create|make|rewrite|refine|shorten|tighten)|help\s+me\s+decide\s+(?:if|whether)\b[\s\S]{0,100}\b(?:write|draft|create|make|rewrite|refine|shorten|tighten)|would\s+(?:an?\s+|the\s+)?(?:stronger|shorter|tighter|clearer|more\s+direct)\b[\s\S]{0,60}\b(?:help|work|improve))\b/i;
const UNSUPPORTED_REFINE_REMOVAL_RE =
  /\b(?:remove|delete|drop|omit)\s+(?:the\s+|my\s+)?(?:cta|call\s+to\s+action|hook|opener|opening|closing|final\s+paragraph)\b|\b(?:do\s+not|don(?:'|’)?t|dont|never)\s+include\s+(?:an?\s+|the\s+)?(?:cta|call\s+to\s+action|hook|opener|opening|closing|final\s+paragraph)\b|\b(?:without|except)\s+(?:for\s+)?(?:an?\s+|the\s+|my\s+)?(?:cta|call\s+to\s+action|hook|opener|opening|closing|final\s+paragraph)\b|^\s*no\s+(?:cta|call\s+to\s+action|hook|opener|closing)\b/i;
const UNSUPPORTED_REFINE_EXPANSION_RE =
  /\b(?:make|write|rewrite)\s+(?:it|this|the\s+post)\s+(?:much\s+|a\s+bit\s+)?longer\b|\bexpand\s+(?:it|this|the\s+post)\b|\badd\s+(?:more|extra|additional)\s+(?:detail|depth|context|examples?|explanation)\b/i;
const FIXED_SOURCE_CONTEXT_RE =
  /\b(?:attached|selected|provided|fixed)\s+(?:source|source\s+post|post|example|template)\b|\b(?:based\s+on|using|from|model(?:ed)?\s+after|inspired\s+by)\s+(?:an?\s+|the\s+)?(?:source|source\s+post|example|template)\b/i;
const UNRESOLVED_REFERENCE_RE =
  /\b(?:about|on|from|using|based\s+on|turn|build(?:ing)?\s+on)\s+(?:that|this|it|the\s+above)\b|\b(?:same|previous|earlier|prior)\s+(?:topic|idea|point|post|message|conversation|discussion|thread|chat|call)\b|\b(?:my|your|our|this|the)\s+(?:(?:last|previous|earlier|prior|current|recent)\s+)?(?:message|conversation|discussion|thread|chat|call)\b|\b(?:expand(?:ing)?|continue|continuing|follow(?:ing)?\s+up)\s+(?:on\s+)?(?:my|your|our|the)?\s*(?:last|previous|earlier|prior)?\s*(?:message|conversation|discussion|thread|chat|call|point|idea)\b|\b(?:topic|idea|point|takeaway|thing)\s+(?:that\s+)?(?:we|i|you)\s+(?:just\s+)?(?:covered|discussed|talked\s+about|said|mentioned|wrote)\b|\bwhat\s+(?:we|i|you)\s+(?:just\s+)?(?:covered|discussed|talked\s+about|said|mentioned|wrote)\b|\b(?:as|like)\s+(?:we|i|you)\s+(?:just\s+)?(?:covered|discussed|talked\s+about|said|mentioned|wrote)\b/i;

const TOPIC_PATTERNS = [
  /\bClarification answer:\s*([^.!?\n]+)/i,
  /\b(?:about|on)\s+([^.!?\n]+)/i,
  /\b(?:argu(?:e|ing)|explain(?:ing)?|teach(?:ing)?|show(?:ing)?)\s+(?:that\s+)?([^.!?\n]+)/i,
  /\b(?:case\s+(?:for|against)|topic\s*:)\s+([^.!?\n]+)/i,
  /\b(?:linkedin\s+)?post\s*[:\u2014-]\s*([^.!?\n]+)/i,
];
const TOPIC_REFERENCE_RE =
  /^(?:it|this|that)(?:\s+again)?$|^(?:my|your|our)\s+(?:idea|topic|point|thing|concept|subject|argument|opinion|thought|take|perspective)\b|^(?:the\s+)?(?:idea|topic|point|thing|concept|subject|argument|opinion|thought|take|perspective)(?:\s+(?:above|below|earlier|before))?(?:\s+again)?$/i;

function hasSubstantiveTopic(instruction: string): boolean {
  for (const pattern of TOPIC_PATTERNS) {
    const topic = instruction.match(pattern)?.[1]?.trim();
    if (!topic || TOPIC_REFERENCE_RE.test(topic)) continue;
    if (/^[\p{P}\p{S}\s]*$/u.test(topic)) continue;
    return true;
  }
  return false;
}

function hasSubstantivePartialTopic(instruction: string): boolean {
  if (hasSubstantiveTopic(instruction)) return true;
  const topic = instruction.match(/\bfor\s+([^.!?\n]+)/i)?.[1]?.trim();
  if (!topic || TOPIC_REFERENCE_RE.test(topic)) return false;
  if (/^(?:me|you|us|them|later|today|tomorrow|now)\b/i.test(topic)) {
    return false;
  }
  return !/^[\p{P}\p{S}\s]*$/u.test(topic);
}

function requiresFixedSource(instruction: string): boolean {
  return FIXED_SOURCE_CONTEXT_RE.test(instruction);
}

function requestsActiveSourceDiscovery(instruction: string): boolean {
  return explicitlyRequestsSourceDiscovery(
    withoutSourceDiscoveryOptOut(instruction),
  );
}

function hasNegatedWritingIntent(instruction: string): boolean {
  return NEGATED_WRITING_RE.test(withoutSourceDiscoveryOptOut(instruction));
}

function discussesWritingInsteadOfRequesting(instruction: string): boolean {
  return (
    META_WRITING_DISCUSSION_RE.test(instruction) ||
    ADVICE_ABOUT_WRITING_RE.test(instruction)
  );
}

/**
 * The direct lane is intentionally narrow: one fully specified, original post
 * whose domain context is already loaded. Anything that may need a tool stays
 * on the hardened agent path.
 */
export function isDirectOriginalPostEligible(
  input: DirectOriginalPostEligibility,
): boolean {
  const instruction = input.userInstruction.trim();
  if (
    !input.enabled ||
    input.hasModelSource ||
    input.isRefine ||
    input.hasAttachments ||
    input.hasLeadMagnet ||
    input.hasCreatorStyle ||
    !input.voiceResolved ||
    !instruction
  ) {
    return false;
  }
  const forbidsDiscovery = explicitlyForbidsSourceDiscovery(instruction);
  if (!FULL_POST_REQUEST_RE.test(instruction)) return false;
  if (
    !isNoModelPostRequest(instruction, false) &&
    !(forbidsDiscovery && FULL_POST_REQUEST_RE.test(instruction))
  ) {
    return false;
  }
  if (AMBIGUOUS_POST_RE.test(instruction)) return false;
  if (hasNegatedWritingIntent(instruction)) return false;
  if (discussesWritingInsteadOfRequesting(instruction)) return false;
  if (!hasSubstantiveTopic(instruction)) return false;
  if (UNRESOLVED_REFERENCE_RE.test(instruction)) return false;
  if (
    requestsPartialTextDeliverable(instruction) ||
    DIRECT_PARTIAL_REQUEST_RE.test(instruction)
  ) {
    return false;
  }
  if (
    freeTextLayersOpenChoice(instruction) ||
    MULTI_DELIVERABLE_RE.test(instruction)
  ) {
    return false;
  }
  if (
    requestsDurableOrAction(instruction) ||
    MIXED_POST_AND_PARTIAL_RE.test(instruction) ||
    COMPOUND_NON_POST_DELIVERABLE_RE.test(instruction) ||
    POST_WITH_VISUAL_RE.test(instruction) ||
    COMPOUND_WRITING_AND_META_RE.test(instruction) ||
    COMPOUND_SECOND_ACTION_RE.test(instruction) ||
    UNRESOLVED_WORKSPACE_CONTEXT_RE.test(instruction) ||
    LIVE_OR_SPECIALIZED_RE.test(instruction) ||
    RESEARCH_REQUIREMENT_RE.test(instruction)
  ) {
    return false;
  }
  if (
    requestsActiveSourceDiscovery(instruction) ||
    requestsDirectSourceModeling(instruction) ||
    requiresFixedSource(instruction)
  ) {
    return false;
  }

  const contract = deriveDeliverableContract(instruction);
  if (contract && contract.expectedCount !== 1) return false;

  // An explicit opt-out is a positive direct-lane signal, but ordinary
  // self-contained original-post briefs are eligible too. Do not reject the
  // word "model" by itself: "do not model after one source" is an opt-out.
  return (
    forbidsDiscovery ||
    !/---\s*(?:POST TO MODEL AFTER|TEMPLATE TO FILL|POST TO REFINE)\s*---/i.test(
      instruction,
    )
  );
}

export type DirectRefineEligibility = {
  enabled: boolean;
  isRefine: boolean;
  refineInstruction: string;
  targetResolved: boolean;
  targetKind: "post" | "hook" | null;
  targetHasLeadMagnet: boolean;
  hasModelSource: boolean;
  hasAttachments: boolean;
  hasLeadMagnet: boolean;
  hasCreatorStyle: boolean;
  voiceResolved: boolean;
};

/**
 * A direct refine owns one already-resolved complete post and needs no tools.
 * Any external context, action, research, or multi-version request stays on
 * the baseline path, which is also the immediate kill-switch fallback.
 */
export function isDirectRefineEligible(
  input: DirectRefineEligibility,
): boolean {
  const instruction = input.refineInstruction.trim();
  if (
    !input.enabled ||
    !input.isRefine ||
    !instruction ||
    !input.targetResolved ||
    input.targetKind !== "post" ||
    input.targetHasLeadMagnet ||
    input.hasModelSource ||
    input.hasAttachments ||
    input.hasLeadMagnet ||
    input.hasCreatorStyle ||
    !input.voiceResolved
  ) {
    return false;
  }
  if (
    hasInvalidExplicitShortenPercentage(instruction) ||
    hasUnsupportedDirectShortenPercentage(instruction) ||
    hasMixedDirectRefineFocuses(instruction) ||
    UNSUPPORTED_REFINE_REMOVAL_RE.test(instruction) ||
    UNSUPPORTED_REFINE_EXPANSION_RE.test(instruction) ||
    hasNegatedWritingIntent(instruction) ||
    discussesWritingInsteadOfRequesting(instruction) ||
    requestsDurableOrAction(instruction) ||
    MIXED_POST_AND_PARTIAL_RE.test(instruction) ||
    COMPOUND_NON_POST_DELIVERABLE_RE.test(instruction) ||
    POST_WITH_VISUAL_RE.test(instruction) ||
    COMPOUND_WRITING_AND_META_RE.test(instruction) ||
    COMPOUND_SECOND_ACTION_RE.test(instruction) ||
    UNRESOLVED_WORKSPACE_CONTEXT_RE.test(instruction) ||
    LIVE_OR_SPECIALIZED_RE.test(instruction) ||
    RESEARCH_REQUIREMENT_RE.test(instruction) ||
    MULTI_DELIVERABLE_RE.test(instruction) ||
    freeTextLayersOpenChoice(instruction) ||
    requestsActiveSourceDiscovery(instruction) ||
    requestsDirectSourceModeling(instruction)
  ) {
    return false;
  }
  const contract = deriveDeliverableContract(instruction);
  return !contract || contract.expectedCount === 1;
}

type DirectWritingContext = {
  enabled: boolean;
  hasAttachments: boolean;
  hasLeadMagnet: boolean;
  hasCreatorStyle: boolean;
  voiceResolved: boolean;
};

export type DirectFixedSourcePostEligibility = DirectWritingContext & {
  userInstruction: string;
  sourceResolved: boolean;
  isRefine: boolean;
};

const FIXED_SOURCE_POST_RE =
  /\b(?:model|mimic|adapt|rewrite|rework|remix|turn)\b[\s\S]{0,100}\b(?:posts?|variations?|versions?|rewrites?)\b|\b(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b[\s\S]{0,100}\b(?:posts?|variations?|versions?|rewrites?)\b/i;

function directWritingContextReady(input: DirectWritingContext): boolean {
  return (
    input.enabled &&
    !input.hasAttachments &&
    !input.hasLeadMagnet &&
    !input.hasCreatorStyle &&
    input.voiceResolved
  );
}

// The unsafe-intent checks that are INDEPENDENT of source discovery: mixed/
// partial deliverables, durable/board actions, visuals, second actions, live/
// research requirements, etc. Shared by both the discovery-rejecting gate
// (below) and the find-and-model gate (which resolves the source itself, so
// requesting discovery is expected, not unsafe).
function hasUnsafeDirectWritingIntentExceptDiscovery(
  instruction: string,
): boolean {
  return (
    hasNegatedWritingIntent(instruction) ||
    discussesWritingInsteadOfRequesting(instruction) ||
    requestsDurableOrAction(instruction) ||
    MIXED_POST_AND_PARTIAL_RE.test(instruction) ||
    COMPOUND_NON_POST_DELIVERABLE_RE.test(instruction) ||
    POST_WITH_VISUAL_RE.test(instruction) ||
    COMPOUND_WRITING_AND_META_RE.test(instruction) ||
    COMPOUND_SECOND_ACTION_RE.test(instruction) ||
    UNRESOLVED_WORKSPACE_CONTEXT_RE.test(instruction) ||
    LIVE_OR_SPECIALIZED_RE.test(instruction) ||
    RESEARCH_REQUIREMENT_RE.test(instruction)
  );
}

function hasUnsafeDirectWritingIntent(instruction: string): boolean {
  return (
    hasUnsafeDirectWritingIntentExceptDiscovery(instruction) ||
    requestsActiveSourceDiscovery(instruction)
  );
}

/**
 * THIN PATH find-and-model. A "find a top post in my swipe file and rewrite it"
 * turn where the server has ALREADY resolved the source up front (see chat-turn
 * `resolveFindAndModelSource`). This is distinct from the fixed-source gate
 * below, which is for a source the user pre-ATTACHED and deliberately rejects
 * discovery phrasing ("it"/"its" with no antecedent, or a request to search).
 * Here the source IS resolved, so those guards don't apply — "it" legitimately
 * refers to the found post, and discovery is the whole point.
 *
 * `requestsDirectSourceModeling` already encodes the safe shape: an explicit
 * source-discovery request, a modeling action, a single post, no multi-scope,
 * and it fails closed on "don't search / don't model a source" opt-outs. We add
 * only: the direct context is ready, exactly one post, no partial-deliverable
 * or external-action layering, and nothing unsafe. Gated by `sourceResolved`,
 * so it never fires unless the search actually returned a source.
 */
export function isDirectFindAndModelEligible(
  input: DirectFixedSourcePostEligibility,
): boolean {
  const instruction = input.userInstruction.trim();
  if (
    !directWritingContextReady(input) ||
    !input.sourceResolved ||
    input.isRefine ||
    !instruction ||
    !requestsDirectSourceModeling(instruction) ||
    hasNegatedWritingIntent(instruction) ||
    hasUnsafeDirectWritingIntentExceptDiscovery(instruction) ||
    requestsPartialTargetVariation(instruction) ||
    requestsPartialTextDeliverable(instruction) ||
    DIRECT_PARTIAL_REQUEST_RE.test(instruction)
  ) {
    return false;
  }
  const count = requestedDirectPostCount(instruction);
  if (count !== null && count !== 1) return false;
  if (count === null && MULTI_DELIVERABLE_RE.test(instruction)) return false;
  return !freeTextLayersOpenChoice(instruction);
}

export type DirectLeadMagnetEligibility = DirectWritingContext & {
  userInstruction: string;
  isRefine: boolean;
  hasModelSource: boolean;
};

/**
 * THIN PATH lead-magnet. A lead-magnet post is a from-scratch original post with
 * the giveaway framing; the caller only consults this AFTER it has resolved the
 * lead-magnet RESOURCE (activeLeadMagnetForDirect) — that resolution is the real
 * "this is a lead-magnet drafting turn" signal, and the CTA is hard-enforced
 * downstream, so the strong model can write it directly.
 *
 * Because the resource is the source, source-DISCOVERY phrasing ("find the most
 * recent lead-magnet post and adapt it") is expected, not unsafe — the found
 * post is never used as a structural source (engine task is `original`, not
 * `source`). So unlike the original-post gate, this does NOT reject discovery.
 * It rejects only what genuinely changes the DELIVERABLE OR THE ROUTE — a second
 * external action, a partial/hook deliverable, more than one post — which the
 * single-post direct engine cannot honor. Everything else the resolved-resource
 * signal already vouched for.
 */
export function isDirectLeadMagnetEligible(
  input: DirectLeadMagnetEligibility,
): boolean {
  const instruction = input.userInstruction.trim();
  if (
    !directWritingContextReady({ ...input, hasLeadMagnet: false }) ||
    input.isRefine ||
    input.hasModelSource ||
    !instruction ||
    requestsDurableOrAction(instruction) ||
    requestsPartialTargetVariation(instruction) ||
    requestsPartialTextDeliverable(instruction) ||
    DIRECT_PARTIAL_REQUEST_RE.test(instruction)
  ) {
    return false;
  }
  const count = requestedDirectPostCount(instruction);
  if (count !== null && count !== 1) return false;
  if (count === null && MULTI_DELIVERABLE_RE.test(instruction)) return false;
  return !freeTextLayersOpenChoice(instruction);
}

/** One already-resolved source, one complete post, and no external action. */
export function isDirectFixedSourcePostEligible(
  input: DirectFixedSourcePostEligibility,
): boolean {
  const instruction = input.userInstruction.trim();
  if (
    !directWritingContextReady(input) ||
    !input.sourceResolved ||
    input.isRefine ||
    !instruction ||
    !FIXED_SOURCE_POST_RE.test(instruction) ||
    hasNegatedWritingIntent(instruction) ||
    UNRESOLVED_REFERENCE_RE.test(instruction) ||
    hasUnsafeDirectWritingIntent(instruction) ||
    requestsPartialTargetVariation(instruction) ||
    requestsPartialTextDeliverable(instruction) ||
    DIRECT_PARTIAL_REQUEST_RE.test(instruction)
  ) {
    return false;
  }
  const count = requestedDirectPostCount(instruction);
  if (count !== null && count !== 1) return false;
  if (count === null && MULTI_DELIVERABLE_RE.test(instruction)) return false;
  return !freeTextLayersOpenChoice(instruction);
}

export type DirectPartialTextEligibility = DirectWritingContext & {
  userInstruction: string;
  sourceRequested: boolean;
  sourceResolved: boolean;
  isRefine: boolean;
};

/** Exact labeled text items with no cards, tools, or unresolved context. */
export function isDirectPartialTextEligible(
  input: DirectPartialTextEligibility,
): boolean {
  const instruction = input.userInstruction.trim();
  const spec = compileDirectPartialTextSpec(instruction);
  const sourceRequired = input.sourceRequested || requiresFixedSource(instruction);
  if (
    !directWritingContextReady(input) ||
    input.isRefine ||
    !instruction ||
    !spec ||
    hasNegatedWritingIntent(instruction) ||
    (sourceRequired && !input.sourceResolved) ||
    UNRESOLVED_REFERENCE_RE.test(instruction) ||
    hasUnsafeDirectWritingIntent(instruction)
  ) {
    return false;
  }
  if (input.sourceResolved) return true;
  return (
    explicitlyForbidsSourceDiscovery(instruction) &&
    hasSubstantivePartialTopic(instruction)
  );
}

export type DirectMultiPostEligibility = DirectWritingContext & {
  userInstruction: string;
  sourceRequested: boolean;
  sourceResolved: boolean;
  isRefine: boolean;
};

/** A bounded exact post count can be compiled without model-owned routing. */
export function isDirectMultiPostEligible(
  input: DirectMultiPostEligibility,
): boolean {
  const instruction = input.userInstruction.trim();
  const count = requestedDirectPostCount(instruction);
  const sourceRequired = input.sourceRequested || requiresFixedSource(instruction);
  if (
    !directWritingContextReady(input) ||
    input.isRefine ||
    !instruction ||
    count === null ||
    count < 2 ||
    NEGATED_WRITING_RE.test(instruction) ||
    (sourceRequired && !input.sourceResolved) ||
    UNRESOLVED_REFERENCE_RE.test(instruction) ||
    hasUnsafeDirectWritingIntent(instruction) ||
    requestsPartialTargetVariation(instruction) ||
    requestsPartialTextDeliverable(instruction) ||
    DIRECT_PARTIAL_REQUEST_RE.test(instruction)
  ) {
    return false;
  }
  if (input.sourceResolved) return true;
  return (
    isNoModelPostRequest(instruction, false) &&
    hasSubstantiveTopic(instruction)
  );
}

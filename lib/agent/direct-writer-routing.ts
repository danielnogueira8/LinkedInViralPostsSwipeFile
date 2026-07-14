import { deriveDeliverableContract } from "@/lib/agent/deliverable-contract";
import { isNoModelPostRequest } from "@/lib/agent/no-model-formats";
import {
  explicitlyForbidsSourceDiscovery,
  explicitlyRequestsSourceDiscovery,
  freeTextLayersOpenChoice,
  requestsDurableOrAction,
  requestsPartialTextDeliverable,
  requestsDirectSourceModeling,
} from "@/lib/agent/source-policy";

type DirectWriterEnvironment = Record<string, string | undefined>;

function enabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function workspaceSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((workspaceId) => workspaceId.trim())
      .filter(Boolean),
  );
}

/**
 * Fail-closed rollout control for the direct writer. A workspace must be
 * explicitly allowed, while either kill switch takes effect immediately.
 */
export function directWriterEnabledForWorkspace(
  workspaceId: string,
  env: DirectWriterEnvironment = process.env,
): boolean {
  if (!workspaceId || !enabled(env.COWORK_DIRECT_WRITER_ENABLED)) return false;
  if (enabled(env.COWORK_DIRECT_WRITER_KILL_SWITCH)) return false;

  const disabled = workspaceSet(env.COWORK_DIRECT_WRITER_DISABLED_WORKSPACES);
  if (disabled.has(workspaceId)) return false;

  const allowed = workspaceSet(env.COWORK_DIRECT_WRITER_WORKSPACES);
  return allowed.has("*") || allowed.has(workspaceId);
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
  /\b(?:two|2|multiple|several)\s+(?:different\s+)?(?:posts?|variations?|versions?)\b|\b(?:plus|and)\s+(?:write\s+)?(?:another|a\s+second)\s+(?:posts?|variations?|versions?)\b/i;
const DIRECT_PARTIAL_REQUEST_RE =
  /\b(?:write|draft|create|generate|give|make)\s+(?:me\s+)?(?:a|an|one|\d+)?\s*(?:linkedin\s+)?(?:post\s+)?(?:ideas?|angles?|outlines?|titles?|hooks?|openers?)\b|\b(?:ideas?|angles?|outlines?|titles?|hooks?|openers?)\s+(?:for|to)\s+(?:a\s+)?(?:linkedin\s+)?post\b/i;
const AMBIGUOUS_POST_RE =
  /^\s*(?:please\s+)?(?:write|draft|create|make)(?:\s+me)?\s+(?:a|one)?\s*(?:linkedin\s+)?post[.!?]?\s*$/i;
const FULL_POST_REQUEST_RE =
  /\b(?:(?:write|draft|create|make|generate)\s+(?:me\s+)?|give\s+me\s+)(?:(?:a|an|one)\s+)?(?:(?:original|complete|full)\s+)?(?:linkedin\s+)?post\b/i;
const UNRESOLVED_REFERENCE_RE =
  /\b(?:about|on|from|using|based\s+on|turn|build(?:ing)?\s+on)\s+(?:that|this|it|the\s+above)\b|\b(?:same|previous|earlier|prior)\s+(?:topic|idea|point|post|message|conversation|discussion|thread|chat|call)\b|\b(?:my|your|our|this|the)\s+(?:(?:last|previous|earlier|prior|current|recent)\s+)?(?:message|conversation|discussion|thread|chat|call)\b|\b(?:expand(?:ing)?|continue|continuing|follow(?:ing)?\s+up)\s+(?:on\s+)?(?:my|your|our|the)?\s*(?:last|previous|earlier|prior)?\s*(?:message|conversation|discussion|thread|chat|call|point|idea)\b|\b(?:topic|idea|point|takeaway|thing)\s+(?:that\s+)?(?:we|i|you)\s+(?:just\s+)?(?:covered|discussed|talked\s+about|said|mentioned|wrote)\b|\bwhat\s+(?:we|i|you)\s+(?:just\s+)?(?:covered|discussed|talked\s+about|said|mentioned|wrote)\b|\b(?:as|like)\s+(?:we|i|you)\s+(?:just\s+)?(?:covered|discussed|talked\s+about|said|mentioned|wrote)\b/i;

const TOPIC_PATTERNS = [
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
    LIVE_OR_SPECIALIZED_RE.test(instruction) ||
    RESEARCH_REQUIREMENT_RE.test(instruction)
  ) {
    return false;
  }
  if (
    explicitlyRequestsSourceDiscovery(instruction) ||
    requestsDirectSourceModeling(instruction)
  ) {
    return false;
  }

  const contract = deriveDeliverableContract(instruction);
  if (contract && contract.expectedCount !== 1) return false;

  // An explicit opt-out is a positive direct-lane signal, but ordinary
  // self-contained original-post briefs are eligible too. Do not reject the
  // word "model" by itself: "do not model after one source" is an opt-out.
  return forbidsDiscovery || !/---\s*(?:POST TO MODEL AFTER|TEMPLATE TO FILL|POST TO REFINE)\s*---/i.test(instruction);
}

export function explicitlyRequestsSourceDiscovery(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return false;
  return (
    /\b(find|search|research|investigate|look\s+(?:for|up|into)|pull|grab|get|fetch|show|list|browse|scan)\b/i.test(
      normalized,
    ) &&
    /\b(latest|recent|top|viral|high[-\s]?performing|highest[-\s]?engagement|best|this\s+week|last\s+7\s+days|swipe\s+file|bookmarks?|tracked\s+accounts?|examples?|inspiration|source\s+posts?)\b/i.test(
      normalized,
    )
  );
}

const SOURCE_MODELING_ACTION_RE =
  /\b(?:model|mimic|adapt|rewrite|rework|remix)\b/i;
const MULTI_POST_SCOPE_RE =
  /\b(?:[2-9]|\d{2,}|two|three|four|five|six|seven|eight|nine|ten|several|multiple|all)\s+(?:(?!(?:posts?)\b)[a-z][\w'-]*\s+){0,4}posts?\b/i;

/** A clear one-source modeling request can use the fast, focused agent lane. */
export function requestsDirectSourceModeling(text: string): boolean {
  return (
    explicitlyRequestsSourceDiscovery(text) &&
    !explicitlyForbidsSourceDiscovery(text) &&
    SOURCE_MODELING_ACTION_RE.test(text) &&
    /\bposts?\b/i.test(text) &&
    !MULTI_POST_SCOPE_RE.test(text)
  );
}

const SOURCE_DISCOVERY_OPTOUT_RE =
  /\b(?:do\s+not|don(?:'|’)?t|dont|never)\s+(?:use\s+(?:a\s+|any\s+)?(?:source(?:s)?|source\s+search(?:ing)?|search(?:ing)?|browse|browsing)|search|browse|look\s+up|pull|fetch)\b|\bwithout\s+(?:any\s+)?(?:sources?|source\s+search(?:ing)?|search(?:ing)?|browsing|looking\s+up)\b|\bno\s+(?:sources?|source\s+search(?:ing)?|search(?:ing)?|browsing)\b|\b(?:do\s+not|don(?:'|’)?t|dont)\s+use\s+(?:any\s+)?tools?\b/i;

const PARTIAL_DELIVERABLE_RE =
  /\b(?:linkedin\s+)?(?:post\s+)?(?:ideas?|angles?|outlines?|titles?|hooks?|openers?)\b(?!\s+(?:style|structure|pattern|mechanics?|format|approach|framework))/i;
const EXPLICIT_PARTIAL_BOUNDARY_RE =
  /\b(?:do\s+not|don(?:'|’)?t|dont)\s+(?:write|draft|create|generate)\s+(?:any\s+)?(?:full\s+)?(?:linkedin\s+)?posts?\b|\b(?:ideas?|angles?|outlines?|titles?|hooks?|openers?)\s+(?:only|not\s+(?:full\s+)?posts?)\b/i;
const DIRECT_FULL_POST_RE =
  /\b(?:write|draft|create|generate|give|make|rewrite|refine|shorten|tighten|adapt|mimic|model)\b[\s\S]{0,80}?\b(?:a|an|one|\d{1,2})?\s*(?:full\s+)?(?:linkedin\s+)?posts?\b(?!\s+(?:ideas?|angles?|outlines?|titles?|hooks?|openers?))/i;
const SOURCE_TO_FULL_POST_RE =
  /\b(?:find|search|pull|select|choose|get)\b[\s\S]{0,120}?\bposts?\b[\s\S]{0,100}?\b(?:rewrite|adapt|mimic|model|turn\s+it\s+into)\b|\b(?:rewrite|adapt|mimic|model)\s+(?:it|this|that|the\s+(?:source|post|draft))\b/i;
const WORKSPACE_CONTEXT_RE =
  /\b(?:in\s+my\s+voice|my\s+(?:voice|brand|profile|workspace|swipe\s+file|saved\s+posts?|tracked\s+accounts?|audience)|based\s+on\s+(?:my|the)\s+(?:voice|brand|profile|workspace|swipe\s+file|saved\s+posts?))\b/i;
const DURABLE_OR_ACTION_RE =
  /\b(?:always|never|from\s+now\s+on|remember\s+(?:that|this)|save|schedule|queue|publish|post\s+it|delete|remove)\b|\b(?:plan|put|place|add|slot)\s+(?:it|this|that|the\s+(?:post|draft))?\s*(?:for|on|into|to)\s+(?:the\s+)?(?:calendar|queue|board|today|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b|\b(?:set|mark|move)\s+(?:it|this|that|the\s+(?:post|draft))?\s*(?:to|as|into)?\s*(?:idea|drafting|ready|posted)\b/i;

/** True when the turn also asks Cowork to remember or mutate durable state. */
export function requestsDurableOrAction(text: string): boolean {
  return DURABLE_OR_ACTION_RE.test(text);
}

/** True when the current user instruction explicitly disables source lookup. */
export function explicitlyForbidsSourceDiscovery(text: string): boolean {
  return SOURCE_DISCOVERY_OPTOUT_RE.test(text);
}

/** Remove only source-discovery opt-outs so other user intents stay visible. */
export function withoutSourceDiscoveryOptOut(text: string): string {
  return text.replace(
    new RegExp(SOURCE_DISCOVERY_OPTOUT_RE.source, "gi"),
    " ",
  );
}

/**
 * Partial deliverables stay in normal chat text. They must never become a full
 * post card merely because the phrase "post ideas" contains the word "post".
 */
export function requestsPartialTextDeliverable(text: string): boolean {
  if (!PARTIAL_DELIVERABLE_RE.test(text)) return false;
  if (EXPLICIT_PARTIAL_BOUNDARY_RE.test(text)) return true;
  return !DIRECT_FULL_POST_RE.test(text) && !SOURCE_TO_FULL_POST_RE.test(text);
}

/**
 * A fully specified partial-deliverable request that opts out of retrieval can
 * be answered in one model round with no workspace tools. Keep personal voice,
 * persistent-preference, and downstream-action requests on the agent path.
 */
export function isSelfContainedPartialTextRequest(text: string): boolean {
  return (
    requestsPartialTextDeliverable(text) &&
    explicitlyForbidsSourceDiscovery(text) &&
    !WORKSPACE_CONTEXT_RE.test(text) &&
    !requestsDurableOrAction(text)
  );
}

export function freeTextLayersOpenChoice(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return false;
  if (/\b(\d{1,4}|two|three|four|five|six|seven|eight|nine|ten|a few|several|couple(?:\s+of)?|multiple)\s+(?:different\s+|more\s+|new\s+)?(variations?|versions?|posts?|hooks?|drafts?|takes?|angles?|options?|captions?|ideas?)\b/.test(normalized)) {
    return true;
  }
  if (/\b(both\b|(?:and|plus|as well as|combined?\s+with|merged?\s+with|mixed?\s+with)\s+(?:the|that|my|this\s+other)\b|(?:another|the\s+other|a\s+second|a\s+different)\s+(?:post|template|source|draft|one))/.test(normalized)) {
    return true;
  }
  return /\b(but\s+actually|instead\s+of\s+th(?:is|at)|ignore\s+(?:this|it|the\s+source)|don'?t\s+(?:use|follow|copy)\s+(?:this|it)|something\s+(?:totally|completely|entirely)\s+different|scrap\s+(?:this|it)|forget\s+(?:this|it|the\s+source))\b/.test(
    normalized,
  );
}

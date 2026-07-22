import {
  compileModeledPostIntent,
  explicitlyRequestsSourceDiscoveryIntent,
} from "@/lib/agent/modeled-post-intent";

export function explicitlyRequestsSourceDiscovery(text: string): boolean {
  return explicitlyRequestsSourceDiscoveryIntent(text);
}

/** Any server-selected source-modeling request, including exact-count multi. */
export function requestsSourceModeling(text: string): boolean {
  return (
    !explicitlyForbidsSourceDiscovery(text) &&
    compileModeledPostIntent(text).kind !== "none"
  );
}

/** A clear one-source modeling request can use the fast, focused agent lane. */
export function requestsDirectSourceModeling(text: string): boolean {
  if (explicitlyForbidsSourceDiscovery(text)) return false;
  const intent = compileModeledPostIntent(text);
  return (
    intent.kind === "exact" &&
    intent.relation === "one_to_one" &&
    intent.expectedDrafts === 1 &&
    intent.minimumSources === 1
  );
}

const SOURCE_DISCOVERY_OPTOUT_RE =
  /\b(?:do\s+not|don(?:'|’)?t|dont|never)\s+(?:use\s+(?:a\s+|any\s+)?(?:source(?:s)?|source\s+search(?:ing)?|search(?:ing)?|browse|browsing)|search|browse|look\s+up|pull|fetch)\b|\bwithout\s+(?:any\s+)?(?:sources?|source\s+search(?:ing)?|search(?:ing)?|browsing|looking\s+up)\b|\bno\s+(?:sources?|source\s+search(?:ing)?|search(?:ing)?|browsing)\b|\b(?:do\s+not|don(?:'|’)?t|dont)\s+use\s+(?:any\s+)?tools?\b|\b(?:do\s+not|don(?:'|’)?t|dont|never)\s+model\s+(?:it|this|that|the\s+post)?\s*(?:after|from|on)\s+(?:an?\s+|one\s+|any\s+|the\s+)?(?:specific\s+)?(?:source\s+posts?|posts?|sources?)\b/i;

const PARTIAL_DELIVERABLE_RE =
  /\b(?:linkedin\s+)?(?:post\s+)?(?:ideas?|angles?|outlines?|titles?|hooks?|openers?)\b(?!\s+(?:style|structure|pattern|mechanics?|format|approach|framework))/i;
const EXPLICIT_PARTIAL_BOUNDARY_RE =
  /\b(?:do\s+not|don(?:'|’)?t|dont)\s+(?:write|draft|create|generate)\s+(?:any\s+)?(?:full\s+)?(?:linkedin\s+)?posts?\b|\b(?:ideas?|angles?|outlines?|titles?|hooks?|openers?)\s+(?:only|not\s+(?:full\s+)?posts?)\b/i;
const PARTIAL_FOR_POST_CONTEXT_RE =
  /\b(?:ideas?|angles?|outlines?|titles?|hooks?|openers?)\b[\s\S]{0,80}?\bfor\s+(?:a|an|one|the)\s+(?:linkedin\s+)?post\b/i;
const DIRECT_FULL_POST_RE =
  /\b(?:write|draft|create|generate|give|make|rewrite|refine|shorten|tighten|adapt|mimic|model)\b[\s\S]{0,80}?\b(?:a|an|one|\d{1,2})?\s*(?:full\s+)?(?:linkedin\s+)?posts?\b(?!\s+(?:ideas?|angles?|outlines?|titles?|hooks?|openers?))/i;
const SOURCE_TO_FULL_POST_RE =
  /\b(?:find|search|pull|select|choose|get)\b[\s\S]{0,120}?\bposts?\b[\s\S]{0,100}?\b(?:rewrite|adapt|mimic|model|turn\s+it\s+into)\b|\b(?:rewrite|adapt|mimic|model)\s+(?:it|this|that|the\s+(?:source|post|draft))\b/i;
const WORKSPACE_CONTEXT_RE =
  /\b(?:in\s+my\s+voice|my\s+(?:voice|brand|profile|workspace|swipe\s+file|saved\s+posts?|tracked\s+accounts?|audience)|based\s+on\s+(?:my|the)\s+(?:voice|brand|profile|workspace|swipe\s+file|saved\s+posts?))\b/i;
const DURABLE_OR_ACTION_RE =
  /\b(?:always|never|from\s+now\s+on|remember\s+(?:that|this)|save|schedule|queue|publish|post\s+it|delete|remove)\b|\b(?:plan|put|place|add|slot)\s+(?:it|this|that|(?:this|that|the)\s+(?:post|draft|one))?\s*(?:for|on|into|to)\s+(?:the\s+)?(?:calendar|queue|board|today|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b|\b(?:set|mark|move)\s+(?:it|this|that|(?:this|that|the)\s+(?:post|draft|one))?\s*(?:to|as|into)?\s*(?:idea|drafting|ready|posted)\b/i;
const WRITING_MUTATION_VERB_PATTERN =
  "(?:write|draft|create|compose|generate|give|make|produce|prepare|model|mimic|adapt|replicate|rewrite|rework|remix|turn|change|edit|refine|tighten|shorten|strengthen)";
const AFFIRMATIVE_POST_VERB_PATTERN =
  "(?:write|draft|create|compose|generate|give|make|produce|prepare|adapt|replicate|rewrite|rework|remix)";
const WRITING_OPTOUT_RE = new RegExp(
  String.raw`\b(?:do\s+not|don(?:'|’)?t|dont|never|no\s+need\s+to)\s+(?:(?:please|just|actually|go\s+ahead\s+and)\s+|(?:want|need|ask)\s+(?:me|you|us|them)\s+to\s+){0,3}${WRITING_MUTATION_VERB_PATTERN}\b|\bwithout\s+(?:writing|drafting|creating|composing|generating|giving|modeling|modelling|adapting|replicating|rewriting|changing|editing|refining|tightening|shortening|strengthening)\b`,
  "i",
);
const COORDINATED_WRITING_OPTOUT_RE = new RegExp(
  String.raw`\b(?:do\s+not|don(?:'|’)?t|dont|never|no)\s+(?:search|browse|look\s+up|pull|fetch)\b[^.!?\n]{0,80}?\b(?:and|or)\s+(?:also\s+)?${WRITING_MUTATION_VERB_PATTERN}\b`,
  "i",
);
const AFFIRMATIVE_FULL_POST_AFTER_OPTOUT_RE = new RegExp(
  String.raw`\b${AFFIRMATIVE_POST_VERB_PATTERN}\b[\s\S]{0,100}?\b(?:linkedin\s+)?posts?\b`,
  "i",
);
const ORPHANED_COORDINATED_WRITING_RE = new RegExp(
  String.raw`\b(?:and|or)\s+(?:also\s+)?${WRITING_MUTATION_VERB_PATTERN}\b`,
  "gi",
);
const INDEPENDENT_NEW_POST_RE = new RegExp(
  String.raw`(?:[,;:]|\b(?:and|but|then|instead)\b)\s*${AFFIRMATIVE_POST_VERB_PATTERN}\b[\s\S]{0,50}?\b(?:a\s+)?(?:new|another|fresh|different)\s+(?:linkedin\s+)?post\b`,
  "i",
);
const SCOPED_ARTIFACT_OPTOUT_WITH_POST_RE = new RegExp(
  String.raw`\b(?:do\s+not|don(?:'|’)?t|dont|never)\s+(?:rewrite|edit|change|refine|tighten|shorten|strengthen)\s+(?:(?:this|that|the|current|existing|selected)\s+)?(?:draft|post|hook)(?:\s+#?\s*\d+)?\b[^.!?;\n]{0,80}?\band\s+${AFFIRMATIVE_POST_VERB_PATTERN}\b[\s\S]{0,80}?\b(?:linkedin\s+)?post\b`,
  "i",
);

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
  const stripped = text.replace(
    new RegExp(SOURCE_DISCOVERY_OPTOUT_RE.source, "gi"),
    " ",
  );
  if (stripped === text) return text;
  // Coordinated opt-outs are commonly phrased as "do not search or use
  // sources". The primary matcher consumes the first prohibited action; remove
  // only the now-orphaned coordinated source action so it cannot be mistaken
  // for an affirmative discovery command by downstream policy.
  return stripped.replace(
    /\b(?:and|or)\s+(?:also\s+)?(?:use|browse|fetch|pull)\s+(?:any\s+)?sources?\b/gi,
    " ",
  );
}

/** True when the current instruction explicitly rejects a writing mutation. */
export function explicitlyForbidsWriting(text: string): boolean {
  const withoutSourceOptOut = withoutSourceDiscoveryOptOut(text);
  const coordinatedOptOut = COORDINATED_WRITING_OPTOUT_RE.exec(text);
  const hasWritingOptOut =
    WRITING_OPTOUT_RE.test(withoutSourceOptOut) || Boolean(coordinatedOptOut);
  if (!hasWritingOptOut) return false;
  if (SCOPED_ARTIFACT_OPTOUT_WITH_POST_RE.test(text)) return false;
  const independentNewPost = INDEPENDENT_NEW_POST_RE.exec(text);
  const independentFallsUnderCoordinatedOptOut = Boolean(
    coordinatedOptOut &&
      independentNewPost &&
      (independentNewPost.index ?? 0) >= (coordinatedOptOut.index ?? 0) &&
      (independentNewPost.index ?? 0) <
        (coordinatedOptOut.index ?? 0) + coordinatedOptOut[0].length,
  );
  if (independentNewPost && !independentFallsUnderCoordinatedOptOut) {
    return false;
  }

  // A prohibition can be scoped to an existing Artifact while the same turn
  // explicitly asks for a new post. Remove only the negated writing clauses and
  // see whether an independent full-post instruction remains; a global boolean
  // must not let "do not rewrite Draft 1" cancel "write a new post".
  const affirmativeRemainder = withoutSourceDiscoveryOptOut(
    text.replace(
      new RegExp(COORDINATED_WRITING_OPTOUT_RE.source, "gi"),
      " ",
    ),
  )
    .replace(new RegExp(WRITING_OPTOUT_RE.source, "gi"), " ")
    .replace(ORPHANED_COORDINATED_WRITING_RE, " ");
  return !AFFIRMATIVE_FULL_POST_AFTER_OPTOUT_RE.test(affirmativeRemainder);
}

/**
 * Partial deliverables stay in normal chat text. They must never become a full
 * post card merely because the phrase "post ideas" contains the word "post".
 */
export function requestsPartialTextDeliverable(text: string): boolean {
  if (!PARTIAL_DELIVERABLE_RE.test(text)) return false;
  if (
    EXPLICIT_PARTIAL_BOUNDARY_RE.test(text) ||
    PARTIAL_FOR_POST_CONTEXT_RE.test(text)
  ) {
    return true;
  }
  return !DIRECT_FULL_POST_RE.test(text) && !SOURCE_TO_FULL_POST_RE.test(text);
}

/** True only when the user asks for complete post cards, not components. */
export function requestsFullPostDeliverable(text: string): boolean {
  return (
    !explicitlyForbidsWriting(text) &&
    DIRECT_FULL_POST_RE.test(text) &&
    !requestsPartialTextDeliverable(text)
  );
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

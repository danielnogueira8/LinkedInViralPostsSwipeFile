import type { ToolDef } from "@/lib/openrouter";

export type RequestedCharacterRange = {
  min?: number;
  max?: number;
};

export type DraftOutputPolicy = {
  characterRange: RequestedCharacterRange | null;
  groundingContext: string;
  enforceGrounding?: boolean;
  enforceFactualSpecificity?: boolean;
  minimumCompletePostChars?: number;
};

function parseCount(raw: string): number {
  return Number(raw.replaceAll(",", ""));
}

function validCount(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 10_000;
}

/** Parse only explicit hard character limits, never vague length preferences. */
export function requestedCharacterRange(
  instruction: string,
): RequestedCharacterRange | null {
  const range = instruction.match(
    /\b(?:between\s+|from\s+)?(\d[\d,]*)\s*(?:-|–|—|to|and)\s*(\d[\d,]*)\s*(?:characters?|chars?)\b/i,
  );
  if (range) {
    const first = parseCount(range[1]);
    const second = parseCount(range[2]);
    if (validCount(first) && validCount(second) && first <= second) {
      return { min: first, max: second };
    }
  }

  const between = instruction.match(
    /\bbetween\s+(\d[\d,]*)\s+and\s+(\d[\d,]*)\s*(?:characters?|chars?)\b/i,
  );
  if (between) {
    const first = parseCount(between[1]);
    const second = parseCount(between[2]);
    if (validCount(first) && validCount(second) && first <= second) {
      return { min: first, max: second };
    }
  }

  const max = instruction.match(
    /\b(?:under|below|fewer\s+than|no\s+more\s+than|at\s+most|up\s+to|max(?:imum)?(?:\s+of)?|keep(?:\s+it|\s+the\s+post)?\s+under)\s*(\d[\d,]*)\s*(?:characters?|chars?)\b/i,
  );
  if (max) {
    const value = parseCount(max[1]);
    if (validCount(value)) return { max: value };
  }
  const maxSuffix = instruction.match(
    /\b(\d[\d,]*)\s*(?:characters?|chars?)\s*(?:max(?:imum)?|or\s+fewer|at\s+most)\b/i,
  );
  if (maxSuffix) {
    const value = parseCount(maxSuffix[1]);
    if (validCount(value)) return { max: value };
  }

  const min = instruction.match(
    /\b(?:at\s+least|minimum(?:\s+of)?|no\s+fewer\s+than|over|more\s+than)\s*(\d[\d,]*)\s*(?:characters?|chars?)\b/i,
  );
  if (min) {
    const value = parseCount(min[1]);
    if (validCount(value)) return { min: value };
  }
  const minSuffix = instruction.match(
    /\b(\d[\d,]*)\s*(?:characters?|chars?)\s*(?:minimum|or\s+more|at\s+least)\b/i,
  );
  if (minSuffix) {
    const value = parseCount(minSuffix[1]);
    if (validCount(value)) return { min: value };
  }

  return null;
}

const EXPERIENCE_VERB_SOURCE = String.raw`(?:watch|watched|watching|see|saw|seen|seeing|notice|noticed|noticing|observe|observed|observing|work|worked|working|spend|spent|spending|build|built|building|run|ran|running|start|started|starting|found|founded|founding|launch|launched|launching|sell|sold|selling|buy|bought|buying|break|broke|breaking|grow|grew|grown|growing|generate|generated|generating|earn|earned|earning|lose|lost|losing|hire|hired|hiring|fire|fired|firing|manage|managed|managing|lead|led|leading|help|helped|helping|coach|coached|coaching|advise|advised|advising|meet|met|meeting|speak|spoke|speaking|talk|talked|talking|chat|chatted|chatting|interview|interviewed|interviewing|mentor|mentored|mentoring|consult|consulted|consulting|teach|taught|teaching|ask|asked|asking|tell|told|telling|hear|heard|hearing|read|reading|write|wrote|writing|publish|published|publishing|ship|shipped|shipping|join|joined|joining|visit|visited|visiting|remember|remembered|remembering|recall|recalled|recalling|learn|learned|learnt|learning|discover|discovered|discovering|test|tested|testing|use|used|using|try|tried|trying|make|made|making|create|created|creating)`;

const FIRST_PERSON_EXPERIENCE_RE = new RegExp(
  String.raw`\b(?:i|we)(?:'ve|\s+have|\s+had|\s+was|\s+were)?\s+(?:(?:once|personally|recently|successfully)\s+)?${EXPERIENCE_VERB_SOURCE}\b|\b(?:i|we)(?:'ve|\s+have)?\s+been\s+(?:ghostwriting|working|building|writing|advising|coaching|running|helping)\b|\b(?:my|our)\s+(?:clients?|customers?|team|company|business|agency|employees?|co-?founders?|portfolio|revenue|sales|users?)\b|\b(?:founders?|ghostwriters?|operators?|consultants?|clients?|customers?|people)\s+(?:i|we)\s+(?:know|work(?:ed)?\s+with|write\s+for|advise(?:d)?|coach(?:ed)?|help(?:ed)?)\b|\b(?:the\s+ones|founders?|ghostwriters?|operators?|consultants?|clients?|customers?|people)\b[^.\n]{0,50}\b(?:tell(?:ing)?|told|ask(?:ing|ed)?|messag(?:e|ed|ing))\s+(?:me|us)\b`,
  "i",
);

const SUPPORT_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "before",
  "being",
  "both",
  "built",
  "could",
  "created",
  "every",
  "first",
  "from",
  "have",
  "into",
  "know",
  "larger",
  "made",
  "more",
  "other",
  "posted",
  "spent",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "took",
  "very",
  "watched",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

function normalizedTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length >= 4 || /^\d+$/.test(token))
    .filter((token) => !SUPPORT_STOP_WORDS.has(token))
    .map((token) => {
      if (/^founders?$/.test(token)) return "founder";
      if (/^ghostwrit(?:er|ers|ing)$/.test(token)) return "ghostwrit";
      if (/^clients?$/.test(token)) return "client";
      return token;
    });
}

function hasContextualSupport(claim: string, context: string): boolean {
  const claimTokens = [...new Set(normalizedTokens(claim))];
  if (claimTokens.length === 0) return false;
  const contextTokens = new Set(normalizedTokens(context));
  const overlap = claimTokens.filter((token) => contextTokens.has(token)).length;
  const required = Math.max(2, Math.ceil(claimTokens.length * 0.5));
  return overlap >= required;
}

function localEvidenceSegments(context: string): string[] {
  const normalized = context.trim();
  if (!normalized) return [];
  const segments = new Set<string>();
  for (const sentence of normalized.match(/[^.!?\n]{1,600}(?:[.!?]+|$)/g) ?? []) {
    const value = sentence.trim();
    if (value) segments.add(value);
  }
  const windowSize = 420;
  const stride = 140;
  for (let start = 0; start < normalized.length; start += stride) {
    const value = normalized.slice(start, start + windowSize).trim();
    if (value) segments.add(value);
    if (start + windowSize >= normalized.length) break;
  }
  return [...segments];
}

const QUANTITY_RE =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|\d[\d,.]*%?)\b/gi;

function quantities(text: string): string[] {
  return (text.match(QUANTITY_RE) ?? []).map((value) =>
    value.toLowerCase().replaceAll(",", ""),
  );
}

const TEMPORAL_QUANTITY_RE =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|\d[\d,.]*)\s*[- ]\s*(years?|months?|weeks?|days?|hours?|minutes?)\b/gi;

function temporalQuantities(text: string): string[] {
  return [...text.matchAll(TEMPORAL_QUANTITY_RE)].map((match) => {
    const count = match[1].toLowerCase().replaceAll(",", "");
    const unit = match[2].toLowerCase().replace(/s$/, "");
    return `${count}:${unit}`;
  });
}

/**
 * Return the first unsupported high-signal numeric claim in ungrounded text.
 * Item numbering is ignored. Bare spelled-out words such as "one idea" stay
 * available for natural prose, while percentages, digit claims, currency, and
 * time spans must already exist in trusted user/backstory context.
 */
export function unsupportedFactualSpecific(
  body: string,
  groundingContext: string,
): string | null {
  const contextQuantities = new Set(quantities(groundingContext));
  const contextTemporalQuantities = new Set(
    temporalQuantities(groundingContext),
  );
  const withoutItemNumbers = body.replace(/^\s*\d{1,2}[.)]\s*/gm, "");
  const segments = withoutItemNumbers
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    if (
      temporalQuantities(segment).some(
        (value) => !contextTemporalQuantities.has(value),
      )
    ) {
      return segment;
    }
    if (
      /(?:\d|[%$€£¥])/u.test(segment) &&
      quantities(segment).some((value) => !contextQuantities.has(value))
    ) {
      return segment;
    }
  }
  return null;
}

/**
 * Source modeling may legitimately reuse a numbered framework ("3 reasons"),
 * but it must not transplant factual specificity from an unrelated source.
 * Keep this narrower than the no-search idea guard: reject time spans, dates,
 * percentages, and currency while allowing structural list counts.
 */
function unsupportedSourceFactualSpecific(
  body: string,
  groundingContext: string,
): string | null {
  const contextQuantities = new Set(quantities(groundingContext));
  const contextTemporalQuantities = new Set(
    temporalQuantities(groundingContext),
  );
  const segments = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    if (
      temporalQuantities(segment).some(
        (value) => !contextTemporalQuantities.has(value),
      )
    ) {
      return segment;
    }
    const hasSensitiveNumeric =
      /[%$€£¥]/u.test(segment) || /\b(?:19|20)\d{2}\b/.test(segment);
    if (
      hasSensitiveNumeric &&
      quantities(segment).some((value) => !contextQuantities.has(value))
    ) {
      return segment;
    }
  }
  return null;
}

const RESULT_PREDICATE_RE =
  /\b(?:generate(?:d)?|earn(?:ed)?|grew|grown|increase(?:d)?|double(?:d)?|triple(?:d)?|save(?:d)?|sold|close(?:d)?|convert(?:ed)?)\b/gi;

function resultPredicates(text: string): string[] {
  return (text.match(RESULT_PREDICATE_RE) ?? []).map((value) => {
    const normalized = value.toLowerCase();
    if (normalized === "grew" || normalized === "grown") return "grow";
    if (normalized === "sold") return "sell";
    if (normalized.startsWith("generat")) return "generate";
    if (normalized.startsWith("earn")) return "earn";
    if (normalized.startsWith("increas")) return "increase";
    if (normalized.startsWith("doubl")) return "double";
    if (normalized.startsWith("tripl")) return "triple";
    if (normalized.startsWith("sav")) return "save";
    if (normalized.startsWith("clos")) return "close";
    if (normalized.startsWith("convert")) return "convert";
    return normalized;
  });
}

const EXPERIENCE_PREDICATE_RE = new RegExp(
  String.raw`\b${EXPERIENCE_VERB_SOURCE}\b`,
  "gi",
);

const EXPERIENCE_LEMMAS: Record<string, string> = {
  watched: "watch",
  watching: "watch",
  saw: "see",
  seen: "see",
  seeing: "see",
  noticed: "notice",
  noticing: "notice",
  observed: "observe",
  observing: "observe",
  worked: "work",
  working: "work",
  spent: "run",
  spending: "run",
  spend: "run",
  built: "build",
  building: "build",
  ran: "run",
  running: "run",
  started: "start",
  starting: "start",
  founded: "found",
  founding: "found",
  launched: "launch",
  launching: "launch",
  sold: "sell",
  selling: "sell",
  bought: "buy",
  buying: "buy",
  broke: "break",
  breaking: "break",
  grew: "grow",
  grown: "grow",
  growing: "grow",
  generated: "generate",
  generating: "generate",
  earned: "earn",
  earning: "earn",
  lost: "lose",
  losing: "lose",
  hired: "hire",
  hiring: "hire",
  fired: "fire",
  firing: "fire",
  managed: "manage",
  managing: "manage",
  led: "lead",
  leading: "lead",
  helped: "help",
  helping: "help",
  coached: "coach",
  coaching: "coach",
  advised: "advise",
  advising: "advise",
  met: "meet",
  meeting: "meet",
  spoke: "speak",
  speaking: "speak",
  talked: "talk",
  talking: "talk",
  chatted: "chat",
  chatting: "chat",
  interviewed: "interview",
  interviewing: "interview",
  mentored: "mentor",
  mentoring: "mentor",
  consulted: "consult",
  consulting: "consult",
  taught: "teach",
  teaching: "teach",
  asked: "ask",
  asking: "ask",
  told: "tell",
  telling: "tell",
  hear: "hear",
  heard: "hear",
  hearing: "hear",
  read: "read",
  reading: "read",
  wrote: "write",
  writing: "write",
  published: "publish",
  publishing: "publish",
  shipped: "ship",
  shipping: "ship",
  joined: "join",
  joining: "join",
  visited: "visit",
  visiting: "visit",
  remembered: "remember",
  remembering: "remember",
  remember: "remember",
  recalled: "recall",
  recalling: "recall",
  recall: "recall",
  learned: "learn",
  learnt: "learn",
  learning: "learn",
  discovered: "discover",
  discovering: "discover",
  tested: "test",
  testing: "test",
  used: "use",
  using: "use",
  tried: "try",
  trying: "try",
  made: "make",
  making: "make",
  created: "create",
  creating: "create",
};

function experiencePredicates(text: string): string[] {
  return (text.match(EXPERIENCE_PREDICATE_RE) ?? []).map(
    (value) => EXPERIENCE_LEMMAS[value.toLowerCase()] ?? value.toLowerCase(),
  );
}

function personalEntityClaims(text: string): string[] {
  const matches = text.toLowerCase().matchAll(
    /\b(?:my|our)\s+(clients?|customers?|team|company|business|agency|employees?|co-?founders?|portfolio|revenue|sales|users?)\b/g,
  );
  return [...matches].map((match) => match[1]);
}

function knownRelationshipClaims(text: string): string[] {
  const normalized = text.toLowerCase();
  return [
    ...(normalized.match(
      /\b(?:founders?|ghostwriters?|operators?|consultants?|clients?|customers?|people)\s+(?:i|we)\s+(?:know|work(?:ed)?\s+with|write\s+for|advise(?:d)?|coach(?:ed)?|help(?:ed)?)\b/g,
    ) ?? []),
    ...(normalized.match(
      /\b(?:the\s+ones|founders?|ghostwriters?|operators?|consultants?|clients?|customers?|people)\b[^.\n]{0,50}\b(?:tell(?:ing)?|told|ask(?:ing|ed)?|messag(?:e|ed|ing))\s+(?:me|us)\b/g,
    ) ?? []),
  ];
}

function hasSpecificEvidence(claim: string, context: string): boolean {
  const contextTemporalQuantities = new Set(temporalQuantities(context));
  if (
    temporalQuantities(claim).some(
      (value) => !contextTemporalQuantities.has(value),
    )
  ) {
    return false;
  }
  const contextQuantities = new Set(quantities(context));
  if (quantities(claim).some((value) => !contextQuantities.has(value))) {
    return false;
  }
  const contextPredicates = new Set(resultPredicates(context));
  if (
    resultPredicates(claim).some((value) => !contextPredicates.has(value))
  ) {
    return false;
  }
  const contextExperience = new Set(experiencePredicates(context));
  if (
    experiencePredicates(claim).some(
      (value) => !contextExperience.has(value),
    )
  ) {
    return false;
  }
  const normalizedContext = context.toLowerCase();
  if (
    personalEntityClaims(claim).some((entity) => {
      const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(
        `(?:\\b(?:my|our)\\s+${escaped}\\b|\\bi\\b[^.\\n]{0,100}\\b${escaped}\\b|verified backstory[^.\\n]{0,100}\\b${escaped}\\b)`,
        "i",
      ).test(normalizedContext);
    })
  ) {
    return false;
  }
  return knownRelationshipClaims(claim).every((value) =>
    normalizedContext.includes(value),
  );
}

/**
 * Return the first high-confidence first-person experience that has no lexical
 * support in user-provided context or the user's stored voice/backstory data.
 * Opinions such as "I think" and "I believe" deliberately do not match.
 */
export function unsupportedFirstPersonClaim(
  body: string,
  groundingContext: string,
): string | null {
  const sentences = body
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    if (!FIRST_PERSON_EXPERIENCE_RE.test(sentence)) continue;
    const supported = localEvidenceSegments(groundingContext).some(
      (segment) =>
        hasSpecificEvidence(sentence, segment) &&
        hasContextualSupport(sentence, segment),
    );
    if (!supported) return sentence;
  }
  return null;
}

export function validateDraftOutput(
  body: string,
  policy: DraftOutputPolicy | undefined,
): { ok: true } | { ok: false; error: string } {
  if (!policy) return { ok: true };

  if (
    policy.minimumCompletePostChars !== undefined &&
    body.trim().length < policy.minimumCompletePostChars
  ) {
    return {
      ok: false,
      error: `This is only ${body.trim().length} characters and reads like a hook fragment, not the complete post the user requested. Write the full post with a developed middle and ending, then call render_post again with at least ${policy.minimumCompletePostChars} characters.`,
    };
  }

  const range = policy.characterRange;
  if (range?.max !== undefined && body.length > range.max) {
    return {
      ok: false,
      error: `Your draft was ${body.length} characters, but the user explicitly requested at most ${range.max}. Tighten it and call render_post again.`,
    };
  }
  if (range?.min !== undefined && body.length < range.min) {
    return {
      ok: false,
      error: `Your draft was ${body.length} characters, but the user explicitly requested at least ${range.min}. Develop the idea without filler and call render_post again.`,
    };
  }

  const unsupportedSpecific = policy.enforceFactualSpecificity
    ? unsupportedSourceFactualSpecific(body, policy.groundingContext)
    : null;
  if (unsupportedSpecific) {
    return {
      ok: false,
      error:
        `This draft contains an unsupported numeric or timeline claim: "${unsupportedSpecific.slice(0, 180)}" ` +
        "Do not transplant percentages, counts, currency, dates, or time spans from a structural source. Rewrite with honest qualitative wording unless the user supplied the fact, then call render_post again.",
    };
  }

  const unsupportedClaim =
    policy.enforceGrounding === false
      ? null
      : unsupportedFirstPersonClaim(body, policy.groundingContext);
  if (unsupportedClaim) {
    return {
      ok: false,
      error:
        `This first-person experience is not supported by the user's messages or stored backstory: "${unsupportedClaim.slice(0, 180)}" ` +
        "Do not invent personal anecdotes, clients, results, timelines, or observations. Rewrite with honest qualitative language, or use only facts explicitly present in the trusted context, then call render_post again.",
    };
  }

  return { ok: true };
}

/**
 * Mirror the user's hard range into render_post's JSON schema. The runtime
 * validator remains authoritative; this prevents a predictable retry in the
 * common case where the provider respects schema length hints.
 */
export function applyCharacterRangeToRenderTool(
  tools: ToolDef[],
  range: RequestedCharacterRange | null,
): ToolDef[] {
  if (!range) return tools;
  return tools.map((tool) => {
    if (tool.function.name !== "render_post") return tool;
    const parameters = tool.function.parameters;
    const properties =
      parameters.properties && typeof parameters.properties === "object"
        ? (parameters.properties as Record<string, unknown>)
        : null;
    const body = properties?.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return tool;
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: {
          ...parameters,
          properties: {
            ...properties,
            body: {
              ...(body as Record<string, unknown>),
              ...(range.min !== undefined ? { minLength: range.min } : {}),
              ...(range.max !== undefined ? { maxLength: range.max } : {}),
            },
          },
        },
      },
    };
  });
}

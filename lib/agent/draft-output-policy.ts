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
  requireCompletePost?: boolean;
};

const DANGLING_END_WORD_RE =
  /\b(?:a|an|the|and|or|but|because|if|when|while)\s*$/i;

const SHORT_SUBJECT_CLAUSE_RE =
  /^(?:most|many|some|few|other|smart|successful|great|too many)\s+(?:people|founders|creators|writers|leaders|teams|companies|brands|professionals|marketers)\s+(?:pick|choose|use|write|create|build|make|want|need|prefer|expect|assume|believe|think|treat|consider|call|find|give|take|try|keep|leave|put|turn)\s*$/i;

const LIST_COUNT_WORDS: Record<string, number> = {
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

function promisedListGap(body: string): string | null {
  const promise = body.slice(0, 500).match(
    /(?:^|\n)\s*(?:here\s+(?:are|is)\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:reasons?|ways?|steps?|lessons?|principles?|rules?|mistakes?|questions?|signs?|things?|truths?|strategies?|tactics?)\b[^\n:]{0,120}:/i,
  );
  if (!promise) return null;
  const expected = /^\d+$/.test(promise[1])
    ? Number(promise[1])
    : LIST_COUNT_WORDS[promise[1].toLowerCase()];
  if (!Number.isInteger(expected) || expected < 2 || expected > 10) return null;

  const markers = [...body.matchAll(/^\s*(\d{1,2})[.)](?:\s+(.*))?$/gm)];
  if (markers.length === 0) return null;
  for (let number = 1; number <= expected; number += 1) {
    const markerIndex = markers.findIndex(
      (marker) => Number(marker[1]) === number,
    );
    if (markerIndex === -1) {
      return `the opening promises ${expected} list items, but item ${number} is missing`;
    }
    const marker = markers[markerIndex];
    const inline = marker[2]?.trim() ?? "";
    const contentStart = (marker.index ?? 0) + marker[0].length;
    const contentEnd = markers[markerIndex + 1]?.index ?? body.length;
    const following = body.slice(contentStart, contentEnd).trim();
    if (!inline && !following) {
      return `the opening promises ${expected} list items, but item ${number} has no content`;
    }
  }
  return null;
}

/**
 * Return only high-confidence evidence that a full post was cut off. LinkedIn
 * prose often uses intentional fragments and omits final punctuation, so this
 * deliberately does not require every draft to end with a period.
 */
export function incompleteDraftReason(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return "the draft is empty";

  const finalLine =
    trimmed
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  const finalFragment =
    finalLine
      .split(/(?<=[.!?…])[\])}'”’\"]*\s+/)
      .map((fragment) => fragment.trim())
      .filter(Boolean)
      .at(-1) ?? finalLine;

  if (/[,:;([{]$/.test(finalLine)) {
    return `the final line ends with unfinished punctuation: "${finalLine.slice(-120)}"`;
  }
  if (/^\d+[.)]\s*$/.test(finalFragment)) {
    return `the final numbered item has no content: "${finalFragment}"`;
  }
  const listGap = promisedListGap(trimmed);
  if (listGap) return listGap;
  if (DANGLING_END_WORD_RE.test(finalFragment)) {
    return `the final line ends on an unfinished connector: "${finalFragment.slice(-120)}"`;
  }

  const finalWords = finalFragment.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
  if (
    finalWords.length <= 8 &&
    !/[.!?…][\])}'”’\"]*$/.test(finalFragment) &&
    SHORT_SUBJECT_CLAUSE_RE.test(finalFragment)
  ) {
    return `the final line stops inside a clause: "${finalFragment.slice(-120)}"`;
  }

  return null;
}

function parseCount(raw: string): number {
  return Number(raw.replaceAll(",", ""));
}

function validCount(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 10_000;
}

const CONTROL_COUNT_TOKEN =
  String.raw`(?:\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)`;
const CONTROL_DELIVERABLE_NOUN =
  String.raw`(?:posts?|drafts?|variations?|versions?|rewrites?|ideas?|angles?|outlines?|titles?|hooks?|openers?|opening\s+lines?|items?)`;
const DELIVERABLE_COUNT_CONTROL_RE = new RegExp(
  String.raw`\b(?:exactly\s+)?${CONTROL_COUNT_TOKEN}(?=\s+(?:(?:complete|finished|full|different|distinct|original|linkedin|post)\s+){0,4}${CONTROL_DELIVERABLE_NOUN}\b)`,
  "gi",
);
const CHARACTER_RANGE_CONTROL_RE =
  /\b(?:between\s+|from\s+)?\d[\d,]*\s*(?:-|–|—|to|and)\s*\d[\d,]*\s*(?:characters?|chars?)\b/gi;
const CHARACTER_PREFIX_CONTROL_RE =
  /\b(?:under|below|fewer\s+than|no\s+more\s+than|at\s+most|up\s+to|max(?:imum)?(?:\s+of)?|keep(?:\s+it|\s+the\s+post)?\s+under|at\s+least|minimum(?:\s+of)?|no\s+fewer\s+than|over|more\s+than)\s*\d[\d,]*\s*(?:characters?|chars?)\b/gi;
const CHARACTER_SUFFIX_CONTROL_RE =
  /\b\d[\d,]*\s*(?:characters?|chars?)\s*(?:max(?:imum)?|or\s+fewer|at\s+most|minimum|or\s+more|at\s+least)\b/gi;
const CHARACTER_EXACT_CONTROL_RE =
  /\b(?:exactly|in|to|at)\s+\d[\d,]*\s*(?:characters?|chars?)\b/gi;

/**
 * Remove numeric output controls before factual grounding. A requested count
 * of three drafts or a 1,200-character limit is not evidence for a $3M result
 * or a 1,200-customer claim inside generated content.
 */
export function withoutOutputControlQuantities(instruction: string): string {
  return instruction
    .replace(CHARACTER_RANGE_CONTROL_RE, "[character-range constraint]")
    .replace(CHARACTER_PREFIX_CONTROL_RE, "[character-limit constraint]")
    .replace(CHARACTER_SUFFIX_CONTROL_RE, "[character-limit constraint]")
    .replace(CHARACTER_EXACT_CONTROL_RE, "[character-limit constraint]")
    .replace(DELIVERABLE_COUNT_CONTROL_RE, "[deliverable-count]");
}

/** Parse only explicit hard character limits, never vague length preferences. */
export function requestedCharacterRange(
  instruction: string,
): RequestedCharacterRange | null {
  const exact = instruction.match(
    /\b(?:exactly|in|to|at)\s+(\d[\d,]*)\s*(?:characters?|chars?)\b/i,
  );
  if (exact) {
    const value = parseCount(exact[1]);
    if (validCount(value)) return { min: value, max: value };
  }
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

const EXPERIENCE_VERB_SOURCE = String.raw`(?:watch|watched|watching|see|saw|seen|seeing|notice|noticed|noticing|observe|observed|observing|work|worked|working|spend|spent|spending|build|built|building|run|ran|running|start|started|starting|found|founded|founding|launch|launched|launching|sell|sold|selling|send|sent|sending|book|booked|booking|buy|bought|buying|break|broke|breaking|grow|grew|grown|growing|generate|generated|generating|earn|earned|earning|lose|lost|losing|hire|hired|hiring|fire|fired|firing|manage|managed|managing|lead|led|leading|help|helped|helping|coach|coached|coaching|advise|advised|advising|meet|met|meeting|speak|spoke|speaking|talk|talked|talking|chat|chatted|chatting|interview|interviewed|interviewing|mentor|mentored|mentoring|consult|consulted|consulting|teach|taught|teaching|ask|asked|asking|tell|told|telling|hear|heard|hearing|read|reading|write|wrote|writing|publish|published|publishing|ship|shipped|shipping|join|joined|joining|visit|visited|visiting|remember|remembered|remembering|recall|recalled|recalling|learn|learned|learnt|learning|discover|discovered|discovering|test|tested|testing|use|used|using|try|tried|trying|make|made|making|create|created|creating)`;

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
  const normalized = context
    .replace(
      /["']?(?:[a-z0-9]+_)*(?:metadata|id|ids|count|created_at|updated_at|generated_at|timestamp|version|status|hash|url|model|provider|tokens?|usage|source)["']?\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\n]+)/gi,
      "",
    )
    .trim();
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

const QUANTITY_WORD_VALUES: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  hundred: "100",
  thousand: "1000",
  million: "1000000",
  billion: "1000000000",
};
const TYPED_QUANTITY_RE =
  /([$€£¥])\s*(\d[\d,.]*)([kmb])?|\b(\d[\d,.]*)([kmb])?(%)?|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion)\b/gi;

function canonicalQuantityValue(raw: string, magnitude = ""): string {
  const normalized = raw.toLowerCase().replaceAll(",", "");
  return `${QUANTITY_WORD_VALUES[normalized] ?? normalized}${magnitude.toLowerCase()}`;
}

function quantities(text: string, includeSpelled = true): string[] {
  return [...text.matchAll(TYPED_QUANTITY_RE)].flatMap((match) => {
    if (match[1]) {
      return [`currency:${match[1]}:${canonicalQuantityValue(match[2], match[3])}`];
    }
    if (match[6]) {
      return [`percent:${canonicalQuantityValue(match[4], match[5])}`];
    }
    if (match[7] && !includeSpelled) return [];
    return [`count:${canonicalQuantityValue(match[7] ?? match[4], match[5])}`];
  });
}

const TEMPORAL_QUANTITY_RE =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|\d[\d,.]*)\s*[- ]\s*(years?|months?|weeks?|days?|hours?|minutes?)\b/gi;

function temporalQuantities(text: string): string[] {
  return [...text.matchAll(TEMPORAL_QUANTITY_RE)].map((match) => {
    const count = canonicalQuantityValue(match[1]);
    const unit = match[2].toLowerCase().replace(/s$/, "");
    return `${count}:${unit}`;
  });
}

function withoutStructuralListCount(segment: string, body: string): string {
  const header = segment.match(
    /^\s*(?:here\s+(?:are|is)\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:reasons?|ways?|lessons?|steps?|ideas?|principles?|rules?|mistakes?|questions?|signs?|things?|truths?|frameworks?|strategies?|tactics?)\b[^:\n.!?]{0,120}([:.])\s*$/i,
  );
  if (!header) return segment;
  if (
    /\b(?:generate(?:d)?|sell|sold|close(?:d)?|book(?:ed)?|buy|bought|earn(?:ed)?|charge(?:d)?|send|sent|convert(?:ed)?|grow|grew|grown)\b/i.test(
      segment,
    )
  ) {
    return segment;
  }
  const expected = Number(
    QUANTITY_WORD_VALUES[header[1].toLowerCase()] ?? header[1],
  );
  if (header[2] !== ":") {
    const markers = new Set(
      [...body.matchAll(/^\s*(\d{1,2})[.)]\s+.+$/gm)].map((match) =>
        Number(match[1]),
      ),
    );
    if (
      !Number.isInteger(expected) ||
      expected < 2 ||
      !Array.from({ length: expected }, (_, index) => index + 1).every(
        (value) => markers.has(value),
      )
    ) {
      return segment;
    }
  }
  return segment.replace(
    /\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)(?=\s+(?:reasons?|ways?|lessons?|steps?|ideas?|principles?|rules?|mistakes?|questions?|signs?|things?|truths?|frameworks?|strategies?|tactics?)\b)/i,
    "",
  );
}

const HIGH_SIGNAL_COUNT_NOUN_RE =
  /\b(?:clients?|customers?|companies|businesses|calls?|dms?|messages?|leads?|deals?|sales|offers?|posts?|strategies|tactics|ideas|reasons|things|revenue|dollars?|euros?|pounds?|yen)\b/i;
const HIGH_SIGNAL_COUNT_ACTIVITY_RE =
  /\b(?:has|had|serve(?:d|s)?|manage(?:d|s)?|work(?:ed|s)?\s+with|generate(?:d|s)?|sell|sold|close(?:d|s)?|book(?:ed|s)?|buy|bought|earn(?:ed|s)?|charge(?:d|s)?|send|sent|convert(?:ed|s)?|grow|grew|grown|produce(?:d|s)?)\b/i;

function enforcesSpelledFactualCounts(segment: string): boolean {
  return (
    HIGH_SIGNAL_COUNT_NOUN_RE.test(segment) &&
    HIGH_SIGNAL_COUNT_ACTIVITY_RE.test(segment)
  );
}

function quantityHasLocalSupport(opts: {
  value: string;
  claim: string;
  evidenceSegments: string[];
  temporal: boolean;
}): boolean {
  return opts.evidenceSegments.some((evidence) => {
    const evidenceValues = opts.temporal
      ? temporalQuantities(evidence)
      : quantities(evidence);
    return (
      evidenceValues.includes(opts.value) &&
      hasContextualSupport(opts.claim, evidence)
    );
  });
}

/**
 * Return the first unsupported high-signal numeric claim in ungrounded text.
 * Item numbering and proven structural list headings are ignored. All factual
 * counts, including spelled-out numbers, must have local type-and-unit-matched
 * evidence in trusted user/backstory context.
 */
export function unsupportedFactualSpecific(
  body: string,
  groundingContext: string,
): string | null {
  const evidenceSegments = localEvidenceSegments(groundingContext);
  const withoutItemNumbers = body.replace(/^\s*\d{1,2}[.)]\s*/gm, "");
  const segments = withoutItemNumbers
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const factualSegment = withoutStructuralListCount(segment, body);
    if (
      temporalQuantities(factualSegment).some(
        (value) =>
          !quantityHasLocalSupport({
            value,
            claim: factualSegment,
            evidenceSegments,
            temporal: true,
          }),
      )
    ) {
      return segment;
    }
    if (
      quantities(
        factualSegment,
        enforcesSpelledFactualCounts(factualSegment),
      ).some(
        (value) =>
          !quantityHasLocalSupport({
            value,
            claim: factualSegment,
            evidenceSegments,
            temporal: false,
          }),
      )
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
  const evidenceSegments = localEvidenceSegments(groundingContext);
  const withoutItemNumbers = body.replace(/^\s*\d{1,2}[.)]\s*/gm, "");
  const segments = withoutItemNumbers
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    if (
      temporalQuantities(segment).some(
        (value) =>
          !quantityHasLocalSupport({
            value,
            claim: segment,
            evidenceSegments,
            temporal: true,
          }),
      )
    ) {
      return segment;
    }
    const factualSegment = withoutDescriptorListCount(
      withoutStructuralListCount(segment, body),
    );
    if (
      quantities(
        factualSegment,
        enforcesSpelledFactualCounts(factualSegment),
      ).some(
        (value) =>
          !quantityHasLocalSupport({
            value,
            claim: factualSegment,
            evidenceSegments,
            temporal: false,
          }),
      )
    ) {
      return segment;
    }
  }
  return null;
}

const RESULT_PREDICATE_RE =
  /\b(?:generate(?:d)?|earn(?:ed)?|grew|grown|increase(?:d)?|double(?:d)?|triple(?:d)?|save(?:d)?|sold|close(?:d)?|convert(?:ed)?)\b/gi;

// A DESCRIPTOR count on a bullet/arrow list item — a small integer directly
// modifying a plural noun, like "→ Claude Prompts For 4 Specialized Agents",
// "- 3 Cold-Email Templates", "• 5 Reply Scripts". These describe WHAT'S INSIDE
// a resource (lead-magnet giveaways especially), not a performance metric, so
// they must NOT be flagged as a transplanted numeric claim. Numbered-list
// HEADERS ("here are 4 ways…") are already handled by withoutStructuralListCount;
// this covers the bullet/arrow ITEMS that format doesn't. Guarded: only fires on
// a genuine list-marker line, and never strips a count tied to a result
// predicate ("→ Booked 12 calls" stays flagged) or a %/$/temporal quantity.
const BULLET_LIST_MARKER_RE = /^\s*(?:[-*•‣▸]|->|[→➜➞»›]|\d{1,2}[.)])\s+/;
// N directly followed by a noun phrase whose head is a PLURAL noun within a few
// words: "4 Specialized Agents", "3 Cold-Email Templates", "5 Reply Scripts".
// The trailing plural (`\w+s`) is the count's referent — a descriptor, not a
// metric. Capitalization-agnostic; the count may be a digit or a spelled number.
const DESCRIPTOR_NOUN_COUNT_RE =
  /\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?=(?:[A-Za-z][\w-]*\s+){0,3}[A-Za-z][\w-]*s\b)/gi;

// Activity / outcome nouns whose count IS a metric, even on a bullet line:
// "12 calls", "50 DMs", "3 deals", "20 leads". These are results, not resource
// contents, so a count tied to them must stay flagged. (Deliverable nouns —
// agents, templates, scripts, prompts, checklists — are the descriptor case.)
const ACTIVITY_METRIC_NOUN_RE =
  /\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:new\s+|more\s+|extra\s+)?(?:calls?|dms?|messages?|emails?|deals?|leads?|clients?|customers?|sales?|signups?|sign-ups?|subscribers?|followers?|users?|meetings?|bookings?|replies?|responses?|conversions?|demos?|trials?|orders?)\b/i;

function withoutDescriptorListCount(segment: string): string {
  if (!BULLET_LIST_MARKER_RE.test(segment)) return segment;
  // Never soften a real result/metric line: a result predicate ("Grew…",
  // "Closed…"), a %/$/temporal span, or an activity-outcome noun-count all mean
  // the number is a metric, not a descriptor of what's inside a resource.
  RESULT_PREDICATE_RE.lastIndex = 0;
  if (RESULT_PREDICATE_RE.test(segment)) return segment;
  if (
    /[$£€%]|\b\d[\d,.]*\s*(?:years?|months?|weeks?|days?|hours?|minutes?)\b/i.test(
      segment,
    )
  ) {
    return segment;
  }
  if (ACTIVITY_METRIC_NOUN_RE.test(segment)) return segment;
  return segment.replace(DESCRIPTOR_NOUN_COUNT_RE, "");
}

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
  sent: "send",
  sending: "send",
  booked: "book",
  booking: "book",
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

export type DraftOutputRejectionCode =
  | "assistant_framing"
  | "incomplete"
  | "too_short"
  | "character_range"
  | "unsupported_specificity"
  | "unsupported_claim";

export type DraftOutputValidation =
  | { ok: true }
  | { ok: false; code: DraftOutputRejectionCode; error: string };

export function evaluateDraftOutput(
  body: string,
  policy: DraftOutputPolicy | undefined,
): DraftOutputValidation {
  if (!policy) return { ok: true };

  if (
    /^(?:(?:here\s+(?:is|are)|here(?:'|’)?s)\s+(?:the|your)\s+(?:linkedin\s+)?(?:post|draft)(?:\s+you\s+asked\s+for)?|(?:linkedin\s+)?(?:post|draft))\s*:\s*(?:\r?\n)+/i.test(
      body,
    )
  ) {
    return {
      ok: false,
      code: "assistant_framing",
      error:
        "Return only the post itself. Remove assistant preambles or labels such as 'Here is your post:' or 'LinkedIn post:', then call render_post again with the clean body.",
    };
  }

  const incompleteReason = policy.requireCompletePost
    ? incompleteDraftReason(body)
    : null;
  if (incompleteReason) {
    return {
      ok: false,
      code: "incomplete",
      error:
        `This draft is unfinished (${incompleteReason}). Do not show it to the user. ` +
        "Write the complete post with a finished ending, then call render_post again with the entire body.",
    };
  }

  if (
    policy.minimumCompletePostChars !== undefined &&
    body.trim().length < policy.minimumCompletePostChars
  ) {
    return {
      ok: false,
      code: "too_short",
      error: `This is only ${body.trim().length} characters and reads like a hook fragment, not the complete post the user requested. Write the full post with a developed middle and ending, then call render_post again with at least ${policy.minimumCompletePostChars} characters.`,
    };
  }

  const range = policy.characterRange;
  if (range?.max !== undefined && body.trim().length > range.max) {
    return {
      ok: false,
      code: "character_range",
      error: `Your draft was ${body.trim().length} characters, but the user explicitly requested at most ${range.max}. Tighten it and call render_post again.`,
    };
  }
  if (range?.min !== undefined && body.trim().length < range.min) {
    return {
      ok: false,
      code: "character_range",
      error: `Your draft was ${body.trim().length} characters, but the user explicitly requested at least ${range.min}. Develop the idea without filler and call render_post again.`,
    };
  }

  const unsupportedSpecific = policy.enforceFactualSpecificity
    ? unsupportedSourceFactualSpecific(body, policy.groundingContext)
    : null;
  if (unsupportedSpecific) {
    return {
      ok: false,
      code: "unsupported_specificity",
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
      code: "unsupported_claim",
      error:
        `This first-person experience is not supported by the user's messages or stored backstory: "${unsupportedClaim.slice(0, 180)}" ` +
        "Do not invent personal anecdotes, clients, results, timelines, or observations. Rewrite with honest qualitative language, or use only facts explicitly present in the trusted context, then call render_post again.",
    };
  }

  return { ok: true };
}

/**
 * Compatibility surface for existing callers that only need the corrective
 * message. The finalizer consumes evaluateDraftOutput so rejection routing is
 * typed without changing the long-standing validation result shape.
 */
export function validateDraftOutput(
  body: string,
  policy: DraftOutputPolicy | undefined,
): { ok: true } | { ok: false; error: string } {
  const result = evaluateDraftOutput(body, policy);
  return result.ok ? result : { ok: false, error: result.error };
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

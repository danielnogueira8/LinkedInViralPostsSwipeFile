import {
  derivePartialTextContract,
  type PartialTextContract,
} from "@/lib/agent/partial-output-policy";

export type DirectPartialKind =
  "hook" | "idea" | "angle" | "outline" | "title" | "opener";

export type DirectPartialTextSpec = {
  kind: DirectPartialKind;
  label: string;
  expectedCount: number;
  contract: PartialTextContract;
};

const COUNT_WORDS: Record<string, number> = {
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
const COUNT_TOKEN = String.raw`(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)`;
const PARTIAL_NOUN =
  String.raw`(?:ideas?|angles?|outlines?|titles?|hooks?|openers?|opening\s+lines?)`;
const PARTIAL_TARGET_VARIATION_RE =
  /\b(?:versions?|variations?|rewrites?)\s+of\s+(?:the\s+|an?\s+)?(?:hooks?|titles?|headlines?|openers?|opening\s+lines?|first\s+(?:sentences?|paragraphs?)|ctas?|calls?\s+to\s+action|endings?|closings?|conclusions?|middles?|bodies?)\b/i;
const PARTIAL_REQUEST_RE = new RegExp(
  String.raw`\b(?:write|draft|create|generate|give(?:\s+me)?|make|produce|prepare|brainstorm|suggest)\s+(?:me\s+)?(?:(?:exactly\s+)?(?:-?\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple|many|few|a\s+few|a\s+couple(?:\s+of)?|a|an|the)\s+)?(?:(?:different|distinct|new)\s+)?(?:linkedin\s+)?(?:post\s+)?${PARTIAL_NOUN}\b`,
  "i",
);
const UNSUPPORTED_PARTIAL_SHAPE_RE =
  /\beach\s+(?:item\s+)?(?:under|below|at\s+most|no\s+more\s+than|maximum|exactly)\s+(?:\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:characters?|chars?|words?|sentences?)\b|\b(?:maximum|at\s+most|no\s+more\s+than|under|below|exactly)\s+(?:\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:characters?|chars?|words?|sentences?)\s+(?:for\s+)?each\b/i;

function countValue(raw: string | undefined, maximum: number): number | null {
  if (!raw) return null;
  const value = /^\d+$/.test(raw)
    ? Number(raw)
    : COUNT_WORDS[raw.toLowerCase()];
  return Number.isInteger(value) && value > 0 && value <= maximum
    ? value
    : null;
}

const PARTIAL_KIND_PATTERNS: Array<{
  kind: DirectPartialKind;
  label: string;
  pattern: RegExp;
}> = [
  { kind: "hook", label: "Hook", pattern: /\bhooks?\b/i },
  { kind: "idea", label: "Idea", pattern: /\bideas?\b/i },
  { kind: "angle", label: "Angle", pattern: /\bangles?\b/i },
  { kind: "outline", label: "Outline", pattern: /\boutlines?\b/i },
  { kind: "title", label: "Title", pattern: /\btitles?\b/i },
  {
    kind: "opener",
    label: "Opener",
    pattern: /\b(?:openers?|opening\s+lines?)\b/i,
  },
];

const PARTIAL_KIND_MAX_ITEMS: Record<DirectPartialKind, number> = {
  hook: 20,
  title: 20,
  opener: 20,
  idea: 10,
  angle: 10,
  outline: 6,
};
const MAX_PARTIAL_FIELD_CELLS = 20;

function pairedPartialCount(
  instruction: string,
  matchIndex: number,
  matchedNoun: string,
): { found: boolean; value: number | null } {
  const prefix = instruction.slice(Math.max(0, matchIndex - 120), matchIndex);
  const match = prefix.match(
    new RegExp(
      String.raw`(?:exactly\s+)?(-?\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple|many|few|a\s+few|a\s+couple(?:\s+of)?|a|an|the)\s+(?:(?:different|distinct|new)\s+)?(?:linkedin\s+)?(?:post\s+)?$`,
      "i",
    ),
  );
  if (!match) {
    return {
      found: false,
      value: /s\b/i.test(matchedNoun) ? null : 1,
    };
  }
  const raw = match[1].toLowerCase().replace(/\s+/g, " ");
  if (raw === "a" || raw === "an" || raw === "the") {
    return { found: true, value: /s\b/i.test(matchedNoun) ? null : 1 };
  }
  if (!/^\d+$/.test(raw) && COUNT_WORDS[raw] === undefined) {
    return { found: true, value: null };
  }
  return { found: true, value: countValue(raw, 20) };
}

function splitFields(raw: string): string[] {
  return raw
    .replace(
      /\s+(?:labels?|fields?)\s+(?:plus|and\s+also)\s+/gi,
      ",",
    )
    .replace(/,?\s+(?:and(?:\s+also)?|plus|&)\s+/gi, ",")
    .split(",")
    .map((field) =>
      field
        .trim()
        .replace(/^(?:also\s+)?(?:a|an|the)\s+/i, "")
        .replace(/\s+(?:labels?|fields?)$/i, "")
        .replace(/[:;]+$/, "")
        .trim(),
    )
    .filter((field) => field.length > 0 && field.length <= 40)
    .slice(0, 8);
}

function naturalRequestedFields(instruction: string): string[] {
  const collected: string[] = [];
  const blockStart = instruction.match(/\beach\s+with\s*:\s*(?:\r?\n)/i);
  if (blockStart?.index !== undefined) {
    const remainder = instruction.slice(blockStart.index + blockStart[0].length);
    for (const line of remainder.split(/\r?\n/)) {
      const label = line.trim().match(/^([\p{L}][\p{L}\p{N} /&'-]{0,39}):\s*$/u)?.[1];
      if (!label) break;
      collected.push(label.trim());
    }
  }
  const patterns = [
    /\bwith\s+(.{1,120}?)\s+labels?\s+(?:for|on)\s+each\b/i,
    /\blabel\s+each(?:\s+(?:one|item))?\s+(?:with|using)\s+(.{1,120}?)(?:[.;]|$)/i,
    /\beach(?:\s+(?:one|item))?\s+labell?ed\s+(?:with|using)\s+(.{1,120}?)(?:[.;]|$)/i,
    /\buse\s+(.{1,120}?)\s+labels?\s+(?:for|on)\s+each\b/i,
    /\bfor\s+each(?:\s+(?:idea|angle|outline|title|hook|opener|opening\s+line))?\s*,?\s*(?:use|include|add)\s+(.{1,120}?)(?:\s+labels?)?(?:[.;]|$)/i,
    /\beach(?:\s+(?:idea|angle|outline|title|hook|opener|opening\s+line))?\s+with\s+(.{1,120}?[:][^\n]{0,100}?)(?:[.;]|$)/i,
    /\b(?:each|every(?:\s+(?:idea|angle|outline|title|hook|opener|opening\s+line))?)\s+(?:(?:must|should)\s+)?(?:have|include|use|needs?)\s+(.{1,120}?)\s+(?:labels?|fields?)(?:[.;]|$)/i,
    /\bput\s+(.{1,120}?)\s+(?:labels?|fields?)\s+on\s+(?:each|every)(?:\s+(?:idea|angle|outline|title|hook|opener|opening\s+line))?\b/i,
    /\b(?:include|add|put|use)\s+(?:a|an|the)?\s*(.{1,120}?)\s+(?:labels?|fields?)\s+on\s+(?:each|every)(?:\s+(?:idea|angle|outline|title|hook|opener|opening\s+line))?\b/i,
  ];
  for (const pattern of patterns) {
    const raw = instruction.match(pattern)?.[1];
    if (raw) collected.push(...splitFields(raw));
  }
  const beneath = instruction.match(
    /\b(?:add|include|with)\s+(?:a|an|the)?\s*(reason|rationale|why\s+it\s+works|explanation|takeaway|angle|hook|title|opener)\s+(?:(?:beneath|under|below)|for)\s+each\b/i,
  )?.[1];
  if (beneath) collected.push(beneath);
  return collected.filter(
    (field, index) =>
      collected.findIndex(
        (candidate) => candidate.toLowerCase() === field.toLowerCase(),
      ) === index,
  );
}

const RECOGNIZED_EXPLICIT_FIELD_CLAUSE_RES = [
  /\bwith\s+.{1,120}?\s+labels?\s+(?:for|on)\s+each\b/gi,
  /\blabel\s+each(?:\s+(?:one|item))?\s+(?:with|using)\s+.{1,120}?(?:[.;]|$)/gi,
  /\beach(?:\s+(?:one|item))?\s+labell?ed\s+(?:with|using)\s+.{1,120}?(?:[.;]|$)/gi,
  /\buse\s+.{1,120}?\s+labels?\s+(?:for|on)\s+each\b/gi,
  /\bfor\s+each(?:\s+(?:idea|angle|outline|title|hook|opener|opening\s+line))?\s*,?\s*(?:use|include|add)\s+.{1,120}?(?:labels?|fields?)(?:[.;]|$)/gi,
  /\b(?:each|every(?:\s+(?:idea|angle|outline|title|hook|opener|opening\s+line))?)\s+(?:(?:must|should)\s+)?(?:have|include|use|needs?)\s+.{1,120}?\s+(?:labels?|fields?)(?:[.;]|$)/gi,
  /\b(?:include|add|put|use)\s+(?:a|an|the)?\s*.{1,120}?\s+(?:labels?|fields?)\s+on\s+(?:each|every)(?:\s+(?:idea|angle|outline|title|hook|opener|opening\s+line))?\b/gi,
  /\binclude\s+(?:only|exactly(?:\s+these\s+fields)?)\s*:\s*[^\n.]+/gi,
];

function hasUnparsedExplicitFieldClause(instruction: string): boolean {
  const recognizedRanges = RECOGNIZED_EXPLICIT_FIELD_CLAUSE_RES.flatMap(
    (pattern) =>
      [...instruction.matchAll(pattern)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
      })),
  );
  return [...instruction.matchAll(/\b(?:labels?|fields?)\b/gi)].some(
    (match) =>
      !recognizedRanges.some(
        (range) => match.index >= range.start && match.index < range.end,
      ),
  );
}

function hasUnparsedFieldConstraint(instruction: string): boolean {
  return /\beach\s+with\s*:|\beach(?:\s+(?:one|item))?\s+labell?ed\b|\blabels?\s+(?:for|on)\s+each\b|\b(?:add|include|with)\s+[^.\n]{1,50}\s+(?:(?:beneath|under|below)|for)\s+each\b|\bfor\s+each(?:\s+\w+)?\s*,?\s*(?:use|include|add)\b|\beach(?:\s+\w+)?\s+with\s+[^.\n]{1,100}:|\b(?:each|every)\b[^.\n]{0,120}\b(?:labels?|fields?)\b|\b(?:labels?|fields?)\b[^.\n]{0,100}\b(?:each|every)\b/i.test(
    instruction,
  );
}

/** Compile one unambiguous partial-text request into an exact server contract. */
export function compileDirectPartialTextSpec(
  instruction: string,
): DirectPartialTextSpec | null {
  if (!PARTIAL_REQUEST_RE.test(instruction)) return null;
  if (UNSUPPORTED_PARTIAL_SHAPE_RE.test(instruction)) return null;
  const matches = PARTIAL_KIND_PATTERNS.flatMap((candidate) => {
    const match = instruction.match(candidate.pattern);
    return match?.index === undefined
      ? []
      : [{ ...candidate, index: match.index, matchedNoun: match[0] }];
  });
  if (matches.length !== 1) return null;

  const selected = matches[0];
  const derived = derivePartialTextContract(instruction);
  const pairedCount = pairedPartialCount(
    instruction,
    selected.index,
    selected.matchedNoun,
  );
  if (pairedCount.value === null) return null;
  const expectedCount = pairedCount.value;
  const naturalFields = naturalRequestedFields(instruction);
  if (hasUnparsedExplicitFieldClause(instruction)) return null;
  if (
    naturalFields.some((field) =>
      /\b(?:labels?|fields?|plus|and\s+also)\b/i.test(field),
    )
  ) {
    return null;
  }
  if (hasUnparsedFieldConstraint(instruction) && naturalFields.length === 0) {
    return null;
  }
  const requestedFields = [
    ...(derived?.requiredFields ?? []),
    ...naturalFields.filter(
      (field) =>
        !(derived?.requiredFields ?? []).some(
          (derivedField) =>
            derivedField.toLowerCase() === field.toLowerCase(),
        ),
    ),
  ];
  if (
    derived?.fieldsOnly &&
    !requestedFields.some(
      (field) => field.toLowerCase() === selected.label.toLowerCase(),
    )
  ) {
    return null;
  }
  const requiredFields = [
    selected.label,
    ...requestedFields.filter(
      (field) => field.toLowerCase() !== selected.label.toLowerCase(),
    ),
  ];
  if (expectedCount > PARTIAL_KIND_MAX_ITEMS[selected.kind]) return null;
  if (expectedCount * requiredFields.length > MAX_PARTIAL_FIELD_CELLS) {
    return null;
  }
  return {
    kind: selected.kind,
    label: selected.label,
    expectedCount,
    contract: {
      expectedCount,
      requiredFields,
      forbidFraming: true,
      fieldsOnly: derived?.fieldsOnly ?? false,
    },
  };
}

/**
 * A request for versions of one post component is never a full-post request.
 * Keep unsupported component kinds on the orchestrated lane instead of
 * silently upgrading them into complete post cards.
 */
export function requestsPartialTargetVariation(instruction: string): boolean {
  return PARTIAL_TARGET_VARIATION_RE.test(instruction);
}

const DIRECT_POST_COUNT_RE = new RegExp(
  String.raw`\b(?:write|draft|create|generate|make|produce|prepare|give\s+me|model|mimic|adapt|rewrite|rework|remix)\s+(?:me\s+)?(?:exactly\s+)?(${COUNT_TOKEN})\s+(?:(?:complete|finished|full|different|distinct|original|linkedin|regular|new|separate)\s+){0,4}(?:posts?|post\s+variations?|variations?|versions?|rewrites?)\b`,
  "i",
);

/** Return only a bounded, explicit full-post count; ambiguous prose is null. */
export function requestedDirectPostCount(instruction: string): number | null {
  if (requestsPartialTargetVariation(instruction)) return null;
  const match = instruction.match(DIRECT_POST_COUNT_RE);
  return countValue(match?.[1], 10);
}

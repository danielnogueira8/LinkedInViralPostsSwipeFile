import type { PostType } from "@/lib/post-type";

export const MAX_MODELED_POST_INTENT_CHARS = 8_192;

export type IntentCardinality =
  | { kind: "missing" }
  | { kind: "exact"; value: number }
  | { kind: "ambiguous"; values: number[] };

export type ModeledPostIntent =
  | { kind: "none" }
  | {
      kind: "ambiguous";
      reason:
        | "invalid_quantity"
        | "source_count"
        | "selection_count"
        | "output_count"
        | "mapping";
      discoveryCount: IntentCardinality;
      selectionCount: IntentCardinality;
      outputCount: IntentCardinality;
    }
  | {
      kind: "exact";
      relation: "one_to_one" | "shared_pool";
      expectedDrafts: number;
      minimumSources: number;
      discoveryCount: number | null;
      selectionCount: number | null;
      outputCount: number | null;
      sourcePostType?: PostType;
      outputPostType?: PostType;
    };

type Token = {
  value: string;
  start: number;
  end: number;
  clause: number;
  quoted: boolean;
};

type Scan = {
  tokens: Token[];
  unmatchedQuote: boolean;
};

type AnchorKind = "discover" | "select" | "produce" | "transform";

type CommandAnchor = {
  kind: AnchorKind;
  index: number;
};

type AnchorLookup = {
  prior: Array<CommandAnchor | null>;
  nextDiscovery: Array<CommandAnchor | null>;
};

type ParsedQuantity =
  | { kind: "missing" }
  | { kind: "exact"; value: number; index: number }
  | { kind: "ambiguous"; values: number[] }
  | { kind: "invalid"; values: number[] };

type SourceEvent = {
  kind: "source";
  headIndex: number;
  quantity: ParsedQuantity;
  plural: boolean;
  minimumHint: number;
  postType?: PostType;
  mappingUnit: boolean;
};

type SelectionEvent = {
  kind: "selection";
  index: number;
  quantity: ParsedQuantity;
};

type OutputEvent = {
  kind: "output";
  headIndex: number;
  quantity: ParsedQuantity;
  plural: boolean;
  postType?: PostType;
};

type MappingEvent = {
  kind: "mapping";
  index: number;
  outputHeadIndex: number | null;
  unitOutputHeadIndex: number | null;
  unsupported: boolean;
};

type IntentEvent =
  | SourceEvent
  | SelectionEvent
  | OutputEvent
  | MappingEvent;

type EventCompilation = {
  events: IntentEvent[];
  hasSourceContext: boolean;
  hasDiscoveryCommand: boolean;
  hasAffirmativeRelation: boolean;
  hasPotentialModeledCue: boolean;
  unmatchedQuote: boolean;
};

const COUNT_WORDS = new Map<string, number>([
  ["a", 1],
  ["an", 1],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
]);

const RECOGNIZED_QUANTITY_WORDS = new Map<string, number>([
  ["zero", 0],
  ...COUNT_WORDS,
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
  ["dozen", 12],
  ["hundred", 100],
  ["thousand", 1_000],
]);

const DISCOVERY_WORDS = new Set([
  "analyze",
  "analyzed",
  "analyzing",
  "browse",
  "browsed",
  "browsing",
  "compare",
  "compared",
  "comparing",
  "discover",
  "discovered",
  "discovering",
  "fetch",
  "fetched",
  "fetching",
  "find",
  "finding",
  "found",
  "get",
  "getting",
  "got",
  "grab",
  "grabbed",
  "grabbing",
  "identify",
  "identified",
  "identifying",
  "inspect",
  "inspected",
  "inspecting",
  "investigate",
  "investigated",
  "investigating",
  "list",
  "listed",
  "listing",
  "locate",
  "located",
  "locating",
  "look",
  "looking",
  "pull",
  "pulled",
  "pulling",
  "read",
  "reading",
  "research",
  "researched",
  "researching",
  "retrieve",
  "retrieved",
  "retrieving",
  "review",
  "reviewed",
  "reviewing",
  "scan",
  "scanned",
  "scanning",
  "search",
  "searched",
  "searching",
  "show",
  "showed",
  "showing",
  "surface",
  "surfaced",
  "surfacing",
  "take",
  "taken",
  "taking",
  "use",
  "used",
]);

const INITIAL_SELECTION_WORDS = new Set([
  "choose",
  "choosing",
  "chose",
  "chosen",
  "pick",
  "picked",
  "picking",
  "select",
  "selected",
  "selecting",
  "shortlist",
  "shortlisted",
  "shortlisting",
]);

const SELECTION_WORDS = new Set([
  ...INITIAL_SELECTION_WORDS,
  "keep",
  "keeping",
  "kept",
  "narrow",
  "narrowed",
  "narrowing",
]);

const OUTPUT_WORDS = new Set([
  "create",
  "created",
  "creating",
  "draft",
  "drafted",
  "drafting",
  "generate",
  "generated",
  "generating",
  "give",
  "giving",
  "gave",
  "make",
  "made",
  "making",
  "prepare",
  "prepared",
  "preparing",
  "produce",
  "produced",
  "producing",
  "write",
  "writing",
  "written",
  "wrote",
]);

const TRANSFORM_WORDS = new Set([
  "adapt",
  "adapted",
  "adapting",
  "base",
  "based",
  "basing",
  "emulate",
  "emulated",
  "emulating",
  "follow",
  "followed",
  "following",
  "inspire",
  "inspired",
  "inspiring",
  "mimic",
  "mimicked",
  "mimicking",
  "model",
  "modeled",
  "modeling",
  "modelled",
  "modelling",
  "remix",
  "remixed",
  "remixing",
  "replicate",
  "replicated",
  "replicating",
  "rework",
  "reworked",
  "reworking",
  "rewrite",
  "rewriting",
  "rewritten",
  "rewrote",
  "turn",
  "turned",
  "turning",
]);

const SOURCE_ONLY_ITEMS = new Set([
  "article",
  "articles",
  "document",
  "documents",
  "example",
  "examples",
  "file",
  "files",
  "source",
  "sources",
]);

const POST_ITEMS = new Set(["post", "posts"]);
const OUTPUT_ONLY_ITEMS = new Set([
  "draft",
  "drafts",
  "rewrite",
  "rewrites",
  "variation",
  "variations",
  "version",
  "versions",
]);

const SOURCE_CONTEXT_WORDS = new Set([
  "best",
  "best-performing",
  "bookmark",
  "bookmarks",
  "example",
  "examples",
  "high",
  "highest",
  "highest-engagement",
  "high-performing",
  "inspiration",
  "latest",
  "popular",
  "recent",
  "saved",
  "source",
  "sources",
  "swipe",
  "top",
  "top-performing",
  "tracked",
  "viral",
]);

const NON_EXACT_QUANTITY_WORDS = new Set([
  "about",
  "approximately",
  "around",
  "between",
  "circa",
  "fewer",
  "least",
  "less",
  "maximum",
  "minimum",
  "more",
  "roughly",
  "several",
  "some",
  "under",
  "up",
]);

const VAGUE_QUANTITY_WORDS = new Set([
  "few",
  "half",
  "handful",
  "most",
  "multiple",
  "several",
  "some",
]);

const SOURCE_RELATION_WORDS = new Set([
  "after",
  "by",
  "from",
  "on",
  "upon",
  "using",
]);

const TOPIC_BOUNDARY_WORDS = new Set([
  "about",
  "for",
  "in",
  "that",
  "where",
  "which",
  "who",
  "whose",
  "with",
]);

const DATA_CONTEXT_WORDS = new Set([
  "about",
  "called",
  "caption",
  "example",
  "headline",
  "hook",
  "phrase",
  "says",
  "text",
  "that",
  "title",
  "which",
  "who",
  "whose",
  "words",
]);

const TOPICAL_DISCOVERY_FRAMING_WORDS = new Set([
  "explaining",
  "helping",
  "showing",
  "teaching",
]);

const FORMAT_HEAD_WORDS = new Set([
  "cadence",
  "challenge",
  "format",
  "framework",
  "frequency",
  "hook",
  "schedule",
  "strategy",
  "structure",
  "style",
  "system",
  "template",
]);

const TRANSFORM_TARGET_WORDS = new Set([
  "each",
  "every",
  "format",
  "formats",
  "hook",
  "hooks",
  "it",
  "its",
  "one",
  "ones",
  "post",
  "posts",
  "rewrite",
  "rewrites",
  "structure",
  "structures",
  "style",
  "styles",
  "that",
  "their",
  "them",
  "these",
  "this",
  "those",
  "variation",
  "variations",
  "version",
  "versions",
]);

const STRUCTURAL_RELATION_WORDS = new Set([
  "based",
  "following",
  "inspired",
  "modeled",
  "modeling",
  "modelled",
  "modelling",
]);

const SOURCE_REFERENCE_WORDS = new Set([
  "after",
  "each",
  "format",
  "formats",
  "from",
  "hook",
  "hooks",
  "it",
  "its",
  "on",
  "source",
  "sources",
  "structure",
  "structures",
  "style",
  "styles",
  "their",
  "them",
  "these",
  "those",
  "using",
]);

const NEGATION_WORDS = new Set([
  "avoid",
  "avoiding",
  "dont",
  "don't",
  "don’t",
  "never",
  "not",
  "refrain",
  "refraining",
  "skip",
  "skipping",
  "without",
]);

const MALFORMED_PREFIXES = new Set([
  "#",
  "+",
  "-",
  "<",
  ">",
  "~",
  "±",
  "≤",
  "≥",
  "−",
  "–",
  "—",
]);

const COUNT_WINDOW = 12;
const COMMAND_WINDOW = 24;

function isWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

/** Linear tokenizer. Quoted spans remain data and never emit command events. */
function scanInstruction(instruction: string): Scan {
  const tokens: Token[] = [];
  let clause = 0;
  let index = 0;
  let lastVisible = "";
  let quoteMode: '"' | "'" | "curly-double" | "curly-single" | "`" | null =
    null;

  while (index < instruction.length) {
    const char = instruction[index];
    const closesQuote =
      (quoteMode === '"' && char === '"') ||
      (quoteMode === "'" && char === "'") ||
      (quoteMode === "curly-double" && char === "”") ||
      (quoteMode === "curly-single" && char === "’") ||
      (quoteMode === "`" && char === "`");
    if (closesQuote) {
      if (char === "`") {
        while (instruction[index + 1] === "`") index += 1;
      }
      quoteMode = null;
      lastVisible = char;
      index += 1;
      continue;
    }
    if (!quoteMode) {
      if (char === '"' || char === "“") {
        quoteMode = char === '"' ? '"' : "curly-double";
        lastVisible = char;
        index += 1;
        continue;
      }
      if (char === "‘") {
        quoteMode = "curly-single";
        lastVisible = char;
        index += 1;
        continue;
      }
      if (
        char === "'" &&
        !isWordCharacter(instruction[index - 1] ?? "") &&
        /\S/.test(instruction[index + 1] ?? "")
      ) {
        quoteMode = "'";
        lastVisible = char;
        index += 1;
        continue;
      }
      if (char === "`") {
        quoteMode = "`";
        while (instruction[index + 1] === "`") index += 1;
        lastVisible = char;
        index += 1;
        continue;
      }
    }
    if (isWordCharacter(char)) {
      const start = index;
      index += 1;
      while (index < instruction.length) {
        const candidate = instruction[index];
        if (isWordCharacter(candidate)) {
          index += 1;
          continue;
        }
        if (
          ["-", "'", "’"].includes(candidate) &&
          isWordCharacter(instruction[index - 1] ?? "") &&
          isWordCharacter(instruction[index + 1] ?? "")
        ) {
          index += 1;
          continue;
        }
        break;
      }
      tokens.push({
        value: instruction.slice(start, index).toLocaleLowerCase("en-US"),
        start,
        end: index,
        clause,
        quoted: quoteMode !== null,
      });
      lastVisible = instruction[index - 1] ?? lastVisible;
      continue;
    }
    if (!quoteMode) {
      if (/[.!?;]/.test(char) || (char === "\n" && lastVisible !== ":")) {
        clause += 1;
      }
    }
    if (!/\s/.test(char)) lastVisible = char;
    index += 1;
  }
  return { tokens, unmatchedQuote: quoteMode !== null };
}

function rawQuantityValue(value: string): number | null {
  const numeric = /^\d+$/.test(value) ? Number(value) : null;
  return numeric ?? RECOGNIZED_QUANTITY_WORDS.get(value) ?? null;
}

function gapBetween(instruction: string, left: Token, right: Token): string {
  return instruction.slice(left.end, right.start).trim().toLocaleLowerCase("en-US");
}

function malformedQuantityToken(instruction: string, token: Token): boolean {
  if (/^\d+(?:st|nd|rd|th)$/i.test(token.value)) return true;
  const parts = token.value.split("-");
  if (
    parts.length === 2 &&
    parts.every((part) => rawQuantityValue(part) !== null)
  ) {
    return true;
  }
  if (!/^\d+$/.test(token.value)) return false;
  const previous = instruction[token.start - 1] ?? "";
  const beforePrevious = instruction[token.start - 2] ?? "";
  const next = instruction[token.end] ?? "";
  const afterNext = instruction[token.end + 1] ?? "";
  return (
    MALFORMED_PREFIXES.has(previous) ||
    MALFORMED_PREFIXES.has(next) ||
    previous === "/" ||
    next === "/" ||
    ([".", ","].includes(previous) && /\d/.test(beforePrevious)) ||
    ([".", ","].includes(next) && /\d/.test(afterNext))
  );
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function parseQuantityBefore(
  instruction: string,
  tokens: Token[],
  headIndex: number,
  lowerBound: number,
): ParsedQuantity {
  const start = Math.max(lowerBound, headIndex - COUNT_WINDOW);
  const visible = tokens.slice(start, headIndex).filter((token) => !token.quoted);
  const malformed = visible.some((token) =>
    malformedQuantityToken(instruction, token),
  );
  let candidates = visible
    .map((token, offset) => ({
      index: start + offset,
      value: rawQuantityValue(token.value),
      token,
    }))
    .filter(
      (candidate): candidate is { index: number; value: number; token: Token } =>
        candidate.value !== null,
    );
  if (candidates.length > 1) {
    const withoutArticles = candidates.filter(
      (candidate) => !["a", "an"].includes(candidate.token.value),
    );
    if (withoutArticles.length > 0) candidates = withoutArticles;
  }
  if (malformed) {
    return { kind: "invalid", values: uniqueNumbers(candidates.map((item) => item.value)) };
  }
  if (candidates.length > 1) {
    const gaps = candidates.slice(1).map((candidate, index) =>
      gapBetween(instruction, candidates[index].token, candidate.token),
    );
    const multiplicative = gaps.some((gap) => /^(?:x|×|\*)$/.test(gap));
    return {
      kind: multiplicative ? "invalid" : "ambiguous",
      values: uniqueNumbers(candidates.map((item) => item.value)),
    };
  }
  const candidate = candidates[0];
  if (!candidate) {
    const coupleIndex = visible.findIndex((token) => token.value === "couple");
    if (coupleIndex >= 0) {
      return { kind: "exact", value: 2, index: start + coupleIndex };
    }
    if (visible.some((token) => VAGUE_QUANTITY_WORDS.has(token.value))) {
      return { kind: "ambiguous", values: [] };
    }
    const ordinal = visible.some((token) =>
      /^(?:\d+)(?:st|nd|rd|th)$/i.test(token.value),
    );
    return ordinal ? { kind: "invalid", values: [] } : { kind: "missing" };
  }
  const modifierStart = Math.max(start, candidate.index - 4);
  const modifiers = tokens
    .slice(modifierStart, candidate.index)
    .map((token) => token.value);
  const symbolPrefix = instruction
    .slice(Math.max(0, candidate.token.start - 2), candidate.token.start)
    .trim();
  if (
    modifiers.some((value) => ["minus", "negative"].includes(value)) ||
    MALFORMED_PREFIXES.has(symbolPrefix.at(-1) ?? "")
  ) {
    return { kind: "invalid", values: [candidate.value] };
  }
  if (
    modifiers.some((value) => NON_EXACT_QUANTITY_WORDS.has(value)) ||
    modifiers.some(
      (value, index) => value === "at" && modifiers[index + 1] === "most",
    ) ||
    modifiers.some(
      (value, index) =>
        value === "as" && modifiers[index + 1] === "many",
    )
  ) {
    return { kind: "ambiguous", values: [candidate.value] };
  }
  return { kind: "exact", value: candidate.value, index: candidate.index };
}

function isNegated(tokens: Token[], index: number): boolean {
  const token = tokens[index];
  const start = Math.max(0, index - 12);
  const before = tokens
    .slice(start, index)
    .filter((candidate) => candidate.clause === token.clause && !candidate.quoted)
    .map((candidate) => candidate.value);
  if (before.some((value) => NEGATION_WORDS.has(value))) return true;
  if (
    before.some(
      (value, offset) =>
        (value === "instead" && before[offset + 1] === "of") ||
        value === "except" ||
        (value === "rather" && before.slice(offset + 1).includes("than")) ||
        (["anything", "everything"].includes(value) &&
          before[offset + 1] === "but"),
    )
  ) {
    return true;
  }
  const after = tokens
    .slice(index + 1, index + 5)
    .filter((candidate) => candidate.clause === token.clause && !candidate.quoted)
    .map((candidate) => candidate.value);
  if (["neither", "no", "none", "nothing"].includes(after[0] ?? "")) {
    return true;
  }
  return after.some(
    (value, offset) =>
      value === "no" &&
      ["draft", "drafts", "one", "ones", "post", "posts", "them"].includes(
        after[offset + 1] ?? "",
      ),
  );
}

function nextValues(tokens: Token[], index: number, distance: number): string[] {
  const clause = tokens[index]?.clause;
  return tokens
    .slice(index + 1, index + 1 + distance)
    .filter((token) => token.clause === clause && !token.quoted)
    .map((token) => token.value);
}

function previousValues(tokens: Token[], index: number, distance: number): string[] {
  const clause = tokens[index]?.clause;
  return tokens
    .slice(Math.max(0, index - distance), index)
    .filter((token) => token.clause === clause && !token.quoted)
    .map((token) => token.value);
}

function hasOutputHead(values: string[]): boolean {
  return values.some(
    (value) => POST_ITEMS.has(value) || OUTPUT_ONLY_ITEMS.has(value),
  );
}

function isImperativeTransform(
  tokens: Token[],
  index: number,
  basicAnchors: CommandAnchor[],
): boolean {
  const token = tokens[index];
  if (
    token.quoted ||
    !TRANSFORM_WORDS.has(token.value) ||
    token.value === "inspiring" ||
    isNegated(tokens, index)
  ) {
    return false;
  }
  const preceding = previousValues(tokens, index, 14);
  const nearestBasic = [...basicAnchors]
    .reverse()
    .find(
      (anchor) =>
        anchor.index < index && index - anchor.index <= COMMAND_WINDOW,
    );
  const between = nearestBasic
    ? tokens
        .slice(nearestBasic.index + 1, index)
        .filter((candidate) => !candidate.quoted)
        .map((candidate) => candidate.value)
    : preceding;
  const lastCommandSeparator = Math.max(
    between.lastIndexOf("and"),
    between.lastIndexOf("then"),
  );
  const commandSegment = between.slice(lastCommandSeparator + 1);
  if (commandSegment.some((value) => DATA_CONTEXT_WORDS.has(value))) return false;

  const following = nextValues(tokens, index, 10);
  if (["turn", "turned", "turning"].includes(token.value)) {
    if (!hasOutputHead(following)) return false;
    if (following.some((value) => ["slide", "slides", "summary", "table"].includes(value))) {
      return false;
    }
  }
  const target = following.some((value) => TRANSFORM_TARGET_WORDS.has(value));
  const countedTarget = following.some((value) => rawQuantityValue(value) !== null);
  const terminalInfinitive = tokens[index - 1]?.value === "to";
  if (!target && !countedTarget && !terminalInfinitive) return false;

  if (!nearestBasic) return true;
  if (nearestBasic.kind === "produce") return false;
  const participial = [
    "based",
    "followed",
    "following",
    "inspired",
    "modeled",
    "modelled",
  ].includes(token.value);
  if (
    participial &&
    (between.some((value) => TRANSFORM_WORDS.has(value)) ||
      !between.some((value) => ["and", "then", "to"].includes(value))) &&
    tokens[nearestBasic.index].clause === token.clause
  ) {
    return false;
  }
  return true;
}

function compileAnchors(tokens: Token[]): CommandAnchor[] {
  const basic: CommandAnchor[] = [];
  let hasDiscovery = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.quoted || isNegated(tokens, index)) continue;
    if (DISCOVERY_WORDS.has(token.value)) {
      const prior = basic.at(-1);
      const between = prior
        ? tokens
            .slice(prior.index + 1, index)
            .filter((candidate) => candidate.clause === token.clause)
            .map((candidate) => candidate.value)
        : [];
      const separator = Math.max(
        between.lastIndexOf("and"),
        between.lastIndexOf("then"),
      );
      const currentSegment = between.slice(separator + 1);
      if (
        prior?.kind === "produce" &&
        tokens[prior.index].clause === token.clause &&
        currentSegment.some((value) =>
          TOPICAL_DISCOVERY_FRAMING_WORDS.has(value),
        )
      ) {
        continue;
      }
      basic.push({ kind: "discover", index });
      hasDiscovery = true;
      continue;
    }
    if (SELECTION_WORDS.has(token.value)) {
      const canStartDiscovery =
        INITIAL_SELECTION_WORDS.has(token.value) && !hasDiscovery;
      basic.push({ kind: canStartDiscovery ? "discover" : "select", index });
      if (canStartDiscovery) hasDiscovery = true;
      continue;
    }
    if (OUTPUT_WORDS.has(token.value)) {
      const prior = basic.at(-1);
      const between = prior
        ? tokens
            .slice(prior.index + 1, index)
            .filter((candidate) => candidate.clause === token.clause)
            .map((candidate) => candidate.value)
        : [];
      const separator = Math.max(
        between.lastIndexOf("and"),
        between.lastIndexOf("then"),
      );
      const segment = between.slice(separator + 1);
      if (
        prior &&
        tokens[prior.index].clause === token.clause &&
        segment.some((value) =>
          ["about", "called", "caption", "headline", "title", "which", "who", "whose"].includes(
            value,
          ),
        )
      ) {
        continue;
      }
      basic.push({ kind: "produce", index });
    }
  }
  const transforms: CommandAnchor[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (isImperativeTransform(tokens, index, basic)) {
      transforms.push({ kind: "transform", index });
    }
  }
  return [...basic, ...transforms].sort((left, right) => left.index - right.index);
}

function buildAnchorLookup(
  tokenLength: number,
  anchors: CommandAnchor[],
): AnchorLookup {
  const prior: Array<CommandAnchor | null> = Array(tokenLength).fill(null);
  const nextDiscovery: Array<CommandAnchor | null> = Array(tokenLength).fill(null);
  const anchorAt = new Map(anchors.map((anchor) => [anchor.index, anchor]));
  let previous: CommandAnchor | null = null;
  for (let index = 0; index < tokenLength; index += 1) {
    prior[index] =
      previous && index - previous.index <= COMMAND_WINDOW ? previous : null;
    previous = anchorAt.get(index) ?? previous;
  }
  let following: CommandAnchor | null = null;
  for (let index = tokenLength - 1; index >= 0; index -= 1) {
    nextDiscovery[index] =
      following && following.index - index <= 5 ? following : null;
    const anchor = anchorAt.get(index);
    if (anchor?.kind === "discover") following = anchor;
  }
  return { prior, nextDiscovery };
}

function lastRelationIndex(tokens: Token[], start: number, end: number): number {
  for (let index = end - 1; index >= start; index -= 1) {
    if (
      !tokens[index].quoted &&
      !isNegated(tokens, index) &&
      (SOURCE_RELATION_WORDS.has(tokens[index].value) ||
        STRUCTURAL_RELATION_WORDS.has(tokens[index].value) ||
        (tokens[index].value === "of" &&
          ["format", "formats", "style", "styles", "structure", "structures"].includes(
            tokens[index - 1]?.value ?? "",
          )))
    ) {
      return index;
    }
  }
  return -1;
}

function postTypeBetween(tokens: Token[], start: number, end: number): PostType | undefined {
  const values = tokens.slice(Math.max(0, start), end + 1).map((token) => token.value);
  const regular = values.includes("regular");
  const leadMagnet =
    values.includes("lead-magnet") ||
    values.some(
      (value, index) => value === "lead" && values[index + 1] === "magnet",
    );
  if (regular === leadMagnet) return undefined;
  return regular ? "regular" : "lead_magnet";
}

function isNominalModifier(tokens: Token[], headIndex: number): boolean {
  const value = tokens[headIndex].value;
  if (value === "source" && POST_ITEMS.has(tokens[headIndex + 1]?.value ?? "")) {
    return true;
  }
  return (
    POST_ITEMS.has(value) &&
    FORMAT_HEAD_WORDS.has(tokens[headIndex + 1]?.value ?? "")
  );
}

function sourceMinimumHint(tokens: Token[], headIndex: number): number {
  const values = previousValues(tokens, headIndex, 5);
  if (values.some((value) => ["few", "handful", "several"].includes(value))) {
    return 3;
  }
  if (values.includes("multiple") || tokens[headIndex].value.endsWith("s")) return 2;
  return 1;
}

function compileSourceEvents(
  instruction: string,
  tokens: Token[],
  anchors: CommandAnchor[],
  anchorLookup: AnchorLookup,
): SourceEvent[] {
  const events: SourceEvent[] = [];
  let previousSourceHead = -1;
  for (let headIndex = 0; headIndex < tokens.length; headIndex += 1) {
    const head = tokens[headIndex];
    if (
      head.quoted ||
      (!POST_ITEMS.has(head.value) && !SOURCE_ONLY_ITEMS.has(head.value)) ||
      isNominalModifier(tokens, headIndex) ||
      (head.value === "file" && tokens[headIndex - 1]?.value === "swipe") ||
      (["each", "every", "per", "selected"].includes(
        tokens[headIndex - 1]?.value ?? "",
      ) && !anchorLookup.nextDiscovery[headIndex])
    ) {
      continue;
    }
    const prior = anchorLookup.prior[headIndex];
    const followingDiscovery = anchorLookup.nextDiscovery[headIndex];
    const relationIndex = prior
      ? lastRelationIndex(tokens, prior.index + 1, headIndex)
      : lastRelationIndex(tokens, Math.max(0, headIndex - 12), headIndex);
    const relationContext = tokens
      .slice(
        relationIndex >= 0 ? relationIndex + 1 : Math.max(0, headIndex - 8),
        Math.min(tokens.length, headIndex + 5),
      )
      .map((candidate) => candidate.value);
    const explicitRelationSource =
      ["source", "sources"].includes(head.value) ||
      relationContext.some((value) =>
        [
          "best",
          "best-performing",
          "bookmark",
          "bookmarks",
          "saved",
          "swipe",
          "top",
          "top-performing",
          "tracked",
          "viral",
        ].includes(value),
      ) ||
      relationContext.some((value) => (rawQuantityValue(value) ?? 0) > 1);
    const governedByDiscovery = prior?.kind === "discover";
    const governedByRelation =
      relationIndex >= 0 &&
      explicitRelationSource &&
      (prior?.kind === "produce" || prior?.kind === "transform" || !prior);
    if (!governedByDiscovery && !followingDiscovery && !governedByRelation) {
      continue;
    }
    let lowerBound = governedByDiscovery ? (prior?.index ?? -1) + 1 : 0;
    if (relationIndex >= 0) lowerBound = Math.max(lowerBound, relationIndex + 1);
    if (previousSourceHead >= lowerBound) lowerBound = previousSourceHead + 1;
    const quantity = parseQuantityBefore(
      instruction,
      tokens,
      headIndex,
      lowerBound,
    );
    const normalizedQuantity =
      quantity.kind === "ambiguous" && quantity.values.length === 0
        ? ({ kind: "missing" } as const)
        : quantity;
    const followingRank = tokens[headIndex + 1];
    const sourceQuantity =
      followingRank &&
      rawQuantityValue(followingRank.value) !== null &&
      malformedQuantityToken(instruction, followingRank)
        ? ({
            kind: "invalid",
            values: [rawQuantityValue(followingRank.value) ?? 0] as number[],
          } satisfies ParsedQuantity)
        : normalizedQuantity;
    const surrounding = tokens
      .slice(Math.max(0, headIndex - 6), Math.min(tokens.length, headIndex + 7))
      .map((token) => token.value);
    const mappingUnit =
      sourceQuantity.kind === "exact" &&
      sourceQuantity.value === 1 &&
      surrounding.some((value) => ["each", "every"].includes(value)) &&
      surrounding.some((value) => ["using", "with"].includes(value));
    events.push({
      kind: "source",
      headIndex,
      quantity:
        sourceQuantity.kind === "missing" && !head.value.endsWith("s")
          ? { kind: "exact", value: 1, index: headIndex }
          : sourceQuantity,
      plural: head.value.endsWith("s"),
      minimumHint: sourceMinimumHint(tokens, headIndex),
      ...(postTypeBetween(tokens, lowerBound, headIndex)
        ? { postType: postTypeBetween(tokens, lowerBound, headIndex) }
        : {}),
      mappingUnit,
    });
    previousSourceHead = headIndex;
  }
  return events;
}

function resultPhraseLowerBound(
  tokens: Token[],
  anchor: CommandAnchor,
  headIndex: number,
): number {
  if (anchor.kind !== "transform") return anchor.index + 1;
  for (let index = headIndex - 1; index > anchor.index; index -= 1) {
    if (["as", "into"].includes(tokens[index].value)) return index + 1;
  }
  return anchor.index + 1;
}

function quantityOccursAfterTopicBoundary(
  tokens: Token[],
  anchorIndex: number,
  headIndex: number,
): boolean {
  const between = tokens.slice(anchorIndex + 1, headIndex).map((token) => token.value);
  return (
    between.some((value) => TOPIC_BOUNDARY_WORDS.has(value)) &&
    !between.some((value) => ["as", "into"].includes(value))
  );
}

function compileOutputEvents(
  instruction: string,
  tokens: Token[],
  anchors: CommandAnchor[],
  anchorLookup: AnchorLookup,
  sourceEvents: SourceEvent[],
): OutputEvent[] {
  const sourceHeads = new Set(sourceEvents.map((event) => event.headIndex));
  const events: OutputEvent[] = [];
  for (let headIndex = 0; headIndex < tokens.length; headIndex += 1) {
    const head = tokens[headIndex];
    if (
      head.quoted ||
      sourceHeads.has(headIndex) ||
      (!POST_ITEMS.has(head.value) && !OUTPUT_ONLY_ITEMS.has(head.value)) ||
      isNominalModifier(tokens, headIndex)
    ) {
      continue;
    }
    const anchor = anchorLookup.prior[headIndex];
    if (!anchor || !["produce", "transform"].includes(anchor.kind)) continue;
    const lowerBound = resultPhraseLowerBound(tokens, anchor, headIndex);
    const quantity = parseQuantityBefore(
      instruction,
      tokens,
      headIndex,
      lowerBound,
    );
    if (quantityOccursAfterTopicBoundary(tokens, anchor.index, headIndex)) continue;
    events.push({
      kind: "output",
      headIndex,
      quantity,
      plural: head.value.endsWith("s"),
      ...(postTypeBetween(tokens, lowerBound, headIndex)
        ? { postType: postTypeBetween(tokens, lowerBound, headIndex) }
        : {}),
    });
  }
  return events;
}

function nextAnchorIndex(anchors: CommandAnchor[], index: number, tokenLength: number): number {
  return anchors.find((anchor) => anchor.index > index)?.index ?? tokenLength;
}

function parseSelectionAfterAnchor(
  instruction: string,
  tokens: Token[],
  anchor: CommandAnchor,
  anchors: CommandAnchor[],
): ParsedQuantity | null {
  const end = Math.min(nextAnchorIndex(anchors, anchor.index, tokens.length), anchor.index + 12);
  const values = tokens.slice(anchor.index + 1, end).map((token) => token.value);
  if (values.includes("couple")) {
    return {
      kind: "exact",
      value: 2,
      index: anchor.index + 1 + values.indexOf("couple"),
    };
  }
  const temporal = values.some((value) =>
    ["based", "criteria", "days", "engagement", "last", "over"].includes(value),
  );
  const countIndexes = tokens
    .slice(anchor.index + 1, end)
    .map((token, offset) => ({ index: anchor.index + 1 + offset, value: rawQuantityValue(token.value) }))
    .filter(
      (item): item is { index: number; value: number } => item.value !== null,
    );
  const first = countIndexes[0];
  if (first && !temporal) {
    const syntheticHead: Token = {
      value: "posts",
      start: tokens[first.index].end,
      end: tokens[first.index].end,
      clause: tokens[first.index].clause,
      quoted: false,
    };
    const augmented = [...tokens.slice(0, first.index + 1), syntheticHead];
    return parseQuantityBefore(
      instruction,
      augmented,
      first.index + 1,
      anchor.index + 1,
    );
  }
  if (values.some((value) => VAGUE_QUANTITY_WORDS.has(value))) {
    return { kind: "ambiguous", values: [] };
  }
  if (values.includes("best") || values.includes("single")) {
    return { kind: "exact", value: 1, index: anchor.index };
  }
  return null;
}

function parseInlineSubset(
  instruction: string,
  tokens: Token[],
  anchor: CommandAnchor,
  outputEvents: OutputEvent[],
): ParsedQuantity | null {
  const end = Math.min(tokens.length, anchor.index + 10);
  const values = tokens.slice(anchor.index + 1, end).map((token) => token.value);
  if (values.some((value) => VAGUE_QUANTITY_WORDS.has(value))) {
    return values.some((value) => ["of", "them", "one", "ones"].includes(value))
      ? { kind: "ambiguous", values: [] }
      : null;
  }
  const firstCountOffset = values.findIndex((value) => rawQuantityValue(value) !== null);
  if (firstCountOffset < 0) return values.includes("both")
    ? { kind: "exact", value: 2, index: anchor.index + 1 + values.indexOf("both") }
    : null;
  const countIndex = anchor.index + 1 + firstCountOffset;
  const outputUsingCount = outputEvents.some(
    (event) =>
      event.quantity.kind === "exact" && event.quantity.index === countIndex,
  );
  if (outputUsingCount) return null;
  const tail = values.slice(firstCountOffset + 1, firstCountOffset + 5);
  const before = values.slice(0, firstCountOffset);
  const subset =
    tail.some((value) => ["it", "one", "ones", "them", "these", "those"].includes(value)) ||
    tail[0] === "of" ||
    before.some((value) => ["best", "only", "top"].includes(value));
  if (!subset) return null;
  const syntheticHead: Token = {
    value: "posts",
    start: tokens[countIndex].end,
    end: tokens[countIndex].end,
    clause: tokens[countIndex].clause,
    quoted: false,
  };
  const augmented = [...tokens.slice(0, countIndex + 1), syntheticHead];
  return parseQuantityBefore(
    instruction,
    augmented,
    countIndex + 1,
    anchor.index + 1,
  );
}

function compileSelectionEvents(
  instruction: string,
  tokens: Token[],
  anchors: CommandAnchor[],
  outputEvents: OutputEvent[],
): SelectionEvent[] {
  const events: SelectionEvent[] = [];
  for (const anchor of anchors) {
    const quantity =
      anchor.kind === "select"
        ? parseSelectionAfterAnchor(instruction, tokens, anchor, anchors)
        : anchor.kind === "transform"
          ? parseInlineSubset(instruction, tokens, anchor, outputEvents)
          : null;
    if (quantity) events.push({ kind: "selection", index: anchor.index, quantity });
  }
  return events;
}

function nearestOutputEvent(outputEvents: OutputEvent[], tokenIndex: number): OutputEvent | null {
  return (
    [...outputEvents]
      .filter((event) => Math.abs(event.headIndex - tokenIndex) <= 10)
      .sort(
        (left, right) =>
          Math.abs(left.headIndex - tokenIndex) -
          Math.abs(right.headIndex - tokenIndex),
      )[0] ?? null
  );
}

function compileMappingEvents(
  tokens: Token[],
  anchors: CommandAnchor[],
  sourceEvents: SourceEvent[],
  outputEvents: OutputEvent[],
): MappingEvent[] {
  const events: MappingEvent[] = [];
  const transformIndexes = new Set(
    anchors.filter((anchor) => anchor.kind === "transform").map((anchor) => anchor.index),
  );
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.quoted || isNegated(tokens, index)) continue;
    const previous = tokens[index - 1]?.value ?? "";
    const next = tokens[index + 1]?.value ?? "";
    const afterNext = tokens[index + 2]?.value ?? "";
    let explicit = false;
    if (token.value === "per" && ["post", "posts", "source", "sources"].includes(next)) {
      explicit = true;
    } else if (token.value === "apiece") {
      explicit = true;
    } else if (["each", "every"].includes(token.value)) {
      const precedingTransform = [...transformIndexes].some(
        (transformIndex) => transformIndex < index && index - transformIndex <= 3,
      );
      const sourceReferent =
        ["for", "from"].includes(previous) &&
        ["one", "post", "posts", "source", "sources", "selected"].includes(next);
      const directReferent = ["post", "posts", "source", "sources", "one"].includes(next);
      const outputToSource =
        ["using", "with"].includes(next) &&
        sourceEvents.some(
          (source) => source.headIndex > index && source.headIndex - index <= 8,
        );
      const eachOfSources =
        previous === "of" &&
        ["post", "posts", "source", "sources"].includes(afterNext);
      const ofEachOutput =
        previous === "of" &&
        outputEvents.some(
          (output) => output.headIndex < index && index - output.headIndex <= 5,
        );
      const nearModeledCommand = anchors.some(
        (anchor) =>
          ["produce", "transform"].includes(anchor.kind) &&
          Math.abs(anchor.index - index) <= 10,
      );
      explicit =
        nearModeledCommand &&
        (precedingTransform ||
          sourceReferent ||
          directReferent ||
          outputToSource ||
          eachOfSources ||
          ofEachOutput ||
          (["for", "from"].includes(previous) && sourceEvents.length > 0));
    }
    if (!explicit) continue;
    const output = nearestOutputEvent(outputEvents, index);
    let unitOutputHeadIndex: number | null = null;
    let unsupported = false;
    if (output?.quantity.kind === "exact") {
      const headDistance = Math.abs(index - output.headIndex);
      const mappingAfterHead = index > output.headIndex && headDistance <= 6;
      const mappingBeforeHead = index < output.headIndex && headDistance <= 8;
      const qualifiesAsUnit =
        token.value === "apiece" ||
        token.value === "per" ||
        previous === "of" ||
        ["for", "from"].includes(previous) ||
        (mappingBeforeHead && transformIndexes.size > 0);
      if (qualifiesAsUnit && (mappingAfterHead || mappingBeforeHead)) {
        const interveningValues = tokens
          .slice(
            Math.min(output.headIndex, index) + 1,
            Math.max(output.headIndex, index),
          )
          .map((candidate) => rawQuantityValue(candidate.value))
          .filter((value): value is number => value !== null);
        const standaloneUnit = interveningValues.at(-1) ?? null;
        if (standaloneUnit === 1 && mappingAfterHead) {
          unitOutputHeadIndex = null;
        } else if (standaloneUnit !== null && standaloneUnit !== 1) {
          unsupported = true;
        } else if (output.quantity.value === 1) {
          unitOutputHeadIndex = output.headIndex;
        } else {
          unsupported = true;
        }
      }
    }
    const mappingTail = tokens
      .slice(index + 1, Math.min(tokens.length, index + 9))
      .map((candidate) => candidate.value);
    if (
      mappingTail.includes("twice") ||
      mappingTail.some(
        (value, offset) =>
          (rawQuantityValue(value) ?? 0) > 1 &&
          mappingTail
            .slice(offset + 1, offset + 4)
            .some((candidate) =>
              ["times", "variations", "versions", "ways"].includes(candidate),
            ),
      )
    ) {
      unsupported = true;
    }
    const sourceMultiplier = sourceEvents.some((source) => {
      const values = tokens
        .slice(source.headIndex + 1, Math.min(tokens.length, source.headIndex + 8))
        .map((candidate) => candidate.value);
      return values.some(
        (value, offset) =>
          ["for", "from"].includes(value) &&
          values[offset + 1] === "each" &&
          values[offset + 2] === "of" &&
          rawQuantityValue(values[offset + 3] ?? "") !== null,
      );
    });
    events.push({
      kind: "mapping",
      index,
      outputHeadIndex: output?.headIndex ?? null,
      unitOutputHeadIndex,
      unsupported: unsupported || sourceMultiplier,
    });
  }
  return events;
}

function structuralRelationPresent(
  tokens: Token[],
  anchors: CommandAnchor[],
  sourceEvents: SourceEvent[],
): boolean {
  const sourceHeads = sourceEvents.map((event) => event.headIndex);
  if (
    sourceEvents.length > 0 &&
    tokens.some(
      (token, index) =>
        !token.quoted &&
        !isNegated(tokens, index) &&
        token.value === "as" &&
        tokens[index + 1]?.value === "inspiration",
    ) &&
    anchors.some((anchor) => anchor.kind === "produce")
  ) {
    return true;
  }
  for (const anchor of anchors) {
    if (anchor.kind === "transform") return true;
    if (anchor.kind !== "produce") continue;
    const end = Math.min(tokens.length, anchor.index + COMMAND_WINDOW);
    for (let index = anchor.index + 1; index < end; index += 1) {
      const token = tokens[index];
      if (token.quoted || isNegated(tokens, index)) continue;
      if (token.clause > tokens[anchor.index].clause + 1) break;
      const following = nextValues(tokens, index, 8);
      if (
        STRUCTURAL_RELATION_WORDS.has(token.value) &&
        (outputEventsNear(tokens, index) ||
          following.some((value) => SOURCE_REFERENCE_WORDS.has(value)) ||
          sourceHeads.some((headIndex) => headIndex > index && headIndex - index <= 12))
      ) {
        return true;
      }
      if (
        token.value === "in" &&
        tokens[index + 1]?.value === "their" &&
        ["format", "formats", "style", "styles", "structure", "structures"].includes(
          tokens[index + 2]?.value ?? "",
        )
      ) {
        return true;
      }
      if (
        ["format", "formats", "style", "styles", "structure", "structures"].includes(
          token.value,
        ) &&
        sourceHeads.some(
          (headIndex) => headIndex > index && headIndex - index <= 8,
        )
      ) {
        return true;
      }
      if (
        ["from", "using"].includes(token.value) &&
        sourceHeads.some((headIndex) => headIndex > index && headIndex - index <= 12)
      ) {
        return true;
      }
    }
  }
  return false;
}

function outputEventsNear(tokens: Token[], index: number): boolean {
  return tokens
    .slice(index + 1, index + 4)
    .some((token) => POST_ITEMS.has(token.value) || OUTPUT_ONLY_ITEMS.has(token.value));
}

function compileEvents(instruction: string): EventCompilation {
  const scan = scanInstruction(instruction);
  const { tokens } = scan;
  const anchors = compileAnchors(tokens);
  const anchorLookup = buildAnchorLookup(tokens.length, anchors);
  const sourceEvents = compileSourceEvents(
    instruction,
    tokens,
    anchors,
    anchorLookup,
  );
  const outputEvents = compileOutputEvents(
    instruction,
    tokens,
    anchors,
    anchorLookup,
    sourceEvents,
  );
  const selectionEvents = compileSelectionEvents(
    instruction,
    tokens,
    anchors,
    outputEvents,
  );
  const mappingEvents = compileMappingEvents(
    tokens,
    anchors,
    sourceEvents,
    outputEvents,
  );
  const structuralRelation = structuralRelationPresent(
    tokens,
    anchors,
    sourceEvents,
  );
  const hasSourceContext =
    sourceEvents.length > 0 ||
    tokens.some(
      (token) => !token.quoted && SOURCE_CONTEXT_WORDS.has(token.value),
    );
  // A source event is emitted only when governed by an explicit discovery
  // command, a relative discovery clause, or a typed source relation.
  const hasDiscoveryCommand = sourceEvents.length > 0;
  const hasAffirmativeRelation =
    structuralRelation || mappingEvents.length > 0;
  const hasPotentialModeledCue = tokens.some(
    (token, index) =>
      !token.quoted &&
      !isNegated(tokens, index) &&
      TRANSFORM_WORDS.has(token.value),
  );
  return {
    events: [
      ...sourceEvents,
      ...selectionEvents,
      ...outputEvents,
      ...mappingEvents,
    ],
    hasSourceContext,
    hasDiscoveryCommand,
    hasAffirmativeRelation,
    hasPotentialModeledCue,
    unmatchedQuote: scan.unmatchedQuote,
  };
}

function roleCardinality(
  events: Array<SourceEvent | SelectionEvent | OutputEvent>,
): { cardinality: IntentCardinality; invalid: boolean } {
  const exact = events
    .map((event) => event.quantity)
    .filter(
      (quantity): quantity is Extract<ParsedQuantity, { kind: "exact" }> =>
        quantity.kind === "exact",
    );
  const ambiguous = events.some((event) => event.quantity.kind === "ambiguous");
  const invalid = events.some((event) => event.quantity.kind === "invalid");
  const values = uniqueNumbers([
    ...exact.map((quantity) => quantity.value),
    ...events.flatMap((event) =>
      event.quantity.kind === "ambiguous" || event.quantity.kind === "invalid"
        ? event.quantity.values
        : [],
    ),
  ]);
  if (ambiguous || invalid || exact.length > 1 || values.length > 1) {
    return { cardinality: { kind: "ambiguous", values }, invalid };
  }
  if (exact.length === 1) {
    return { cardinality: { kind: "exact", value: exact[0].value }, invalid };
  }
  return { cardinality: { kind: "missing" }, invalid };
}

function cardinalityValue(cardinality: IntentCardinality): number | null {
  return cardinality.kind === "exact" ? cardinality.value : null;
}

function ambiguousIntent(
  reason: Extract<ModeledPostIntent, { kind: "ambiguous" }>["reason"],
  discoveryCount: IntentCardinality,
  selectionCount: IntentCardinality,
  outputCount: IntentCardinality,
): ModeledPostIntent {
  return { kind: "ambiguous", reason, discoveryCount, selectionCount, outputCount };
}

function uniquePostType(events: Array<SourceEvent | OutputEvent>): PostType | undefined {
  const values = [...new Set(events.flatMap((event) => event.postType ?? []))];
  return values.length === 1 ? values[0] : undefined;
}

/** Pure reduction from typed command events to the public cardinality contract. */
function reduceEvents(
  compilation: EventCompilation,
  draftCountOverride?: number,
): ModeledPostIntent {
  const sourceEvents = compilation.events.filter(
    (event): event is SourceEvent => event.kind === "source" && !event.mappingUnit,
  );
  const selectionEvents = compilation.events.filter(
    (event): event is SelectionEvent => event.kind === "selection",
  );
  const mappingEvents = compilation.events.filter(
    (event): event is MappingEvent => event.kind === "mapping",
  );
  const unitOutputHeads = new Set(
    mappingEvents.flatMap((event) =>
      event.unitOutputHeadIndex === null ? [] : [event.unitOutputHeadIndex],
    ),
  );
  const outputEvents = compilation.events.filter(
    (event): event is OutputEvent =>
      event.kind === "output" && !unitOutputHeads.has(event.headIndex),
  );
  const source = roleCardinality(sourceEvents);
  const selection = roleCardinality(selectionEvents);
  const parsedOutput = roleCardinality(outputEvents);
  const output =
    draftCountOverride !== undefined && !parsedOutput.invalid
      ? {
          cardinality: {
            kind: "exact" as const,
            value: draftCountOverride,
          },
          invalid: false,
        }
      : parsedOutput;
  const modeledRequest =
    compilation.hasSourceContext &&
    compilation.hasDiscoveryCommand &&
    compilation.hasAffirmativeRelation;
  if (!modeledRequest) {
    return compilation.unmatchedQuote &&
      compilation.hasSourceContext &&
      compilation.hasDiscoveryCommand &&
      compilation.hasPotentialModeledCue
      ? ambiguousIntent(
          "invalid_quantity",
          source.cardinality,
          selection.cardinality,
          output.cardinality,
        )
      : { kind: "none" };
  }
  if (
    compilation.unmatchedQuote ||
    source.invalid ||
    selection.invalid ||
    output.invalid
  ) {
    return ambiguousIntent(
      "invalid_quantity",
      source.cardinality,
      selection.cardinality,
      output.cardinality,
    );
  }
  if (source.cardinality.kind === "ambiguous") {
    return ambiguousIntent(
      "source_count",
      source.cardinality,
      selection.cardinality,
      output.cardinality,
    );
  }
  if (selection.cardinality.kind === "ambiguous") {
    return ambiguousIntent(
      "selection_count",
      source.cardinality,
      selection.cardinality,
      output.cardinality,
    );
  }
  if (output.cardinality.kind === "ambiguous") {
    return ambiguousIntent(
      "output_count",
      source.cardinality,
      selection.cardinality,
      output.cardinality,
    );
  }
  if (mappingEvents.some((event) => event.unsupported)) {
    return ambiguousIntent(
      "mapping",
      source.cardinality,
      selection.cardinality,
      output.cardinality,
    );
  }
  const sourceTypes = [...new Set(sourceEvents.flatMap((event) => event.postType ?? []))];
  const outputTypes = [...new Set(outputEvents.flatMap((event) => event.postType ?? []))];
  if (sourceTypes.length > 1 || outputTypes.length > 1) {
    return ambiguousIntent(
      "mapping",
      source.cardinality,
      selection.cardinality,
      output.cardinality,
    );
  }

  const discovered = cardinalityValue(source.cardinality);
  const selected = cardinalityValue(selection.cardinality);
  const outputTotal = cardinalityValue(output.cardinality);
  if (
    [discovered].some((value) => value !== null && (value < 1 || value > 10)) ||
    [selected, outputTotal].some(
      (value) => value !== null && (value < 1 || value > 5),
    )
  ) {
    return ambiguousIntent(
      "invalid_quantity",
      source.cardinality,
      selection.cardinality,
      output.cardinality,
    );
  }
  if (discovered !== null && selected !== null && selected > discovered) {
    return ambiguousIntent(
      "mapping",
      source.cardinality,
      selection.cardinality,
      output.cardinality,
    );
  }

  const distributive = mappingEvents.length > 0;
  const mappedCount = selected ?? discovered;
  let expectedDrafts: number | null;
  let relation: "one_to_one" | "shared_pool";
  if (distributive) {
    if (
      outputTotal !== null &&
      mappedCount !== null &&
      outputTotal !== mappedCount
    ) {
      return ambiguousIntent(
        "mapping",
        source.cardinality,
        selection.cardinality,
        output.cardinality,
      );
    }
    expectedDrafts = mappedCount ?? outputTotal;
    relation = "one_to_one";
  } else if (outputTotal !== null) {
    expectedDrafts = outputTotal;
    relation =
      mappedCount === null || mappedCount === outputTotal
        ? "one_to_one"
        : "shared_pool";
  } else {
    expectedDrafts = mappedCount;
    relation = "one_to_one";
  }

  if (expectedDrafts === null) {
    const pluralSource = sourceEvents.some((event) => event.plural);
    return pluralSource
      ? ambiguousIntent(
          "mapping",
          source.cardinality,
          selection.cardinality,
          output.cardinality,
        )
      : { kind: "none" };
  }
  if (expectedDrafts < 1 || expectedDrafts > 5) {
    return ambiguousIntent(
      "invalid_quantity",
      source.cardinality,
      selection.cardinality,
      output.cardinality,
    );
  }
  const minimumHint = sourceEvents.reduce(
    (maximum, event) => Math.max(maximum, event.minimumHint),
    0,
  );
  const minimumSources = Math.max(
    discovered ?? 0,
    selected ?? 0,
    minimumHint,
    relation === "one_to_one" ? expectedDrafts : 1,
  );
  return {
    kind: "exact",
    relation,
    expectedDrafts,
    minimumSources,
    discoveryCount: discovered,
    selectionCount: selected,
    outputCount: outputTotal,
    ...(uniquePostType(sourceEvents)
      ? { sourcePostType: uniquePostType(sourceEvents) }
      : {}),
    ...(uniquePostType(outputEvents)
      ? { outputPostType: uniquePostType(outputEvents) }
      : {}),
  };
}

function overlongInstructionLooksModeled(instruction: string): boolean {
  const normalized = instruction.toLocaleLowerCase("en-US");
  return (
    /\b(?:analyze|browse|choose|discover|fetch|find|locate|pull|read|research|retrieve|review|scan|search|select|surface|take|use)\b/.test(
      normalized,
    ) &&
    /\b(?:top|viral|best|swipe\s+file|bookmarks?|source\s+posts?|examples?)\b/.test(
      normalized,
    ) &&
    /\b(?:adapt|base|emulate|follow|inspire|mimic|model|remix|replicate|rewrite|rework|turn)\b/.test(
      normalized,
    )
  );
}

/**
 * Compile a server-selected modeled-post request into one bounded cardinality
 * contract. Quoted text is data; command, quantity, and mapping events are
 * immutable; unsupported mappings fail closed instead of borrowing a count
 * from another clause.
 */
export function compileModeledPostIntent(
  instruction: string,
  options: { draftCountOverride?: number } = {},
): ModeledPostIntent {
  if (!instruction.trim()) return { kind: "none" };
  if (instruction.length > MAX_MODELED_POST_INTENT_CHARS) {
    return overlongInstructionLooksModeled(instruction)
      ? ambiguousIntent(
          "invalid_quantity",
          { kind: "missing" },
          { kind: "missing" },
          { kind: "missing" },
        )
      : { kind: "none" };
  }
  return reduceEvents(
    compileEvents(instruction),
    options.draftCountOverride,
  );
}

/** Shared discovery vocabulary for generic and modeled source policies. */
export function explicitlyRequestsSourceDiscoveryIntent(text: string): boolean {
  if (!text.trim() || text.length > MAX_MODELED_POST_INTENT_CHARS) return false;
  const scan = scanInstruction(text);
  if (scan.unmatchedQuote) return false;
  const anchors = compileAnchors(scan.tokens);
  const sources = compileSourceEvents(
    text,
    scan.tokens,
    anchors,
    buildAnchorLookup(scan.tokens.length, anchors),
  );
  return (
    sources.length > 0 &&
    anchors.some((anchor) => anchor.kind === "discover")
  );
}

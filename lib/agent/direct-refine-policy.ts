import { splicePreservedBody } from "@/lib/hook-splice";
import type { RequestedCharacterRange } from "@/lib/agent/draft-output-policy";

export type DirectRefineFocus = "hook" | "cta" | "shorten" | "general";

const CTA_REFINE_RE =
  /\b(?:cta|call[ -]?to[ -]?action|closing|ending|last line|final line|sign[ -]?off)\b/i;
const HOOK_REFINE_RE =
  /\b(?:hook|opener|opening|first line|first sentence|lede|lead-in)\b/i;
const SHORTEN_REFINE_RE =
  /\b(?:shorten|shorter|trim|condense|concise|tighten\s+(?:it|this|(?:the\s+)?(?:post|body|whole|entire))|cut\s+(?:it|this|the\s+post|down)|reduce(?:\s+(?:it|this|the\s+post))?)\b|\b\d+(?:\.\d+)?\s*%\s*(?:shorter|less)\b/i;
const GENERAL_REWRITE_RE =
  /\b(?:rewrite|rework|revise|reshape|change|improve|polish)\s+(?:it|this|the\s+(?:post|body|whole|entire)|everything|the\s+(?:tone|voice|flow|structure))\b|\bmake\s+(?:it|this|the\s+(?:post|body|whole|entire))\s+(?:more|less)\s+(?:direct|story[ -]?driven|narrative|conversational|personal|punchy|engaging|clear|confident|contrarian|specific|practical|emotional)\b/i;
const SHORTEN_PERCENT_RES = [
  /\b(\d+(?:\.\d+)?)\s*(?:%|percent\b)\s*(?:shorter|less)\b/i,
  /\b(?:shorten|trim|reduce|cut|condense|tighten)(?:\s+(?:it|this|(?:the\s+)?(?:post|body|length)))?(?:\s+down)?\s+by\s+(\d+(?:\.\d+)?)\s*(?:%|percent\b)/i,
];
const LIGHT_SHORTEN_RE =
  /\b(?:slightly|lightly|gently|modestly|a\s+(?:little|bit))\b/i;
const COMPOUND_SEPARATOR_RE =
  /\b(?:as\s+well\s+as|along\s+with|together\s+with|and|also|plus|then|while|whilst|whereas|but)\b|[;:+]|\n+|,(?=\s+\p{L})|\.(?=\s+\p{L})|\s+[&/—–-]\s+/iu;
const BENIGN_PRESERVATION_CLAUSE_RE =
  /^(?:please\s+)?(?:(?:keep|leave|preserve|retain|maintain)\s+(?:(?:the|this|that|my|your|our|its|original|current|existing|same|core|main|all|other)\s+){0,3}(?:everything\s+else|rest|remainder|body|middle|ending|cta|post|argument|meaning|message|point|idea|voice|tone|style|facts?|details?|structure|format)(?:\s+of\s+(?:(?:the|this|that|current|original)\s+)?(?:post|body))?(?:\s+(?:unchanged|intact|the\s+same|as\s+is))?|(?:keep|maintain)\s+it\s+(?:in|with)\s+(?:(?:my|your|our|the|same)\s+)?(?:voice|tone|style)(?:\s+(?:unchanged|intact|the\s+same|as\s+is))?|(?:do\s+not|don(?:'|’)?t)\s+(?:(?:otherwise|materially|substantially)\s+)?(?:change|edit|rewrite|rework|alter|touch|remove|lose|drop|invent|add)\b.*|without\s+(?:(?:otherwise|materially|substantially)\s+)?(?:changing|editing|rewriting|reworking|altering|touching|removing|losing|dropping|inventing|adding)\b.*|(?:same|unchanged|intact|as\s+is)\b)[.!?]*$/i;
const EXACT_LINE_PRESERVATION_CLAUSE_RE =
  /^(?:please\s+)?(?:keep|leave|preserve|retain|maintain)\s+(?:the\s+)?exact\s+(?:final|last)\s+line(?:\s+exactly)?(?:\s+.+)?$/i;
const GENERAL_MODIFIER_CONTINUATION_RE =
  /^(?:more|less)\s+(?:direct|story[ -]?driven|narrative|conversational|personal|punchy|engaging|clear|confident|contrarian|specific|practical|emotional)[.!?]*$/i;
const COURTESY_CLAUSE_RE = /^(?:please|thanks?|thank\s+you)[.!?]*$/i;
const EXACT_HOOK_REPLACEMENT_RE =
  /^\s*(?:replace|change)\s+(?:only\s+)?(?:the\s+)?(?:opening|first)\s+(?:sentence|line|hook|opener)\s+(?:with|to)\s*:\s*(\S[\s\S]*?)\s*$/i;

export const MAX_DIRECT_SHORTEN_PERCENTAGE = 50;

/**
 * Return every independently actionable refine focus in an instruction.
 *
 * The direct lane owns exactly one deterministic preservation policy. If a
 * request asks for both a hook and CTA change, for example, choosing either
 * one would silently discard half the user's instruction. Those requests must
 * fail closed to the orchestrated baseline instead.
 */
export function directRefineFocusSignals(
  instruction: string,
): DirectRefineFocus[] {
  const clauses = COMPOUND_SEPARATOR_RE.test(instruction)
    ? instruction
        .split(new RegExp(COMPOUND_SEPARATOR_RE.source, "giu"))
        .map((clause) => clause.trim())
        .filter(Boolean)
    : [instruction];
  const actionableInstruction = clauses
    .filter(
      (clause) =>
        !BENIGN_PRESERVATION_CLAUSE_RE.test(clause) &&
        !EXACT_LINE_PRESERVATION_CLAUSE_RE.test(clause),
    )
    .join(" ");
  const signals: DirectRefineFocus[] = [];
  // Detect the requested element literally here. The older
  // isHookFocusedRefine helper deliberately suppresses hook detection when a
  // whole-post term is present; that is useful for its single splice policy,
  // but would hide compound requests such as "shorten the entire post and
  // tighten the hook" from this fail-closed router.
  if (HOOK_REFINE_RE.test(actionableInstruction)) signals.push("hook");
  if (CTA_REFINE_RE.test(actionableInstruction)) signals.push("cta");
  if (SHORTEN_REFINE_RE.test(actionableInstruction)) signals.push("shorten");
  if (GENERAL_REWRITE_RE.test(actionableInstruction)) signals.push("general");
  return signals;
}

/**
 * A recognized narrow edit must not hide a second edit that the classifier
 * does not understand. Every unknown compound clause fails closed unless it
 * is an explicitly benign preservation constraint such as "keep the rest
 * unchanged". A finite action-verb list would be fail-open: ordinary verbs
 * such as "weave" or gerunds such as "adding" would eventually slip through.
 */
export function hasUnrecognizedCompoundRefineClause(
  instruction: string,
): boolean {
  if (EXACT_HOOK_REPLACEMENT_RE.test(instruction)) return false;
  if (!COMPOUND_SEPARATOR_RE.test(instruction)) return false;
  const instructionSignals = directRefineFocusSignals(instruction);
  const clauses = instruction
    .split(new RegExp(COMPOUND_SEPARATOR_RE.source, "giu"))
    .map((clause) => clause.trim())
    .filter(Boolean);
  return clauses.some(
    (clause) =>
      directRefineFocusSignals(clause).length === 0 &&
      !BENIGN_PRESERVATION_CLAUSE_RE.test(clause) &&
      !EXACT_LINE_PRESERVATION_CLAUSE_RE.test(clause) &&
      !(
        instructionSignals.includes("general") &&
        GENERAL_MODIFIER_CONTINUATION_RE.test(clause)
      ) &&
      !COURTESY_CLAUSE_RE.test(clause),
  );
}

export function hasMixedDirectRefineFocuses(instruction: string): boolean {
  return (
    directRefineFocusSignals(instruction).length > 1 ||
    hasUnrecognizedCompoundRefineClause(instruction)
  );
}

export function isExclusiveHookRefine(instruction: string): boolean {
  const signals = directRefineFocusSignals(instruction);
  return (
    signals.length === 1 &&
    signals[0] === "hook" &&
    !hasUnrecognizedCompoundRefineClause(instruction)
  );
}

function explicitShortenPercentage(instruction: string): number | null {
  const raw = SHORTEN_PERCENT_RES
    .map((pattern) => instruction.match(pattern)?.[1])
    .find((value): value is string => Boolean(value));
  if (!raw) return null;
  const percentage = Number(raw);
  return Number.isFinite(percentage) ? percentage : null;
}

export function hasInvalidExplicitShortenPercentage(
  instruction: string,
): boolean {
  const percentage = explicitShortenPercentage(instruction);
  return percentage !== null && (percentage <= 0 || percentage >= 100);
}

export function hasUnsupportedDirectShortenPercentage(
  instruction: string,
): boolean {
  const percentage = explicitShortenPercentage(instruction);
  return percentage !== null && percentage > MAX_DIRECT_SHORTEN_PERCENTAGE;
}

export function requestedShortenReduction(instruction: string): number {
  const explicitPercentage = explicitShortenPercentage(instruction);
  if (
    explicitPercentage !== null &&
    explicitPercentage > 0 &&
    explicitPercentage < 100
  ) {
    return explicitPercentage / 100;
  }
  return LIGHT_SHORTEN_RE.test(instruction) ? 0.05 : 0.15;
}

export function classifyDirectRefineFocus(
  instruction: string,
): DirectRefineFocus {
  const [focus] = directRefineFocusSignals(instruction);
  if (focus) return focus;
  return "general";
}

function finalParagraphRange(body: string): {
  start: number;
  end: number;
  body: string;
} | null {
  const trailing = body.match(/\s*$/)?.[0].length ?? 0;
  const end = body.length - trailing;
  if (end <= 0) return null;
  const before = body.slice(0, end);
  const separator = [...before.matchAll(/\n[ \t]*\n/g)].at(-1);
  const start = separator?.index === undefined
    ? 0
    : separator.index + separator[0].length;
  const paragraph = body.slice(start, end).trim();
  return paragraph ? { start, end, body: paragraph } : null;
}

function replaceFinalParagraph(
  originalBody: string,
  candidateBody: string,
): { ok: true; body: string } | { ok: false; message: string } {
  const original = finalParagraphRange(originalBody);
  const candidate = finalParagraphRange(candidateBody);
  if (!original || !candidate) {
    return {
      ok: false,
      message:
        "The CTA revision did not contain a complete closing paragraph. Return the full post with a finished replacement CTA.",
    };
  }
  return {
    ok: true,
    body:
      originalBody.slice(0, original.start) +
      candidate.body +
      originalBody.slice(original.end),
  };
}

export function transformDirectRefineCandidate(input: {
  focus: DirectRefineFocus;
  instruction?: string;
  originalBody: string;
  candidateBody: string;
  characterRange?: RequestedCharacterRange | null;
}): { ok: true; body: string } {
  // Fail-open: the writer is instructed to produce a narrow revision, but if
  // the candidate does not perfectly fit the deterministic splice policy we
  // accept the best-effort result rather than rejecting the draft. The
  // finalizer still enforces the hard server character cap and validates the
  // artifact, so imperfect-but-usable revisions reach the user instead of
  // burning retries on dead-end structure gates.
  if (input.focus === "hook") {
    const exactReplacement = input.instruction
      ?.match(EXACT_HOOK_REPLACEMENT_RE)?.[1]
      ?.trim()
      .replace(/^(["'“‘])([\s\S]*)["'”’]$/, "$2");
    if (exactReplacement) {
      const original = input.originalBody;
      const sentenceEnd = original.search(/[.!?…](?=\s|$)/u);
      const lineEnd = original.indexOf("\n");
      const replacementEnd =
        sentenceEnd >= 0
          ? sentenceEnd + 1
          : lineEnd >= 0
            ? lineEnd
            : original.length;
      return {
        ok: true,
        body: `${exactReplacement}${original.slice(replacementEnd)}`,
      };
    }
    return {
      ok: true,
      body: splicePreservedBody(input.originalBody, input.candidateBody),
    };
  }
  if (input.focus === "cta") {
    const replaced = replaceFinalParagraph(
      input.originalBody,
      input.candidateBody,
    );
    return {
      ok: true,
      body: replaced.ok ? replaced.body : input.candidateBody,
    };
  }
  return { ok: true, body: input.candidateBody };
}

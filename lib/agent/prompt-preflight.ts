export type PromptPreflightReason =
  | "empty"
  | "overlong"
  | "junk"
  | "placeholder"
  | "injection_only";

export type PromptPreflightResult =
  | { ok: true }
  | {
      ok: false;
      reason: PromptPreflightReason;
      message: string;
      status: 400 | 413 | 422;
    };

const PLACEHOLDER_RE = /\[[a-z][a-z0-9 _/-]{1,48}\]/gi;
const MEANINGFUL_WORD_RE = /[\p{L}\p{N}]{2,}/u;
const INJECTION_ONLY_RE =
  /^(?:ignore|disregard|forget|override|reveal|print|show|dump|output|exfiltrate)\b[\s\S]{0,240}\b(?:previous|above|system|developer|instructions?|prompt|tools?|schemas?|secrets?|env|api keys?)\b[\s.!?]*$/i;

const FRIENDLY: Record<PromptPreflightReason, string> = {
  empty: "Type what you want me to write or change, then send it.",
  overlong:
    "That message is too long for one chat turn. Shorten it or attach the source as a file instead.",
  junk: "I need a little more direction before I can help. Tell me the topic, draft, or outcome you want.",
  placeholder:
    "Looks like this still has an unfilled placeholder. Replace the bracketed part first, then send it.",
  injection_only:
    "I can't help with requests to reveal or override internal instructions. Send the writing task you want help with instead.",
};

export const MAX_PROMPT_CHARS = 8000;

export function findUnfilledPlaceholders(text: string): string[] {
  const matches = text.match(PLACEHOLDER_RE) ?? [];
  return Array.from(new Set(matches.map((m) => m.trim()))).slice(0, 6);
}

export function preflightUserPrompt(input: string): PromptPreflightResult {
  const text = input.trim();
  if (!text) {
    return { ok: false, reason: "empty", message: FRIENDLY.empty, status: 400 };
  }

  if (text.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      reason: "overlong",
      message: FRIENDLY.overlong,
      status: 413,
    };
  }

  const placeholders = findUnfilledPlaceholders(text);
  if (placeholders.length > 0) {
    const listed = placeholders.join(", ");
    return {
      ok: false,
      reason: "placeholder",
      message: `${FRIENDLY.placeholder} Found: ${listed}`,
      status: 422,
    };
  }

  if (INJECTION_ONLY_RE.test(text)) {
    return {
      ok: false,
      reason: "injection_only",
      message: FRIENDLY.injection_only,
      status: 422,
    };
  }

  if (!MEANINGFUL_WORD_RE.test(text)) {
    return { ok: false, reason: "junk", message: FRIENDLY.junk, status: 422 };
  }

  return { ok: true };
}

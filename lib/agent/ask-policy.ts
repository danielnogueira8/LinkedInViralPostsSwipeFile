import type { AskQuestion } from "@/lib/agent/contracts";

const DONE_ISH_RE =
  /\b(we'?re\s+done|it'?s?\s+(all\s+)?good|they'?re\s+(all\s+)?good|looks?\s+(great|good|perfect)|nothing\s+(to\s+change|else)|all\s+(set|good|done)|i'?m\s+(good|happy|satisfied|done)|perfect|ship\s+it|good\s+to\s+go|no\s+changes?)\b|—\s*done\b|\bdone\b/i;
const PROCEED_ESCAPE_RE =
  /\b(your?\s+(best\s+)?(judge?ment|call|choice|discretion)|you\s+(decide|choose|pick)|whatever\s+you\s+(think|prefer|want)|surprise\s+me|up\s+to\s+you|dealer'?s\s+choice)\b/i;

const MAX_ASK_OPTIONS = 6;
const MAX_ASK_OPTION_LEN = 80;
const MAX_ASK_QUESTION_LEN = 240;
export const ASK_TOOL_NAME = "ask_user";

export function isProceedAskOption(text: string): boolean {
  return PROCEED_ESCAPE_RE.test(text);
}

export function isTerminalAskOption(text: string): boolean {
  return DONE_ISH_RE.test(text) && !isProceedAskOption(text);
}

export function recoverTerminalAskOption(
  options: string[],
  persisted: string | undefined,
): string | undefined {
  if (persisted && options.includes(persisted) && !isProceedAskOption(persisted)) {
    return persisted;
  }
  const terminal = options.filter(isTerminalAskOption);
  return terminal.length === 1 ? terminal[0] : undefined;
}

export function buildAskQuestion(
  parsedArgs: Record<string, unknown> | null,
): { ask: AskQuestion } | { error: string } {
  if (parsedArgs === null) {
    return { error: "ask_user arguments were not valid JSON." };
  }
  const question =
    typeof parsedArgs.question === "string" ? parsedArgs.question.trim() : "";
  if (!question) {
    return { error: 'ask_user requires a non-empty "question" string.' };
  }
  const rawOptions = Array.isArray(parsedArgs.options) ? parsedArgs.options : [];
  const options = rawOptions
    .map((option) => (typeof option === "string" ? option.trim() : ""))
    .filter((option) => option.length > 0)
    .slice(0, MAX_ASK_OPTIONS)
    .map((option) => option.slice(0, MAX_ASK_OPTION_LEN));
  if (options.length < 2) {
    return {
      error:
        'ask_user requires an "options" array of at least 2 short option labels.',
    };
  }
  const rawDone =
    typeof parsedArgs.doneOption === "string"
      ? parsedArgs.doneOption.trim().slice(0, MAX_ASK_OPTION_LEN)
      : undefined;
  const doneOption = recoverTerminalAskOption(options, rawDone);
  const multiSelect = parsedArgs.multiSelect === true;
  return {
    ask: {
      question: question.slice(0, MAX_ASK_QUESTION_LEN),
      options,
      allowOther: parsedArgs.allowOther !== false,
      ...(multiSelect ? { multiSelect: true } : {}),
      ...(doneOption ? { doneOption } : {}),
    },
  };
}

export function userNamedASpecificItem(text: string): boolean {
  if (!text || /\b(all|both|each|every)\b/i.test(text)) return false;
  const numbers = text.match(/\b\d{1,2}\b/g) ?? [];
  if (numbers.length > 1) return false;
  return /(?:\b(?:post|idea|hook|option|number|draft|one)\s*#?\s*\d{1,2}\b|#\s*\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\b)/i.test(
    text,
  );
}

// The user explicitly told the agent NOT to ask a clarifying question — e.g.
// "do not ask questions", "don't ask me anything", "no clarifying questions",
// "without asking", "just write it, no questions". Asking anyway is a direct
// instruction violation (distinct from asking on genuine ambiguity, which stays
// allowed). Deliberately narrow: it must be an imperative directed at asking, so
// an incidental mention like "write a post about asking better questions" or a
// standalone "no" does not trip it.
const NO_CLARIFICATION_RE =
  /\b(?:do\s*n[o']?t|don'?t|never|no\s+need\s+to|without|please\s+do\s*n[o']?t)\s+(?:\w+\s+){0,3}?ask\b|\bno\s+(?:clarify(?:ing)?|clarification|follow[-\s]?up)?\s*questions?\b|\b(?:no|zero|without)\s+clarif(?:ication|ying)\b|\bask\s+no\s+questions?\b|\bwithout\s+asking\b/i;

export function explicitlyForbidsClarification(text: string): boolean {
  return typeof text === "string" && NO_CLARIFICATION_RE.test(text);
}

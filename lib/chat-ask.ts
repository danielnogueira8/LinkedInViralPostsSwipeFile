import type { AskQuestion } from "@/lib/agent/contracts";
import { isTerminalAskOption } from "@/lib/agent/ask-policy";

export function composeAskAnswer(selected: string[], otherText: string): string {
  const parts = [...selected];
  const other = otherText.trim();
  if (other) parts.push(other);
  return parts.join("; ");
}

export function recoverDoneOption(
  options: string[],
  persistedDone: string | undefined,
): string | undefined {
  // Preserve an explicit persisted value for backward compatibility. Older
  // rows may intentionally mark the proceed escape as terminal; inference for
  // new/missing metadata remains strict and never promotes that option.
  if (persistedDone && options.includes(persistedDone)) return persistedDone;
  const terminal = options.filter(isTerminalAskOption);
  return terminal.length === 1 ? terminal[0] : undefined;
}

type PersistedToolCall = {
  function?: { name?: string; arguments?: string };
};

export function resolvePersistedTerminalAsk(
  toolCalls: PersistedToolCall[] | null | undefined,
  selectedOption: string,
): { terminalReason: "done" | "cancelled" } | null {
  const call = toolCalls?.find(
    (candidate) => candidate.function?.name === "ask_user",
  );
  if (!call?.function?.arguments) return null;

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {
    return null;
  }

  const options = Array.isArray(args.options)
    ? args.options.filter((option): option is string => typeof option === "string")
    : [];
  const persistedDone =
    typeof args.doneOption === "string" ? args.doneOption : undefined;
  const doneOption =
    args.actionLane === true
      ? persistedDone && options.includes(persistedDone)
        ? persistedDone
        : undefined
      : recoverDoneOption(options, persistedDone);
  if (!doneOption || selectedOption !== doneOption) return null;

  const selectedIndex = options.indexOf(selectedOption);
  const choiceIds = Array.isArray(args.choiceIds) ? args.choiceIds : [];
  return {
    terminalReason:
      choiceIds[selectedIndex] === "cancel" ||
      /^(cancel|never mind|stop)$/i.test(selectedOption.trim())
        ? "cancelled"
        : "done",
  };
}

type AskMessageCandidate = {
  id: string;
  role: "user" | "assistant";
  ask?: AskQuestion;
};

const PERSISTED_MESSAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPersistedChatMessageId(id: string): boolean {
  return PERSISTED_MESSAGE_ID_RE.test(id);
}

function sameOptionalArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

export function latestMatchingAskMessageId(
  messages: readonly AskMessageCandidate[],
  renderedAsk: AskQuestion,
): string | null {
  const latest = messages.at(-1);
  const ask = latest?.role === "assistant" ? latest.ask : undefined;
  if (!latest || !ask) return null;
  const matches =
    ask.question === renderedAsk.question &&
    sameOptionalArray(ask.options, renderedAsk.options) &&
    ask.allowOther === renderedAsk.allowOther &&
    ask.multiSelect === renderedAsk.multiSelect &&
    ask.targetCount === renderedAsk.targetCount &&
    ask.doneOption === renderedAsk.doneOption &&
    ask.variant === renderedAsk.variant &&
    sameOptionalArray(ask.questions, renderedAsk.questions) &&
    sameOptionalArray(ask.optionIds, renderedAsk.optionIds) &&
    sameOptionalArray(ask.choiceIds, renderedAsk.choiceIds);
  return matches ? latest.id : null;
}

export function isTerminalAskAnswer(text: string): boolean {
  return isTerminalAskOption(text);
}

export function resolveAskSubmission(
  ask: AskQuestion,
  selected: string[],
  otherText: string,
): { kind: "done" } | { kind: "send"; text: string } {
  const text = composeAskAnswer(selected, otherText);
  const isDone =
    Boolean(ask.doneOption) &&
    selected.length === 1 &&
    selected[0] === ask.doneOption &&
    !otherText.trim();
  return isDone ? { kind: "done" } : { kind: "send", text };
}

export function isAskSelectionComplete(
  ask: AskQuestion,
  selected: string[],
  otherText: string,
): boolean {
  if (!ask.targetCount) {
    return composeAskAnswer(selected, otherText).trim().length > 0;
  }
  return (
    !otherText.trim() &&
    new Set(selected).size === ask.targetCount &&
    selected.every((option) => ask.options.includes(option))
  );
}

// The interview card walks its questions locally and sends ONE message at the
// end. This composes that message: every question paired with its answer, in
// order, with unanswered ones marked so the executor can tell "passed on it"
// from "answered briefly" when it distils them into knowledge.
export const INTERVIEW_SKIPPED = "[skipped]";
// A completed interview can contain up to five answers. Ordinary Cowork
// messages stay capped at 8,000 characters, but the card submission is a
// structured source-material payload and needs room for all of its answers.
export const INTERVIEW_SUBMISSION_MAX_CHARS = 80_000;

export function composeInterviewAnswers(
  questions: string[],
  answers: string[],
): string {
  return questions
    .map(
      (question, index) =>
        `Q${index + 1}: ${question}\nA${index + 1}: ${
          answers[index]?.trim() || INTERVIEW_SKIPPED
        }`,
    )
    .join("\n\n");
}

export function toggleAskOption(
  ask: AskQuestion,
  selected: string[],
  option: string,
): string[] {
  if (selected.includes(option)) return selected.filter((item) => item !== option);
  if (!ask.multiSelect) return [option];
  if (ask.doneOption && option === ask.doneOption) return [option];
  if (ask.targetCount && selected.length >= ask.targetCount) return selected;
  return [...selected.filter((item) => item !== ask.doneOption), option];
}

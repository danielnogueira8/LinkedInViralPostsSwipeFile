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

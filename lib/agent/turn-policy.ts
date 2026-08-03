import type { Artifact } from "@/lib/agent/contracts";
import type { ChatMessage, ToolCall } from "@/lib/openrouter";
import {
  SKILLS,
  selectSkills,
  type Skill,
} from "@/lib/agent/skills";
import { findOpenSpecializedSkill } from "@/lib/agent/skill-continuation";
import { latestUserText, windowChatHistory } from "@/lib/agent/history";
import {
  isInterviewAskArgs,
  persistedAskRemainsPending,
  type ChatTerminalReason,
} from "@/lib/chat-ask-lifecycle";

export type TurnPolicy = {
  controlHistory: ChatMessage[];
  latestInstruction: string;
  skills: Skill[];
  allowsNewsSearch: boolean;
  requiresGroundedNewsSearch: boolean;
  newsSearchQuery: string;
};

const NEWS_SUBJECT_RE = /\b(?:news|headlines?|news stor(?:y|ies))\b/i;
const NEWS_DISCOVERY_RE =
  /\b(?:find|search|look\s+up|show|give|get|fetch|check|latest|fresh|recent|current|today|breaking|what(?:'s|\s+is|\s+are))\b/i;
const NEWSJACK_NAME_RE = /\bnews[ -]?jack(?:ing)?\b|\breact\s+to\s+(?:the\s+)?news\b/i;
const NEWS_EVENT_RE =
  /\b(?:funding\s+round|acquisition|layoffs?|launch(?:ed|es)?|announcement|announced)\b/i;
const NEWS_FRESHNESS_RE =
  /\b(?:latest|fresh|recent|current|today|this\s+week|breaking|trending|just|my\s+take\s+on)\b/i;
const DRAFT_ACTION_RE =
  /\b(?:write|draft|create|make|turn|adapt|post|react|take)\b/i;
const EXPLICIT_NON_NEWS_DRAFT_RE =
  /\b(?:normal|regular|evergreen)\s+(?:linkedin\s+)?post\b|\b(?:not|don't|do\s+not)\s+news[ -]?jack|\b(?:model|mimic|adapt)\b[\s\S]{0,80}\b(?:attached|source|post|template|draft)\b/i;

function explicitlyRequestsNewsjackDraft(instruction: string): boolean {
  return (
    NEWSJACK_NAME_RE.test(instruction) ||
    (NEWS_EVENT_RE.test(instruction) &&
      NEWS_FRESHNESS_RE.test(instruction) &&
      DRAFT_ACTION_RE.test(instruction))
  );
}

function explicitlyRequestsNewsSearch(instruction: string): boolean {
  return (
    NEWS_DISCOVERY_RE.test(instruction) &&
    (NEWS_SUBJECT_RE.test(instruction) ||
      (NEWS_EVENT_RE.test(instruction) && NEWS_FRESHNESS_RE.test(instruction)))
  );
}

function userInstruction(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.find((block) => block.type === "text")?.text ?? "";
}

/**
 * Reconstruct the control instruction for an answer to a turn-ending
 * clarification. The latest user row contains only the selected answer, so
 * classifying it alone loses the original deliverable (and can expose every
 * research tool to a plain topic choice). Only carry context from an ask-only
 * turn; an ask that followed render_post is an edit menu and must stay a refine.
 */
export function clarificationFollowupInstruction(
  history: ChatMessage[],
  currentAnswer: string,
): string {
  let latestUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return currentAnswer;

  let assistantIndex = -1;
  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    if (history[index].role === "tool") continue;
    if (history[index].role === "assistant") assistantIndex = index;
    break;
  }
  if (assistantIndex < 0) return currentAnswer;

  if (
    !persistedAskRemainsPending(
      history[assistantIndex].persisted_terminal_reason,
    )
  ) {
    return currentAnswer;
  }

  const calls = history[assistantIndex].tool_calls ?? [];
  const names = new Set(calls.map((call) => call.function.name));
  if (!names.has("ask_user") || names.has("render_post")) {
    return currentAnswer;
  }

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role !== "user") continue;
    const original = userInstruction(message).trim();
    const answer = currentAnswer.trim();
    if (!original || !answer || original === answer) return currentAnswer;
    return `${original}\n\nClarification answer: ${answer}`;
  }
  return currentAnswer;
}

/**
 * Preserve the structured AskCard long enough to reconstruct its answer, then
 * sanitize/window the transcript for the provider. Ask-only assistant rows do
 * not have a matching tool-result row, so protocol sanitization intentionally
 * removes their unmatched tool call. Reversing this order loses the original
 * request and turns a short topic answer into an unrestricted new turn.
 */
export function prepareClarificationTurn(
  history: ChatMessage[],
  currentAnswer: string,
): { history: ChatMessage[]; effectiveUserInstruction: string } {
  return {
    effectiveUserInstruction: clarificationFollowupInstruction(
      history,
      currentAnswer,
    ),
    history: windowChatHistory(history),
  };
}

/**
 * Inspect newest-first persisted rows while skipping tool results. The chat
 * persistence RPC timestamps tool rows after their assistant owner, so looking
 * only at the newest row would miss every persisted ask card.
 */
type PersistedAskCandidate = {
  role: ChatMessage["role"];
  tool_calls?: ToolCall[] | null;
  terminal_reason?: ChatTerminalReason | null;
};

export function hasPendingAskOnly(
  recentMessages: PersistedAskCandidate[],
): boolean {
  const latestNonTool = recentMessages.find(
    (message) => message.role !== "tool",
  );
  return latestNonTool ? isPendingAskMessage(latestNonTool) : false;
}

export function isPendingAskMessage(message: PersistedAskCandidate): boolean {
  if (message.role !== "assistant") return false;
  if (!persistedAskRemainsPending(message.terminal_reason)) return false;
  const names = new Set(
    (message.tool_calls ?? []).map((call) => call.function.name),
  );
  return (
    !names.has("render_post") &&
    (names.has("ask_user") || message.terminal_reason === "ask")
  );
}

export function hasPendingActionAsk(
  recentMessages: PersistedAskCandidate[],
): boolean {
  const ask = latestPendingAskCall(recentMessages);
  if (!ask) return false;
  try {
    const args = JSON.parse(ask.function.arguments) as Record<string, unknown>;
    return args.actionLane === true;
  } catch {
    return false;
  }
}

function latestPendingAskCall(
  recentMessages: PersistedAskCandidate[],
): ToolCall | undefined {
  const latestNonTool = recentMessages.find(
    (message) => message.role !== "tool",
  );
  if (latestNonTool?.role !== "assistant") return undefined;
  if (!persistedAskRemainsPending(latestNonTool.terminal_reason)) {
    return undefined;
  }
  return (latestNonTool.tool_calls ?? []).find(
    (call) => call.function.name === "ask_user",
  );
}

export function hasPendingInterviewAsk(
  recentMessages: PersistedAskCandidate[],
): boolean {
  const ask = latestPendingAskCall(recentMessages);
  if (!ask) return false;
  try {
    return isInterviewAskArgs(
      JSON.parse(ask.function.arguments) as Record<string, unknown>,
    );
  } catch {
    return false;
  }
}

export function hasUnsavedAssistantDraftReferent(
  recentMessages: Array<{
    role: ChatMessage["role"];
    artifacts?: Artifact[] | null;
  }>,
): boolean {
  const latestDraftMessage = recentMessages.find(
    (message) =>
      message.role === "assistant" &&
      message.artifacts?.some(
        (artifact) => artifact.kind === "post" || artifact.kind === "hook",
      ),
  );
  if (!latestDraftMessage) return false;
  const draftArtifacts = latestDraftMessage.artifacts?.filter(
    (artifact) => artifact.kind === "post" || artifact.kind === "hook",
  ) ?? [];
  return draftArtifacts.some((artifact) => {
    const boardDraftId = artifact.meta?.board_draft_id;
    return !(
      typeof boardDraftId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        boardDraftId,
      )
    );
  });
}

export function validatePendingActionAnswer(
  recentMessages: PersistedAskCandidate[],
  currentAnswer: string,
  actionSelectionIds: string[] = [],
):
  | { ok: true; selectedTargetIds?: string[]; cancelled?: boolean }
  | { ok: false; expected: number } {
  const ask = latestPendingAskCall(recentMessages);
  if (!ask) return { ok: true };
  try {
    const args = JSON.parse(ask.function.arguments) as Record<string, unknown>;
    if (args.actionLane !== true) return { ok: true };
    if (
      actionSelectionIds.length === 0 &&
      /^\s*(?:never\s*mind|cancel|stop|no\s+changes?|leave\s+it|don['’]t\s+(?:change|move|schedule|do)\s+(?:anything|it|them)|do\s+not\s+(?:change|move|schedule|do)\s+(?:anything|it|them))\s*[.!?]?$/i.test(
        currentAnswer,
      )
    ) {
      return { ok: true, cancelled: true };
    }
    const targetCount = args.targetCount;
    const options = Array.isArray(args.options)
      ? args.options.filter((option): option is string => typeof option === "string")
      : [];
    const candidateDraftIds = Array.isArray(args.candidateDraftIds)
      ? args.candidateDraftIds.filter(
          (draftId): draftId is string => typeof draftId === "string",
        )
      : [];
    if (candidateDraftIds.length === 0) return { ok: true };
    const expectedCount =
      typeof targetCount === "number" &&
      Number.isInteger(targetCount) &&
      targetCount >= 2
        ? targetCount
        : 1;
    if (
      candidateDraftIds.length !== options.length ||
      actionSelectionIds.length !== expectedCount ||
      new Set(actionSelectionIds).size !== expectedCount ||
      !actionSelectionIds.every((draftId) => candidateDraftIds.includes(draftId))
    ) {
      return { ok: false, expected: expectedCount };
    }
    return { ok: true, selectedTargetIds: actionSelectionIds };
  } catch {
    return { ok: false, expected: 2 };
  }
}

/**
 * Project the model-visible transcript onto its trusted control plane.
 *
 * ChatTurn deliberately places the user's typed instruction in the first text
 * block and appends sources, files, templates, and image descriptions as later
 * blocks. Those later blocks are data for generation, never authority for
 * skill selection, tool availability, or deterministic policy gates.
 */
export function controlHistoryForTurn(
  history: ChatMessage[],
  currentUserInstruction?: string,
): ChatMessage[] {
  let latestUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  return history.map((message, index) => {
    if (message.role !== "user") return message;
    const instruction =
      index === latestUserIndex && currentUserInstruction !== undefined
        ? currentUserInstruction
        : userInstruction(message);
    return { ...message, content: instruction };
  });
}

function newsSearchQuery(history: ChatMessage[]): string {
  const userTurns = history
    .filter((message) => message.role === "user")
    .slice(-3)
    .map((message) => userInstruction(message).trim())
    .filter(Boolean);
  const query = userTurns.join("\n");
  if (query.length <= 500) return query;

  const separators = Math.max(0, userTurns.length - 1);
  const perTurnLimit = Math.floor((500 - separators) / userTurns.length);
  return userTurns.map((text) => text.slice(0, perTurnLimit)).join("\n");
}

function selectTurnSkills(
  controlHistory: ChatMessage[],
  latestInstruction: string,
  hasExplicitDraftContext: boolean,
): Skill[] {
  const allLatest = selectSkills(latestInstruction, SKILLS.length);
  const hasOtherSpecialized = allLatest.some(
    (skill) => skill.specialized && skill.id !== "newsjacking",
  );
  const explicitNamedNewsjack = NEWSJACK_NAME_RE.test(latestInstruction);
  const allowsInferredNewsjack =
    !hasOtherSpecialized && explicitlyRequestsNewsjackDraft(latestInstruction);
  const latest = allLatest.filter(
    (skill) =>
      skill.id !== "newsjacking" ||
      explicitNamedNewsjack ||
      allowsInferredNewsjack,
  );
  if (latest.some((skill) => skill.specialized)) return latest.slice(0, 3);
  if (
    hasExplicitDraftContext ||
    EXPLICIT_NON_NEWS_DRAFT_RE.test(latestInstruction)
  ) {
    return latest.slice(0, 3);
  }

  const carried = findOpenSpecializedSkill(
    controlHistory.slice(0, -1),
    (skill, instruction) =>
      skill.id !== "newsjacking" ||
      explicitlyRequestsNewsjackDraft(instruction),
  );
  if (!carried) return latest.slice(0, 3);
  return [carried, ...latest.filter((skill) => skill.id !== carried.id)].slice(
    0,
    3,
  );
}

export function compileTurnPolicy(opts: {
  history: ChatMessage[];
  currentUserInstruction?: string;
  hasExplicitDraftContext?: boolean;
}): TurnPolicy {
  const controlHistory = controlHistoryForTurn(
    opts.history,
    opts.currentUserInstruction,
  );
  const latestInstruction = latestUserText(controlHistory);
  const skills = selectTurnSkills(
    controlHistory,
    latestInstruction,
    Boolean(opts.hasExplicitDraftContext),
  );
  const isNewsjackTurn = skills.some((skill) => skill.id === "newsjacking");
  const allowsNewsSearch =
    isNewsjackTurn || explicitlyRequestsNewsSearch(latestInstruction);
  const recentUserContext = controlHistory
    .filter((message) => message.role === "user")
    .slice(-3)
    .map(userInstruction)
    .join("\n");

  return {
    controlHistory,
    latestInstruction,
    skills,
    allowsNewsSearch,
    requiresGroundedNewsSearch:
      isNewsjackTurn && !/https?:\/\/\S+/i.test(recentUserContext),
    newsSearchQuery: newsSearchQuery(controlHistory),
  };
}

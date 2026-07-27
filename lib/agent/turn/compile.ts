import type { SupabaseClient } from "@supabase/supabase-js";
import {
  explicitlyForbidsSourceDiscovery,
  explicitlyForbidsWriting,
  explicitlyRequestsSourceDiscovery,
  requestsDurableOrAction,
  requestsDirectSourceModeling,
  requestsFullPostDeliverable,
} from "@/lib/agent/source-policy";
import {
  compileDirectPartialTextSpec,
  requestedDirectPostCount,
} from "@/lib/agent/direct-deliverable-policy";
import {
  isDirectFindAndModelEligible,
  isDirectFixedSourcePostEligible,
  isDirectLeadMagnetEligible,
  isDirectMultiPostEligible,
  isDirectOriginalPostEligible,
  isDirectPartialTextEligible,
  isDirectRefineEligible,
  isGeneralRefineEligible,
  isOpinionOrQuestionAboutContent,
  requiresLiveNewsOrResearch,
} from "@/lib/agent/direct-writer-policy";
import { classifyDirectRefineFocus } from "@/lib/agent/direct-refine-policy";
import {
  continuationForModeledDraftRoute,
  type ModeledDraftBatchContinuation,
} from "@/lib/agent/modeled-draft-continuation";
import { runTool } from "@/lib/agent/tools";
import { canonicalScrapedPostText } from "@/lib/agent/scraped-post-text";
import {
  compileModeledPostIntent,
  type ModeledPostIntent,
} from "@/lib/agent/modeled-post-intent";
import { wrapUntrustedXml } from "@/lib/agent/untrusted";
import type { Artifact, AskQuestion } from "@/lib/agent/contracts";
import type { PostType } from "@/lib/post-type";
import type { ComposerTaskContext } from "@/lib/composer-task-context";
import type { Source, WriterTask } from "@/lib/agent/execute/writer";
import type { CoworkRoute } from "@/lib/agent/cowork-telemetry";
import type { ModelSourceReference } from "@/lib/agent/turn/context";
import { MAX_GROUNDED_ANSWER_RESULTS } from "@/lib/agent/evidence";
import type { TurnCompileContext } from "@/lib/agent/turn/state";
import type {
  ActionOrchestratorRoute,
  ActionOrchestratorRoutingInput,
  ActionRequirement,
  BoardMoveStatus,
  TurnContract,
  TurnContractDirectTask,
} from "@/lib/agent/turn/protocol";
export type {
  ActionOrchestratorRoute,
  ActionOrchestratorRoutingInput,
  ActionRequirement,
  BoardMoveStatus,
  TurnContract,
  TurnContractDirectTask,
  TurnContractKind,
} from "@/lib/agent/turn/protocol";

export {
  resolveTurnCount,
  type TurnCountSource,
  type TurnDraftCount,
  MIN_TURN_DRAFT_COUNT,
  MAX_TURN_DRAFT_COUNT,
} from "./count";

/**
 * The ONE deliverable contract for a turn (PLAN-cowork-unification Phase 1,
 * step 3 COMPILE): the authoritative contract is resolved exactly once per
 * turn, AFTER clarification, from the same post-clarification instruction the
 * executors consume. The pre-claim path builds only a telemetry placeholder
 * through this same builder (never a divergent implementation) plus a
 * count-only estimate for the generation-config stamp and cost-reservation
 * headroom.
 */
/** Action orchestrator is part of the unified path; no rollout gating remains. */
export function actionOrchestratorEnabledForWorkspace(): boolean {
  return true;
}

function actionTurnContract(route: ActionOrchestratorRoute): TurnContract {
  return {
    kind: "saved_draft_action",
    expectedCount:
      route.kind === "action_management"
        ? route.targetCount * route.requirements.length
        : 0,
  };
}

function readOnlyTurnContract(route: ReadOnlyOrchestratorRoute): TurnContract {
  const canonicalRoute = canonicalizeReadOnlyOrchestratorRoute(route);
  return canonicalRoute.outcome?.kind === "draft"
    ? {
        kind: "post",
        expectedCount: canonicalRoute.outcome.expectedDrafts,
      }
    : { kind: "research", expectedCount: 1 };
}

/**
 * Resolve the turn's single deliverable contract. The priority mirrors the
 * executor that will actually serve the turn:
 *   direct writer > served action route > served read-only route >
 *   unrouted action route > unrouted read-only route > answer lane.
 * When none of the v2 executors claim the turn and the instruction is not a
 * post/partial/refine/source/action/research request, it resolves to the
 * deterministic "answer" contract (kind: "answer", expectedCount: 1).
 * `fallbackPostCount` is the post-clarification post count (UI override >
 * composer task count > refine default), null when the turn is not
 * post-shaped.
 */
export function resolveTurnContract(input: {
  directWriterTask?: TurnContractDirectTask | null;
  actionRoute?: ActionOrchestratorRoute | null;
  useActionOrchestrator?: boolean;
  readOnlyRoute?: ReadOnlyOrchestratorRoute | null;
  useReadOnlyOrchestrator?: boolean;
  hasPartialSpec?: boolean;
  fallbackPostCount?: number | null;
}): TurnContract {
  const directWriterTask = input.directWriterTask ?? null;
  if (directWriterTask) {
    if (directWriterTask.kind === "partial") {
      return { kind: "partial", expectedCount: 1 };
    }
    if (directWriterTask.kind === "multi") {
      return {
        kind: "post",
        expectedCount: directWriterTask.expectedCount ?? 1,
      };
    }
    return { kind: "post", expectedCount: 1 };
  }
  const actionContract = input.actionRoute
    ? actionTurnContract(input.actionRoute)
    : null;
  if (input.useActionOrchestrator && actionContract) return actionContract;
  const readOnlyContract = input.readOnlyRoute
    ? readOnlyTurnContract(input.readOnlyRoute)
    : null;
  if (input.useReadOnlyOrchestrator && readOnlyContract) {
    return readOnlyContract;
  }
  if (actionContract) return actionContract;
  if (readOnlyContract) return readOnlyContract;
  if (input.fallbackPostCount != null) {
    return { kind: "post", expectedCount: input.fallbackPostCount };
  }
  if (input.hasPartialSpec) return { kind: "partial", expectedCount: 1 };
  return { kind: "answer", expectedCount: 1 };
}

const DRAFT_REFERENCE_RE =
  /\b(?:drafts?|posts?|queue|board|it|this|that|one|these|those)\b/i;
const ACTION_COMMAND_WORDS =
  String.raw`(?:mark|move|set|put|change|advance|promote|shift|ready|schedule|reschedule|unschedule|plan|queue|publish|post|save|delete|remove|clear|cancel|unset|push|take|send)`;
const NEGATED_ACTION_RE = new RegExp(
  String.raw`(?:^\s*(?:(?:please|actually)\s+)?(?:don['’]t|do\s+not|never)\s+${ACTION_COMMAND_WORDS}\b)|` +
    String.raw`(?:^\s*(?:i|you|we)\s+(?:can['’]t|cannot|couldn['’]t|shouldn['’]t|wouldn['’]t|mustn['’]t|won['’]t)\s+${ACTION_COMMAND_WORDS}\b)|` +
    String.raw`(?:\b(?:no|none\s+of\s+the)\s+(?:drafts?|posts?)\b)|` +
    String.raw`(?:(?:—|--|,|;)\s*(?:actually\s*,?\s*)?(?:don['’]t|stop|cancel|never\s+mind)\s*[.!?]?\s*$)|` +
    String.raw`(?:\b${ACTION_COMMAND_WORDS}\b[^.!?]{0,80}\bnot\s+(?:to\s+|for\s+)?(?:idea|drafting|ready|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)`,
  "i",
);
const INFORMATIONAL_ACTION_RE =
  /^\s*(?:how\s+|which\s+|what\s+|where\s+|why\s+|(?:can|could|should|would|may)\s+(?:i|we)\b|do\s+i\b|is\s+it\s+possible\b|am\s+i\s+able\b)/i;

const COMMAND_PREFIX =
  String.raw`(?:^|[.;!?]\s*|,\s*(?:and|then|also)\s+|\band\s+then\s+|\b(?:to|as)\s+(?:idea|drafting|ready)\s+and\s+(?:then\s+)?)(?:(?:please\s+(?:just\s+)?|(?:can|could|would|will)\s+you\s+(?:(?:please|kindly|just)\s+){0,2}|i\s+(?:want|need)\s+(?:you\s+)?to\s+|i(?:['’]d|\s+would)\s+like\s+(?:you\s+)?to\s+))?`;

function hasCommand(instruction: string, verbs: string): boolean {
  return new RegExp(`${COMMAND_PREFIX}(?:${verbs})\\b`, "i").test(instruction);
}

function hasLikelyBoardMoveCommand(instruction: string): boolean {
  if (!/\b(?:to|into|as)\s+(?:idea|drafting|ready)\b/i.test(instruction)) {
    return false;
  }
  return new RegExp(
    String.raw`${COMMAND_PREFIX}[A-Za-z][A-Za-z0-9'’_-]*\b[\s\S]{0,180}\b(?:drafts?|posts?|it|this|that|one)\b`,
    "i",
  ).test(instruction);
}

function requestsNewPost(instruction: string): boolean {
  // A content-generation request — the model writes NEW post(s), whether from
  // scratch ("write"), from a source ("rewrite / model / adapt / mimic"), or by
  // discovering sources first ("find … posts … and rewrite"). None of these is
  // a board mutation; they belong to the drafting / read-only-orchestrator
  // lanes. Matched here so the action lane never claims them (the "find 4 top
  // posts and rewrite them → How many saved drafts should I update?" bug).
  const contentVerb =
    "write|draft|create|generate|make|produce|prepare|give\\s+me|rewrite|rework|remix|model|mimic|adapt";
  if (
    hasCommand(instruction, contentVerb) &&
    /\b(?:linkedin\s+)?posts?\b/i.test(instruction)
  ) {
    return true;
  }
  // "Find/search/pull N … posts … and rewrite/model/… them" — swipe-file
  // discovery feeding a content rewrite. `hasCommand` anchors to a clause
  // start, so a mid-sentence "and rewrite" is caught by this pattern instead.
  return (
    /\b(?:find|search|pull|look\s+for|get)\b[\s\S]{0,120}\b(?:linkedin\s+)?posts?\b/i.test(
      instruction,
    ) &&
    /\b(?:rewrite|rework|remix|model|mimic|adapt|write|draft|create|turn\s+(?:it|them|these|those)\s+into)\b/i.test(
      instruction,
    )
  );
}

function isInformationalQuestion(instruction: string): boolean {
  if (INFORMATIONAL_ACTION_RE.test(instruction)) return true;
  if (!/\?\s*$/.test(instruction)) return false;
  return !(
    hasCommand(instruction, ACTION_COMMAND_WORDS) ||
    hasLikelyBoardMoveCommand(instruction)
  );
}

function clearsSchedule(instruction: string): boolean {
  return (
    hasCommand(instruction, "clear|remove|unset") &&
    /\b(?:planned\s+dates?|plan\s+dates?|board\s+plans?)\b/i.test(instruction)
  );
}

function wantsSchedule(instruction: string): boolean {
  if (hasCommand(instruction, "schedule|plan|queue")) return true;
  return (
    hasCommand(instruction, "set|put") &&
    /\b(?:for|on)\s+(?:this\s+)?(?:\d{4}-\d{2}-\d{2}|today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(
      instruction,
    )
  );
}

function isDateBearingSetPutSchedule(instruction: string): boolean {
  return (
    hasCommand(instruction, "set|put") &&
    /\b(?:for|on)\s+(?:this\s+)?(?:\d{4}-\d{2}-\d{2}|today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(
      instruction,
    )
  );
}

export function explicitBoardDestinationStatuses(
  instruction: string,
): Array<BoardMoveStatus | "posted"> {
  const dateClause = instruction.match(
    /\b(?:for|on)\s+(?:this\s+)?(?:\d{4}-\d{2}-\d{2}|today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
  );
  const beforeDate = instruction.slice(0, dateClause?.index ?? instruction.length);
  const quotedRanges = [
    ...beforeDate.matchAll(/["“][^"”]*["”]/gu),
  ].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const dateBearingSetPut = isDateBearingSetPutSchedule(instruction);
  const destinations = [
    ...beforeDate.matchAll(
      /\b(?:to|into|as)\s+(idea|drafting|ready|posted)\b/giu,
    ),
  ];
  return destinations.flatMap((destination) => {
    const start = destination.index ?? 0;
    if (
      quotedRanges.some((range) => start >= range.start && start < range.end)
    ) {
      return [];
    }
    const beforeDestination = beforeDate.slice(0, start);
    const afterDestination = beforeDate.slice(start + destination[0].length);
    const laterTarget = afterDestination.match(/\b(?:drafts?|posts?)\b/i);
    if (laterTarget) {
      const beforeLaterTarget = afterDestination.slice(0, laterTarget.index ?? 0);
      if (
        !/\b(?:and|then)\s+(?:schedule|plan|queue)\b/i.test(
          beforeLaterTarget,
        )
      ) {
        return [];
      }
    }
    const nounBeforeCommand = beforeDestination.match(
      new RegExp(
        `${COMMAND_PREFIX}(?:mark|move|set|put|change|advance|promote|shift|ready|push|take|send)\\s+(?:(?:the|my|a|an|saved|latest|this|that)\\s+)*(?:draft|post)\\b`,
        "i",
      ),
    );
    const targetReferences = [
      ...beforeDestination.matchAll(/\b(?:drafts?|posts?|it|this|that|one)\b/giu),
    ];
    const nearestTarget = targetReferences[targetReferences.length - 1];
    if (nounBeforeCommand?.index === 0 || nearestTarget) {
      const targetEnd =
        nounBeforeCommand?.index === 0
          ? nounBeforeCommand[0].length
          : (nearestTarget?.index ?? 0) + (nearestTarget?.[0].length ?? 0);
      const titleOrSource = beforeDestination
        .slice(targetEnd)
        .trim();
      if (titleOrSource) {
        const quotedTitle = /^["“][\s\S]*["”]$/u.test(titleOrSource);
        const explicitSourceStatus =
          /^from\s+(?:idea|drafting|ready|posted)$/i.test(titleOrSource);
        if (
          !quotedTitle &&
          (dateBearingSetPut || !explicitSourceStatus)
        ) {
          return [];
        }
      }
    }
    const simpleDestinationCommand =
      /^\s*(?:mark|move|set|put|change|advance|promote|shift|ready|push|take|send)\s*(?:it|this|that|one)?\s*$/i.test(
        beforeDestination,
      );
    if (
      !simpleDestinationCommand &&
      !/\b(?:drafts?|posts?|it|this|that|one)\b/i.test(beforeDestination)
    ) {
      return [];
    }
    return [
      destination[1].toLocaleLowerCase("en-US") as
        | BoardMoveStatus
        | "posted",
    ];
  });
}

function hasExplicitBoardDestination(instruction: string): boolean {
  return explicitBoardDestinationStatuses(instruction).length > 0;
}

function changesPublishingSchedule(instruction: string): boolean {
  return (
    hasCommand(instruction, "unschedule|reschedule") ||
    (hasCommand(instruction, "cancel|clear|remove|unset") &&
      /\bschedule\b/i.test(instruction) &&
      !/\b(?:planned\s+date|plan\s+date|board\s+plan)\b/i.test(instruction))
  );
}

const COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
};

function requestedTargetCount(
  instruction: string,
):
  | { kind: "ok"; count: number }
  | { kind: "clarify" }
  | { kind: "mixed" } {
  const clarificationMatch = instruction.match(
    /\bClarification answer:\s*([\s\S]+)$/i,
  );
  const originalInstruction = clarificationMatch
    ? instruction.slice(0, clarificationMatch.index ?? instruction.length).trim()
    : instruction;
  const explicitMatches = [
    ...originalInstruction.matchAll(
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b[\s\S]{0,40}?\b(?:drafts|posts)\b/giu,
    ),
    ...originalInstruction.matchAll(/\b(one|1)\s+(?:draft|post)\b/giu),
    ...originalInstruction.matchAll(
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+of\s+(?:them|these|those)\b/giu,
    ),
  ];
  const perItemTarget = originalInstruction.match(
    /\b(?:mark|move|set|put|change|advance|promote|shift|ready|schedule|plan|queue|clear|remove|unset)\s+(.+?)\s+(?:(?:to|into|as)\s+(?:idea|drafting|ready|posted)|(?:for|on)\s+(?:this\s+)?(?:\d{4}-\d{2}-\d{2}|today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/iu,
  )?.[1];
  const perItemCount = perItemTarget
    ? perItemTarget
        .split(/\s*,\s*(?:and\s+)?|\s+and\s+/iu)
        .filter((part) => /\b(?:draft|post)s?\b/i.test(part)).length
    : 0;
  const clearTarget = originalInstruction.match(
    /\b(?:clear|remove|unset)\s+(?:(?:the|my)\s+)?(?:(?:planned|plan)\s+dates?|board\s+plans?)\s+from\s+(.+?)[.!?]?$/iu,
  )?.[1];
  const clearPerItemCount = clearTarget
    ? clearTarget
        .split(/\s*,\s*(?:and\s+)?|\s+and\s+/iu)
        .filter((part) => /\b(?:draft|post)s?\b/i.test(part)).length
    : 0;
  const explicit = explicitMatches
    .map((match) => {
      const raw = match[1].toLocaleLowerCase("en-US");
      return Number(raw) || COUNT_WORDS[raw] || 4;
    })
    .concat(
      perItemCount >= 2 || clearPerItemCount >= 2
        ? []
        : [
            ...originalInstruction.matchAll(
              /\b(?:this|that|the|my|a|an)\s+(?:[\p{L}\p{N}'’_-]+\s+){0,9}(?:draft|post)\b/giu,
            ),
          ].map(() => 1),
    );
  if (perItemCount >= 2) explicit.push(perItemCount <= 3 ? perItemCount : 4);
  if (clearPerItemCount >= 2) {
    explicit.push(clearPerItemCount <= 3 ? clearPerItemCount : 4);
  }
  for (const match of originalInstruction.matchAll(
    /\b(?:mark|move|set|put|change|advance|promote|shift|ready|schedule|plan|queue|clear|remove|unset)\s+(?:this|that|it|one)\b/giu,
  )) {
    if (match[0]) explicit.push(1);
  }
  for (const match of originalInstruction.matchAll(
    /\b(?:mark|move|set|put|change|advance|promote|shift|ready|schedule|plan|queue|clear|remove|unset)\s+(?:the|my)\s+([^.!?]{1,120}?)\s+(?:drafts|posts)\b/giu,
  )) {
    const names = match[1]
      .split(/\s*,\s*(?:and\s+)?|\s+and\s+/iu)
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length >= 2 && names.length <= 3) explicit.push(names.length);
    if (names.length > 3) explicit.push(4);
  }
  if (new Set(explicit).size > 1) return { kind: "mixed" };
  const originalNeedsClarification =
    explicit.some((count) => count < 1 || count > 3) ||
    (explicit.length === 0 && /\b(?:all|these|those)\b/i.test(originalInstruction));
  if (originalNeedsClarification && clarificationMatch) {
    const clarified = [
      ...clarificationMatch[1].matchAll(/\b(one|two|three|[1-3])\b/giu),
    ].map((match) => Number(match[1]) || COUNT_WORDS[match[1].toLowerCase()]);
    if (clarified.length > 0 && new Set(clarified).size === 1) {
      return { kind: "ok", count: clarified[0] };
    }
  }
  if (originalNeedsClarification) return { kind: "clarify" };
  if (explicit.length > 0) return { kind: "ok", count: explicit[0] };
  if (/\bboth\b/i.test(originalInstruction)) return { kind: "ok", count: 2 };
  return { kind: "ok", count: 1 };
}

function requestedMoveStatus(
  instruction: string,
): BoardMoveStatus | "posted" | "ambiguous" | undefined {
  const moveCommand =
    "mark|move|set|put|change|advance|promote|shift|ready|push|take|send";
  if (!hasCommand(instruction, moveCommand)) return undefined;
  if (hasCommand(instruction, "ready")) return "ready";
  const clarificationAnswer = instruction.match(
    /\bClarification answer:\s*([\s\S]+)$/i,
  )?.[1];
  const source =
    clarificationAnswer && hasCommand(clarificationAnswer, moveCommand)
      ? clarificationAnswer
      : instruction;
  const destinations = explicitBoardDestinationStatuses(source);
  if (destinations.length > 0) {
    return new Set(destinations).size === 1
      ? (destinations[destinations.length - 1] as BoardMoveStatus | "posted")
      : "ambiguous";
  }
  if (/\b(?:from|currently\s+in|in)\s+(?:idea|drafting|ready|posted)\b/i.test(source)) {
    return undefined;
  }
  const statuses = [
    ...source.matchAll(
      /\b(?:draft|post|it|this|that|one)\b[\s\S]{0,60}\b(idea|drafting|ready|posted)\b\s*[.!?]?$/giu,
    ),
  ].map((match) => match[1].toLocaleLowerCase("en-US"));
  return new Set(statuses).size === 1
    ? (statuses[0] as BoardMoveStatus | "posted")
    : statuses.length > 0
      ? "ambiguous"
      : undefined;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function validTimeZone(value: string | undefined): string | undefined {
  if (!value || value.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return value;
  } catch {
    return undefined;
  }
}

function localIsoDay(date: Date, timeZone: string | undefined): string {
  const normalized = validTimeZone(timeZone);
  if (!normalized) return isoDay(date);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalized,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function scheduledDate(
  instruction: string,
  now: Date,
  timeZone?: string,
): string | null | undefined {
  if (clearsSchedule(instruction)) return null;
  const today = localIsoDay(now, timeZone);
  const localNow = new Date(`${today}T00:00:00.000Z`);
  const token =
    "\\d{4}-\\d{2}-\\d{2}|today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday";
  const clarification = instruction.match(
    new RegExp(`\\bClarification answer:\\s*(${token})\\s*[.!?]?$`, "i"),
  )?.[1];
  const destinationMatches = clarification
    ? [clarification]
    : [
        ...instruction.matchAll(
          new RegExp(`\\b(?:for|on)\\s+(?:this\\s+)?(${token})\\b`, "giu"),
        ),
        ...instruction.matchAll(
          new RegExp(
            `\\b(?:draft|post|it|this|that|one)\\s+(${token})\\s*[.!?]?$`,
            "giu",
          ),
        ),
      ].map((match) => match[1]);
  const normalized = [
    ...new Set(
      destinationMatches.map((value) => value.toLocaleLowerCase("en-US")),
    ),
  ];
  if (normalized.length !== 1) return undefined;
  const requested = normalized[0];
  const explicit = requested?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
  if (explicit) {
    const parsed = new Date(`${explicit}T00:00:00.000Z`);
    if (
      !Number.isNaN(parsed.getTime()) &&
      isoDay(parsed) === explicit &&
      explicit >= today
    ) {
      return explicit;
    }
    return undefined;
  }
  if (requested === "tomorrow") return isoDay(addUtcDays(localNow, 1));
  if (requested === "today") return today;
  const weekday = requested && requested in WEEKDAY_INDEX ? requested : undefined;
  if (weekday) {
    const target = WEEKDAY_INDEX[weekday];
    const delta = (target - localNow.getUTCDay() + 7) % 7;
    return isoDay(addUtcDays(localNow, delta));
  }
  return undefined;
}

type ClarificationReason = Extract<
  ActionOrchestratorRoute,
  { kind: "clarify_action" }
>["clarificationReason"];

function clarificationRoute(
  reasons: ClarificationReason[],
  requirements: ActionRequirement[],
  targetCount: number | null,
): Extract<ActionOrchestratorRoute, { kind: "clarify_action" }> {
  return {
    kind: "clarify_action",
    clarificationReason: reasons[0],
    remainingClarifications: reasons,
    partialRequirements: requirements,
    partialTargetCount: targetCount,
  };
}

export function advanceActionOrchestratorClarification(
  route: Extract<ActionOrchestratorRoute, { kind: "clarify_action" }>,
  answer: string,
  now: Date = new Date(),
  clientTimezone?: string,
): ActionOrchestratorRoute {
  const remaining = [
    ...(route.remainingClarifications ?? [route.clarificationReason]),
  ];
  const current = remaining[0];
  const requirements = [...(route.partialRequirements ?? [])];
  let targetCount = route.partialTargetCount ?? null;

  if (current === "date") {
    const date = scheduledDate(
      `Schedule this draft for ${answer}`,
      now,
      clientTimezone,
    );
    if (date === undefined) return route;
    requirements.push({
      type: "schedule_post",
      date,
      ...(validTimeZone(clientTimezone)
        ? { timeZone: clientTimezone }
        : {}),
    });
  } else if (current === "target_count") {
    const count = requestedTargetCount(`Move ${answer} drafts`);
    if (count.kind !== "ok") return route;
    targetCount = count.count;
  } else {
    if (wantsSchedule(answer)) {
      const date = scheduledDate(answer, now, clientTimezone);
      if (date === undefined) {
        return clarificationRoute(
          ["date", ...remaining.slice(1)],
          requirements,
          targetCount,
        );
      }
      requirements.push({
        type: "schedule_post",
        date,
        ...(validTimeZone(clientTimezone)
          ? { timeZone: clientTimezone }
          : {}),
      });
      remaining.shift();
      if (remaining.length > 0) {
        return clarificationRoute(remaining, requirements, targetCount);
      }
      return {
        kind: "action_management",
        targetCount: targetCount ?? 1,
        requirements,
      };
    }
    const status = requestedMoveStatus(answer);
    if (!status || status === "ambiguous") return route;
    if (status === "posted") {
      return { kind: "disallowed_action", disallowedReason: "posted" };
    }
    requirements.push({ type: "move_on_board", status });
  }

  remaining.shift();
  if (remaining.length > 0) {
    return clarificationRoute(remaining, requirements, targetCount);
  }
  if (requirements.length === 0) return route;
  return {
    kind: "action_management",
    targetCount: targetCount ?? 1,
    requirements,
  };
}

export function compileActionOrchestratorRoute(
  input: ActionOrchestratorRoutingInput,
  now: Date = new Date(),
): ActionOrchestratorRoute | null {
  const instruction = input.userInstruction.replace(/\s+/g, " ").trim();
  if (
    !instruction ||
    input.isRefine ||
    input.hasModelSource ||
    input.hasAttachments ||
    input.hasLeadMagnet ||
    input.hasCreatorStyle ||
    !DRAFT_REFERENCE_RE.test(instruction)
  ) {
    return null;
  }

  // A newly written chat draft is not on the saved board yet. Preserve the
  // current Save-button handoff instead of pretending a later mutation can
  // target an unsaved artifact.
  if (requestsNewPost(instruction)) return null;
  if (
    input.hasUnsavedDraftReferent &&
    /\b(?:(?:this|that|the|latest)\s+(?:draft|post|one)|it)\b/i.test(
      instruction,
    ) &&
    hasCommand(
      instruction,
      "mark|move|set|put|change|advance|promote|shift|ready|schedule|plan|queue|publish|post|save|delete|remove|clear|cancel|unset",
    )
  ) {
    return { kind: "disallowed_action", disallowedReason: "save" };
  }
  if (NEGATED_ACTION_RE.test(instruction)) {
    return { kind: "no_action", noActionReason: "negated" };
  }
  if (isInformationalQuestion(instruction)) {
    return null;
  }
  if (hasCommand(instruction, "publish|post|send\\s+live|make\\s+live")) {
    return { kind: "disallowed_action", disallowedReason: "publish" };
  }
  if (hasCommand(instruction, "save")) {
    return { kind: "disallowed_action", disallowedReason: "save" };
  }
  if (changesPublishingSchedule(instruction)) {
    return { kind: "disallowed_action", disallowedReason: "publish" };
  }
  const clearsPlannedDate = clearsSchedule(instruction);
  if (hasCommand(instruction, "delete|remove") && !clearsPlannedDate) {
    return { kind: "disallowed_action", disallowedReason: "delete" };
  }

  const moveCommandRequested = hasCommand(
    instruction,
    "mark|move|set|put|change|advance|promote|shift|ready|push|take|send",
  );
  const likelyBoardMutation = hasLikelyBoardMoveCommand(instruction);
  const hasSeparateMoveCommand = hasCommand(
    instruction,
    "mark|move|change|advance|promote|shift|ready|push|take|send",
  );
  const moveStatus =
    isDateBearingSetPutSchedule(instruction) &&
    !hasSeparateMoveCommand &&
    !hasExplicitBoardDestination(instruction)
      ? undefined
      : requestedMoveStatus(instruction);
  if (moveStatus === "posted") {
    return { kind: "disallowed_action", disallowedReason: "posted" };
  }
  const schedulesPost = wantsSchedule(instruction) || clearsPlannedDate;
  const date = schedulesPost
    ? scheduledDate(instruction, now, input.clientTimezone)
    : undefined;
  const targetCount = requestedTargetCount(instruction);
  if (targetCount.kind === "mixed") {
    return { kind: "no_action", noActionReason: "mixed_count" };
  }
  const requirements: ActionRequirement[] = [];
  if (moveStatus && moveStatus !== "ambiguous") {
    requirements.push({
      type: "move_on_board",
      status: moveStatus,
    });
  }
  if (schedulesPost && date !== undefined) {
    requirements.push({
      type: "schedule_post",
      date: date ?? null,
      ...(validTimeZone(input.clientTimezone)
        ? { timeZone: input.clientTimezone }
        : {}),
    });
  }
  const remaining: ClarificationReason[] = [];
  if (
    moveStatus === "ambiguous" ||
    (!moveStatus &&
      !schedulesPost &&
      (moveCommandRequested || likelyBoardMutation))
  ) {
    remaining.push("action");
  }
  if (schedulesPost && date === undefined) remaining.push("date");
  // The board-action lane is for MOVING/SCHEDULING saved drafts. A bare count
  // ambiguity is only OUR concern when the turn actually wants a board action —
  // otherwise a pure content request like "find 4 top posts and rewrite them"
  // (a swipe-file draft-generation turn the read-only orchestrator owns) got
  // hijacked into "How many saved drafts should I update?", which is nonsense
  // and never produced the posts. Require real board-action intent — a built
  // requirement, a board command, a mutation signal, or an already-raised
  // action/date clarification — before a target_count clarification can claim
  // the turn. With no board intent, fall through to null so content lanes run.
  const hasBoardActionIntent =
    requirements.length > 0 ||
    remaining.length > 0 ||
    moveCommandRequested ||
    likelyBoardMutation ||
    schedulesPost;
  if (targetCount.kind === "clarify" && hasBoardActionIntent) {
    remaining.push("target_count");
  }
  if (remaining.length > 0) {
    return clarificationRoute(
      remaining,
      requirements,
      targetCount.kind === "ok" ? targetCount.count : null,
    );
  }
  if (requirements.length === 0) return null;
  return {
    kind: "action_management",
    targetCount: targetCount.kind === "ok" ? targetCount.count : 1,
    requirements,
  };
}

export const READ_ONLY_ORCHESTRATOR_ROUTE_KINDS = [
  "news_research",
  "web_research",
  "workspace_research",
  "file_inspection",
  "ambiguous_read_only",
] as const;

export type ReadOnlyOrchestratorRouteKind =
  (typeof READ_ONLY_ORCHESTRATOR_ROUTE_KINDS)[number];

export type ReadOnlyOrchestratorRoute = {
  kind: ReadOnlyOrchestratorRouteKind;
  /** @deprecated Accepted only while persisted/test fixtures migrate; ignored by production routing. */
  expectsDraft?: boolean;
  /** @deprecated Use outcome.expectedDrafts. */
  expectedDrafts?: number;
  outcome?:
    | { kind: "draft"; expectedDrafts: number }
    | {
        kind: "grounded_answer";
        format: "summary" | "takeaways" | "comparison" | "report";
        resultCount?: number;
      };
  allowExternalSearch?: boolean;
  allowedSearchKinds?: Array<"news" | "web" | "workspace">;
  minimumSources?: number;
  workspaceSearchMode?: "diverse" | "strict_top";
  workspaceSince?: "1d" | "7d" | "30d";
  workspacePostType?: PostType;
  /** Full-text topic constraint for workspace post bodies (not an account niche). */
  workspaceQuery?: string;
  // Genuine explicit user choice for the saved draft's post type (UI / starter
  // contract), distinct from workspacePostType which is used for source
  // filtering. Carried through to the artifact meta so the client does not
  // reclassify from body text.
  explicitPostType?: PostType;
  workspaceDraftSourceMode?: "one_to_one";
  clarificationReason?: "outcome" | "research_topic" | "modeled_mapping";
  modeledAmbiguityReason?: Extract<
    ModeledPostIntent,
    { kind: "ambiguous" }
  >["reason"];
  authoritativeInstruction?: string;
};

/**
 * Decode legacy persisted/test routes exactly once at the boundary. Production
 * compilers emit only `outcome`; contradictory authorities are rejected rather
 * than letting downstream consumers choose different fallbacks.
 */
export function canonicalizeReadOnlyOrchestratorRoute(
  route: ReadOnlyOrchestratorRoute,
): ReadOnlyOrchestratorRoute {
  const { expectsDraft, expectedDrafts, ...canonical } = route;
  if (canonical.outcome) {
    const outcomeDrafts =
      canonical.outcome.kind === "draft"
        ? canonical.outcome.expectedDrafts
        : undefined;
    if (
      (expectsDraft !== undefined &&
        expectsDraft !== (canonical.outcome.kind === "draft")) ||
      (expectedDrafts !== undefined && expectedDrafts !== outcomeDrafts)
    ) {
      throw new Error("Read-only route contains contradictory outcome authorities.");
    }
    return canonical;
  }
  if (expectsDraft === true) {
    const legacyExpectedDrafts = expectedDrafts ?? 1;
    if (
      !Number.isInteger(legacyExpectedDrafts) ||
      Number(legacyExpectedDrafts) < 1 ||
      Number(legacyExpectedDrafts) > 6
    ) {
      throw new Error("Legacy draft route has an invalid expected draft count.");
    }
    return {
      ...canonical,
      outcome: { kind: "draft", expectedDrafts: Number(legacyExpectedDrafts) },
    };
  }
  if (expectedDrafts !== undefined) {
    throw new Error("Read-only route contains contradictory outcome authorities.");
  }
  return canonical;
}

export type ReadOnlyOrchestratorRoutingInput = {
  userInstruction: string;
  draftCountOverride?: number;
  composerTaskContext?: ComposerTaskContext;
  explicitPostType?: PostType;
  isRefine: boolean;
  hasModelSource: boolean;
  hasAttachments: boolean;
  hasLeadMagnet: boolean;
  hasCreatorStyle: boolean;
};

/** Read-only orchestrator is part of the unified path; no rollout gating remains. */
export function readOnlyOrchestratorEnabledForWorkspace(): boolean {
  return true;
}

/** Compile source requirements chosen in the composer without reclassifying text. */
function composerResearchRoute(
  context: ComposerTaskContext | undefined,
): ReadOnlyOrchestratorRoute | null {
  const requirement = context?.researchRequirement;
  if (!context || !requirement) return null;
  const outcome =
    context.kind === "post"
      ? ({ kind: "draft", expectedDrafts: context.expectedDraftCount } as const)
      : ({
          kind: "grounded_answer",
          format: context.kind === "ideas" ? "takeaways" : "summary",
          ...(requirement.lane === "workspace"
            ? { resultCount: requirement.minimumSources }
            : {}),
        } as const);
  if (requirement.lane === "workspace") {
    return {
      kind: "workspace_research",
      outcome,
      minimumSources: requirement.minimumSources,
      workspaceSearchMode: requirement.searchMode,
      ...(requirement.since ? { workspaceSince: requirement.since } : {}),
      ...(requirement.postType
        ? { workspacePostType: requirement.postType }
        : {}),
      ...(requirement.oneSourcePerDraft
        ? { workspaceDraftSourceMode: "one_to_one" as const }
        : {}),
    };
  }
  return {
    kind: requirement.lane === "news" ? "news_research" : "web_research",
    outcome,
  };
}

const FULL_POST_REQUEST_RE =
  /\b(?:write|draft|create|generate|make|produce|prepare|give\s+me|model|mimic|adapt|rewrite|rework|remix)\b[\s\S]{0,180}\b(?:linkedin\s+)?posts?\b|\b(?:linkedin\s+)?posts?\b[\s\S]{0,120}\b(?:write|draft|create|generate|make|produce|prepare|model|mimic|adapt|rewrite|rework|remix)\b/i;
const NEWS_RE =
  /\b(?:news(?:jack(?:ing)?)?|breaking|trending|latest|today(?:'s)?|current|recent)\b[\s\S]{0,100}\b(?:announcement|launch|release|development|update|story|coverage|news|trend)|\b(?:announcement|launch|release|development|update|story|coverage|news|trend)\b[\s\S]{0,100}\b(?:latest|today(?:'s)?|current|recent|breaking|trending)\b/i;
const EXPLICIT_NEWS_TOPIC_RE = /\b(?:news|newsjack(?:ing)?)\b/i;
const FIRST_PARTY_NEWS_CONTEXT_RE =
  /\b(?:our|my)(?:\s+(?:latest|recent|new|current))?(?:\s+(?:company|product|team|career|business))?\s+(?:news|announcement|launch|release|development|update)\b|\b(?:news|announcement|launch|release|development|update)\b(?:\s+[\p{L}\p{N}-]+){0,2}\s+(?:about|from|in|at)\s+(?:our|my)\s+(?:company|product|team|career|business)\b/iu;
const RESEARCH_RE =
  /\b(?:research|investigate|fact[ -]?check|verify|look\s+into|browse|search)\b/i;
const MULTI_SOURCE_RE =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|[2-9]|10|multiple|several)\b(?:(?![.!?]|\b(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b)[\s\S]){0,160}?\b(?:sources?|examples?|posts?|articles?|files?|documents?)\b|\b(?:compare|synthesi[sz]e|cross[ -]?check)\b[\s\S]{0,100}\b(?:sources?|examples?|posts?|articles?|files?|documents?)\b/iu;
const OUTPUT_FIRST_SOURCE_DISCOVERY_RE =
  /\b(?:after|using)\s+(?:finding|searching|researching|reviewing|comparing)\b[\s\S]{0,140}\b(?:viral|top|best|swipe\s+file|bookmarks?|examples?|sources?|posts?|articles?|files?|documents?)\b/i;
const FILE_INSPECTION_RE =
  /\b(?:attached|attachment|file|document|pdf|interview|transcript)\b|\b(?:inspect|analy[sz]e|review|read|compare|summari[sz]e|extract)\b/i;
const COMPLEX_READ_RE =
  /\b(?:research|investigate|fact[ -]?check|verify|compare|synthesi[sz]e|inspect|analy[sz]e|review|read|search|find)\b/i;
const EXPLICIT_NON_POST_OUTCOME_RE =
  /\b(?:summari[sz]e|summary|compare|analy[sz]e|explain|tell\s+me|show\s+me|list|report|recommend|answer|give\s+me\s+(?:the\s+)?(?:findings|takeaways|results|lessons))\b/i;
const WORKSPACE_RESEARCH_CONTEXT_RE =
  /\b(?:my|our)\s+(?:swipe\s+file|bookmarks?|saved\s+posts?)\b/i;
// A direct request to search the workspace's OWN collection — the swipe file
// (scraped viral posts), bookmarks/saved posts, or tracked accounts. The swipe
// file IS the product's data, so "find posts from the swipe file" must always
// run a real search, not answer conversationally. Unlike
// WORKSPACE_RESEARCH_CONTEXT_RE this does NOT require a possessive ("my/our"):
// "the swipe file", "swipe file", "swipe-in", "bookmarks" all count. It pairs a
// discovery verb with a workspace-collection noun so an incidental mention
// ("I love my swipe file") never triggers a search.
const WORKSPACE_SEARCH_INTENT_RE =
  /\b(?:find|search|show|pull|browse|get|surface|look\s+(?:for|through)|dig\s+(?:up|through)|grab|give\s+me)\b[\s\S]{0,80}?\b(?:swipe[\s-]?file|swipe[\s-]?in|bookmarks?|saved\s+posts?|tracked\s+accounts?)\b/i;
const HISTORY_DEPENDENT_RESEARCH_RE =
  /\b(?:this|that|it|these|those|their|his|her|its|above|previous|earlier)\b/i;
const STRICT_TOP_SOURCE_RE =
  /\b(?:top|best|highest[-\s]?engagement|high[-\s]?performing)\b/i;
const SOURCE_COUNT_RE =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|[1-9]|10)\b(?:(?![.!?]|\b(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b)[\s\S]){0,160}?\b(?:sources?|examples?|posts?|articles?|files?|documents?)\b/giu;
const SOURCE_COUNT_WORDS: Record<string, number> = {
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

function requestedExplicitSourceCount(instruction: string): number | null {
  const explicitCounts = [...instruction.matchAll(SOURCE_COUNT_RE)].map(
    (match) => {
      const value = match[1]?.toLowerCase() ?? "";
      return Number(value) || SOURCE_COUNT_WORDS[value] || 0;
    },
  );
  return explicitCounts.length > 0 ? Math.max(...explicitCounts) : null;
}

function requestedSourceMinimum(
  instruction: string,
  exactSourceCount?: number | null,
): number {
  // Requests can put the output first ("write one post after finding three
  // posts"). Taking the first match would undercount the research requirement.
  // The maximum is deliberately conservative: asking for one extra source is
  // preferable to drafting from fewer sources than the user explicitly asked
  // us to compare.
  const explicitCount =
    exactSourceCount ?? requestedExplicitSourceCount(instruction);
  // A one-to-one rewrite needs exactly one source. Requiring a second source
  // would turn a clear modeling request into an unnecessary synthesis task.
  if (explicitCount === 1) return 1;
  return Math.max(
    2,
    /\bseveral\b/i.test(instruction) ? 3 : 2,
    explicitCount ?? 0,
  );
}

function requestedWorkspacePostType(
  researchClause: string,
): PostType | undefined {
  if (/\blead[-\s]?magnet\s+posts?\b/i.test(researchClause)) {
    return "lead_magnet";
  }
  if (/\bregular\s+posts?\b/i.test(researchClause)) return "regular";
  return undefined;
}

function requestedGroundedAnswer(
  instruction: string,
): Extract<
  NonNullable<ReadOnlyOrchestratorRoute["outcome"]>,
  { kind: "grounded_answer" }
> | null {
  if (!EXPLICIT_NON_POST_OUTCOME_RE.test(instruction)) return null;
  if (
    FULL_POST_REQUEST_RE.test(instruction) &&
    !explicitlyForbidsWriting(instruction)
  ) {
    return null;
  }
  const format = /\bcompar(?:e|ison)\b/i.test(instruction)
    ? "comparison"
    : /\b(?:takeaways?|lessons?|list)\b/i.test(instruction)
      ? "takeaways"
      : /\breport\b/i.test(instruction)
        ? "report"
        : "summary";
  const explicitCount = requestedExplicitSourceCount(instruction);
  return {
    kind: "grounded_answer",
    format,
    ...(explicitCount
      ? { resultCount: Math.min(explicitCount, MAX_GROUNDED_ANSWER_RESULTS) }
      : {}),
  };
}

function sourceResearchClause(instruction: string): string {
  const normalized = instruction.replace(/\s+/g, " ").trim();
  const outputFirst = normalized.match(
    /\b(?:after|using)\s+((?:finding|researching|searching|comparing|reviewing|inspecting)\b[\s\S]*)$/i,
  )?.[1];
  if (outputFirst) {
    return outputFirst
      .split(/[.!?](?:\s|$)/, 1)[0]
      .split(
        /\s*,?\s*\b(?:and|then)\s+(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b/i,
        1,
      )[0]
      .trim();
  }
  const directWritingTopic = normalized.match(
    /^(?:please\s+)?(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b[\s\S]{0,120}?\babout\s+([\s\S]+)$/i,
  )?.[1];
  if (directWritingTopic) {
    return directWritingTopic.split(/[.!?](?:\s|$)/, 1)[0].trim();
  }
  return normalized
    .split(
      /(?:\b(?:and|then)\s+|[.!?]\s*)(?:please\s+)?(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b/i,
    )[0]
    .trim();
}

const GENERIC_RESEARCH_TERMS = new Set([
  "a",
  "about",
  "an",
  "and",
  "announcement",
  "breaking",
  "browse",
  "coverage",
  "current",
  "development",
  "fact-check",
  "fact",
  "check",
  "for",
  "further",
  "investigate",
  "into",
  "latest",
  "launch",
  "look",
  "more",
  "news",
  "newsjack",
  "newsjacking",
  "of",
  "on",
  "please",
  "recent",
  "release",
  "research",
  "search",
  "story",
  "the",
  "this",
  "today",
  "trend",
  "trending",
  "update",
  "verify",
  "web",
]);

function hasConcreteResearchTopic(instruction: string): boolean {
  return (
    instruction
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}][\p{L}\p{N}-]+/gu)
      ?.some((term) => !GENERIC_RESEARCH_TERMS.has(term)) ?? false
  );
}

function requestedWorkspaceWindow(
  instruction: string,
): "1d" | "7d" | "30d" | undefined {
  if (/\b(?:today|last\s+24\s+hours?|past\s+24\s+hours?)\b/i.test(instruction)) {
    return "1d";
  }
  if (/\b(?:this\s+week|last\s+7\s+days?|past\s+7\s+days?)\b/i.test(instruction)) {
    return "7d";
  }
  if (
    /\b(?:this\s+month|last\s+30\s+days?|past\s+30\s+days?|latest|recent)\b/i.test(
      instruction,
    )
  ) {
    return "30d";
  }
  return undefined;
}

function clarificationFollowup(
  instruction: string,
): { original: string; answer: string } | null {
  const match = instruction.match(
    /^([\s\S]*?)\r?\n\r?\nClarification answer:[ \t]*([^\r\n]+)[ \t]*$/i,
  );
  const original = match?.[1]?.trim() ?? "";
  const answer = match?.[2]?.trim() ?? "";
  return original &&
    answer &&
    !/\bClarification answer:/i.test(original)
    ? { original, answer }
    : null;
}

function instructionWithResolvedResearchTopic(
  original: string,
  answer: string,
): string {
  if (
    /\b(?:news|announcement|launch|release|development|update|story|coverage|trend)\b/i.test(
      original,
    )
  ) {
    return original.replace(
      /\b(?:news|announcement|launch|release|development|update|story|coverage|trend)\b/i,
      (noun) => `${answer} ${noun}`,
    );
  }
  return original.replace(
    /\b(?:research|investigate|fact[ -]?check|verify|look\s+into|browse|search)\b/i,
    (verb) => `${verb} ${answer}`,
  );
}

const CLARIFIED_COUNT_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

// The clarifying question is model-generated ("How many LinkedIn posts?"),
// and a user answering naturally drops the word "LinkedIn" entirely ("3
// posts", "three posts") — even a bare count ("3", "three") is a normal
// answer to a "how many" question. Requiring the literal word "LinkedIn"
// silently failed the whole clarification resolution for these answers,
// falling the turn out of the orchestrator instead of completing it.
function clarifiedLinkedInPostCount(answer: string): number | null {
  const trimmed = answer.trim();
  const match =
    trimmed.match(
      /^(?:(a|an|one|two|three|four|five|six|[1-6])\s+)?(?:linkedin\s+)?posts?[.!?]?$/i,
    ) ?? trimmed.match(/^(a|an|one|two|three|four|five|six|[1-6])[.!?]?$/i);
  if (!match) return null;
  const value = match[1]?.toLocaleLowerCase("en-US") ?? "one";
  return Number(value) || CLARIFIED_COUNT_WORDS[value] || 1;
}

const MODELED_CLARIFICATION_COUNT_WORDS: Record<string, number> = {
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

type ExactModeledClarification =
  | { kind: "count"; count: number }
  | { kind: "one_per_source"; count: number | null }
  | { kind: "one_from_all" }
  | { kind: "source_then_draft"; sourceCount: number; draftCount: number };

const MODELED_COUNT_TOKEN =
  "(10|[1-9]|one|two|three|four|five|six|seven|eight|nine|ten)";

function modeledClarificationCount(value: string): number {
  return Number(value) || MODELED_CLARIFICATION_COUNT_WORDS[value];
}

/**
 * Parse only complete, positive answers to the cardinality question. This is
 * deliberately an allowlist: extracting a number from prose turns negations,
 * ranges, ordinals, and estimates into false exact answers.
 */
function parseExactModeledClarification(
  answer: string,
): ExactModeledClarification | null {
  const normalized = answer
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .replace(/(?:,\s*)?\bplease$/, "")
    .replace(/^please\s+/, "")
    .trim();
  if (!normalized) return null;

  const sourceThenDraft = normalized.match(
    new RegExp(
      `^(?:find|select|choose|use)?\\s*(?:exactly\\s+)?${MODELED_COUNT_TOKEN}\\s+sources?\\s*(?:,|and|then)\\s*(?:exactly\\s+)?${MODELED_COUNT_TOKEN}\\s+(?:new\\s+)?drafts?$`,
      "i",
    ),
  );
  if (sourceThenDraft) {
    return {
      kind: "source_then_draft",
      sourceCount: modeledClarificationCount(sourceThenDraft[1]),
      draftCount: modeledClarificationCount(sourceThenDraft[2]),
    };
  }

  const countedPerSourceMapping = normalized.match(
    new RegExp(
      `^(?:find|select|choose|use)?\\s*(?:exactly\\s+)?${MODELED_COUNT_TOKEN}\\s+sources?\\s*(?:,|and|then)\\s*(?:one|1)\\s+(?:new\\s+)?draft\\s+(?:per|for\\s+each)\\s+source$`,
      "i",
    ),
  );
  if (countedPerSourceMapping) {
    return {
      kind: "one_per_source",
      count: modeledClarificationCount(countedPerSourceMapping[1]),
    };
  }

  const countedOnePerSource = normalized.match(
    new RegExp(
      `^(?:find|select|choose|use)\\s+(?:exactly\\s+)?${MODELED_COUNT_TOKEN}(?:\\s+(?:sources?|posts?))?\\s+(?:and|then)\\s+(?:rewrite|adapt|model|create|write|make)\\s+(?:each(?:\\s+(?:one|source|post))?|one\\s+(?:new\\s+)?draft\\s+(?:per|for\\s+each)\\s+source)$`,
      "i",
    ),
  );
  if (countedOnePerSource) {
    return {
      kind: "one_per_source",
      count: modeledClarificationCount(countedOnePerSource[1]),
    };
  }

  if (
    /^(?:(?:one|1)\s+(?:new\s+)?draft\s+(?:per|for\s+each)\s+source|one\s+for\s+each\s+source|(?:rewrite|adapt|model)\s+each(?:\s+(?:one|source|post))?|each(?:\s+(?:one|source|post))?)$/i.test(
      normalized,
    )
  ) {
    return { kind: "one_per_source", count: null };
  }

  if (
    /^(?:(?:one|1)\s+draft\s+(?:using|from)\s+(?:all|the)\s+sources|one\s+draft\s+using\s+all\s+sources)$/i.test(
      normalized,
    )
  ) {
    return { kind: "one_from_all" };
  }

  const exactCount = normalized.match(
    new RegExp(
      `^(?:(?:find|select|choose|use|write|create|make)\\s+)?(?:exactly\\s+)?${MODELED_COUNT_TOKEN}(?:\\s+(?:selected\\s+)?(?:sources?|posts?|drafts?))?$`,
      "i",
    ),
  );
  return exactCount
    ? { kind: "count", count: modeledClarificationCount(exactCount[1]) }
    : null;
}

function canonicalResearchTopicAnswer(answer: string): string | null {
  const topic = answer.trim().replace(/\s+/g, " ");
  const terms = topic.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  if (
    !topic ||
    topic.length > 120 ||
    terms.length < 1 ||
    terms.length > 12 ||
    !/^[\p{L}\p{N}][\p{L}\p{N}\s&+.'’()\/:-]*$/u.test(topic) ||
    /\b(?:clarification\s+answer|ignore|forget|instead|write|draft|create|generate|make|produce|prepare|give\s+me)\b/i.test(
      topic,
    )
  ) {
    return null;
  }
  return topic;
}

function exactIntentCount(
  cardinality: Extract<
    ModeledPostIntent,
    { kind: "ambiguous" }
  >["discoveryCount"],
): number | null {
  return cardinality.kind === "exact" ? cardinality.value : null;
}

/**
 * Resolve only answers that fully determine a supported source/draft mapping.
 * The result is a fresh canonical instruction, so contradictory quantities in
 * the original request cannot leak back into routing after clarification.
 */
function resolvedModeledClarification(
  original: string,
  answer: string,
  intent: Extract<ModeledPostIntent, { kind: "ambiguous" }>,
): { routeInstruction: string; authoritativeInstruction: string } | null {
  const clarification = parseExactModeledClarification(answer);
  if (!clarification) return null;
  const onePerSource = clarification.kind === "one_per_source";
  const oneFromAll = clarification.kind === "one_from_all";
  const clarifiedCount =
    clarification.kind === "count" || clarification.kind === "one_per_source"
      ? clarification.count
      : null;
  let sourceCount = exactIntentCount(intent.discoveryCount);
  let selectionCount = exactIntentCount(intent.selectionCount);
  let draftCount = exactIntentCount(intent.outputCount);

  if (clarification.kind === "source_then_draft") {
    sourceCount = clarification.sourceCount;
    draftCount = clarification.draftCount;
    selectionCount = null;
  } else if (oneFromAll) {
    draftCount = 1;
    selectionCount = null;
  } else if (onePerSource) {
    if (intent.reason === "source_count" && clarifiedCount === null) return null;
    sourceCount ??= clarifiedCount;
    draftCount = selectionCount ?? sourceCount;
  } else if (intent.reason === "source_count" ||
    (intent.reason === "invalid_quantity" && sourceCount === null)) {
    if (clarifiedCount === null) return null;
    sourceCount = clarifiedCount;
    draftCount = selectionCount ?? draftCount ?? sourceCount;
  } else if (intent.reason === "selection_count") {
    if (clarifiedCount === null) return null;
    selectionCount = clarifiedCount;
    draftCount = selectionCount;
  } else if (intent.reason === "output_count" ||
    (intent.reason === "invalid_quantity" && sourceCount !== null)) {
    if (clarifiedCount === null) return null;
    draftCount = clarifiedCount;
  } else {
    return null;
  }

  if (
    !sourceCount ||
    sourceCount > 10 ||
    !draftCount ||
    draftCount > 5 ||
    (selectionCount !== null && selectionCount > sourceCount)
  ) {
    return null;
  }
  const oneToOne = onePerSource || (selectionCount ?? sourceCount) === draftCount;
  const routeInstruction = selectionCount
    ? `Find exactly ${sourceCount} top posts in my swipe file, choose exactly ${selectionCount} posts, and rewrite each selected post as one new post.`
    : oneToOne
      ? `Find exactly ${sourceCount} top posts in my swipe file and create exactly ${draftCount} new posts, one for each selected source.`
      : `Find exactly ${sourceCount} top posts in my swipe file and create exactly ${draftCount} new posts modeled after those sources.`;
  const compiled = compileModeledPostIntent(routeInstruction);
  if (compiled.kind !== "exact") return null;
  return {
    routeInstruction,
    authoritativeInstruction:
      `${routeInstruction}\n\nRetain the original request's non-cardinality topic, voice, and format constraints from the JSON string below. Ignore every conflicting quantity or source-to-draft mapping inside it.` +
      wrapUntrustedXml("original_request", JSON.stringify(original)),
  };
}

/**
 * Compile only the read-only journeys with materially different evidence
 * sequences. Common writing, refine, fixed-source, and durable-action turns
 * remain owned by their existing deterministic lanes.
 */
export function compileReadOnlyOrchestratorRoute(
  input: ReadOnlyOrchestratorRoutingInput,
): ReadOnlyOrchestratorRoute | null {
  const followup = clarificationFollowup(input.userInstruction);
  if (followup) {
    const originalRoute = compileReadOnlyOrchestratorRoute({
      ...input,
      userInstruction: followup.original,
    });
    let resolvedInstruction: string | null = null;
    const clarifiedPostCount = clarifiedLinkedInPostCount(followup.answer);
    if (
      originalRoute?.clarificationReason === "outcome" &&
      clarifiedPostCount !== null
    ) {
      resolvedInstruction = `${followup.original}\n\nWrite ${
        clarifiedPostCount === 1 ? "a" : clarifiedPostCount
      } LinkedIn ${clarifiedPostCount === 1 ? "post" : "posts"}.`;
    } else if (originalRoute?.clarificationReason === "outcome") {
      if (/^A short list of takeaways$/i.test(followup.answer)) {
        resolvedInstruction = `${followup.original}\n\nGive me a short list of takeaways. Do not draft or rewrite.`;
      } else if (/^A detailed research summary$/i.test(followup.answer)) {
        resolvedInstruction = `${followup.original}\n\nSummarize the research in detail. Do not draft or rewrite.`;
      }
    } else if (originalRoute?.clarificationReason === "research_topic") {
      const researchTopic = canonicalResearchTopicAnswer(followup.answer);
      if (researchTopic) {
        resolvedInstruction = instructionWithResolvedResearchTopic(
          followup.original,
          researchTopic,
        );
      }
    } else if (originalRoute?.clarificationReason === "modeled_mapping") {
      const originalIntent = compileModeledPostIntent(followup.original);
      const resolved =
        originalIntent.kind === "ambiguous"
          ? resolvedModeledClarification(
              followup.original,
              followup.answer,
              originalIntent,
            )
          : null;
      if (resolved) {
        const resolvedRoute = compileReadOnlyOrchestratorRoute({
          ...input,
          userInstruction: resolved.routeInstruction,
        });
        return resolvedRoute
          ? {
              ...resolvedRoute,
              authoritativeInstruction: resolved.authoritativeInstruction,
            }
          : null;
      }
    }
    if (resolvedInstruction) {
      const resolvedRoute = compileReadOnlyOrchestratorRoute({
        ...input,
        userInstruction: resolvedInstruction,
      });
      return resolvedRoute
        ? { ...resolvedRoute, authoritativeInstruction: resolvedInstruction }
        : null;
    }
    if (originalRoute?.clarificationReason === "modeled_mapping") {
      return originalRoute;
    }
    return null;
  }
  const instruction = input.userInstruction.trim();
  const groundedAnswer = requestedGroundedAnswer(instruction);
  const forbidsDiscovery = explicitlyForbidsSourceDiscovery(instruction);
  const modeledIntent =
    forbidsDiscovery ||
    (groundedAnswer !== null && explicitlyForbidsWriting(instruction))
    ? ({ kind: "none" } as const)
    : compileModeledPostIntent(instruction, {
        draftCountOverride: input.draftCountOverride,
      });
  if (
    /\bClarification\s+answer\s*:/i.test(instruction) &&
    modeledIntent.kind !== "none"
  ) {
    return {
      kind: "ambiguous_read_only",
      clarificationReason: "modeled_mapping",
      modeledAmbiguityReason:
        modeledIntent.kind === "ambiguous"
          ? modeledIntent.reason
          : "mapping",
    };
  }
  if (
    !instruction ||
    input.isRefine ||
    input.hasModelSource ||
    requestsDurableOrAction(instruction)
  ) {
    return null;
  }
  const selectedComposerRoute = composerResearchRoute(
    input.composerTaskContext,
  );
  if (selectedComposerRoute) return selectedComposerRoute;
  if (
    ((input.hasLeadMagnet || input.hasCreatorStyle) &&
      modeledIntent.kind === "none") ||
    (forbidsDiscovery && !input.hasAttachments)
  ) {
    return null;
  }
  if (modeledIntent.kind === "ambiguous") {
    return {
      kind: "ambiguous_read_only",
      clarificationReason: "modeled_mapping",
      modeledAmbiguityReason: modeledIntent.reason,
    };
  }
  const sourceModelingRequest = modeledIntent.kind === "exact";
  const researchClause = sourceResearchClause(instruction);
  const explicitDraftCount =
    input.draftCountOverride ??
    (sourceModelingRequest
      ? modeledIntent.expectedDrafts
      : requestedDirectPostCount(instruction));
  const explicitSourceCount = sourceModelingRequest
    ? modeledIntent.discoveryCount
    : null;
  const workspacePostType =
    (sourceModelingRequest
      ? (modeledIntent.sourcePostType ??
        requestedWorkspacePostType(researchClause))
      : requestedWorkspacePostType(researchClause)) ??
    // A multi-draft campaign/series must model REGULAR posts only: without an
    // explicit type the workspace search would also return lead magnets as
    // source material. An explicit lead-magnet request (message or modeled
    // intent) still wins — that is a lead-magnet flow, not a campaign/series.
    ((explicitDraftCount ?? 1) >= 2 ? ("regular" as const) : undefined);
  const writingOutputClause = instruction.match(
    /\b(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b[\s\S]{0,180}?\b(?:linkedin\s+)?posts?\b/i,
  )?.[0] ?? "";
  const hasPluralPostTarget = /\b(?:linkedin\s+)?posts\b/i.test(
    writingOutputClause,
  );
  const unresolvedPluralDraftTarget =
    !sourceModelingRequest &&
    groundedAnswer === null &&
    FULL_POST_REQUEST_RE.test(instruction) &&
    hasPluralPostTarget &&
    explicitDraftCount === null;
  const expectsDraft =
    groundedAnswer === null &&
    (sourceModelingRequest ||
      (FULL_POST_REQUEST_RE.test(instruction) &&
        (!hasPluralPostTarget || explicitDraftCount !== null)));
  const expectedDrafts = explicitDraftCount ?? 1;
  const workspaceDraftSourceMode =
    sourceModelingRequest &&
    modeledIntent.relation === "one_to_one" &&
    expectedDrafts <= 6
      ? ("one_to_one" as const)
      : undefined;
  const workspaceMinimumSources =
    sourceModelingRequest
      ? modeledIntent.minimumSources
      : requestedSourceMinimum(researchClause, explicitSourceCount);
  const needsFileInspection =
    input.hasAttachments && FILE_INSPECTION_RE.test(instruction);
  const needsNews =
    !FIRST_PARTY_NEWS_CONTEXT_RE.test(instruction) &&
    (EXPLICIT_NEWS_TOPIC_RE.test(instruction) ||
      (NEWS_RE.test(instruction) && RESEARCH_RE.test(instruction)));
  // True when the message is an explicit search of the workspace's own
  // collection (discovery verb + swipe-file/bookmark/tracked-accounts noun).
  // Consumed by workspaceAnswerSearch below — deliberately NOT folded into
  // needsWorkspaceResearch, so it can't disturb the draft path's
  // count-clarification.
  const explicitWorkspaceSearch = WORKSPACE_SEARCH_INTENT_RE.test(instruction);
  const needsWorkspaceResearch =
    sourceModelingRequest ||
    ((explicitlyRequestsSourceDiscovery(instruction) ||
      OUTPUT_FIRST_SOURCE_DISCOVERY_RE.test(instruction)) &&
      (groundedAnswer !== null
        ? WORKSPACE_RESEARCH_CONTEXT_RE.test(researchClause)
        : MULTI_SOURCE_RE.test(researchClause) ||
          workspaceDraftSourceMode === "one_to_one"));
  const complexRead =
    needsFileInspection ||
    needsNews ||
    needsWorkspaceResearch ||
    COMPLEX_READ_RE.test(instruction);

  if (
    !needsFileInspection &&
    FIRST_PARTY_NEWS_CONTEXT_RE.test(instruction) &&
    RESEARCH_RE.test(researchClause)
  ) {
    return null;
  }

  if (
    !needsFileInspection &&
    groundedAnswer === null &&
    (RESEARCH_RE.test(researchClause) || needsNews) &&
    HISTORY_DEPENDENT_RESEARCH_RE.test(researchClause)
  ) {
    return null;
  }

  // The swipe file is the product's data — a bare search of it ("find/show me
  // posts from the swipe file") must ALWAYS return real posts, never a
  // conversational "I don't have access." Force a workspace answer-search
  // whenever the request is an explicit swipe-file/bookmark search that ISN'T a
  // draft or modeled request. Gated on !expectsDraft so it can never override
  // the draft path's count-clarification. When the message has no explicit
  // outcome verb, synthesize a list (takeaways) grounded answer so the answer
  // branch below emits instead of dropping to null/clarify.
  // A CONCRETE draft request — a counted write ("...and write 3 posts") or a
  // resolved modeled transformation — keeps the draft path. Everything else
  // that is an explicit swipe-file search (including a soft "posts I could
  // adapt", where the transform word trips expectsDraft but there's no count or
  // resolved mapping) lists the found posts instead of dropping to a null /
  // conversational no-op. The swipe file is the product's data: searching it
  // always returns real posts.
  const concreteDraftRequest =
    expectsDraft && (explicitDraftCount !== null || sourceModelingRequest);
  const workspaceAnswerSearch =
    explicitWorkspaceSearch &&
    !concreteDraftRequest &&
    // A genuine but uncounted "...and write posts" request keeps its
    // count-clarification (the user is asking to write, just didn't say how
    // many) — don't pre-empt that with a bare listing.
    !unresolvedPluralDraftTarget &&
    !needsFileInspection &&
    !needsNews &&
    !forbidsDiscovery;
  const effectiveGroundedAnswer =
    groundedAnswer ??
    (workspaceAnswerSearch
      ? ({
          kind: "grounded_answer" as const,
          format: "takeaways" as const,
          ...(explicitSourceCount
            ? {
                resultCount: Math.min(
                  explicitSourceCount,
                  MAX_GROUNDED_ANSWER_RESULTS,
                ),
              }
            : {}),
        })
      : null);

  // Swipe-file / bookmark search wins over the draft/answer split: the
  // product's own data is always searched and listed (real posts), never
  // answered conversationally or sent to clarification. Placed before the
  // expectsDraft branch so a soft transform word ("posts I could adapt") that
  // trips expectsDraft — but carries no count or resolved mapping — still lists
  // the found posts. A concrete counted/modeled draft is excluded via
  // concreteDraftRequest in workspaceAnswerSearch above.
  if (workspaceAnswerSearch && effectiveGroundedAnswer && !needsFileInspection) {
    return {
      kind: "workspace_research",
      outcome: effectiveGroundedAnswer,
      minimumSources: Math.max(1, effectiveGroundedAnswer.resultCount ?? 1),
      workspaceSearchMode: STRICT_TOP_SOURCE_RE.test(researchClause)
        ? "strict_top"
        : "diverse",
      ...(requestedWorkspaceWindow(researchClause)
        ? { workspaceSince: requestedWorkspaceWindow(researchClause) }
        : {}),
      ...(workspacePostType ? { workspacePostType } : {}),
    };
  }

  if (!expectsDraft) {
    if (groundedAnswer && needsFileInspection) {
      const allowedSearchKinds: Array<"news" | "web" | "workspace"> = [];
      if (!forbidsDiscovery) {
        if (needsNews) allowedSearchKinds.push("news");
        if (needsWorkspaceResearch) allowedSearchKinds.push("workspace");
        if (
          RESEARCH_RE.test(researchClause) &&
          !needsNews &&
          !needsWorkspaceResearch
        ) {
          allowedSearchKinds.push("web");
        }
      }
      return {
        kind: "file_inspection",
        outcome: groundedAnswer,
        allowExternalSearch: allowedSearchKinds.length > 0,
        allowedSearchKinds,
        ...(needsWorkspaceResearch
          ? {
              minimumSources: Math.max(1, groundedAnswer.resultCount ?? 1),
              workspaceSearchMode: STRICT_TOP_SOURCE_RE.test(researchClause)
                ? ("strict_top" as const)
                : ("diverse" as const),
              ...(requestedWorkspaceWindow(researchClause)
                ? { workspaceSince: requestedWorkspaceWindow(researchClause) }
                : {}),
              ...(workspacePostType ? { workspacePostType } : {}),
            }
          : {}),
      };
    }
    if (groundedAnswer && needsNews) {
      if (!hasConcreteResearchTopic(researchClause)) {
        return {
          kind: "ambiguous_read_only",
          clarificationReason: "research_topic",
        };
      }
      return { kind: "news_research", outcome: groundedAnswer };
    }
    if (groundedAnswer && needsWorkspaceResearch) {
      return {
        kind: "workspace_research",
        outcome: groundedAnswer,
        minimumSources: Math.max(1, groundedAnswer.resultCount ?? 1),
        workspaceSearchMode: STRICT_TOP_SOURCE_RE.test(researchClause)
          ? "strict_top"
          : "diverse",
        ...(requestedWorkspaceWindow(researchClause)
          ? { workspaceSince: requestedWorkspaceWindow(researchClause) }
          : {}),
        ...(workspacePostType ? { workspacePostType } : {}),
      };
    }
    if (groundedAnswer && RESEARCH_RE.test(researchClause)) {
      if (!hasConcreteResearchTopic(researchClause)) {
        return {
          kind: "ambiguous_read_only",
          clarificationReason: "research_topic",
        };
      }
      return { kind: "web_research", outcome: groundedAnswer };
    }
    return unresolvedPluralDraftTarget ||
      (complexRead && !EXPLICIT_NON_POST_OUTCOME_RE.test(instruction))
      ? {
          kind: "ambiguous_read_only",
          clarificationReason: "outcome",
        }
      : null;
  }
  if (needsFileInspection) {
    const allowedSearchKinds: Array<"news" | "web" | "workspace"> = [];
    if (!forbidsDiscovery) {
      if (needsNews) allowedSearchKinds.push("news");
      if (needsWorkspaceResearch) allowedSearchKinds.push("workspace");
      if (
        RESEARCH_RE.test(researchClause) &&
        !needsNews &&
        !needsWorkspaceResearch
      ) {
        allowedSearchKinds.push("web");
      }
    }
    return {
      kind: "file_inspection",
      outcome: { kind: "draft", expectedDrafts },
      allowExternalSearch: allowedSearchKinds.length > 0,
      allowedSearchKinds,
      ...(input.explicitPostType ? { explicitPostType: input.explicitPostType } : {}),
      ...(needsWorkspaceResearch
        ? {
            minimumSources: workspaceMinimumSources,
            workspaceSearchMode: STRICT_TOP_SOURCE_RE.test(researchClause)
              ? ("strict_top" as const)
              : ("diverse" as const),
            ...(requestedWorkspaceWindow(researchClause)
              ? { workspaceSince: requestedWorkspaceWindow(researchClause) }
              : {}),
            ...(workspacePostType ? { workspacePostType } : {}),
          }
        : {}),
    };
  }
  if (needsNews) {
    if (!hasConcreteResearchTopic(researchClause)) {
      return {
        kind: "ambiguous_read_only",
        clarificationReason: "research_topic",
      };
    }
    return {
      kind: "news_research",
      outcome: { kind: "draft", expectedDrafts },
      ...(input.explicitPostType ? { explicitPostType: input.explicitPostType } : {}),
    };
  }
  if (needsWorkspaceResearch) {
    return {
      kind: "workspace_research",
      outcome: { kind: "draft", expectedDrafts },
      minimumSources: workspaceMinimumSources,
      workspaceSearchMode: STRICT_TOP_SOURCE_RE.test(researchClause)
        ? "strict_top"
        : "diverse",
      ...(requestedWorkspaceWindow(researchClause)
        ? { workspaceSince: requestedWorkspaceWindow(researchClause) }
        : {}),
      ...(workspacePostType ? { workspacePostType } : {}),
      ...(workspaceDraftSourceMode ? { workspaceDraftSourceMode } : {}),
      ...(input.explicitPostType ? { explicitPostType: input.explicitPostType } : {}),
    };
  }
  if (RESEARCH_RE.test(instruction)) {
    if (!hasConcreteResearchTopic(researchClause)) {
      return {
        kind: "ambiguous_read_only",
        clarificationReason: "research_topic",
      };
    }
    return {
      kind: "web_research",
      outcome: { kind: "draft", expectedDrafts },
      ...(input.explicitPostType ? { explicitPostType: input.explicitPostType } : {}),
    };
  }
  return null;
}

/**
 * Cost admission happens before optional resources are resolved. A selected
 * lead magnet can later be ignored for a neutral research request, so it must
 * not suppress the larger reserve at claim time. Over-reserving a turn that
 * ultimately uses a lead magnet is safe; under-reserving an orchestrated turn
 * is not.
 */
export function compileReadOnlyOrchestratorReserveRoute(
  input: ReadOnlyOrchestratorRoutingInput,
): ReadOnlyOrchestratorRoute | null {
  return compileReadOnlyOrchestratorRoute({
    ...input,
    hasLeadMagnet: false,
  });
}


// ---------------------------------------------------------------------------
// Turn plan compilation (PLAN-cowork-unification Phase 3, step 7)
//
// Everything that decides *which* executor serves a turn and what contract it
// must deliver lives here. The result is a single TurnPlan value that the
// execution phase consumes without further routing decisions.
// ---------------------------------------------------------------------------

export type ResolvedFindAndModelSource = {
  source: Source;
  sourceUrl: string | null;
};

/**
 * THIN PATH find-and-model source resolver. Runs the SAME rotation-aware search
 * the heavy loop's directSourceModelingTurn prefetch uses (top viral REGULAR
 * post, limit 1), so "find a top post and rewrite it" resolves a source up
 * front and can take the lean direct route instead of the GLM render loop.
 * Returns the source body (for the engine) AND the post_url (for the source
 * chip). Fail-open: any error / empty result returns undefined and the caller
 * falls through to the heavy path unchanged.
 */
export async function resolveFindAndModelSource(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<ResolvedFindAndModelSource | undefined> {
  try {
    const result = await runTool(
      "search_viral_posts",
      { post_type: "regular", sort: "viral", dir: "desc", limit: 1 },
      workspaceId,
      signal,
      { autoSelectModelingSources: true },
    );
    if (result.ok === false) return undefined;
    const posts = Array.isArray(result.posts)
      ? (result.posts as Array<{
          id?: unknown;
          text?: unknown;
          post_url?: unknown;
        }>)
      : [];
    const top = posts[0];
    if (
      !top ||
      typeof top.id !== "string" ||
      typeof top.text !== "string" ||
      !top.text.trim()
    ) {
      return undefined;
    }
    const body = canonicalScrapedPostText(top.text);
    if (!body) return undefined;
    const sourceUrl =
      typeof top.post_url === "string" && /^https?:\/\//i.test(top.post_url)
        ? top.post_url
        : null;
    return { source: { id: top.id, text: body }, sourceUrl };
  } catch {
    return undefined;
  }
}

type TurnPlanCommon = {
  contract: TurnContract;
  existingArtifactIds: string[];
  atomicDraftSet: boolean;
  modeledBatchContinuation: ModeledDraftBatchContinuation | null;
  activeModeledBatchContinuation: ModeledDraftBatchContinuation | null;
  modeledBatchRetryRootUserMessageId: string | undefined;
  directPostCount: number | null;
  modelSourceReference: ModelSourceReference | null;
};

/**
 * The one operation authorized for the current turn. A discriminated union
 * makes contradictory states (for example writer=true and action=true) unable
 * to compile, instead of relying on an if/else priority to hide them.
 */
export type TurnPlan = TurnPlanCommon &
  (
    | {
        kind: "write";
        route: "direct_writer";
        task: WriterTask;
        isDirectRefine: boolean;
        usesLeadMagnet: boolean;
        usesCreatorStyle: boolean;
      }
    | {
        kind: "action";
        route: "action_orchestrator";
        actionRoute: ActionOrchestratorRoute;
      }
    | {
        kind: "research";
        route: "read_only_orchestrator";
        researchRoute: ReadOnlyOrchestratorRoute;
      }
    | {
        kind: "clarify";
        route: "answer";
        ask: AskQuestion;
      }
    | {
        kind: "answer";
        route: "answer";
      }
  );

const AMBIGUOUS_CONTINUATION_RE =
  /^\s*(?:keep going|continue|go on|another one|another angle|what about (?:the )?other one|do (?:the )?other one|same again)\s*[?.!]*\s*$/i;

export function clarificationForAmbiguousContinuation(
  instruction: string,
): AskQuestion | null {
  if (!AMBIGUOUS_CONTINUATION_RE.test(instruction)) return null;
  return {
    question: "What would you like me to continue with?",
    options: [
      "Edit the current Post",
      "Create a new Post",
      "Continue the previous research or board task",
    ],
    allowOther: true,
  };
}

export type TurnCompileDependencies = {
  actionOrchestratorEnabledForWorkspace: () => boolean;
  readOnlyOrchestratorEnabledForWorkspace: () => boolean;
  releaseChatTurn: (
    workspaceId: string,
    chatId: string,
    operationKey: string | null,
  ) => Promise<void>;
  persistChatSetupFailure: (opts: {
    sb: SupabaseClient;
    chatId: string;
    workspaceId: string;
    content: string;
    recoverable?: {
      code: string | number;
      message: string;
      retryRootUserMessageId?: string;
      continuation?: ModeledDraftBatchContinuation;
    };
  }) => Promise<void>;
};

export async function compileTurnPlan(
  setup: TurnCompileContext,
  chatId: string,
  deps: TurnCompileDependencies,
): Promise<TurnPlan | Response> {
  const {
    workspaceId,
    sbRaw,
    attachments,
    modelSourceId,
    skipDecision,
    refineInstruction,
    trustedRefineTarget,
    existingArtifactIds,
    creatorStyleId,
    hasModelSource,
    turnCostOperationKey,
    claimedUserMessageId,
    actionTurnMessageId,
    normalizedActionRoute,
    confirmedActionTargetIds,
    actionRetryRepository,
    persistedActionContinuation,
    pendingAskOnly,
    artifactClarification,
    fallthroughClarification,
    modeledBatchContinuation,
    modeledBatchContractRequested,
    setupDeadline,
    setupSignal,
    postClarificationPostCount,
    coworkTelemetry,
    currentModelSource,
    modelSourceReference: initialModelSourceReference,
    effectiveUserInstruction,
    currentTurnOperation,
    composerTaskContext,
    activeDraftCountOverride,
    shouldAttachLeadMagnet,
    appliedLeadMagnet,
    activeLeadMagnetCampaign,
    leadMagnetBlock,
    creatorStyleBlock,
    preloadedVoiceResult,
    resolvedGenerationConfig,
    turnError,
    structureMatch,
  } = setup;

  let modelSourceReference = initialModelSourceReference;
  const atomicDraftSet =
    currentTurnOperation?.kind === "create_post" &&
    currentTurnOperation.delivery === "atomic";

  // Direct writer is the unified drafting path; the COWORK_THIN_PATH rollout
  // flag has been removed and lean mode is no longer forced (default false).
  const directWriterEnabled = true;
  const reviewOperation = currentTurnOperation?.kind === "review_artifact";
  const directPartialSpec = compileDirectPartialTextSpec(
    effectiveUserInstruction,
  );
  const directPostCount =
    activeDraftCountOverride ??
    (composerTaskContext?.kind === "post"
      ? composerTaskContext.expectedDraftCount
      : null) ??
    requestedDirectPostCount(effectiveUserInstruction);

  if (
    currentTurnOperation?.kind === "create_post" &&
    modelSourceId &&
    !currentModelSource
  ) {
    const message =
      "The selected source Post is no longer available in this workspace, so Cowork did not create an unmodeled replacement. Choose the source again and send a new request.";
    coworkTelemetry.configure({
      traceId: claimedUserMessageId ?? chatId,
      route: "answer",
      requestedContract: { kind: "post", expectedCount: directPostCount ?? 1 },
    });
    await deps.persistChatSetupFailure({
      sb: sbRaw,
      chatId,
      workspaceId,
      content: `⚠️ ${message}`,
    });
    await coworkTelemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 0 },
      provenanceStatus: "missing",
      terminalOutcome: "hard_failure",
    });
    await deps.releaseChatTurn(workspaceId, chatId, turnCostOperationKey);
    return turnError(message, 409);
  }

  // Ask is a capability boundary, not a best-effort routing hint. Once the
  // browser selects Ask, no wording, attachment, prior question, source, or
  // missing voice profile may promote the turn into writing or mutation.
  if (currentTurnOperation?.kind === "ask") {
    const missingContext = Boolean(
      currentTurnOperation.artifactId && !trustedRefineTarget,
    );
    // The swipe file is the product's data: an explicit swipe-file / bookmark
    // search must ALWAYS run a real search, even on an Ask turn with no
    // starter-supplied researchRequirement. Without this the turn falls to the
    // tool-less answer lane below and the model hallucinates "I don't have
    // access to a swipe file database." The same applies to live news: a typed
    // "search verified news about X…" Ask otherwise lands on the tool-less
    // lane and the model can only reply "I don't have live web search access"
    // — the exact refusal that prompted this gate. Compile the research route
    // whenever the request carries a research requirement, is an explicit
    // workspace-collection search, OR its wording demands live news/research.
    // Ask still never WRITES: only grounded_answer outcomes are served below,
    // so a "newsjack this and write a post" Ask keeps the answer lane (which
    // can say it can't write on Ask) instead of sneaking a draft through.
    const askWantsWorkspaceSearch = WORKSPACE_SEARCH_INTENT_RE.test(
      effectiveUserInstruction,
    );
    // Same news signals the route compiler applies below (needsNews): an
    // explicit news mention, or news wording paired with a research verb.
    // requiresLiveNewsOrResearch covers the newsjack/breaking-news shapes.
    const askWantsLiveNews =
      EXPLICIT_NEWS_TOPIC_RE.test(effectiveUserInstruction) ||
      (NEWS_RE.test(effectiveUserInstruction) &&
        RESEARCH_RE.test(effectiveUserInstruction)) ||
      requiresLiveNewsOrResearch(effectiveUserInstruction);
    const askResearchRoute =
      composerTaskContext?.researchRequirement ||
      askWantsWorkspaceSearch ||
      askWantsLiveNews
        ? compileReadOnlyOrchestratorRoute({
            userInstruction: effectiveUserInstruction,
            isRefine: false,
            hasModelSource: Boolean(modelSourceId),
            hasAttachments: attachments.length > 0,
            hasLeadMagnet: false,
            hasCreatorStyle: false,
            composerTaskContext: composerTaskContext ?? undefined,
          })
        : null;
    const servesResearch = Boolean(
      !missingContext &&
        askResearchRoute?.outcome?.kind === "grounded_answer" &&
        deps.readOnlyOrchestratorEnabledForWorkspace(),
    );
    const contract: TurnContract = servesResearch
      ? { kind: "research", expectedCount: 1 }
      : {
          kind: "answer",
          expectedCount: missingContext ? 0 : 1,
        };
    coworkTelemetry.configure({
      traceId: claimedUserMessageId ?? chatId,
      route: servesResearch ? "read_only_orchestrator" : "answer",
      requestedContract: contract,
    });
    const common = {
      contract,
      existingArtifactIds,
      atomicDraftSet,
      modeledBatchContinuation,
      activeModeledBatchContinuation: null,
      modeledBatchRetryRootUserMessageId: undefined,
      directPostCount: null,
      modelSourceReference,
    };
    if (servesResearch && askResearchRoute) {
      return {
        ...common,
        kind: "research",
        route: "read_only_orchestrator",
        researchRoute: askResearchRoute,
      };
    }
    return missingContext
      ? {
          ...common,
          kind: "clarify",
          route: "answer",
          ask: {
            question: "I couldn't find that Post in this chat.",
            options: ["Ask without a Post", "Cancel"],
            choiceIds: ["ask.without_post", "cancel"],
            doneOption: "Cancel",
            allowOther: true,
          },
        }
      : { ...common, kind: "answer", route: "answer" };
  }

  // A clarification compiled during setup is already the server's terminal
  // decision for this turn. Return the typed plan before any writer, research,
  // action, source lookup, or missing-voice logic can reinterpret the text.
  const authoritativeClarification =
    artifactClarification ??
    (pendingAskOnly ? null : fallthroughClarification);
  if (authoritativeClarification) {
    const contract: TurnContract = { kind: "answer", expectedCount: 0 };
    coworkTelemetry.configure({
      traceId: claimedUserMessageId ?? chatId,
      route: "answer",
      requestedContract: contract,
    });
    return {
      contract,
      existingArtifactIds,
      atomicDraftSet,
      modeledBatchContinuation,
      activeModeledBatchContinuation: null,
      modeledBatchRetryRootUserMessageId: undefined,
      directPostCount,
      modelSourceReference,
      kind: "clarify",
      route: "answer",
      ask: authoritativeClarification,
    };
  }

  // Find-and-model: a "find a top post in my swipe file and rewrite it" turn
  // has NO pre-attached source, so directSource is empty and the fixed-source
  // direct route is rejected. Resolve the source HERE with the same rotation-
  // aware search the heavy loop's prefetch uses, so the discovery-phrased turn
  // qualifies for the direct route and the strong model writes it tool-free.
  // Runs at most once (advances the rotation cursor once); any failure falls
  // through to the heavy loop unchanged (fail-open).
  const wantsFindAndModel =
    !currentModelSource?.post_text.trim() &&
    !modelSourceId &&
    requestsDirectSourceModeling(effectiveUserInstruction);
  const resolvedFindSource = wantsFindAndModel
    ? await resolveFindAndModelSource(workspaceId, setupSignal)
    : undefined;
  const directSource: Source | undefined =
    currentModelSource?.post_text.trim()
      ? {
          id: currentModelSource.source_post_id ?? currentModelSource.id,
          text: currentModelSource.post_text,
        }
      : resolvedFindSource?.source;

  // Stamp the "Source post" chip for a find-and-model draft. The chip is drawn
  // from `modelSourceReference` (tagArtifactWithModelSourceReference below);
  // that's normally set only for a pre-ATTACHED source, so a find-and-model
  // draft would otherwise ship with no chip even though it DID model a real
  // swipe-file post. Only set it when we actually resolved a find source and no
  // attached source already owns the reference.
  if (resolvedFindSource && !modelSourceReference) {
    modelSourceReference = {
      source_post_id: resolvedFindSource.source.id,
      source_url: resolvedFindSource.sourceUrl,
    };
  }

  // Lead-magnet direct route. A lead-magnet post is a from-scratch original post
  // with the giveaway framing. The lead-magnet and creator-style flags are
  // inputs to the single eligibility compiler below so actual routing and
  // missing-voice diagnosis can never drift into different route matrices.
  const activeLeadMagnetForDirect = Boolean(
    activeLeadMagnetCampaign && leadMagnetBlock.trim(),
  );
  const activeCreatorStyleForDirect = Boolean(
    creatorStyleId && !hasModelSource && creatorStyleBlock.trim(),
  );
  const explicitCreateOperation = currentTurnOperation?.kind === "create_post";
  const explicitEditOperation = currentTurnOperation?.kind === "edit_artifact";

  const compileDirectWriterEligibility = (voiceResolved: boolean) => {
    const context = {
      enabled: directWriterEnabled,
      hasAttachments: attachments.length > 0,
      hasLeadMagnet: Boolean(
        shouldAttachLeadMagnet || appliedLeadMagnet || activeLeadMagnetCampaign,
      ),
      hasCreatorStyle: Boolean(creatorStyleId),
      voiceResolved,
    };
    const refineInput = {
      ...context,
      isRefine: skipDecision,
      refineInstruction: refineInstruction ?? "",
      targetResolved: trustedRefineTarget !== null,
      targetKind:
        trustedRefineTarget?.kind === "post" ||
        trustedRefineTarget?.kind === "hook"
          ? trustedRefineTarget.kind
          : null,
      targetHasLeadMagnet: Boolean(trustedRefineTarget?.meta?.lead_magnet),
      hasModelSource: Boolean(modelSourceId),
    };
    const commandEditEligible = Boolean(
      explicitEditOperation &&
        currentTurnOperation?.kind === "edit_artifact" &&
        currentTurnOperation.editMode !== undefined &&
        voiceResolved &&
        trustedRefineTarget?.kind === "post" &&
        attachments.length === 0 &&
        !context.hasLeadMagnet &&
        !context.hasCreatorStyle,
    );
    const supportedRefineTarget =
      !explicitEditOperation || trustedRefineTarget?.kind === "post";
    const directRefine =
      supportedRefineTarget &&
      (commandEditEligible || isDirectRefineEligible(refineInput));
    // A resolved refine rejected only by the strict instruction-shape gate can
    // still use the full-post rewrite lane, but it must retain edit identity.
    const generalRefine =
      supportedRefineTarget &&
      !directRefine &&
      isGeneralRefineEligible(refineInput);
    const directPartial = isDirectPartialTextEligible({
      ...context,
      userInstruction: effectiveUserInstruction,
      sourceRequested: Boolean(modelSourceId),
      sourceResolved: Boolean(directSource),
      isRefine: skipDecision,
    });
    // The explicit `create` command may claim the turn for the tool-less
    // direct writer ONLY when the typed instruction itself needs no tools.
    // requiresLiveNewsOrResearch applies the same live-news/research text
    // gates isDirectOriginalPostEligible applies on the free-text path —
    // without it, a typed "Newsjack a recent event… search verified news
    // first" was claimed here and the writer (which has no search_news tool)
    // could only refuse, instead of routing to news_research. A research
    // starter chip already blocks via researchRequirement; a plain typed
    // brief matches neither pattern and keeps the fast path.
    const commandCreateEligible = Boolean(
      explicitCreateOperation &&
        voiceResolved &&
        attachments.length === 0 &&
        !composerTaskContext?.researchRequirement &&
        !requiresLiveNewsOrResearch(effectiveUserInstruction),
    );
    const directMulti = Boolean(
      commandCreateEligible && (directPostCount ?? 1) > 1,
    ) || isDirectMultiPostEligible({
      ...context,
      userInstruction: effectiveUserInstruction,
      sourceRequested: Boolean(modelSourceId),
      sourceResolved: Boolean(directSource),
      isRefine: skipDecision,
      requestedCount: directPostCount ?? undefined,
      composerTaskContext: composerTaskContext ?? undefined,
    });
    const directStructureSource = Boolean(
      voiceResolved &&
        !modeledBatchContractRequested &&
        !skipDecision &&
        structureMatch &&
        directSource &&
        !isOpinionOrQuestionAboutContent(effectiveUserInstruction) &&
        // Same live-news/research gate as commandCreateEligible above: the
        // embedding structure matcher can auto-match a builtin template for a
        // newsjack brief, and without this the tool-less writer claimed the
        // turn and could only SIMULATE the search it needs — prod shipped a
        // draft whose whole body was '[search_news(query="…")]'.
        !requiresLiveNewsOrResearch(effectiveUserInstruction) &&
        (composerTaskContext?.kind === "post" ||
          requestsFullPostDeliverable(effectiveUserInstruction) ||
          directPostCount === 1),
    );
    const directSourceEligible =
      Boolean(commandCreateEligible && directSource && (directPostCount ?? 1) === 1) ||
      isDirectFixedSourcePostEligible({
        ...context,
        userInstruction: effectiveUserInstruction,
        sourceResolved: Boolean(directSource),
        isRefine: skipDecision,
      }) ||
      (Boolean(resolvedFindSource) &&
        isDirectFindAndModelEligible({
          ...context,
          userInstruction: effectiveUserInstruction,
          sourceResolved: Boolean(directSource),
          isRefine: skipDecision,
        })) ||
      directStructureSource;
    const directOriginal = Boolean(
      commandCreateEligible && !directSource && (directPostCount ?? 1) === 1,
    ) || isDirectOriginalPostEligible({
      userInstruction: effectiveUserInstruction,
      requestedCount: directPostCount ?? undefined,
      ...context,
      hasModelSource: Boolean(modelSourceId),
      isRefine: skipDecision,
      composerTaskContext: composerTaskContext ?? undefined,
    });
    const directLeadMagnet = Boolean(
      activeLeadMagnetForDirect &&
        isDirectLeadMagnetEligible({
          userInstruction: effectiveUserInstruction,
          ...context,
          hasModelSource: Boolean(modelSourceId),
          isRefine: skipDecision,
        }),
    );
    const directCreatorStyle = Boolean(
      activeCreatorStyleForDirect &&
        isDirectOriginalPostEligible({
          userInstruction: effectiveUserInstruction,
          requestedCount: directPostCount ?? undefined,
          ...context,
          hasCreatorStyle: false,
          hasModelSource: Boolean(modelSourceId),
          isRefine: skipDecision,
          composerTaskContext: composerTaskContext ?? undefined,
        }),
    );

    return {
      useDirectRefine: directRefine,
      useGeneralRefine: generalRefine,
      useDirectPartial: directPartial,
      useDirectMulti: directMulti,
      useDirectSource: directSourceEligible,
      useDirectOriginal: directOriginal,
      useDirectLeadMagnet: directLeadMagnet,
      useDirectCreatorStyle: directCreatorStyle,
      eligible: Boolean(
        directRefine ||
          generalRefine ||
          directPartial ||
          directMulti ||
          directSourceEligible ||
          directOriginal ||
          directLeadMagnet ||
          directCreatorStyle
      ),
    };
  };

  const directWriterEligibility = compileDirectWriterEligibility(
    preloadedVoiceResult?.ok === true,
  );
  const {
    useDirectRefine,
    useGeneralRefine,
    useDirectPartial,
    useDirectMulti,
    useDirectSource,
    useDirectOriginal,
    useDirectLeadMagnet,
    useDirectCreatorStyle,
  } = directWriterEligibility;
  // CENTRAL GATE, by lane family. Every CREATE-family lane already applies
  // the live-news/research gate individually (#1568, #1579) — the tool-less
  // writer can never serve a newsjack/research brief, only simulate the
  // search in-band. Those per-lane gates have been missed TWICE, so the
  // invariant is now also enforced once here: when ONLY create lanes claim
  // and the instruction demands live news/research, the direct writer loses
  // and the grounded read-only route takes over. This is a deliberate no-op
  // on every input reachable today (all create lanes already reject such
  // instructions); it exists so the NEXT claim path added above inherits the
  // gate instead of having to remember it. Refine lanes are untouched:
  // editing an existing draft never needs a search.
  const directRefineClaimed = useDirectRefine || useGeneralRefine;
  const directCreateClaimed =
    useDirectPartial ||
    useDirectMulti ||
    useDirectSource ||
    useDirectOriginal ||
    useDirectLeadMagnet ||
    useDirectCreatorStyle;
  const useDirectWriter =
    !reviewOperation &&
    !modeledBatchContractRequested &&
    directWriterEligibility.eligible &&
    (directRefineClaimed ||
      !directCreateClaimed ||
      !requiresLiveNewsOrResearch(effectiveUserInstruction));
  const directWriterWouldBeEligibleWithVoice =
    compileDirectWriterEligibility(true).eligible;
  const actionOrchestratorRoute: ActionOrchestratorRoute | null = useDirectWriter
    ? null
    : currentTurnOperation
      ? null
      : normalizedActionRoute;

  const useActionOrchestrator = Boolean(
    actionOrchestratorRoute &&
      (deps.actionOrchestratorEnabledForWorkspace() ||
        persistedActionContinuation),
  );
  if (useActionOrchestrator) {
    coworkTelemetry.configure({
      route: "action_orchestrator",
      // Intermediate value only — the single resolveTurnContract call below
      // re-configures telemetry with the same result once routing lands.
      requestedContract: resolveTurnContract({
        actionRoute: actionOrchestratorRoute,
        useActionOrchestrator: true,
      }),
    });
    if (!claimedUserMessageId || !actionRetryRepository) {
      throw new Error("Action retry context could not be scoped to this turn.");
    }
    try {
      await actionRetryRepository.saveContext({
        workspaceId,
        chatId,
        userMessageId: claimedUserMessageId,
        rootTurnMessageId: actionTurnMessageId ?? claimedUserMessageId,
        effectiveInstruction: effectiveUserInstruction,
        route: actionOrchestratorRoute!,
        confirmedTargetIds: confirmedActionTargetIds,
        signal: setupSignal,
      });
    } catch {
      const actionSetupExpired = setupDeadline?.didExpire() ?? false;
      const actionRequestAborted = setupSignal.aborted;
      const message = actionSetupExpired
        ? "Cowork took too long to prepare this board action. Please retry."
        : actionRequestAborted
          ? "The board action was cancelled before it started."
          : "I couldn’t persist the safety context for this board action, so nothing was changed. Send it again to retry safely.";
      await deps.persistChatSetupFailure({
        sb: sbRaw,
        chatId,
        workspaceId,
        content: `⚠️ ${message}`,
      });
      await coworkTelemetry.finish({
        deliveredContract: {
          kind: "saved_draft_action",
          deliveredCount: 0,
        },
        provenanceStatus: "not_required",
        terminalOutcome: actionSetupExpired
          ? "recoverable_error"
          : actionRequestAborted
            ? "cancelled"
            : "hard_failure",
      });
      await deps.releaseChatTurn(workspaceId, chatId, turnCostOperationKey);

      return turnError(
        message,
        actionSetupExpired ? 504 : actionRequestAborted ? 499 : 503,
      );
    }
  }

  const inferredReadOnlyOrchestratorRoute: ReadOnlyOrchestratorRoute | null =
    useDirectWriter || useActionOrchestrator || skipDecision || reviewOperation
      ? null
      : modeledBatchContinuation?.route ??
        compileReadOnlyOrchestratorRoute({
          userInstruction: effectiveUserInstruction,
          ...(activeDraftCountOverride
            ? { draftCountOverride: activeDraftCountOverride }
            : {}),
          ...(resolvedGenerationConfig?.postType
            ? { explicitPostType: resolvedGenerationConfig.postType }
            : {}),
          isRefine: skipDecision,
          hasModelSource: Boolean(modelSourceId),
          hasAttachments: attachments.length > 0,
          hasLeadMagnet: Boolean(
            shouldAttachLeadMagnet ||
              appliedLeadMagnet ||
              activeLeadMagnetCampaign,
          ),
          hasCreatorStyle: Boolean(creatorStyleId),
          composerTaskContext: composerTaskContext ?? undefined,
        });

  const readOnlyOrchestratorRoute: ReadOnlyOrchestratorRoute | null =
    explicitCreateOperation && attachments.length > 0
      ? {
          ...(inferredReadOnlyOrchestratorRoute?.kind === "file_inspection"
            ? inferredReadOnlyOrchestratorRoute
            : {
                kind: "file_inspection" as const,
                allowExternalSearch: false,
                allowedSearchKinds: [],
              }),
          outcome: {
            kind: "draft",
            expectedDrafts: directPostCount ?? 1,
          },
        }
      : inferredReadOnlyOrchestratorRoute;


  const modeledBatchRouteContract = continuationForModeledDraftRoute(
    readOnlyOrchestratorRoute,
  );
  const deterministicModeledRoute = Boolean(
    modeledBatchContinuation ||
      modeledBatchRouteContract ||
      (readOnlyOrchestratorRoute &&
        compileModeledPostIntent(effectiveUserInstruction, {
          draftCountOverride: activeDraftCountOverride,
        }).kind !== "none"),
  );
  // Re-running the same eligibility compiler with only voice marked available
  // distinguishes a real writing request with a missing prerequisite from a
  // compound/brainstorm request intentionally left to the answer lane.
  const writingOperationRequested = Boolean(
    directWriterWouldBeEligibleWithVoice ||
      explicitCreateOperation ||
      skipDecision ||
      modeledBatchContractRequested ||
      deterministicModeledRoute,
  );
  if (writingOperationRequested && preloadedVoiceResult?.ok !== true) {
    // A missing voice profile is never transient — retrying re-runs the exact
    // same lookup and fails the exact same way every time, so offering "Retry"
    // is a loop with no exit. loadVoiceProfile marks that case with a `status`
    // key on the tool result (lib/agent/tools.ts); a transient load failure
    // (err() shape, no `status`) keeps the recoverable 503 path below.
    const noReadyVoiceProfile =
      preloadedVoiceResult !== null && "status" in preloadedVoiceResult;
    if (noReadyVoiceProfile) {
      const message =
        "This needs a voice profile to write in your voice, and your workspace doesn't have one yet. Head to the Voice tab to generate one, then send this again.";
      await deps.persistChatSetupFailure({
        sb: sbRaw,
        chatId,
        workspaceId,
        content: `⚠️ ${message}`,
      });
      await coworkTelemetry.finish({
        deliveredContract: {
          kind: "post",
          deliveredCount: 0,
        },
        provenanceStatus: "missing",
        terminalOutcome: "hard_failure",
      });
      await deps.releaseChatTurn(workspaceId, chatId, turnCostOperationKey);

      return turnError(message, 422);
    }
    const message = modeledBatchContinuation
      ? "I couldn’t load the writing context required to resume this modeled set safely. Retry will continue the same saved batch."
      : deterministicModeledRoute
        ? "I couldn’t load the writing context required to start this modeled set safely. Retry will try the request again without creating a partial set."
        : "I couldn’t load the writing context required for this Post safely. Please retry.";
    await deps.persistChatSetupFailure({
      sb: sbRaw,
      chatId,
      workspaceId,
      content: `⚠️ ${message}`,
      recoverable: {
        code: "modeled_batch_context_unavailable",
        message,
        retryRootUserMessageId:
          actionTurnMessageId ?? claimedUserMessageId ?? undefined,
        ...(modeledBatchContinuation
          ? {
              continuation: modeledBatchContinuation,
            }
          : {}),
      },
    });
    await coworkTelemetry.finish({
      deliveredContract: {
        kind: "post",
        deliveredCount: 0,
      },
      provenanceStatus: "missing",
      terminalOutcome: "recoverable_error",
    });
    await deps.releaseChatTurn(workspaceId, chatId, turnCostOperationKey);

    return turnError(message, 503);
  }

  const useReadOnlyOrchestrator = Boolean(
    readOnlyOrchestratorRoute &&
      (readOnlyOrchestratorRoute.outcome?.kind !== "draft" ||
        preloadedVoiceResult?.ok === true) &&
      (Boolean(modeledBatchRouteContract) ||
        deterministicModeledRoute ||
        deps.readOnlyOrchestratorEnabledForWorkspace()),
  );
  // A completed lane is never authority for the next turn. If the current
  // message does not identify an operation on its own, stop before any model or
  // tool can guess whether to create, edit, research, or mutate board state.
  const clarificationAsk =
    currentTurnOperation?.kind === "edit_artifact" &&
      trustedRefineTarget?.kind !== "post"
      ? {
          question: "Which Post should I edit?",
          options: ["Edit the latest chat Post", "Cancel"],
          choiceIds: ["edit.latest_post", "cancel"],
          doneOption: "Cancel",
          allowOther: false,
        }
      : currentTurnOperation?.kind === "review_artifact" &&
      (!currentTurnOperation.artifactId || !trustedRefineTarget)
      ? {
          question: "Which Post should I review?",
          options: ["Review the latest Post", "Cancel"],
          choiceIds: ["review.latest_post", "cancel"],
          doneOption: "Cancel",
          allowOther: false,
        }
      : currentTurnOperation?.kind === "create_post" &&
          !useDirectWriter &&
          !useReadOnlyOrchestrator
      ? {
          question: "What topic or angle should the new post cover?",
          options: ["Choose a topic from my profile", "Cancel"],
          choiceIds: ["create.profile_topic", "cancel"],
          doneOption: "Cancel",
          allowOther: true,
        }
      : skipDecision && !useDirectWriter
        ? trustedRefineTarget
        ? {
            question:
              "This turn includes extra source or attachment context that the in-place editor cannot apply safely. How should I proceed?",
            options: [
              "Edit the current Post without the extra context",
              "Cancel",
            ],
            choiceIds: [
              "edit.ignore_extra_context",
              "cancel",
            ],
            doneOption: "Cancel",
            allowOther: false,
          }
        : {
            question: "Which Post should I edit?",
            options: ["Edit the latest chat Post", "Cancel"],
            choiceIds: ["edit.latest_post", "cancel"],
            doneOption: "Cancel",
            allowOther: false,
          }
      : !useDirectWriter &&
          !useActionOrchestrator &&
          !useReadOnlyOrchestrator &&
          !pendingAskOnly
        ? fallthroughClarification ??
          clarificationForAmbiguousContinuation(effectiveUserInstruction)
        : null;

  const directWriterTask: WriterTask = useDirectRefine
    ? {
        kind: "refine",
        instruction: refineInstruction!,
        focus:
          currentTurnOperation?.kind === "edit_artifact" &&
          currentTurnOperation.editMode
            ? currentTurnOperation.editMode === "hook_only"
              ? "hook"
              : "general"
            : classifyDirectRefineFocus(refineInstruction!),
        target: trustedRefineTarget as Artifact & { kind: "post" | "hook" },
      }
    : useGeneralRefine
      ? {
          // Fallback refine: always a full-post rewrite (never a hook/CTA
          // splice), so it safely handles compound/removal instructions while
          // still editing the SAME artifact in place.
          kind: "refine",
          instruction: refineInstruction!,
          focus: "general",
          target: trustedRefineTarget as Artifact & { kind: "post" | "hook" },
        }
    : useDirectPartial
      ? {
          kind: "partial",
          spec: directPartialSpec!,
          ...(directSource ? { source: directSource } : {}),
        }
      : useDirectMulti
        ? {
            kind: "multi",
            expectedCount: directPostCount!,
            ...(directSource ? { source: directSource } : {}),
          }
        : useDirectSource
          ? { kind: "source", source: directSource! }
          : { kind: "original" };

  const coworkRoute: CoworkRoute = useDirectWriter
    ? "direct_writer"
    : useActionOrchestrator
      ? "action_orchestrator"
      : useReadOnlyOrchestrator
        ? "read_only_orchestrator"
        : "answer";

  // THE single authoritative deliverable contract for this turn
  // (PLAN-cowork-unification Phase 1, step 3): computed ONCE, here —
  // post-clarification and post-routing — from the same
  // effectiveUserInstruction the executors consume. The only other contract
  // value in the turn is the telemetry placeholder above, produced by this
  // same builder and overwritten here.
  const turnContract: TurnContract = clarificationAsk
    ? { kind: "answer", expectedCount: 0 }
    : resolveTurnContract({
    directWriterTask: useDirectWriter ? directWriterTask : null,
    actionRoute: actionOrchestratorRoute,
    useActionOrchestrator,
    readOnlyRoute: readOnlyOrchestratorRoute,
    useReadOnlyOrchestrator,
    hasPartialSpec: directPartialSpec !== null,
    fallbackPostCount:
      activeDraftCountOverride ??
      postClarificationPostCount ??
      (skipDecision ? 1 : null),
      });
  coworkTelemetry.configure({
    traceId: claimedUserMessageId ?? chatId,
    route: coworkRoute,
    requestedContract: turnContract,
  });

  const activeModeledBatchContinuation = useReadOnlyOrchestrator
    ? modeledBatchRouteContract
    : null;
  const modeledBatchRetryRootUserMessageId = activeModeledBatchContinuation
    ? actionTurnMessageId ?? claimedUserMessageId ?? undefined
    : undefined;

  const commonPlan: TurnPlanCommon = {
    contract: turnContract,
    existingArtifactIds,
    atomicDraftSet,
    modeledBatchContinuation,
    activeModeledBatchContinuation,
    modeledBatchRetryRootUserMessageId,
    directPostCount,
    modelSourceReference,
  };

  if (useDirectWriter) {
    return {
      ...commonPlan,
      kind: "write",
      route: "direct_writer",
      task: directWriterTask,
      isDirectRefine: useDirectRefine,
      usesLeadMagnet: useDirectLeadMagnet,
      usesCreatorStyle: useDirectCreatorStyle,
    };
  }
  if (useActionOrchestrator && actionOrchestratorRoute) {
    return {
      ...commonPlan,
      kind: "action",
      route: "action_orchestrator",
      actionRoute: actionOrchestratorRoute,
    };
  }
  if (useReadOnlyOrchestrator && readOnlyOrchestratorRoute) {
    return {
      ...commonPlan,
      kind: "research",
      route: "read_only_orchestrator",
      researchRoute: readOnlyOrchestratorRoute,
    };
  }
  if (clarificationAsk) {
    return {
      ...commonPlan,
      kind: "clarify",
      route: "answer",
      ask: clarificationAsk,
    };
  }
  return { ...commonPlan, kind: "answer", route: "answer" };
}

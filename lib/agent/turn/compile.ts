import type { SupabaseClient } from "@supabase/supabase-js";
import {
  explicitlyForbidsSourceDiscovery,
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
import type { Artifact } from "@/lib/agent/contracts";
import type { PostType } from "@/lib/post-type";
import type { ComposerTaskContext } from "@/lib/composer-task-context";
import type { Source, WriterTask } from "@/lib/agent/execute/writer";
import type { CoworkRoute } from "@/lib/agent/cowork-telemetry";
import type { ModelSourceReference } from "@/lib/agent/turn/context";
import type { TurnSetupResult } from "@/lib/agent/turn/setup";

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
export type TurnContractKind =
  | "post"
  | "partial"
  | "research"
  | "saved_draft_action"
  | "answer";

export type TurnContract = {
  kind: TurnContractKind;
  expectedCount: number;
};

/**
 * Structural view of the direct-writer task: the contract only reads the task
 * kind and, for multi-draft tasks, the slot count. Kept structural (instead
 * of importing DraftEngineTask) so the compile module stays free of executor
 * dependencies while the full TurnPlan type lands in later steps.
 */
export type TurnContractDirectTask = {
  kind: string;
  expectedCount?: number;
};

export type BoardMoveStatus = "idea" | "drafting" | "ready";

/** Action orchestrator is part of the unified path; no rollout gating remains. */
export function actionOrchestratorEnabledForWorkspace(): boolean {
  return true;
}

export type ActionRequirement =
  | { type: "move_on_board"; status: BoardMoveStatus }
  | { type: "schedule_post"; date: string | null; timeZone?: string };

export type ActionOrchestratorRoute =
  | {
      kind: "action_management";
      targetCount: number;
      requirements: ActionRequirement[];
    }
  | {
      kind: "clarify_action";
      clarificationReason: "date" | "target_count" | "action";
      remainingClarifications?: Array<"date" | "target_count" | "action">;
      partialRequirements?: ActionRequirement[];
      partialTargetCount?: number | null;
    }
  | {
      kind: "no_action";
      noActionReason: "negated" | "informational" | "cancelled" | "mixed_count";
    }
  | {
      kind: "disallowed_action";
      disallowedReason: "publish" | "save" | "delete" | "posted";
    };

export type ActionOrchestratorRoutingInput = {
  userInstruction: string;
  isRefine: boolean;
  hasModelSource: boolean;
  hasAttachments: boolean;
  hasLeadMagnet: boolean;
  hasCreatorStyle: boolean;
  hasUnsavedDraftReferent?: boolean;
  clientTimezone?: string;
};

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
  return route.expectsDraft
    ? { kind: "post", expectedCount: route.expectedDrafts ?? 1 }
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
  expectsDraft: boolean;
  expectedDrafts?: number;
  allowExternalSearch?: boolean;
  allowedSearchKinds?: Array<"news" | "web" | "workspace">;
  minimumSources?: number;
  workspaceSearchMode?: "diverse" | "strict_top";
  workspaceSince?: "1d" | "7d" | "30d";
  workspacePostType?: PostType;
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
  // This orchestrator owns researched drafts only. Plain answer/ideas turns are
  // routed to the deterministic answer lane, so they never reach here.
  if (!context || context.kind !== "post" || !requirement) return null;
  if (requirement.lane === "workspace") {
    return {
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts: context.expectedDraftCount,
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
    expectsDraft: true,
    expectedDrafts: context.expectedDraftCount,
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
  /\b(?:summari[sz]e|compare|analy[sz]e|explain|tell\s+me|show\s+me|list|report|recommend|answer|give\s+me\s+(?:the\s+)?(?:findings|takeaways|results|lessons))\b/i;
const NEGATED_POST_OUTCOME_RE =
  /\b(?:do\s+not|don(?:'|’)?t|dont|never)\s+(?:write|draft|create|generate|make|produce|prepare|model|mimic|adapt|rewrite|rework|remix|replicate|turn)\b/i;
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
  const forbidsDiscovery = explicitlyForbidsSourceDiscovery(instruction);
  const modeledIntent = forbidsDiscovery
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
      expectsDraft: false,
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
  if (
    NEGATED_POST_OUTCOME_RE.test(instruction) &&
    EXPLICIT_NON_POST_OUTCOME_RE.test(instruction)
  ) {
    return null;
  }

  if (modeledIntent.kind === "ambiguous") {
    return {
      kind: "ambiguous_read_only",
      expectsDraft: false,
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
  const workspacePostType = sourceModelingRequest
    ? (modeledIntent.sourcePostType ??
      requestedWorkspacePostType(researchClause))
    : requestedWorkspacePostType(researchClause);
  const writingOutputClause = instruction.match(
    /\b(?:write|draft|create|generate|make|produce|prepare|give\s+me)\b[\s\S]{0,180}?\b(?:linkedin\s+)?posts?\b/i,
  )?.[0] ?? "";
  const hasPluralPostTarget = /\b(?:linkedin\s+)?posts\b/i.test(
    writingOutputClause,
  );
  const unresolvedPluralDraftTarget =
    !sourceModelingRequest &&
    FULL_POST_REQUEST_RE.test(instruction) &&
    hasPluralPostTarget &&
    explicitDraftCount === null;
  const expectsDraft =
    sourceModelingRequest ||
    (FULL_POST_REQUEST_RE.test(instruction) &&
      (!hasPluralPostTarget || explicitDraftCount !== null));
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
  const needsWorkspaceResearch =
    sourceModelingRequest ||
    ((explicitlyRequestsSourceDiscovery(instruction) ||
      OUTPUT_FIRST_SOURCE_DISCOVERY_RE.test(instruction)) &&
    (MULTI_SOURCE_RE.test(researchClause) ||
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
    (RESEARCH_RE.test(researchClause) || needsNews) &&
    HISTORY_DEPENDENT_RESEARCH_RE.test(researchClause)
  ) {
    return null;
  }

  if (!expectsDraft) {
    return unresolvedPluralDraftTarget ||
      (complexRead && !EXPLICIT_NON_POST_OUTCOME_RE.test(instruction))
      ? {
          kind: "ambiguous_read_only",
          expectsDraft: false,
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
      expectsDraft: true,
      expectedDrafts,
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
        expectsDraft: false,
        clarificationReason: "research_topic",
      };
    }
    return {
      kind: "news_research",
      expectsDraft: true,
      expectedDrafts,
      ...(input.explicitPostType ? { explicitPostType: input.explicitPostType } : {}),
    };
  }
  if (needsWorkspaceResearch) {
    return {
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts,
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
        expectsDraft: false,
        clarificationReason: "research_topic",
      };
    }
    return {
      kind: "web_research",
      expectsDraft: true,
      expectedDrafts,
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

export type TurnPlan = {
  route: CoworkRoute;
  contract: TurnContract;
  // Direct writer
  useDirectWriter: boolean;
  directWriterTask: WriterTask;
  useDirectRefine: boolean;
  useDirectLeadMagnet: boolean;
  useDirectCreatorStyle: boolean;
  // Action orchestrator
  useActionOrchestrator: boolean;
  actionOrchestratorRoute: ActionOrchestratorRoute | null;
  // Read-only orchestrator
  useReadOnlyOrchestrator: boolean;
  readOnlyOrchestratorRoute: ReadOnlyOrchestratorRoute | null;
  modeledBatchContinuation: ModeledDraftBatchContinuation | null;
  activeModeledBatchContinuation: ModeledDraftBatchContinuation | null;
  modeledBatchRetryRootUserMessageId: string | undefined;
  // Shared execution inputs
  directPostCount: number | null;
  modelSourceReference: ModelSourceReference | null;
};

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
  setup: TurnSetupResult,
  chatId: string,
  retryOfUserMessageId: string | undefined,
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
    creatorStyleId,
    hasModelSource,
    turnCostOperationKey,
    claimedUserMessageId,
    actionTurnMessageId,
    normalizedActionRoute,
    confirmedActionTargetIds,
    actionRetryRepository,
    persistedActionContinuation,
    pendingActionAsk,
    pendingAskOnly,
    modeledBatchContinuation,
    modeledBatchContractRequested,
    setupDeadline,
    setupSignal,
    postClarificationPostCount,
    pinnedCoworkRoute,
    coworkTelemetry,
    currentModelSource,
    modelSourceReference: initialModelSourceReference,
    effectiveUserInstruction,
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

  // Direct writer is the unified drafting path; the COWORK_THIN_PATH rollout
  // flag has been removed and lean mode is no longer forced (default false).
  const directWriterEnabled = true;
  const directPartialSpec = compileDirectPartialTextSpec(
    effectiveUserInstruction,
  );
  const directPostCount =
    activeDraftCountOverride ??
    (composerTaskContext?.kind === "post"
      ? composerTaskContext.expectedDraftCount
      : null) ??
    requestedDirectPostCount(effectiveUserInstruction);

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

  const directWritingContext = {
    enabled: directWriterEnabled,
    hasAttachments: attachments.length > 0,
    hasLeadMagnet: Boolean(
      shouldAttachLeadMagnet || appliedLeadMagnet || activeLeadMagnetCampaign,
    ),
    hasCreatorStyle: Boolean(creatorStyleId),
    voiceResolved: preloadedVoiceResult?.ok === true,
  };

  const useDirectRefine = isDirectRefineEligible({
    ...directWritingContext,
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
  });
  const useDirectPartial = isDirectPartialTextEligible({
    ...directWritingContext,
    userInstruction: effectiveUserInstruction,
    sourceRequested: Boolean(modelSourceId),
    sourceResolved: Boolean(directSource),
    isRefine: skipDecision,
  });
  const useDirectMulti = isDirectMultiPostEligible({
    ...directWritingContext,
    userInstruction: effectiveUserInstruction,
    sourceRequested: Boolean(modelSourceId),
    sourceResolved: Boolean(directSource),
    isRefine: skipDecision,
    requestedCount: directPostCount ?? undefined,
    composerTaskContext: composerTaskContext ?? undefined,
  });
  // Server-selected structure match: the user asked for an original post, but
  // the deterministic matcher found a strong template/swipe/built-in source.
  // Treat it as a fixed-source direct write so the source's structure is
  // actually modeled rather than silently ignored.
  const useDirectStructureSource = Boolean(
    !modeledBatchContractRequested &&
      !skipDecision &&
      structureMatch &&
      directSource &&
      (composerTaskContext?.kind === "post" ||
        requestsFullPostDeliverable(effectiveUserInstruction) ||
        directPostCount === 1),
  );

  const useDirectSource =
    isDirectFixedSourcePostEligible({
      ...directWritingContext,
      userInstruction: effectiveUserInstruction,
      sourceResolved: Boolean(directSource),
      isRefine: skipDecision,
    }) ||
    // Find-and-model: source was resolved up front by resolveFindAndModelSource,
    // so the discovery-phrasing turn now qualifies for the direct route instead
    // of the heavy GLM render loop.
    (Boolean(resolvedFindSource) &&
      isDirectFindAndModelEligible({
        ...directWritingContext,
        userInstruction: effectiveUserInstruction,
        sourceResolved: Boolean(directSource),
        isRefine: skipDecision,
      })) ||
    useDirectStructureSource;
  const useDirectOriginal = isDirectOriginalPostEligible({
    userInstruction: effectiveUserInstruction,
    requestedCount: directPostCount ?? undefined,
    ...directWritingContext,
    // Intent must fail closed here. A supplied source/style id can resolve to
    // nothing (deleted, not ready, or outside the workspace); that still means
    // the user requested context the direct engine does not own.
    hasModelSource: Boolean(modelSourceId),
    isRefine: skipDecision,
    composerTaskContext: composerTaskContext ?? undefined,
  });

  // Lead-magnet direct route. A lead-magnet post is a from-scratch original post
  // with the giveaway framing. The direct engine injects that framing
  // (leadMagnetBlock) and the CTA is HARD-enforced downstream by
  // transformDraftCandidate (rejects a draft that doesn't mention the resource),
  // so a lead-magnet post can be written by the strong model without ever
  // shipping without its comment-CTA.
  const activeLeadMagnetForDirect = Boolean(
    activeLeadMagnetCampaign && leadMagnetBlock.trim(),
  );
  const useDirectLeadMagnet =
    activeLeadMagnetForDirect &&
    isDirectLeadMagnetEligible({
      userInstruction: effectiveUserInstruction,
      ...directWritingContext,
      hasModelSource: Boolean(modelSourceId),
      isRefine: skipDecision,
    });

  // Creator-style direct route. A creator-style post is a from-scratch original
  // post that borrows another creator's WRITING MECHANICS (hooks, cadence,
  // formatting) for the user's own topic. The direct engine injects that
  // mechanics-only block (creatorStyleBlock), so the strong model can write it.
  // Reuses the original-post eligibility with hasCreatorStyle forced false (the
  // engine owns it now). No hard CTA-style guard is needed — creator style
  // shapes rhythm, it has no mandatory element to enforce; the block's own
  // wrapper already forbids copying the creator's topics/claims.
  const activeCreatorStyleForDirect = Boolean(
    creatorStyleId && !hasModelSource && creatorStyleBlock.trim(),
  );
  const useDirectCreatorStyle =
    activeCreatorStyleForDirect &&
    isDirectOriginalPostEligible({
      userInstruction: effectiveUserInstruction,
      requestedCount: directPostCount ?? undefined,
      ...directWritingContext,
      hasCreatorStyle: false,
      hasModelSource: Boolean(modelSourceId),
      isRefine: skipDecision,
      composerTaskContext: composerTaskContext ?? undefined,
    });

  let useDirectWriter =
    !modeledBatchContractRequested &&
    (useDirectRefine ||
      useDirectPartial ||
      useDirectMulti ||
      useDirectSource ||
      useDirectOriginal ||
      useDirectLeadMagnet ||
      useDirectCreatorStyle);
  let actionOrchestratorRoute: ActionOrchestratorRoute | null = useDirectWriter
    ? null
    : normalizedActionRoute;

  // Session-sticky lane pinning: unless this turn is explicitly continuing a
  // saved workflow (retry, action clarification, or any pending ask answer),
  // reuse the chat's pinned lane. The compiler stays authoritative for the
  // contract/count; the pin only selects the lane. "answer" is allowed in the
  // schema but never pinned, so it is treated as no preference.
  const hasExplicitWorkflowContinuation =
    Boolean(retryOfUserMessageId) || pendingActionAsk || pendingAskOnly;
  const honorPinnedRoute =
    pinnedCoworkRoute &&
    !hasExplicitWorkflowContinuation &&
    pinnedCoworkRoute !== "answer";
  if (honorPinnedRoute) {
    // The pin never overrides an explicit research requirement: a starter that
    // asks for workspace/web/news evidence must actually RUN that research.
    // Pinning it to the writer lane would silently free-write with no sources
    // (and no research narration — the "Planning next moves → draft" jump).
    if (
      pinnedCoworkRoute === "direct_writer" &&
      !composerTaskContext?.researchRequirement
    ) {
      useDirectWriter = true;
    } else if (
      pinnedCoworkRoute === "action_orchestrator" &&
      !actionOrchestratorRoute
    ) {
      actionOrchestratorRoute = {
        kind: "clarify_action",
        clarificationReason: "action",
      };
    }
  }

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

  let readOnlyOrchestratorRoute: ReadOnlyOrchestratorRoute | null =
    useDirectWriter || useActionOrchestrator
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

  if (
    honorPinnedRoute &&
    pinnedCoworkRoute === "read_only_orchestrator" &&
    !readOnlyOrchestratorRoute
  ) {
    readOnlyOrchestratorRoute = {
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts: directPostCount ?? 1,
      minimumSources: 2,
      workspaceSearchMode: "diverse",
    };
  }

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
  if (deterministicModeledRoute && preloadedVoiceResult?.ok !== true) {
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
      : "I couldn’t load the writing context required to start this modeled set safely. Retry will try the request again without creating a partial set.";
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
      preloadedVoiceResult?.ok === true &&
      (Boolean(modeledBatchRouteContract) ||
        deterministicModeledRoute ||
        deps.readOnlyOrchestratorEnabledForWorkspace()),
  );

  const directWriterTask: WriterTask = useDirectRefine
    ? {
        kind: "refine",
        instruction: refineInstruction!,
        focus: classifyDirectRefineFocus(refineInstruction!),
        target: trustedRefineTarget as Artifact & { kind: "post" },
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
  const turnContract: TurnContract = resolveTurnContract({
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

  return {
    route: coworkRoute,
    contract: turnContract,
    useDirectWriter,
    directWriterTask,
    useDirectRefine,
    useDirectLeadMagnet,
    useDirectCreatorStyle,
    useActionOrchestrator,
    actionOrchestratorRoute,
    useReadOnlyOrchestrator,
    readOnlyOrchestratorRoute,
    modeledBatchContinuation,
    activeModeledBatchContinuation,
    modeledBatchRetryRootUserMessageId,
    directPostCount,
    modelSourceReference,
  };
}

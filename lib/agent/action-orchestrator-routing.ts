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

import { stripArtifactFences } from "@/lib/artifact-fences";
import type { Artifact, AskQuestion, PlanStep } from "@/lib/agent/contracts";
import { isNoModelFormatId, noModelFormatLabel } from "@/lib/agent/no-model-format-catalog";
import { recoverDoneOption } from "@/lib/chat-ask";
import type { LeadMagnetResourceType } from "@/lib/lead-magnets";
import type { ContentFormat } from "@/lib/markdown/mode";
import {
  parseCoworkTurnUsage,
  type CoworkTurnUsage,
} from "@/lib/cowork-turn-usage";

export type AppliedLeadMagnet = {
  id?: string;
  title: string;
  selection: "manual" | "auto";
  publicSlug?: string | null;
  selectionSummary?: string | null;
  deliverables?: string[];
  resourceType?: LeadMagnetResourceType;
  estimatedMinutes?: number | null;
};

export type ToolChip = {
  id: string;
  name: string;
  args?: string;
  ok?: boolean;
  summary?: string;
};

export type RecoverableError = {
  code: string;
  message: string;
  recovery: "continue";
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  contentFormat?: ContentFormat;
  clientTurnId?: string;
  transportRecoveryRequested?: boolean;
  userStopRequested?: boolean;
  terminalReason?: "done" | "ask" | "cancelled" | "deadline" | "error";
  files?: string[];
  skills?: string[];
  postFormat?: string;
  creatorStyle?: { name: string; creatorName: string | null };
  leadMagnet?: AppliedLeadMagnet;
  tools?: ToolChip[];
  plan?: PlanStep[];
  artifacts?: Artifact[];
  draftRendered?: boolean;
  ask?: AskQuestion;
  recoverable?: RecoverableError;
  usage?: CoworkTurnUsage;
  streaming?: boolean;
};

export type ChatRun = {
  userMsg: Message;
  assistantId: string;
  rawText: string;
  contentFormat?: ContentFormat;
  tools: ToolChip[];
  plan: PlanStep[];
  artifacts: Artifact[];
  ask?: AskQuestion;
  recoverable?: RecoverableError;
  usage?: CoworkTurnUsage;
  stopped?: boolean;
  streaming: boolean;
  ctrl: AbortController;
  clientTurnId?: string;
  stopPending?: boolean;
  turnStartedAt?: string;
};

export type RawDbMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  content_format?: ContentFormat | "legacy" | null;
  artifacts: Artifact[] | null;
  client_turn_id?: string | null;
  transport_recovery_requested_at?: string | null;
  user_stop_requested_at?: string | null;
  terminal_reason?: "done" | "ask" | "cancelled" | "deadline" | "error" | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[] | null;
};

export function applyPersistedUserMessageId(
  run: Pick<ChatRun, "userMsg">,
  persistedUserMessageId: string | null,
): void {
  if (!persistedUserMessageId) return;
  run.userMsg = { ...run.userMsg, id: persistedUserMessageId };
}

export function retryTaskText(
  messages: Message[],
  failedAssistantId: string,
): string {
  return retryTask(messages, failedAssistantId)?.text ?? "";
}

export function retryTask(
  messages: Message[],
  failedAssistantId: string,
): { userMessageId: string; text: string } | null {
  const failedIndex = messages.findIndex(
    (message) => message.id === failedAssistantId,
  );
  if (failedIndex < 0) return null;
  for (let index = failedIndex - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user" && message.text.trim()) {
      return { userMessageId: message.id, text: message.text.trim() };
    }
  }
  return null;
}

export function persistedRetryTaskForUserMessage(
  messages: Message[],
  userMessage: Message,
): { userMessageId: string; text: string } | null {
  const userIndex = messages.findIndex(
    (message) =>
      message.role === "user" &&
      (message.id === userMessage.id ||
        Boolean(
          message.clientTurnId &&
            userMessage.clientTurnId &&
            message.clientTurnId === userMessage.clientTurnId,
        )),
  );
  if (userIndex < 0) return null;
  const user = messages[userIndex];
  if (user.userStopRequested) return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      user.id,
    )
  ) {
    return null;
  }
  const afterUser = messages.slice(userIndex + 1);
  const nextUserIndex = afterUser.findIndex(
    (message) => message.role === "user",
  );
  const terminal = afterUser
    .slice(0, nextUserIndex >= 0 ? nextUserIndex : undefined)
    .find((message) => message.role === "assistant");
  if (!terminal) return null;
  const confirmedCancelled =
    terminal.recoverable ||
    (user.transportRecoveryRequested && terminal.terminalReason === "cancelled");
  if (!confirmedCancelled) return null;
  return { userMessageId: user.id, text: user.text.trim() };
}

export function stripAskQuestionFromText(text: string, question: string): string {
  const trimmedText = text.trim();
  const trimmedQuestion = question.trim();
  if (!trimmedText || !trimmedQuestion) return text;
  if (trimmedText === trimmedQuestion) return "";
  if (!trimmedText.endsWith(trimmedQuestion)) return text;
  return trimmedText.slice(0, -trimmedQuestion.length).trimEnd();
}

function toolArgs(
  toolCalls: RawDbMessage["tool_calls"],
  name: string,
): Record<string, unknown> | undefined {
  const call = toolCalls?.find((candidate) => candidate.function?.name === name);
  if (!call) return undefined;
  try {
    return JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractPersistedAsk(
  calls: RawDbMessage["tool_calls"],
): AskQuestion | undefined {
  const args = toolArgs(calls, "ask_user");
  if (!args) return undefined;
  const question = typeof args.question === "string" ? args.question : "";
  const options = Array.isArray(args.options)
    ? args.options.filter((option): option is string => typeof option === "string")
    : [];
  if (!question || options.length < 2) return undefined;
  const doneOption =
    args.actionLane === true
      ? typeof args.doneOption === "string"
        ? args.doneOption
        : undefined
      : recoverDoneOption(
          options,
          typeof args.doneOption === "string" ? args.doneOption : undefined,
        );
  const optionIds = Array.isArray(args.candidateDraftIds)
    ? args.candidateDraftIds.filter(
        (draftId): draftId is string => typeof draftId === "string",
      )
    : [];
  return {
    question,
    options,
    allowOther: args.allowOther !== false,
    ...(args.multiSelect === true ? { multiSelect: true } : {}),
    ...(typeof args.targetCount === "number" ? { targetCount: args.targetCount } : {}),
    ...(optionIds.length === options.length ? { optionIds } : {}),
    ...(doneOption ? { doneOption } : {}),
  };
}

function extractPersistedSkills(calls: RawDbMessage["tool_calls"]): string[] | undefined {
  const args = toolArgs(calls, "_custom_skills_applied");
  const names = Array.isArray(args?.names)
    ? args.names.filter((name): name is string => typeof name === "string")
    : [];
  return names.length > 0 ? names : undefined;
}

function extractPersistedRecoverable(
  calls: RawDbMessage["tool_calls"],
): RecoverableError | undefined {
  const args = toolArgs(calls, "_recoverable");
  const message = typeof args?.message === "string" ? args.message : "";
  if (!message) return undefined;
  return {
    code: typeof args?.code === "string" ? args.code : "",
    message,
    recovery: "continue",
  };
}

function extractPersistedTurnUsage(
  calls: RawDbMessage["tool_calls"],
): CoworkTurnUsage | undefined {
  return parseCoworkTurnUsage(toolArgs(calls, "_turn_usage")) ?? undefined;
}

function extractPersistedPostFormat(
  calls: RawDbMessage["tool_calls"],
): string | undefined {
  const args = toolArgs(calls, "_post_format_selected");
  if (!args) return undefined;
  if (typeof args.label === "string" && args.label.trim()) return args.label.trim();
  return isNoModelFormatId(args.id) ? noModelFormatLabel(args.id) : undefined;
}

export function extractPersistedCreatorStyle(
  calls: RawDbMessage["tool_calls"],
): { name: string; creatorName: string | null } | undefined {
  const args = toolArgs(calls, "_creator_style_selected");
  const name = typeof args?.name === "string" ? args.name.trim() : "";
  if (!name) return undefined;
  return {
    name,
    creatorName:
      typeof args?.creatorName === "string" && args.creatorName.trim()
        ? args.creatorName.trim()
        : null,
  };
}

export function extractPersistedLeadMagnet(
  calls: RawDbMessage["tool_calls"],
): AppliedLeadMagnet | undefined {
  const args = toolArgs(calls, "_lead_magnet_selected");
  const id = typeof args?.id === "string" ? args.id.trim() : "";
  const title = typeof args?.title === "string" ? args.title.trim() : "";
  if (!title) return undefined;
  const deliverables = Array.isArray(args?.deliverables)
    ? args.deliverables
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
        .slice(0, 6)
    : [];
  const publicSlug =
    typeof args?.publicSlug === "string" && args.publicSlug.trim()
      ? args.publicSlug.trim()
      : "";
  const selectionSummary =
    typeof args?.selectionSummary === "string" && args.selectionSummary.trim()
      ? args.selectionSummary.trim()
      : "";
  const estimatedMinutes = Number(args?.estimatedMinutes);
  return {
    ...(id ? { id } : {}),
    title,
    selection: args?.selection === "manual" ? "manual" : "auto",
    ...(publicSlug ? { publicSlug } : {}),
    ...(selectionSummary ? { selectionSummary } : {}),
    ...(deliverables.length ? { deliverables } : {}),
    ...(typeof args?.resourceType === "string"
      ? { resourceType: args.resourceType as LeadMagnetResourceType }
      : {}),
    ...(Number.isFinite(estimatedMinutes) && estimatedMinutes > 0
      ? { estimatedMinutes: Math.round(estimatedMinutes) }
      : {}),
  };
}

export function hydrate(rows: RawDbMessage[]): Message[] {
  const visible = rows.filter(
    (row) => row.role === "user" || row.role === "assistant",
  );
  return visible.map((row, index) => {
    const isLast = index === visible.length - 1;
    const pairedUser =
      row.role === "assistant"
        ? visible
            .slice(0, index)
            .reverse()
            .find((candidate) => candidate.role === "user")
        : undefined;
    const parsedAsk =
      row.role === "assistant" ? extractPersistedAsk(row.tool_calls) : undefined;
    const text =
      row.role === "assistant" ? stripArtifactFences(row.content) : row.content;
    const recoverable =
      row.role === "assistant" &&
      isLast &&
      !pairedUser?.user_stop_requested_at
        ? extractPersistedRecoverable(row.tool_calls)
        : undefined;
    const usage =
      row.role === "assistant"
        ? extractPersistedTurnUsage(row.tool_calls)
        : undefined;
    const skills =
      row.role === "user" ? extractPersistedSkills(row.tool_calls) : undefined;
    const postFormat =
      row.role === "user" ? extractPersistedPostFormat(row.tool_calls) : undefined;
    const creatorStyle =
      row.role === "user" ? extractPersistedCreatorStyle(row.tool_calls) : undefined;
    const leadMagnet =
      row.role === "user" ? extractPersistedLeadMagnet(row.tool_calls) : undefined;
    return {
      id: row.id,
      role: row.role as "user" | "assistant",
      text: parsedAsk
        ? stripAskQuestionFromText(text, parsedAsk.question)
        : text,
      artifacts: row.artifacts ?? undefined,
      ...(row.role === "assistant" &&
      (row.content_format === "markdown" || row.content_format === "plain")
        ? { contentFormat: row.content_format }
        : {}),
      ...(row.role === "user" && row.client_turn_id
        ? { clientTurnId: row.client_turn_id }
        : {}),
      ...(row.role === "user" && row.transport_recovery_requested_at
        ? { transportRecoveryRequested: true }
        : {}),
      ...(row.role === "user" && row.user_stop_requested_at
        ? { userStopRequested: true }
        : {}),
      ...(row.role === "assistant" && row.terminal_reason
        ? { terminalReason: row.terminal_reason }
        : {}),
      ...(parsedAsk && isLast ? { ask: parsedAsk } : {}),
      ...(recoverable ? { recoverable } : {}),
      ...(usage ? { usage } : {}),
      ...(skills?.length ? { skills } : {}),
      ...(postFormat ? { postFormat } : {}),
      ...(creatorStyle ? { creatorStyle } : {}),
      ...(leadMagnet ? { leadMagnet } : {}),
    };
  });
}

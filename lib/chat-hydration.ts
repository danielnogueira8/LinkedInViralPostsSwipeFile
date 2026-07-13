import { stripArtifactFences } from "@/lib/artifact-fences";
import type { Artifact, AskQuestion, PlanStep } from "@/lib/agent/contracts";
import { isNoModelFormatId, noModelFormatLabel } from "@/lib/agent/no-model-format-catalog";
import { recoverDoneOption } from "@/lib/chat-ask";
import type { LeadMagnetResourceType } from "@/lib/lead-magnets";

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
  files?: string[];
  skills?: string[];
  postFormat?: string;
  creatorStyle?: { name: string; creatorName: string | null };
  leadMagnet?: AppliedLeadMagnet;
  tools?: ToolChip[];
  plan?: PlanStep[];
  artifacts?: Artifact[];
  ask?: AskQuestion;
  recoverable?: RecoverableError;
  streaming?: boolean;
};

export type ChatRun = {
  userMsg: Message;
  assistantId: string;
  rawText: string;
  tools: ToolChip[];
  plan: PlanStep[];
  artifacts: Artifact[];
  ask?: AskQuestion;
  recoverable?: RecoverableError;
  stopped?: boolean;
  streaming: boolean;
  ctrl: AbortController;
  turnStartedAt?: string;
};

export type RawDbMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  artifacts: Artifact[] | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[] | null;
};

export function retryTaskText(
  messages: Message[],
  failedAssistantId: string,
): string {
  const failedIndex = messages.findIndex(
    (message) => message.id === failedAssistantId,
  );
  if (failedIndex < 0) return "";
  for (let index = failedIndex - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user" && message.text.trim()) return message.text.trim();
  }
  return "";
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
  const doneOption = recoverDoneOption(
    options,
    typeof args.doneOption === "string" ? args.doneOption : undefined,
  );
  return {
    question,
    options,
    allowOther: args.allowOther !== false,
    ...(args.multiSelect === true ? { multiSelect: true } : {}),
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
    const parsedAsk =
      row.role === "assistant" ? extractPersistedAsk(row.tool_calls) : undefined;
    const text =
      row.role === "assistant" ? stripArtifactFences(row.content) : row.content;
    const recoverable =
      row.role === "assistant" && isLast
        ? extractPersistedRecoverable(row.tool_calls)
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
      ...(parsedAsk && isLast ? { ask: parsedAsk } : {}),
      ...(recoverable ? { recoverable } : {}),
      ...(skills?.length ? { skills } : {}),
      ...(postFormat ? { postFormat } : {}),
      ...(creatorStyle ? { creatorStyle } : {}),
      ...(leadMagnet ? { leadMagnet } : {}),
    };
  });
}

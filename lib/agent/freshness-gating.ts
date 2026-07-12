import type { ChatMessage } from "@/lib/openrouter";

// Only render_post produces a draft card now — hooks are plain reply text
// (render_hook removed).
const DRAFT_RENDER_TOOLS = new Set(["render_post"]);

const SPECIALIZED_WRITING_PATTERN =
  /\b(?:newsjack|brandjack|namejack|lead[ -]?magnet|giveaway|ghostwrite)\b/i;

const DRAFT_ACTION_PATTERN =
  /\b(?:write|draft|create|generate|compose|rewrite|refine|adapt|model|mimic|turn|convert|transform)\b[\s\S]{0,80}\b(?:post|posts|draft|drafts|hook|hooks|caption|carousel|content|thread|lead[ -]?magnet|giveaway)\b|\b(?:post|posts|draft|drafts|hook|hooks|caption|carousel|content|thread|lead[ -]?magnet|giveaway)\b[\s\S]{0,80}\b(?:write|draft|create|generate|compose|rewrite|refine|adapt|model|mimic|turn|convert|transform)\b/i;

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
      block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

function unresolvedUserText(history: ChatMessage[]): string {
  const userTurns: string[] = [];

  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (
      message.role === "assistant" &&
      (message.tool_calls ?? []).some((call) =>
        DRAFT_RENDER_TOOLS.has(call.function?.name ?? ""),
      )
    ) {
      break;
    }
    if (message.role === "user") userTurns.push(messageText(message));
  }

  return userTurns.reverse().join("\n");
}

export function isDraftCapableTurn(opts: {
  history: ChatMessage[];
  isRefine?: boolean;
  hasModelSource?: boolean;
  noModelFormatBlock?: string;
  leadMagnetBlock?: string;
  creatorStyleBlock?: string;
  customSkillNames?: string[];
  customSkillBodies?: string[];
}): boolean {
  if (opts.isRefine) return false;

  if (
    opts.hasModelSource ||
    opts.noModelFormatBlock?.trim() ||
    opts.leadMagnetBlock?.trim() ||
    opts.creatorStyleBlock?.trim() ||
    opts.customSkillNames?.length ||
    opts.customSkillBodies?.length
  ) {
    return true;
  }

  const unresolvedText = unresolvedUserText(opts.history);
  return (
    SPECIALIZED_WRITING_PATTERN.test(unresolvedText) ||
    DRAFT_ACTION_PATTERN.test(unresolvedText)
  );
}

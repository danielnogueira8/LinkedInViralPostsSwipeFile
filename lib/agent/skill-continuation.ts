import { selectSkills, type Skill } from "@/lib/agent/skills";
import type { ChatMessage } from "@/lib/openrouter";

const CONTINUATION_LOOKBACK_TURNS = 8;
const DELIVERABLE_TOOLS = new Set(["render_post", "render_hook", "render_cite"]);

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join(" ");
}

export function findOpenSpecializedSkill(
  history: ChatMessage[],
  isEligible: (skill: Skill, instruction: string) => boolean = () => true,
): Skill | null {
  let userTurnsChecked = 0;
  for (
    let index = history.length - 1;
    index >= 0 && userTurnsChecked < CONTINUATION_LOOKBACK_TURNS;
    index--
  ) {
    const message = history[index];
    if (message.role === "assistant") {
      const delivered = (message.tool_calls ?? []).some((call) =>
        DELIVERABLE_TOOLS.has(call.function?.name ?? ""),
      );
      if (delivered) return null;
      continue;
    }
    if (message.role !== "user") continue;
    const instruction = messageText(message);
    const specialized = selectSkills(instruction).find(
      (skill) => skill.specialized && isEligible(skill, instruction),
    );
    if (specialized) return specialized;
    userTurnsChecked++;
  }
  return null;
}

import { latestUserText } from "@/lib/agent/history";
import type { ChatMessage } from "@/lib/openrouter";

export const SHORTEN_REFINE_MAX_RATIO = 0.85;

export function shortenRefineContext(
  history: ChatMessage[],
): { originalLength: number } | null {
  const text = latestUserText(history);
  const match = text.match(
    /^Refine this (?:post|hook): ([\s\S]*?)\n\nKeep it in my voice\. Here's the current (?:post|hook):\n"""\n([\s\S]*)\n"""$/,
  );
  if (!match) return null;
  const [, instruction, body] = match;
  if (instruction.includes("Rewrite ONLY the hook")) return null;
  if (!/\bshort(?:er|en)\w*|\btrim\b|\bcondense|\bconcise\b|\bcut it down\b/i.test(instruction)) {
    return null;
  }
  return { originalLength: body.length };
}

export function contentTaskHeuristic(history: ChatMessage[]): boolean {
  const text = latestUserText(history).trim();
  if (!text || text.length < 14) return false;
  return /\b(find|search|look|pull|grab|show|give|get|fetch|list|what|which|write|draft|create|make|adapt|mimic|model|rewrite|template|hooks?|post|posts|ideas?|niche|brand|voice|namejack|brandjack|brand[- ]?jack)\b/i.test(
    text,
  );
}

export function announcesToolUse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 320) return false;
  return (
    /\b(i'?ll|i will|i'?m going to|i am going to|let me|first,? i'?ll|i'?ll start by)\b/i.test(
      trimmed,
    ) &&
    /\b(pull|search|look|find|check|fetch|grab|load|read|scan|review|gather|retriev)/i.test(
      trimmed,
    )
  );
}

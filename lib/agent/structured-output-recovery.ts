import type { AskQuestion } from "@/lib/agent/contracts";
import {
  buildAskQuestion,
  isTerminalAskOption,
} from "@/lib/agent/ask-policy";
import { looksCorruptedDraft } from "@/lib/agent/specialists/nets";

const MAX_ASK_OPTIONS = 6;
const MAX_ASK_OPTION_LEN = 80;
const MAX_PLAN_STEPS = 8;
const MAX_PLAN_LABEL_LEN = 80;

export function promoteLeakedDraft(
  text: string,
): { body: string; note: string; kind: "post" } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let splitAt = -1;
  const ruleMatch = [...trimmed.matchAll(/(^|\n)\s*-{3,}\s*(\n|$)/g)].pop();
  if (ruleMatch?.index !== undefined) {
    splitAt = ruleMatch.index + ruleMatch[0].length;
  } else {
    const colonMatch = [
      ...trimmed.matchAll(/(^|\n)([^\n]{0,160}:)\s*\n\s*\n/g),
    ].pop();
    if (colonMatch?.index !== undefined) {
      splitAt = colonMatch.index + colonMatch[0].length;
    }
  }
  if (splitAt < 0) return null;
  const note = trimmed.slice(0, splitAt).replace(/\s*-{3,}\s*$/, "").trim();
  const body = trimmed.slice(splitAt).trim();
  if (/```/.test(body) || looksCorruptedDraft(body)) return null;
  if (body.length >= 200 && (/\n[ \t]*\n/.test(body) || body.length >= 400)) {
    return { body, note, kind: "post" };
  }
  return null;
}

function extractTrailingJsonBlock(
  text: string,
): { parsed: unknown; note: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = [
    ...trimmed.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g),
  ].pop();
  let json: string | null = null;
  let start = -1;
  if (fenced?.index !== undefined) {
    json = fenced[1];
    start = fenced.index;
  } else {
    const brace = trimmed.lastIndexOf("{");
    if (brace >= 0 && trimmed.endsWith("}")) {
      json = trimmed.slice(brace);
      start = brace;
    }
  }
  if (!json) return null;
  try {
    return {
      parsed: JSON.parse(json),
      note: trimmed.slice(0, start).replace(/\s*-{3,}\s*$/, "").trim(),
    };
  } catch {
    return null;
  }
}

const LEAKED_CALL_RE =
  /(?:^|\n|\s)(?:start)?call\s*:\s*(?:default_api\s*[.:]\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/;

function parseLeakedCallSyntax(
  text: string,
): { tool: string; args: Record<string, unknown>; note: string } | null {
  const trimmed = text.trim();
  const match = LEAKED_CALL_RE.exec(trimmed);
  if (!match || match.index === undefined) return null;
  const braceStart = match.index + match[0].length - 1;
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceEnd <= braceStart) return null;
  const inner = trimmed.slice(braceStart + 1, braceEnd);
  const segments: string[] = [];
  let depth = 0;
  let segmentStart = 0;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index];
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    else if (
      char === "," &&
      depth === 0 &&
      /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(inner.slice(index + 1))
    ) {
      segments.push(inner.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }
  segments.push(inner.slice(segmentStart));
  const args: Record<string, unknown> = {};
  for (const segment of segments) {
    const pair = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:([\s\S]*)$/.exec(segment);
    if (!pair) return null;
    const raw = pair[2].trim();
    if (/^\[[\s\S]*\]$/.test(raw)) {
      args[pair[1]] = raw
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (raw === "true" || raw === "false") {
      args[pair[1]] = raw === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
      args[pair[1]] = Number(raw);
    } else {
      args[pair[1]] = raw;
    }
  }
  return {
    tool: match[1],
    args,
    note: trimmed.slice(0, match.index).replace(/\s*-{3,}\s*$/, "").trim(),
  };
}

export function stripLeakedCallSyntax(text: string): string {
  const trimmed = text.trim();
  const match = LEAKED_CALL_RE.exec(trimmed);
  if (!match || match.index === undefined) return text;
  return trimmed.slice(0, match.index).replace(/\s*-{3,}\s*$/, "").trim();
}

function promoteNaturalLanguageMenu(
  text: string,
): { question: string; options: string[]; note: string } | null {
  const lead = /(?:^|\n)\s*(?:if\s+you\s+(?:want|like|prefer|'?d\s+like)|want\s+me\s+to|i\s+can\s+(?:also\s+)?(?:do|try|help\s+with)|here'?s?\s+what\s+i\s+can\s+do|a\s+few\s+(?:things|options)\s+i\s+could\s+do|next\s+(?:steps?|up)|from\s+here\s+i\s+can|would\s+you\s+like\s+me\s+to|happy\s+to)\b[^\n:]*:\s*(?:\n|$)/i.exec(
    text,
  );
  if (!lead || lead.index === undefined) return null;
  const options: string[] = [];
  for (const line of text.slice(lead.index + lead[0].length).split(/\n/)) {
    const bullet = /^(?:[-*•–·]\s+)(.+)$/.exec(line.trim());
    if (bullet) {
      const label = bullet[1].trim();
      if (label && label.length <= MAX_ASK_OPTION_LEN) options.push(label);
    } else if (line.trim() && options.length > 0) {
      break;
    }
  }
  if (
    options.length < 2 ||
    options.length > MAX_ASK_OPTIONS ||
    !options.some(isTerminalAskOption)
  ) {
    return null;
  }
  return {
    question: lead[0].trim().replace(/:\s*$/, "").trim(),
    options,
    note: text.slice(0, lead.index).trim(),
  };
}

export function promoteLeakedAsk(
  text: string,
): { ask: AskQuestion; note: string } | null {
  let parsed: unknown;
  let note = "";
  const found = extractTrailingJsonBlock(text);
  if (found) {
    ({ parsed, note } = found);
  } else {
    const options = text.match(/\n\s*(?:[-*]\s*)?(\[(?:"(?:[^"\\]|\\.)*"\s*,?\s*){2,}\])\s*\(set multiSelect:\s*(true|false)\)/i);
    const done = text.match(/doneOption:\s*"([^"]+)"/i);
    if (options) {
      try {
        const before = text.slice(0, options.index).trim();
        const lines = before
          .split(/\n+/)
          .map((line) => line.trim())
          .filter((line) => line && !/^[•*\-]+$/.test(line));
        const question = lines.at(-1) ?? "";
        parsed = {
          question,
          options: JSON.parse(options[1]),
          multiSelect: options[2].toLowerCase() === "true",
          ...(done ? { doneOption: done[1] } : {}),
        };
        note = before.slice(0, Math.max(0, before.length - question.length)).trim();
      } catch {
        return null;
      }
    } else {
      const menu = promoteNaturalLanguageMenu(text);
      if (menu) {
        parsed = { question: menu.question, options: menu.options, multiSelect: true };
        note = menu.note;
      } else {
        const call = parseLeakedCallSyntax(text);
        if (!call || call.tool !== "ask_user") return null;
        parsed = call.args;
        note = call.note;
      }
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.question !== "string" || !Array.isArray(record.options)) {
    return null;
  }
  const built = buildAskQuestion(record);
  return "ask" in built ? { ask: built.ask, note } : null;
}

export function promoteLeakedPlan(
  text: string,
): { steps: string[]; note: string } | null {
  const found = extractTrailingJsonBlock(text);
  const call = found ? null : parseLeakedCallSyntax(text);
  if (!found && (!call || call.tool !== "write_plan")) return null;
  const parsed = found?.parsed ?? call?.args;
  const note = found?.note ?? call?.note ?? "";
  if (!parsed || typeof parsed !== "object") return null;
  const raw = (parsed as Record<string, unknown>).steps;
  if (!Array.isArray(raw)) return null;
  const steps = raw
    .map((step) => (typeof step === "string" ? step.trim() : ""))
    .filter(Boolean)
    .slice(0, MAX_PLAN_STEPS)
    .map((step) => step.slice(0, MAX_PLAN_LABEL_LEN));
  return steps.length >= 2 ? { steps, note } : null;
}

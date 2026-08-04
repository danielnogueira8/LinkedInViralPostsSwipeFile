import type { ChatMessage } from "@/lib/openrouter";
import { MAX_HISTORY_USER_TURNS } from "@/lib/agent/history";

// Compacting the transcript instead of silently truncating it.
//
// windowChatHistory keeps the last MAX_HISTORY_USER_TURNS user turns and drops
// everything older. That bound is right — an unbounded transcript eventually
// exceeds the model's window and burns cost on every turn — but the DROP was
// silent and total: at user turn 21, turn 1 simply ceased to exist. Asking
// "remember that client result I mentioned earlier?" worked at turn 15 and
// failed at turn 25, and the agent could not tell the difference between "you
// never said that" and "I can no longer see it".
//
// So summarize what falls out of the window into a short block that rides in
// the system prompt. Cost stays roughly flat (a few hundred tokens replacing
// thousands), and a reference to something said an hour ago still resolves.
//
// Deliberately extractive, not generative. The compaction runs on EVERY turn
// of a long chat, so a model call here would add latency and cost to exactly
// the conversations that are already the most expensive. Pulling the durable
// facts out with rules is cheaper, faster, and — most importantly — cannot
// hallucinate a detail the user never said, which in a memory block would be
// worse than forgetting.

/** Hard cap so a very long chat cannot grow the system prompt without bound. */
export const MAX_COMPACTED_CHARS = 1_400;
/** Never summarize fewer than this many dropped turns — not worth the tokens. */
const MIN_DROPPED_TURNS_TO_COMPACT = 2;
const MAX_FACTS = 12;
const MAX_FACT_CHARS = 160;

function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text?: unknown }).text ?? "")
          : "",
      )
      .join(" ");
  }
  return "";
}

/**
 * The turns windowChatHistory will discard: everything before the cut that
 * keeps the last `maxUserTurns` user messages.
 *
 * Mirrors windowChatHistory's own scan so the two cannot disagree about where
 * the boundary is — a mismatch would either double-count a turn or lose one in
 * the gap between them.
 */
export function droppedHistory(
  history: readonly ChatMessage[],
  maxUserTurns: number = MAX_HISTORY_USER_TURNS,
): ChatMessage[] {
  if (maxUserTurns <= 0) return [];
  let userTurns = 0;
  let cutIndex = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role !== "user") continue;
    userTurns += 1;
    if (userTurns === maxUserTurns) {
      cutIndex = index;
      break;
    }
  }
  return cutIndex > 0 ? history.slice(0, cutIndex) : [];
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

// A user line worth remembering states something durable — a fact about their
// business, a preference, a decision — rather than issuing an instruction that
// was already carried out ("make it shorter", "post 2").
const DURABLE_USER_RE =
  /\b(?:i|we|my|our)\b[\s\S]{0,60}\b(?:am|are|is|was|were|have|has|had|run|ran|work|worked|built|build|launched|sold|charge|charged|prefer|hate|love|want|need|use|used|client|clients|company|team|business|agency|product|revenue|customers?)\b/i;
// Numbers and proper nouns are the details a user most often refers back to.
const CONCRETE_RE =
  /\d|\b[A-Z][a-z]{2,}\b/;
// Pure instructions: already executed, and useless as memory.
const INSTRUCTION_ONLY_RE =
  /^(?:ok|okay|yes|no|sure|thanks|thank you|got it|perfect|nice|great|cool|do it|go ahead|continue|next|shorter|longer|again|retry|post \d+|option \d+|[\d\s.,!?]*)$/i;

/**
 * Pull the durable facts out of the dropped turns.
 *
 * User messages only. An assistant message is the agent's own output — folding
 * it back in as "memory" would let the agent's past guesses harden into
 * remembered fact, which is how a small early error becomes a permanent one.
 */
export function extractDurableFacts(dropped: readonly ChatMessage[]): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const message of dropped) {
    if (message.role !== "user") continue;
    const raw = clean(textOf(message));
    if (!raw || INSTRUCTION_ONLY_RE.test(raw)) continue;
    for (const sentence of raw.split(/(?<=[.!?])\s+/)) {
      const candidate = clean(sentence);
      if (candidate.length < 15) continue;
      if (!DURABLE_USER_RE.test(candidate)) continue;
      if (!CONCRETE_RE.test(candidate)) continue;
      const key = candidate.toLowerCase().slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(truncate(candidate, MAX_FACT_CHARS));
      if (facts.length >= MAX_FACTS) return facts;
    }
  }
  return facts;
}

/**
 * Render the block injected into the system prompt, or "" when there is
 * nothing worth carrying.
 *
 * The wording matters: it tells the model these are notes from a transcript it
 * can no longer see, so it neither treats them as the current request nor
 * claims the user never mentioned them.
 */
export function compactedHistoryBlock(
  history: readonly ChatMessage[],
  maxUserTurns: number = MAX_HISTORY_USER_TURNS,
): string {
  const dropped = droppedHistory(history, maxUserTurns);
  const droppedUserTurns = dropped.filter(
    (message) => message.role === "user",
  ).length;
  if (droppedUserTurns < MIN_DROPPED_TURNS_TO_COMPACT) return "";
  const facts = extractDurableFacts(dropped);
  if (facts.length === 0) return "";

  const lines = [
    "EARLIER IN THIS CONVERSATION",
    `The ${droppedUserTurns} turns before this point are no longer shown in full. What the user said then:`,
    ...facts.map((fact) => `- ${fact}`),
    "Treat these as things the user already told you: reference them when relevant, and never claim they were not mentioned. They are notes, not the current request.",
  ];
  let block = lines.join("\n");
  if (block.length > MAX_COMPACTED_CHARS) {
    // Drop whole facts from the end rather than cutting one mid-sentence.
    const trimmed = [...facts];
    while (trimmed.length > 1 && block.length > MAX_COMPACTED_CHARS) {
      trimmed.pop();
      block = [
        lines[0],
        lines[1],
        ...trimmed.map((fact) => `- ${fact}`),
        lines[lines.length - 1],
      ].join("\n");
    }
  }
  return block;
}

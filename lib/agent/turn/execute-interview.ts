import { supabaseAdmin } from "@/lib/supabase";
import {
  CHAT_MODEL,
  logOpenRouterUsage,
  streamChat,
  type ChatMessage,
  type Usage,
} from "@/lib/openrouter";
import { routesToNativeOpenAI } from "@/lib/openai";
import { createWorkspaceKnowledgeStore } from "@/lib/content-learning/workspace-knowledge";
import {
  normalizeChatInterviewAnswers,
  saveChatInterviewKnowledge,
  type ChatInterviewAnswer,
} from "@/lib/content-learning/chat-interview-knowledge";
import { INTERVIEW_QUESTIONS } from "@/lib/voice-interview";
import type { AgentEvent, AskQuestion } from "@/lib/agent/contracts";
import type { TurnExecuteContext } from "@/lib/agent/turn/state";

// ---------------------------------------------------------------------------
// The interview turn executor — the "Interview me" workflow's lane. The chat
// agent's lanes are server-compiled (the model never calls tools freely), so
// the interview is a small state machine driven by this executor:
//
//   model reply (STRICT JSON) → server acts:
//   {"action":"ask",  question, examples, total} → emit the interview AskCard
//   {"action":"save", answers:[…]}               → accumulate Workspace Knowledge
//   {"action":"chat", text}                      → ordinary reply (off-script)
//
// Progress (Question N of M) is counted from the persisted interview cards in
// the chat history, and "what's already known" is injected server-side every
// turn — the two things the shipped tool-prompt version could not do from the
// tool-less answer lane.
// ---------------------------------------------------------------------------

/** Free-text requests that route to the interview lane (starter not required). */
export const INTERVIEW_REQUEST_RE =
  /\binterview\s+me\b|\binterview\s+myself\b|\bask\s+me\s+(?:some\s+)?questions?\s+about\s+me\b/i;

/** True when a persisted ask_user tool-call's args belong to the interview lane. */
export function isInterviewAskArgs(args: Record<string, unknown> | null | undefined): boolean {
  return args?.variant === "interview";
}

/**
 * Count interview questions from raw persisted rows. This must NOT run on the
 * turn's model history: sanitizeToolProtocolHistory strips tool_calls from
 * ask-only assistant rows (they have no matching tool result), which reset
 * the count to 0 every turn — the "always Question 1 of 4" bug.
 */
export function countInterviewQuestionsInRows(
  rows: Array<{ tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> | null }>,
): number {
  let count = 0;
  for (const row of rows) {
    for (const call of row.tool_calls ?? []) {
      if (call.function?.name !== "ask_user") continue;
      try {
        const args = JSON.parse(call.function.arguments ?? "") as Record<string, unknown>;
        if (isInterviewAskArgs(args)) count += 1;
      } catch {
        // A malformed persisted card can't advance the counter.
      }
    }
  }
  return count;
}

/** How many interview questions have already been asked in this chat (DB truth). */
async function countPersistedInterviewQuestions(
  workspaceId: string,
  chatId: string,
): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from("chat_messages")
    .select("tool_calls")
    .eq("workspace_id", workspaceId)
    .eq("chat_id", chatId)
    .eq("role", "assistant")
    .not("tool_calls", "is", null)
    .limit(200);
  if (error) {
    console.warn("[interview] question count query failed", error.message);
    return 0;
  }
  return countInterviewQuestionsInRows(
    (data ?? []) as Array<{ tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> | null }>,
  );
}

// The interview's running question target. The model proposes, the server
// clamps — a runaway "47 questions" plan never reaches the card.
export const INTERVIEW_MIN_QUESTIONS = 3;
export const INTERVIEW_MAX_QUESTIONS = 5;

export type InterviewOutput =
  | {
      action: "ask";
      question: string;
      examples: string[];
      total: number;
    }
  | { action: "save"; answers: ChatInterviewAnswer[] }
  | { action: "chat"; text: string }
  | { action: "invalid" };

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clampTotal(raw: unknown): number {
  const total = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : INTERVIEW_MAX_QUESTIONS;
  return Math.min(INTERVIEW_MAX_QUESTIONS, Math.max(INTERVIEW_MIN_QUESTIONS, total));
}

export function parseInterviewOutput(text: string): InterviewOutput {
  const parsed = extractJson(text);
  if (typeof parsed !== "object" || parsed === null) return { action: "invalid" };
  const record = parsed as Record<string, unknown>;
  if (record.action === "ask") {
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const examples = (Array.isArray(record.examples) ? record.examples : [])
      .map((example) => (typeof example === "string" ? example.trim() : ""))
      .filter((example) => example.length > 0)
      .slice(0, 4);
    if (!question || examples.length < 2) return { action: "invalid" };
    return {
      action: "ask",
      question: question.slice(0, 500),
      examples,
      total: clampTotal(record.total),
    };
  }
  if (record.action === "save") {
    const answers = normalizeChatInterviewAnswers(record.answers);
    if ("error" in answers) return { action: "invalid" };
    return { action: "save", answers: answers.answers };
  }
  if (record.action === "chat") {
    const chatText = typeof record.text === "string" ? record.text.trim() : "";
    if (!chatText) return { action: "invalid" };
    return { action: "chat", text: chatText.slice(0, 4_000) };
  }
  return { action: "invalid" };
}

const OUTPUT_CONTRACT = `Reply with STRICT JSON only — no prose, no code fences — exactly one of:
{"action":"ask","question":"<the ONE question>","examples":["<short plausible answer>","<another>"],"total":<3-5>}
{"action":"save","answers":[{"question":"...","answer":"...","kind":"story|belief|proof|offer|audience_insight|topic_expertise|prohibition","title":"..."}]}
{"action":"chat","text":"<a normal short reply>"}`;

async function runInterviewModel(input: {
  system: string;
  history: ChatMessage[];
  signal: AbortSignal;
  sessionId: string;
  onModelUsed: (model: string) => void;
}): Promise<{ text: string; model: string; usage: Usage | undefined }> {
  const messages: ChatMessage[] = [
    { role: "system", content: input.system },
    ...input.history,
  ];
  const stream = streamChat({
    cachePrompt: false,
    model: CHAT_MODEL,
    messages,
    signal: input.signal,
    sessionId: input.sessionId,
  });
  let text = "";
  let model = CHAT_MODEL;
  let usage: Usage | undefined;
  for await (const delta of stream) {
    if (delta.model) {
      model = delta.model;
      input.onModelUsed(model);
    }
    if (delta.text) text += delta.text;
    if (delta.usage) usage = delta.usage;
  }
  return { text, model, usage };
}

function interviewAskEvents(ask: AskQuestion): AgentEvent[] {
  const askId = crypto.randomUUID();
  const args = JSON.stringify({
    question: ask.question,
    options: ask.options,
    allowOther: ask.allowOther,
    // Stable ids per option so a persisted interview card can validate a
    // choice-index answer on a follow-up turn (the "stale choice" 409 fired
    // when these were absent).
    choiceIds: ask.options.map((_, index) => `ex.${index}`),
    variant: "interview",
    ...(ask.progress ? { progress: ask.progress } : {}),
  });
  const call = {
    id: askId,
    type: "function" as const,
    function: { name: "ask_user", arguments: args },
  };
  return [
    { type: "tool_start", id: askId, name: "ask_user", args },
    { type: "ask", ask },
    { type: "tool_end", id: askId, name: "ask_user", ok: true },
    {
      type: "done",
      terminalReason: "ask",
      message: {
        content: ask.question,
        tool_calls: [call],
        artifacts: [],
        toolMessages: [
          {
            role: "tool",
            tool_call_id: askId,
            content: JSON.stringify({ ok: true, answer_pending: true }),
          },
        ],
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  ];
}

function doneTextEvents(
  text: string,
  usage: Usage | undefined,
): AgentEvent[] {
  return [
    { type: "text", delta: text },
    {
      type: "done",
      message: {
        content: text,
        tool_calls: null,
        artifacts: [],
        toolMessages: [],
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
    },
  ];
}

export async function* executeInterviewTurn(
  setup: TurnExecuteContext,
  chatId: string,
  signal: AbortSignal,
  onModelUsed: (model: string) => void,
): AsyncGenerator<AgentEvent> {
  const telemetry = setup.coworkTelemetry;
  const startedAt = Date.now();

  // What's already on file — injected server-side so questions stay fresh
  // without the model needing a tool to look it up.
  const store = createWorkspaceKnowledgeStore(supabaseAdmin());
  const [verified, proposed, priorCount] = await Promise.all([
    store.listActive(setup.workspaceId),
    store.listProposed(setup.workspaceId),
    countPersistedInterviewQuestions(setup.workspaceId, chatId),
  ]);
  const knownLines = [...verified, ...proposed]
    .map((item) => `- (${item.kind}, ${item.verification}) ${item.title}`)
    .slice(0, 40);
  const remaining = Math.max(1, INTERVIEW_MAX_QUESTIONS - priorCount);

  const system = [
    "You are Cowork's interviewer. The user asked you to interview them so you have fresher, deeper context for future LinkedIn posts. This is a conversation, not a form: your job is to surface stories, beliefs, proof, and audience insight that could become content angles — then save them.",
    "",
    "GROUND ALREADY COVERED — never ask about any of this:",
    ...INTERVIEW_QUESTIONS.map((question) => `- ${question.prompt}`),
    ...(knownLines.length > 0
      ? ["- Saved knowledge:", ...knownLines]
      : ["- (No knowledge saved yet.)"]),
    "",
    `You have already asked ${priorCount} question${priorCount === 1 ? "" : "s"} in this interview. Aim for ${INTERVIEW_MIN_QUESTIONS}-${INTERVIEW_MAX_QUESTIONS} total; you have at most ${remaining} left.`,
    "",
    "Rules:",
    "- ONE question per ask, specific and angle-hunting: stories with tension (a recent win, a failure that changed an approach, a client who pushed back), beliefs worth posting (a changed mind, common advice they think is wrong), proof (a number or receipt they never posted), craft (a ritual, setup, or decision framework).",
    "- React to what they just said — the best next question usually follows their last answer.",
    "- Skip the standard bio questions entirely (what they do, their audience, their mission) — the Context interview form on the Knowledge page owns those.",
    "- examples must be 2-4 short, plausible answers that jog memory, never the 'right' answer.",
    '- If the user\'s message is "[skipped]", drop that topic and ask about something else.',
    '- If the user\'s message is "[done with the interview]", or they have answered your target, reply with action "save" containing every answered question, distilled faithfully — their facts only, never invented specifics. If they answered nothing at all, close gracefully with action "chat" instead.',
    '- For anything off-script (they ask you something, want to stop before answering, or steer elsewhere) reply with action "chat".',
    "- If an answer is really a durable writing rule (\"never call my clients customers\"), keep it in the answers with kind \"prohibition\".",
    "",
    OUTPUT_CONTRACT,
  ].join("\n");

  const runOnce = (extraInstruction?: string) =>
    runInterviewModel({
      system: extraInstruction ? `${system}\n\n${extraInstruction}` : system,
      history: setup.history,
      signal,
      sessionId: chatId,
      onModelUsed,
    });

  let result = await runOnce();
  let output = parseInterviewOutput(result.text);
  if (output.action === "invalid") {
    // One repair pass — the model's second chance to emit the contract.
    result = await runOnce(
      "Your previous reply was not valid. Reply with STRICT JSON only, matching the contract exactly.",
    );
    output = parseInterviewOutput(result.text);
  }

  const latencyMs = Date.now() - startedAt;
  telemetry.recordAttempt({
    stage: "interview",
    attempt: 1,
    model: result.model,
    provider: routesToNativeOpenAI(result.model) ? "openai" : "openrouter",
    outcome: "accepted",
    latencyMs,
    usage: result.usage,
  });
  await logOpenRouterUsage("cowork_interview", result.model, result.usage, setup.workspaceId, {
    chat_id: chatId,
  });

  if (output.action === "ask") {
    const ask: AskQuestion = {
      question: output.question,
      options: output.examples,
      allowOther: true,
      variant: "interview",
      choiceIds: output.examples.map((_, index) => `ex.${index}`),
      progress: { current: priorCount + 1, total: output.total },
    };
    for (const event of interviewAskEvents(ask)) yield event;
    return;
  }

  if (output.action === "save") {
    const saved = await saveChatInterviewKnowledge({
      store,
      workspaceId: setup.workspaceId,
      answers: output.answers,
    });
    const text =
      saved.length > 0
        ? `That's a wrap — I saved ${saved.length} ${saved.length === 1 ? "item" : "items"} from our conversation as proposed knowledge: ${saved.map((item) => item.title).join(", ")}. Review and approve them on the Knowledge page; nothing reaches your drafts until you do. Want me to draft a post from one of these angles?`
        : "I couldn't save what we collected just now (a storage error). Nothing was lost on my side — say the word and I'll try saving again.";
    for (const event of doneTextEvents(text, result.usage)) yield event;
    return;
  }

  // "chat", or an unparseable reply after the repair pass — show whatever the
  // model said rather than erroring the turn.
  const fallbackText =
    output.action === "chat"
      ? output.text
      : result.text.trim() ||
        "I lost my thread for a second — what would you like to talk about?";
  for (const event of doneTextEvents(fallbackText, result.usage)) yield event;
}

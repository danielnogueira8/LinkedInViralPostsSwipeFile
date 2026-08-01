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
  CHAT_INTERVIEW_MAX_ANSWER_CHARS,
  CHAT_INTERVIEW_MAX_QUESTION_CHARS,
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
//   {"action":"plan", questions:[…]} → emit ONE interview card holding them all
//   {"action":"save", answers:[…]}   → accumulate Workspace Knowledge
//   {"action":"chat", text}          → ordinary reply (off-script)
//
// The whole question set is planned in a single call, and the client card
// walks it locally (see InterviewCard) — advancing a question costs no turn,
// no credit and no latency. Only when the last answer lands does the client
// send one message carrying every Q/A pair, which routes back here as "save".
// So an interview is two model calls total, not one per question.
//
// "What's already known" is injected server-side so the planned questions
// avoid ground the workspace already covers.
// ---------------------------------------------------------------------------

/** Free-text requests that route to the interview lane (starter not required). */
export const INTERVIEW_REQUEST_RE =
  /\binterview\s+me\b|\binterview\s+myself\b|\bask\s+me\s+(?:some\s+)?questions?\s+about\s+me\b/i;

/** True when a persisted ask_user tool-call's args belong to the interview lane. */
export function isInterviewAskArgs(args: Record<string, unknown> | null | undefined): boolean {
  return args?.variant === "interview";
}

// The interview's question target. The model proposes, the server clamps —
// a runaway "47 questions" plan never reaches the card.
//
// (There is no persisted question counter any more: the whole set ships on
// one card and the client tracks its own position, so "Question N of M" is
// local state rather than a DB count replayed every turn.)
export const INTERVIEW_MIN_QUESTIONS = 3;
export const INTERVIEW_MAX_QUESTIONS = 5;

export type InterviewOutput =
  | { action: "plan"; questions: string[] }
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

export function parseInterviewOutput(text: string): InterviewOutput {
  const parsed = extractJson(text);
  if (typeof parsed !== "object" || parsed === null) return { action: "invalid" };
  const record = parsed as Record<string, unknown>;
  if (record.action === "plan") {
    // The model proposes the set, the server validates its bounds: a runaway
    // "47 questions" plan is truncated to the max, while malformed or
    // overlong questions are rejected instead of being silently shortened.
    const rawQuestions = (Array.isArray(record.questions) ? record.questions : [])
      .map((question) => (typeof question === "string" ? question.trim() : ""))
      .filter((question) => question.length > 0);
    if (
      rawQuestions.some(
        (question) =>
          Array.from(question).length > CHAT_INTERVIEW_MAX_QUESTION_CHARS,
      )
    ) {
      return { action: "invalid" };
    }
    const seen = new Set<string>();
    const questions = rawQuestions
      .filter((question) => {
        const key = question.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, INTERVIEW_MAX_QUESTIONS);
    if (questions.length < INTERVIEW_MIN_QUESTIONS) return { action: "invalid" };
    return { action: "plan", questions };
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

export type RawInterviewAnswer = {
  question: string;
  answer: string;
};

export type RawInterviewAnswerExtraction = {
  answers: RawInterviewAnswer[];
  complete: boolean;
};

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.find((block) => block.type === "text")?.text ?? "";
}

function plannedInterviewQuestions(history: ChatMessage[]): string[] {
  for (const message of [...history].reverse()) {
    const call = message.tool_calls?.find(
      (candidate) => candidate.function.name === "ask_user",
    );
    if (!call) continue;
    try {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      if (args.variant !== "interview") continue;
      const questions = Array.isArray(args.questions)
        ? args.questions.filter(
            (question): question is string =>
              typeof question === "string" && question.trim().length > 0,
          )
        : [];
      if (questions.length > 0) return questions.map((question) => question.trim());
      // Cards written before the batched interview shape carry one question
      // instead. Treat that as a one-question plan so the original answer can
      // still be recovered after a reload or deploy.
      const legacyQuestion =
        typeof args.question === "string" ? args.question.trim() : "";
      if (legacyQuestion) return [legacyQuestion];
      continue;
    } catch {
      // A malformed historical ask should not prevent a best-effort parse.
    }
  }
  return [];
}

/**
 * Recover the user's original Q/A pairs from the interview card submission.
 * The save model still chooses the knowledge kind and title, but it must not
 * become the source of truth for the answer itself: a summary here would lose
 * the steps, caveats, names, or numbers the user actually supplied.
 */
export function extractInterviewAnswerSubmissionFromHistory(
  history: ChatMessage[],
): RawInterviewAnswerExtraction {
  const currentUserMessage = [...history]
    .reverse()
    .find((message) => message.role === "user");
  const text = currentUserMessage ? messageText(currentUserMessage) : "";
  if (!text) return { answers: [], complete: false };

  const plannedQuestions = plannedInterviewQuestions(history);
  const markerPattern = /(?:^|\n)Q(\d+): ([^\n]+)\nA\1: /g;
  const markers: Array<{
    questionIndex: number;
    question: string;
    answerStart: number;
    markerStart: number;
  }> = [];
  if (plannedQuestions.length > 0) {
    // Use the persisted card text as the delimiter when it is available. The
    // generic one-line regex cannot parse a question that itself contains a
    // newline, and silently shortening that question would lose provenance.
    let searchFrom = 0;
    for (const [questionIndex, plannedQuestion] of plannedQuestions.entries()) {
      const marker = `Q${questionIndex + 1}: ${plannedQuestion}\nA${questionIndex + 1}: `;
      let markerStart = text.indexOf(marker, searchFrom);
      while (
        markerStart >= 0 &&
        markerStart !== 0 &&
        text.slice(markerStart - 2, markerStart) !== "\n\n"
      ) {
        markerStart = text.indexOf(marker, markerStart + marker.length);
      }
      if (markerStart < 0) continue;
      markers.push({
        questionIndex,
        question: plannedQuestion,
        answerStart: markerStart + marker.length,
        markerStart,
      });
      searchFrom = markerStart + marker.length;
    }
  } else {
    for (const match of text.matchAll(markerPattern)) {
      const questionNumber = Number(match[1]);
      const questionIndex = questionNumber - 1;
      const question = match[2]?.trim() ?? "";
      const markerStart = match.index ?? 0;
      markers.push({
        questionIndex,
        question,
        answerStart: markerStart + match[0].length,
        markerStart,
      });
    }
  }

  const answers: RawInterviewAnswer[] = [];
  let answerOverflowed = false;
  for (const [index, marker] of markers.entries()) {
    const answerEnd = markers[index + 1]?.markerStart ?? text.length;
    const answer = text.slice(marker.answerStart, answerEnd).trim();
    const question = marker.question;
    if (!question || !answer || /^\[skipped\]$/i.test(answer)) continue;
    if (Array.from(answer).length > CHAT_INTERVIEW_MAX_ANSWER_CHARS) {
      answerOverflowed = true;
    }
    answers.push({
      question,
      answer,
    });
  }
  const questionIndexes = new Set(markers.map((marker) => marker.questionIndex));
  return {
    answers,
    complete:
      plannedQuestions.length > 0 &&
      !answerOverflowed &&
      markers.length === plannedQuestions.length &&
      questionIndexes.size === plannedQuestions.length,
  };
}

export function extractInterviewAnswersFromHistory(
  history: ChatMessage[],
): RawInterviewAnswer[] {
  return extractInterviewAnswerSubmissionFromHistory(history).answers;
}

function comparableQuestion(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function fallbackKindForInterviewAnswer(
  source: RawInterviewAnswer,
): ChatInterviewAnswer["kind"] {
  const text = `${source.question} ${source.answer}`.toLowerCase();
  if (/\b(result|proof|metric|number|followers?|revenue|grew|growth|client win)\b/.test(text)) {
    return "proof";
  }
  if (/\b(audience|reader|customer|who do you write for|keeps? them up)\b/.test(text)) {
    return "audience_insight";
  }
  if (/\b(never|don't|do not|refuse|avoid|must not)\b/.test(text)) {
    return "prohibition";
  }
  if (/\b(offer|help|service|sell|work with)\b/.test(text)) return "offer";
  if (/\b(belief|advice|wrong|disagree|opinion|think)\b/.test(text)) {
    return "belief";
  }
  if (/\b(process|how|ritual|rule|step|system|framework)\b/.test(text)) {
    return "topic_expertise";
  }
  return "story";
}

function fallbackTitleForInterviewAnswer(question: string): string {
  return Array.from(question.replace(/[?!.]+$/, "").trim())
    .slice(0, 240)
    .join("") || "Interview answer";
}

/**
 * Replace model-distilled answer text with the original card submission and
 * drop any model-only claims. Missing classifications get a conservative
 * deterministic kind/title so an answered question is never silently lost.
 */
export function reconcileInterviewAnswers(
  modelAnswers: ChatInterviewAnswer[],
  rawAnswers: RawInterviewAnswer[],
): ChatInterviewAnswer[] {
  const remaining = [...modelAnswers];
  const modelCountMatches = modelAnswers.length === rawAnswers.length;
  return rawAnswers.map((source, index) => {
    const comparable = comparableQuestion(source.question);
    const exactIndex = remaining.findIndex(
      (candidate) => comparableQuestion(candidate.question) === comparable,
    );
    const fuzzyIndex =
      exactIndex >= 0
        ? exactIndex
        : remaining.findIndex((candidate) => {
            const candidateQuestion = comparableQuestion(candidate.question);
            return (
              candidateQuestion.includes(comparable) ||
              comparable.includes(candidateQuestion)
            );
    });
    const candidateIndex =
      fuzzyIndex >= 0
        ? fuzzyIndex
        : modelCountMatches && index < remaining.length
          ? index
          : -1;
    const candidate = candidateIndex >= 0 ? remaining.splice(candidateIndex, 1)[0] : null;
    return candidate
      ? { ...candidate, question: source.question, answer: source.answer }
      : {
          question: source.question,
          answer: source.answer,
          kind: fallbackKindForInterviewAnswer(source),
          title: fallbackTitleForInterviewAnswer(source.question),
        };
  });
}

/**
 * Keep the card submission authoritative even when the save model returns
 * malformed JSON or no classifications. An answered card is already an
 * explicit save intent; the model only adds labels around that source text.
 */
export function recoverInterviewAnswers(
  output: InterviewOutput,
  rawAnswers: RawInterviewAnswer[],
  rawAnswersComplete = rawAnswers.length > 0,
): InterviewOutput {
  if (!rawAnswersComplete) {
    return {
      action: "chat",
      text:
        rawAnswers.length > 0
          ? "I couldn't reliably read every interview answer, so I didn't save a partial result. Please send the answers again and I'll keep them intact."
          : "I couldn't reliably read the interview card, so I didn't save anything. Please send the answers again and I'll keep them intact.",
    };
  }
  if (rawAnswers.length === 0) {
    return output.action === "chat"
      ? output
      : {
          action: "chat",
          text: "No worries — we can try another interview whenever you're ready.",
        };
  }
  if (rawAnswers.length > 0) {
    return {
      action: "save",
      answers: reconcileInterviewAnswers(
        output.action === "save" ? output.answers : [],
        rawAnswers,
      ),
    };
  }
  return output;
}

const OUTPUT_CONTRACT = `Reply with STRICT JSON only — no prose, no code fences — exactly one of:
{"action":"plan","questions":["<question 1>","<question 2>","<question 3>"]}
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
    // No options: an interview card offers no pre-filled example answers.
    // Suggested answers bias what the user tells us, and biased source
    // material is worse content downstream.
    options: [],
    allowOther: ask.allowOther,
    questions: ask.questions,
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
  const [verified, proposed] = await Promise.all([
    store.listActive(setup.workspaceId),
    store.listProposed(setup.workspaceId),
  ]);
  const knownLines = [...verified, ...proposed]
    .map((item) => `- (${item.kind}, ${item.verification}) ${item.title}`)
    .slice(0, 40);
  // An UNANSWERED card stands right now, so this turn carries the user's
  // answers back: the job is to save, not to plan another round.
  //
  // This is deliberately the pending-ask signal rather than a count of cards
  // in the chat: a completed interview leaves its card persisted forever, so
  // counting would permanently refuse to start a second interview in the
  // same chat. `pendingInterviewAsk` is true only while the latest assistant
  // message is an interview card awaiting its answer.
  const alreadyPlanned = setup.pendingInterviewAsk;
  const rawInterview = alreadyPlanned
    ? extractInterviewAnswerSubmissionFromHistory(setup.history)
    : { answers: [], complete: false };

  const system = [
    "You are Cowork's interviewer. The user asked you to interview them so you have fresher, deeper context for future LinkedIn posts. Your job is to surface stories, beliefs, proof, and audience insight that could become content angles — then save them.",
    "",
    "GROUND ALREADY COVERED — never ask about any of this:",
    ...INTERVIEW_QUESTIONS.map((question) => `- ${question.prompt}`),
    ...(knownLines.length > 0
      ? ["- Saved knowledge:", ...knownLines]
      : ["- (No knowledge saved yet.)"]),
    "",
    alreadyPlanned
      ? 'You have ALREADY asked your questions and the user has now answered them (their message lists each question with its answer; "[skipped]" means they passed on it). Do not plan more questions. Reply with action "save" containing exactly one entry for every question they actually answered. Copy each complete answer into the entry\'s "answer" field — do not summarize, shorten, merge, clean up, or replace it with a title. Preserve every step, qualifier, name, number, and caveat; use only the user\'s facts. The "title" is only a short label and must never stand in for the answer. If they answered nothing at all, close gracefully with action "chat" instead.'
      : `Plan the WHOLE interview in one go: ${INTERVIEW_MIN_QUESTIONS}-${INTERVIEW_MAX_QUESTIONS} questions, asked in order. The user answers them all before you hear back, so each question must stand on its own — never write one that depends on how they answered an earlier one ("you mentioned…", "which of those…").`,
    "",
    "Rules:",
    "- Every question is specific and angle-hunting: stories with tension (a recent win, a failure that changed an approach, a client who pushed back), beliefs worth posting (a changed mind, common advice they think is wrong), proof (a number or receipt they never posted), craft (a ritual, setup, or decision framework).",
    "- Cover different ground with each one — do not ask the same thing twice in new words.",
    "- Skip the standard bio questions entirely (what they do, their audience, their mission) — the Context interview form on the Knowledge page owns those.",
    "- Ask the question and nothing else. Never suggest or list possible answers — the user's own unprompted wording is the whole point.",
    '- For anything off-script (they ask you something, or steer elsewhere) reply with action "chat".',
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

  if (alreadyPlanned) {
    output = recoverInterviewAnswers(
      output,
      rawInterview.answers,
      rawInterview.complete,
    );
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

  // A plan is only meaningful as the interview's opening move. If the model
  // proposes one when a card already stands (it ignored the save instruction),
  // planning again would throw away the answers the user just typed — so fall
  // through to the graceful close instead.
  if (output.action === "plan" && !alreadyPlanned) {
    const ask: AskQuestion = {
      question: output.questions[0],
      options: [],
      allowOther: true,
      variant: "interview",
      questions: output.questions,
      progress: { current: 1, total: output.questions.length },
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

  // "chat", a stray re-plan, or an unparseable reply after the repair pass —
  // say something useful rather than erroring the turn. A stray plan must not
  // fall back to `result.text`: that would dump raw JSON into the chat.
  const fallbackText =
    output.action === "chat"
      ? output.text
      : output.action === "plan"
        ? "Thanks — I've got your answers. I couldn't file them as knowledge just now; say the word and I'll try again."
        : result.text.trim() ||
          "I lost my thread for a second — what would you like to talk about?";
  for (const event of doneTextEvents(fallbackText, result.usage)) yield event;
}

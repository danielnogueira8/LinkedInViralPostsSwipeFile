import { createHash } from "node:crypto";
import {
  CONTENT_LEARNING_SCHEMA_VERSION,
  KNOWLEDGE_ITEM_KINDS,
  workspaceKnowledgeProposalSchema,
  type KnowledgeItemKind,
  type WorkspaceKnowledge,
  type WorkspaceKnowledgeItem,
  type WorkspaceKnowledgeProposal,
} from "@/lib/content-learning/contracts";

// Chat interview ("Interview me" in Cowork) — the conversational sibling of
// the Voice/Knowledge page's 10-question Context interview. Answers ACCUMULATE
// as Workspace Knowledge proposals (nothing is replaced or retired), so every
// session adds fresh context and content angles; an identical question+answer
// dedupes naturally via the proposal key.
//
// Provenance: the same `interview` source as the form interview but a distinct
// source_ref prefix (`<owner>:chat-interview:`), so the form interview's
// revision-replace RPC (migration-130) never retires chat-collected items —
// and the review UI can label where each item came from. The prefix is keyed
// on the workspace id (not the voice profile id) so the flow works before a
// voice profile exists.

export type ChatInterviewAnswer = {
  question: string;
  answer: string;
  kind: KnowledgeItemKind;
  title: string;
};

// The save tool accepts at most this many answers per call — one interview
// session's worth. A model that collected more should call again.
export const CHAT_INTERVIEW_MAX_ANSWERS = 8;
const MAX_QUESTION_CHARS = 500;
const MAX_ANSWER_CHARS = 2_000;
const MAX_TITLE_CHARS = 240;

function cut(value: string, max: number): string {
  return Array.from(value.trim()).slice(0, max).join("");
}

// Mirror of interview-knowledge.ts's sourceVoiceId (private there): prefix
// bases must be slug-safe, with a hash fallback for arbitrary ids.
function sourceOwnerId(value: string): string {
  if (/^[A-Za-z0-9_-]{1,80}$/.test(value)) return value;
  return createHash("sha256").update(value).digest("hex");
}

export function chatInterviewKnowledgeSourcePrefix(workspaceId: string): string {
  return `${sourceOwnerId(workspaceId)}:chat-interview:`;
}

// A stable ref per unique question+answer. The proposal key (which hashes the
// source ref alongside the content) then dedupes identical answers while
// letting every genuinely new answer accumulate. 24 hex chars keeps the full
// ref well under the 160-char column limit.
function answerRef(question: string, answer: string): string {
  return createHash("sha256")
    .update(`${question.trim()}\n${answer.trim()}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Validate + normalize the raw `answers` argument from the save_interview_answers
 * tool. Strict on kind (the model must use the real enum — an unknown kind is a
 * model error worth feeding back) and on shape; blank answers are dropped
 * rather than stored as empty knowledge.
 */
export function normalizeChatInterviewAnswers(
  raw: unknown,
): { answers: ChatInterviewAnswer[] } | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: 'save_interview_answers requires an "answers" array.' };
  }
  if (raw.length === 0) {
    return {
      error:
        "No answers to save. Ask a few questions first — save_interview_answers is for answers the user actually gave.",
    };
  }
  if (raw.length > CHAT_INTERVIEW_MAX_ANSWERS) {
    return {
      error: `Too many answers (${raw.length}) — save at most ${CHAT_INTERVIEW_MAX_ANSWERS} per call.`,
    };
  }
  const answers: ChatInterviewAnswer[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { error: "Each answer must be an object with question, answer, kind, and title." };
    }
    const candidate = entry as Record<string, unknown>;
    const question = typeof candidate.question === "string" ? cut(candidate.question, MAX_QUESTION_CHARS) : "";
    const answer = typeof candidate.answer === "string" ? cut(candidate.answer, MAX_ANSWER_CHARS) : "";
    const title = typeof candidate.title === "string" ? cut(candidate.title, MAX_TITLE_CHARS) : "";
    const kind = typeof candidate.kind === "string" ? candidate.kind.trim() : "";
    if (!question || !answer) continue; // blank answers are skipped, not stored
    if (!(KNOWLEDGE_ITEM_KINDS as readonly string[]).includes(kind)) {
      return {
        error: `Unknown knowledge kind "${kind}". Use one of: ${KNOWLEDGE_ITEM_KINDS.join(", ")}.`,
      };
    }
    answers.push({
      question,
      answer,
      kind: kind as KnowledgeItemKind,
      title: title || cut(question, MAX_TITLE_CHARS),
    });
  }
  if (answers.length === 0) {
    return { error: "Every answer was blank — nothing to save." };
  }
  return { answers };
}

// Map a free-form answer onto the fixed content shape of its kind (the shapes
// are trigger-validated in the DB — see migration-129 — so they must match
// exactly). Unlike the form interview's proposalShape, the question is not
// from a fixed catalog: the answer text fills the primary field and the title
// carries the topic.
function contentFor(
  kind: KnowledgeItemKind,
  title: string,
  answer: string,
): WorkspaceKnowledgeProposal["content"] {
  switch (kind) {
    case "story":
      return { summary: answer, details: null };
    case "belief":
      return { statement: answer, rationale: null };
    case "proof":
      return { claim: answer, evidence: "Shared in an Interview me chat." };
    case "offer":
      return { name: cut(title, MAX_TITLE_CHARS), promise: answer };
    case "audience_insight":
      return { audience: cut(title, MAX_TITLE_CHARS), insight: answer };
    case "topic_expertise":
      return { topic: cut(title, MAX_TITLE_CHARS), basis: answer };
    case "prohibition":
      return { claim: answer, reason: null };
  }
}

export function buildChatInterviewKnowledgeProposals(input: {
  workspaceId: string;
  answers: ChatInterviewAnswer[];
}): WorkspaceKnowledgeProposal[] {
  const prefix = chatInterviewKnowledgeSourcePrefix(input.workspaceId);
  return input.answers.map((answer) =>
    workspaceKnowledgeProposalSchema.parse({
      schemaVersion: CONTENT_LEARNING_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      kind: answer.kind,
      title: answer.title,
      content: contentFor(answer.kind, answer.title, answer.answer),
      source: "interview" as const,
      sourceRef: `${prefix}${answerRef(answer.question, answer.answer)}`,
      confidence: 1,
    }),
  );
}

/**
 * Accumulate one interview session's answers as proposed knowledge. Uses the
 * store's plain propose() (upsert with ignoreDuplicates) rather than the form
 * interview's replace RPC — chat interviews ADD to the knowledge base instead
 * of replacing a revision. Identical answers return their existing row, so
 * re-saving the same session is idempotent.
 */
export async function saveChatInterviewKnowledge(input: {
  store: WorkspaceKnowledge;
  workspaceId: string;
  answers: ChatInterviewAnswer[];
}): Promise<WorkspaceKnowledgeItem[]> {
  const proposals = buildChatInterviewKnowledgeProposals({
    workspaceId: input.workspaceId,
    answers: input.answers,
  });
  const saved: WorkspaceKnowledgeItem[] = [];
  for (const proposal of proposals) {
    const item = await input.store.propose(proposal);
    if (item) saved.push(item);
  }
  return saved;
}

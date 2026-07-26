import { createHash } from "node:crypto";
import {
  CONTENT_LEARNING_SCHEMA_VERSION,
  workspaceKnowledgeProposalSchema,
  type WorkspaceKnowledge,
  type WorkspaceKnowledgeItem,
  type WorkspaceKnowledgeProposal,
} from "@/lib/content-learning/contracts";
import {
  INTERVIEW_QUESTIONS,
  type InterviewQuestion,
} from "@/lib/voice-interview";
import type { InterviewAnswer } from "@/lib/claude";

type ProposalContent = WorkspaceKnowledgeProposal["content"];

const questionByPrompt = new Map(
  INTERVIEW_QUESTIONS.map((question) => [question.prompt, question]),
);

function cut(value: string, max: number): string {
  return Array.from(value.trim()).slice(0, max).join("");
}

function sourceVoiceId(value: string): string {
  if (/^[A-Za-z0-9_-]{1,80}$/.test(value)) return value;
  return createHash("sha256").update(value).digest("hex");
}

function proposalShape(
  question: InterviewQuestion,
  answer: string,
): {
  kind: WorkspaceKnowledgeProposal["kind"];
  title: string;
  content: ProposalContent;
} {
  switch (question.id) {
    case "what_you_do":
      return {
        kind: "offer",
        title: "What you do and who you help",
        content: {
          name: "Your work",
          promise: cut(answer, 2_000),
        },
      };
    case "core_outcome":
      return {
        kind: "offer",
        title: "The outcome you help create",
        content: {
          name: "Your core outcome",
          promise: cut(answer, 2_000),
        },
      };
    case "contrarian_belief":
      return {
        kind: "belief",
        title: "A belief that sets you apart",
        content: {
          statement: cut(answer, 2_000),
          rationale: null,
        },
      };
    case "turning_point":
      return {
        kind: "story",
        title: "A defining career moment",
        content: {
          summary: cut(answer, 2_000),
          details: null,
        },
      };
    case "proof":
      return {
        kind: "proof",
        title: "A result you are proud of",
        content: {
          claim: cut(answer, 2_000),
          evidence: "Shared directly in your Context interview.",
        },
      };
    case "the_reader":
      return {
        kind: "audience_insight",
        title: "Who you write for",
        content: {
          audience: "Your intended reader",
          insight: cut(answer, 2_000),
        },
      };
    case "hard_lesson":
      return {
        kind: "story",
        title: "A hard-won lesson",
        content: {
          summary: cut(answer, 2_000),
          details: null,
        },
      };
    case "content_pillars":
      return {
        kind: "topic_expertise",
        title: "Topics you can discuss for hours",
        content: {
          topic: cut(answer, 240),
          basis: cut(answer, 2_000),
        },
      };
    case "reader_takeaway":
      return {
        kind: "belief",
        title: "What readers should take away",
        content: {
          statement: cut(answer, 2_000),
          rationale: null,
        },
      };
    case "mission":
      return {
        kind: "belief",
        title: "The mission behind your work",
        content: {
          statement: cut(answer, 2_000),
          rationale: null,
        },
      };
  }
  throw new Error(`Unsupported interview question: ${question.id}`);
}

export function interviewKnowledgeSourcePrefix(
  voiceProfileId: string,
): string {
  return `${sourceVoiceId(voiceProfileId)}:interview:`;
}

export function buildInterviewKnowledgeProposals(input: {
  workspaceId: string;
  voiceProfileId: string;
  interviewUpdatedAt: string;
  answers: InterviewAnswer[];
}): WorkspaceKnowledgeProposal[] {
  const prefix = interviewKnowledgeSourcePrefix(input.voiceProfileId);
  const revision = input.interviewUpdatedAt.replace(/[^0-9TZ.-]/g, "");
  const byQuestion = new Map<string, InterviewAnswer>();
  for (const answer of input.answers) {
    const question = questionByPrompt.get(answer.question);
    const value = answer.answer.trim();
    if (question && value) byQuestion.set(question.id, answer);
  }
  return Array.from(byQuestion.values()).flatMap((answer) => {
    const question = questionByPrompt.get(answer.question);
    if (!question) return [];
    const value = answer.answer.trim();
    const shaped = proposalShape(question, value);
    return [workspaceKnowledgeProposalSchema.parse({
      schemaVersion: CONTENT_LEARNING_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      ...shaped,
      source: "interview" as const,
      sourceRef: `${prefix}${question.id}:${revision}`,
      confidence: 1,
    })];
  });
}

export async function syncInterviewKnowledge(input: {
  store: WorkspaceKnowledge;
  workspaceId: string;
  voiceProfileId: string;
  interviewUpdatedAt: string;
  answers: InterviewAnswer[];
}): Promise<WorkspaceKnowledgeItem[]> {
  const prefix = interviewKnowledgeSourcePrefix(input.voiceProfileId);
  const proposals = buildInterviewKnowledgeProposals(input);
  const saved = await input.store.replaceInterviewProposals(
    input.workspaceId,
    prefix,
    proposals,
  );
  if (!saved) {
    throw new Error("Couldn't reconcile the interview knowledge revision");
  }
  return saved.filter((item) => item.active);
}

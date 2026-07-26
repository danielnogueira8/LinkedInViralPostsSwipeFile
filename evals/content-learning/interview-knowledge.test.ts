import { describe, expect, test, vi } from "vitest";
import type {
  WorkspaceKnowledge,
  WorkspaceKnowledgeItem,
} from "@/lib/content-learning/contracts";
import {
  buildInterviewKnowledgeProposals,
  syncInterviewKnowledge,
} from "@/lib/content-learning/interview-knowledge";
import { INTERVIEW_QUESTIONS } from "@/lib/voice-interview";

const timestamp = "2026-07-26T14:00:00.000Z";

function item(
  overrides: Partial<WorkspaceKnowledgeItem>,
): WorkspaceKnowledgeItem {
  return {
    schemaVersion: 1,
    id: "knowledge-1",
    workspaceId: "workspace-1",
    kind: "belief",
    title: "Old belief",
    content: { statement: "Old answer", rationale: null },
    source: "interview",
    sourceRef: "voice-1:interview:contrarian_belief:old",
    confidence: 1,
    verification: "proposed",
    lastVerifiedAt: null,
    active: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  } as WorkspaceKnowledgeItem;
}

describe("interview Workspace Knowledge", () => {
  test("maps each known answer to a traceable, reviewable domain kind", () => {
    const proposals = buildInterviewKnowledgeProposals({
      workspaceId: "workspace-1",
      voiceProfileId: "voice-1",
      interviewUpdatedAt: timestamp,
      answers: INTERVIEW_QUESTIONS.map((question) => ({
        question: question.prompt,
        answer: `Answer for ${question.id}`,
      })),
    });

    expect(proposals).toHaveLength(10);
    expect(proposals.map((proposal) => proposal.kind)).toEqual([
      "offer",
      "offer",
      "belief",
      "story",
      "proof",
      "audience_insight",
      "story",
      "topic_expertise",
      "belief",
      "belief",
    ]);
    expect(
      proposals.every(
        (proposal) =>
          !("verification" in proposal) &&
          proposal.source === "interview" &&
          proposal.sourceRef?.startsWith("voice-1:interview:"),
      ),
    ).toBe(true);
  });

  test("ignores unknown or blank answers instead of inventing knowledge", () => {
    expect(
      buildInterviewKnowledgeProposals({
        workspaceId: "workspace-1",
        voiceProfileId: "voice-1",
        interviewUpdatedAt: timestamp,
        answers: [
          { question: "Unknown question", answer: "Do not infer this." },
          { question: INTERVIEW_QUESTIONS[0]!.prompt, answer: " " },
        ],
      }),
    ).toEqual([]);
  });

  test("keeps one proposal when a canonical question is duplicated", () => {
    const question = INTERVIEW_QUESTIONS[2]!;
    const proposals = buildInterviewKnowledgeProposals({
      workspaceId: "workspace-1",
      voiceProfileId: "voice-1",
      interviewUpdatedAt: timestamp,
      answers: [
        { question: question.prompt, answer: "Old answer" },
        { question: question.prompt, answer: "Updated answer" },
      ],
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.content).toEqual({
      statement: "Updated answer",
      rationale: null,
    });
  });

  test("replaces an interview revision through one atomic store operation", async () => {
    const proposed = item({
      id: "knowledge-new",
      title: "A belief that sets you apart",
      content: { statement: "New answer", rationale: null },
      sourceRef: `voice-1:interview:contrarian_belief:${timestamp}`,
    });
    const store = {
      replaceInterviewProposals: vi.fn(async () => [proposed]),
      review: vi.fn(async () => null),
      archive: vi.fn(async () => null),
      propose: vi.fn(async () => null),
      listProposed: vi.fn(async () => []),
      listActiveBySource: vi.fn(async () => []),
      listActive: vi.fn(async () => []),
    } satisfies WorkspaceKnowledge;

    const result = await syncInterviewKnowledge({
      store,
      workspaceId: "workspace-1",
      voiceProfileId: "voice-1",
      interviewUpdatedAt: timestamp,
      answers: [{
        question: INTERVIEW_QUESTIONS[2]!.prompt,
        answer: "New answer",
      }],
    });

    expect(store.replaceInterviewProposals).toHaveBeenCalledWith(
      "workspace-1",
      "voice-1:interview:",
      [
        expect.objectContaining({
          workspaceId: "workspace-1",
          source: "interview",
          content: { statement: "New answer", rationale: null },
        }),
      ],
    );
    expect(result).toEqual([proposed]);
  });

  test("fails the knowledge sync when the atomic replacement rolls back", async () => {
    const store = {
      replaceInterviewProposals: vi.fn(async () => null),
      review: vi.fn(async () => null),
      archive: vi.fn(async () => null),
      propose: vi.fn(async () => null),
      listProposed: vi.fn(async () => []),
      listActiveBySource: vi.fn(async () => []),
      listActive: vi.fn(async () => []),
    } satisfies WorkspaceKnowledge;

    await expect(
      syncInterviewKnowledge({
        store,
        workspaceId: "workspace-1",
        voiceProfileId: "voice-1",
        interviewUpdatedAt: timestamp,
        answers: [{
          question: INTERVIEW_QUESTIONS[2]!.prompt,
          answer: "New answer",
        }],
      }),
    ).rejects.toThrow("Couldn't reconcile");
    expect(store.propose).not.toHaveBeenCalled();
  });
});

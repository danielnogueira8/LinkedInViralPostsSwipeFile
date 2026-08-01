import { describe, expect, test, vi } from "vitest";
import type {
  WorkspaceKnowledge,
  WorkspaceKnowledgeItem,
  WorkspaceKnowledgeProposal,
} from "@/lib/content-learning/contracts";
import {
  buildChatInterviewKnowledgeProposals,
  chatInterviewKnowledgeSourcePrefix,
  normalizeChatInterviewAnswers,
  saveChatInterviewKnowledge,
  CHAT_INTERVIEW_MAX_ANSWERS,
} from "@/lib/content-learning/chat-interview-knowledge";

const timestamp = "2026-07-30T14:00:00.000Z";

const sampleAnswers = [
  {
    question: "What did you change your mind about this year?",
    answer: "I stopped batching content. Daily small bets compound harder.",
    kind: "belief",
    title: "Stopped batching content",
  },
  {
    question: "A result from the last quarter you never posted about?",
    answer: "Grew a client's newsletter from 400 to 3,100 subs in 90 days.",
    kind: "proof",
    title: "Client newsletter 400 to 3,100",
  },
  {
    question: "A moment a client pushed back hard?",
    answer: "A client killed our launch post an hour before it went out. We rebuilt it around their customer's words and it outperformed everything before it.",
    kind: "story",
    title: "The killed launch post",
  },
] as const;

describe("normalizeChatInterviewAnswers", () => {
  test("accepts a well-formed session and trims fields", () => {
    const result = normalizeChatInterviewAnswers(
      sampleAnswers.map((answer) => ({ ...answer })),
    );
    expect("answers" in result && result.answers).toHaveLength(3);
  });

  test("rejects an unknown kind so the model learns the enum", () => {
    const result = normalizeChatInterviewAnswers([
      { question: "Q", answer: "A", kind: "opinion", title: "T" },
    ]);
    expect(result).toEqual({
      error: expect.stringContaining('Unknown knowledge kind "opinion"'),
    });
  });

  test("drops blank answers instead of storing empty knowledge", () => {
    const result = normalizeChatInterviewAnswers([
      { question: "Q", answer: "  ", kind: "belief", title: "T" },
    ]);
    expect(result).toEqual({ error: "Every answer was blank — nothing to save." });
  });

  test("preserves an answer longer than the old 2,000-character field limit", () => {
    const answer = "A".repeat(2_500);
    const question = "Q".repeat(600);
    const result = normalizeChatInterviewAnswers([
      {
        question,
        answer,
        kind: "topic_expertise",
        title: "Process",
      },
    ]);
    expect("answers" in result && result.answers[0]?.answer).toBe(answer);
    expect("answers" in result && result.answers[0]?.question).toBe(question);
  });

  test("rejects an answer beyond the chat boundary instead of shortening it", () => {
    const result = normalizeChatInterviewAnswers([
      {
        question: "What is your process?",
        answer: "A".repeat(8_001),
        kind: "topic_expertise",
        title: "Process",
      },
    ]);
    expect(result).toEqual({
      error: "Each answer must be 8,000 characters or fewer.",
    });
  });

  test("caps a session at the max answer count", () => {
    const tooMany = Array.from(
      { length: CHAT_INTERVIEW_MAX_ANSWERS + 1 },
      (_, i) => ({
        question: `Q${i}`,
        answer: `A${i}`,
        kind: "belief",
        title: `T${i}`,
      }),
    );
    const result = normalizeChatInterviewAnswers(tooMany);
    expect(result).toEqual({
      error: expect.stringContaining("Too many answers"),
    });
  });
});

describe("buildChatInterviewKnowledgeProposals", () => {
  const proposals = buildChatInterviewKnowledgeProposals({
    workspaceId: "workspace-1",
    answers: sampleAnswers.map((answer) => ({ ...answer })),
  });

  test("maps each answer onto its kind's fixed content shape", () => {
    expect(proposals).toHaveLength(3);
    expect(proposals.map((proposal) => proposal.kind)).toEqual([
      "belief",
      "proof",
      "story",
    ]);
    const [belief, proof, story] = proposals;
    expect(belief?.content).toEqual({
      statement: sampleAnswers[0].answer,
      rationale: null,
      sourceQuestion: sampleAnswers[0].question,
    });
    expect(proof?.content).toEqual({
      claim: sampleAnswers[1].answer,
      evidence: "Shared in an Interview me chat.",
      sourceQuestion: sampleAnswers[1].question,
    });
    expect(story?.content).toEqual({
      summary: sampleAnswers[2].answer,
      details: null,
      sourceQuestion: sampleAnswers[2].question,
    });
  });

  test("keeps a complete topic answer in basis instead of the short title", () => {
    const answer =
      "I ask Claude for different hook angles, format the post for readability, and verify every fact before publishing.";
    const [proposal] = buildChatInterviewKnowledgeProposals({
      workspaceId: "workspace-1",
      answers: [
        {
          question: "What exact process turns a raw idea into a finished post?",
          answer,
          kind: "topic_expertise",
          title: "The three-step process for turning an idea into a post",
        },
      ],
    });

    expect(proposal?.content).toEqual({
      topic: "The three-step process for turning an idea into a post",
      basis: answer,
      sourceQuestion: "What exact process turns a raw idea into a finished post?",
    });
  });

  test("builds a proposal without shortening a long answer", () => {
    const answer = "A".repeat(2_500);
    const [proposal] = buildChatInterviewKnowledgeProposals({
      workspaceId: "workspace-1",
      answers: [
        {
          question: "What is your process?",
          answer,
          kind: "topic_expertise",
          title: "Process",
        },
      ],
    });

    expect(proposal?.content).toEqual({
      topic: "Process",
      basis: answer,
      sourceQuestion: "What is your process?",
    });
  });

  test("tags proposals with the interview source and the chat prefix", () => {
    const prefix = chatInterviewKnowledgeSourcePrefix("workspace-1");
    expect(prefix).toBe("workspace-1:chat-interview:");
    for (const proposal of proposals) {
      expect(proposal.source).toBe("interview");
      expect(proposal.sourceRef?.startsWith(prefix)).toBe(true);
      expect((proposal.sourceRef ?? "").length).toBeLessThanOrEqual(160);
    }
  });

  test("identical answers dedupe; different answers accumulate", () => {
    const again = buildChatInterviewKnowledgeProposals({
      workspaceId: "workspace-1",
      answers: [{ ...sampleAnswers[0] }],
    });
    // Same question+answer → same ref → same proposal key downstream.
    expect(again[0]?.sourceRef).toBe(proposals[0]?.sourceRef);
    // A different answer to the same question → a NEW item, never a replace.
    const revisited = buildChatInterviewKnowledgeProposals({
      workspaceId: "workspace-1",
      answers: [{ ...sampleAnswers[0], answer: "A refined take." }],
    });
    expect(revisited[0]?.sourceRef).not.toBe(proposals[0]?.sourceRef);
  });
});

describe("saveChatInterviewKnowledge", () => {
  function storedItem(
    proposal: WorkspaceKnowledgeProposal,
  ): WorkspaceKnowledgeItem {
    return {
      ...proposal,
      id: `item-${proposal.title}`,
      verification: "proposed",
      lastVerifiedAt: null,
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as WorkspaceKnowledgeItem;
  }

  test("accumulates every answer through propose() without replacing", async () => {
    const proposed: WorkspaceKnowledgeProposal[] = [];
    const store: WorkspaceKnowledge = {
      propose: vi.fn(async (proposal: WorkspaceKnowledgeProposal) => {
        proposed.push(proposal);
        return storedItem(proposal);
      }),
      replaceInterviewProposals: vi.fn(),
      review: vi.fn(),
      archive: vi.fn(),
      listProposed: vi.fn(async () => []),
      listActiveBySource: vi.fn(async () => []),
      listActive: vi.fn(async () => []),
    };
    const items = await saveChatInterviewKnowledge({
      store,
      workspaceId: "workspace-1",
      answers: sampleAnswers.map((answer) => ({ ...answer })),
    });
    expect(items).toHaveLength(3);
    expect(proposed).toHaveLength(3);
    // The accumulation path must never touch the form interview's
    // revision-replace RPC.
    expect(store.replaceInterviewProposals).not.toHaveBeenCalled();
  });

  test("tolerates individual proposal failures without losing the session", async () => {
    let calls = 0;
    const store: WorkspaceKnowledge = {
      propose: vi.fn(async (proposal: WorkspaceKnowledgeProposal) => {
        calls += 1;
        return calls === 2 ? null : storedItem(proposal);
      }),
      replaceInterviewProposals: vi.fn(),
      review: vi.fn(),
      archive: vi.fn(),
      listProposed: vi.fn(async () => []),
      listActiveBySource: vi.fn(async () => []),
      listActive: vi.fn(async () => []),
    };
    const items = await saveChatInterviewKnowledge({
      store,
      workspaceId: "workspace-1",
      answers: sampleAnswers.map((answer) => ({ ...answer })),
    });
    expect(items).toHaveLength(2);
  });
});

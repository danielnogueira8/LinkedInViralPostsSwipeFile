import { describe, expect, test } from "vitest";
import {
  countInterviewQuestions,
  INTERVIEW_MAX_QUESTIONS,
  INTERVIEW_MIN_QUESTIONS,
  isInterviewAskArgs,
  parseInterviewOutput,
} from "@/lib/agent/turn/execute-interview";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// The interview lane's pure core: output parsing (the model's STRICT JSON
// contract), progress counting from persisted interview cards, and the
// pending-ask variant detection that routes follow-up turns back to the lane.
// ---------------------------------------------------------------------------

function interviewCall(question: string): ChatMessage {
  return {
    role: "assistant",
    content: question,
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "ask_user",
          arguments: JSON.stringify({
            question,
            options: ["a", "b"],
            allowOther: true,
            variant: "interview",
            progress: { current: 1, total: 4 },
          }),
        },
      },
    ],
  } as ChatMessage;
}

describe("parseInterviewOutput", () => {
  test("parses an ask with 2-4 examples and clamps the total into 3-5", () => {
    const output = parseInterviewOutput(
      '{"action":"ask","question":"What changed your mind this year?","examples":["Stopped batching","Hired an editor"],"total":9}',
    );
    expect(output).toEqual({
      action: "ask",
      question: "What changed your mind this year?",
      examples: ["Stopped batching", "Hired an editor"],
      total: INTERVIEW_MAX_QUESTIONS,
    });
    const low = parseInterviewOutput(
      '{"action":"ask","question":"Q?","examples":["a","b"],"total":1}',
    );
    expect(low.action === "ask" && low.total).toBe(INTERVIEW_MIN_QUESTIONS);
  });

  test("tolerates code fences and surrounding whitespace", () => {
    const output = parseInterviewOutput(
      '```json\n{"action":"chat","text":"Sure — what would you like to know?"}\n```',
    );
    expect(output).toEqual({
      action: "chat",
      text: "Sure — what would you like to know?",
    });
  });

  test("an ask without at least two examples is invalid (card needs 2+ chips)", () => {
    expect(
      parseInterviewOutput('{"action":"ask","question":"Q?","examples":["only one"]}'),
    ).toEqual({ action: "invalid" });
  });

  test("save validates answers through the knowledge normalizer", () => {
    const output = parseInterviewOutput(
      '{"action":"save","answers":[{"question":"A result?","answer":"Grew subs 400 to 3100.","kind":"proof","title":"Newsletter 400 to 3,100"}]}',
    );
    expect(output).toEqual({
      action: "save",
      answers: [
        {
          question: "A result?",
          answer: "Grew subs 400 to 3100.",
          kind: "proof",
          title: "Newsletter 400 to 3,100",
        },
      ],
    });
    expect(
      parseInterviewOutput(
        '{"action":"save","answers":[{"question":"Q","answer":"A","kind":"opinion","title":"T"}]}',
      ),
    ).toEqual({ action: "invalid" });
  });

  test("prose (the old free-text failure mode) is invalid, never a silent ask", () => {
    expect(
      parseInterviewOutput(
        "Great — let's build from what's current.\n1. What are you working on?\n2. What changed your perspective?",
      ),
    ).toEqual({ action: "invalid" });
  });
});

describe("countInterviewQuestions + isInterviewAskArgs", () => {
  test("counts only interview-variant cards in the history", () => {
    const clarification: ChatMessage = {
      role: "assistant",
      content: "Which one?",
      tool_calls: [
        {
          id: "call-2",
          type: "function",
          function: {
            name: "ask_user",
            arguments: JSON.stringify({ question: "Which?", options: ["a", "b"] }),
          },
        },
      ],
    } as ChatMessage;
    const history: ChatMessage[] = [
      interviewCall("Q1"),
      { role: "user", content: "answer 1" },
      interviewCall("Q2"),
      clarification,
    ];
    expect(countInterviewQuestions(history)).toBe(2);
  });

  test("detects the interview variant in persisted ask args", () => {
    expect(isInterviewAskArgs({ variant: "interview" })).toBe(true);
    expect(isInterviewAskArgs({ question: "Which?" })).toBe(false);
    expect(isInterviewAskArgs(null)).toBe(false);
  });
});

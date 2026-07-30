import { describe, expect, test } from "vitest";
import {
  countInterviewQuestionsInRows,
  INTERVIEW_MAX_QUESTIONS,
  INTERVIEW_MIN_QUESTIONS,
  isInterviewAskArgs,
  parseInterviewOutput,
} from "@/lib/agent/turn/execute-interview";

function interviewRow(question: string) {
  return {
    tool_calls: [
      {
        id: "call-1",
        type: "function" as const,
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
  };
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

describe("countInterviewQuestionsInRows + isInterviewAskArgs", () => {
  test("counts only interview-variant cards across persisted rows", () => {
    const clarificationRow = {
      tool_calls: [
        {
          id: "call-2",
          type: "function" as const,
          function: {
            name: "ask_user",
            arguments: JSON.stringify({ question: "Which?", options: ["a", "b"] }),
          },
        },
      ],
    };
    const rows = [interviewRow("Q1"), { tool_calls: null }, interviewRow("Q2"), clarificationRow];
    expect(countInterviewQuestionsInRows(rows)).toBe(2);
  });

  test("detects the interview variant in persisted ask args", () => {
    expect(isInterviewAskArgs({ variant: "interview" })).toBe(true);
    expect(isInterviewAskArgs({ question: "Which?" })).toBe(false);
    expect(isInterviewAskArgs(null)).toBe(false);
  });
});

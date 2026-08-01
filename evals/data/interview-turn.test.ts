import { describe, expect, test } from "vitest";
import {
  extractInterviewAnswersFromHistory,
  INTERVIEW_MAX_QUESTIONS,
  isInterviewAskArgs,
  parseInterviewOutput,
  reconcileInterviewAnswers,
} from "@/lib/agent/turn/execute-interview";
import type { ChatMessage } from "@/lib/openrouter";
import { AskQuestionSchema, type AskQuestion } from "@/lib/agent/contracts";
import { hydrate } from "@/lib/chat-hydration";
import { composeInterviewAnswers } from "@/lib/chat-ask";

describe("parseInterviewOutput", () => {
  test("parses a plan carrying the whole question set", () => {
    const output = parseInterviewOutput(
      '{"action":"plan","questions":["What changed your mind this year?","Which result never made it into a post?","What advice do you think is wrong?"]}',
    );
    expect(output).toEqual({
      action: "plan",
      questions: [
        "What changed your mind this year?",
        "Which result never made it into a post?",
        "What advice do you think is wrong?",
      ],
    });
  });

  test("a runaway plan is truncated to the max rather than rejected", () => {
    const questions = Array.from({ length: 12 }, (_, i) => `Question ${i + 1}?`);
    const output = parseInterviewOutput(
      JSON.stringify({ action: "plan", questions }),
    );
    expect(output.action === "plan" && output.questions).toHaveLength(
      INTERVIEW_MAX_QUESTIONS,
    );
  });

  test("a plan thinner than the minimum is invalid", () => {
    expect(
      parseInterviewOutput('{"action":"plan","questions":["Only one?"]}'),
    ).toEqual({ action: "invalid" });
  });

  test("duplicate questions are dropped, and may drop the plan below the floor", () => {
    // Case-insensitive dedupe: three entries, one distinct question left.
    expect(
      parseInterviewOutput(
        '{"action":"plan","questions":["Same question?","same QUESTION?","Same question?"]}',
      ),
    ).toEqual({ action: "invalid" });
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

  test("the retired single-question ask shape no longer parses", () => {
    expect(
      parseInterviewOutput(
        '{"action":"ask","question":"Q?","examples":["a","b"],"total":4}',
      ),
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

describe("interview answer fidelity", () => {
  test("recovers every non-skipped answer from the submitted card message", () => {
    const history: ChatMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Q1: What changed your mind?",
              "A1: I stopped batching content. Small daily bets compound harder.",
              "",
              "Q2: Which result?",
              "A2: [skipped]",
              "",
              "Q3: What is your process?",
              "A3: I ask for three hook angles, then verify every fact.",
            ].join("\n"),
          },
        ],
      },
    ];

    expect(extractInterviewAnswersFromHistory(history)).toEqual([
      {
        question: "What changed your mind?",
        answer: "I stopped batching content. Small daily bets compound harder.",
      },
      {
        question: "What is your process?",
        answer: "I ask for three hook angles, then verify every fact.",
      },
    ]);
  });

  test("uses the original answer even when the model summarizes it", () => {
    const raw = [
      {
        question: "What is your process?",
        answer: "I ask for three hook angles, then verify every fact.",
      },
    ];
    expect(
      reconcileInterviewAnswers(
        [
          {
            question: "What is your process?",
            answer: "A three-step process.",
            kind: "topic_expertise",
            title: "The process",
          },
        ],
        raw,
      ),
    ).toEqual([
      {
        question: "What is your process?",
        answer: "I ask for three hook angles, then verify every fact.",
        kind: "topic_expertise",
        title: "The process",
      },
    ]);
  });

  test("creates a conservative item when the model omitted an answered question", () => {
    expect(
      reconcileInterviewAnswers(
        [],
        [{ question: "What result are you proud of?", answer: "15,000 followers." }],
      ),
    ).toEqual([
      {
        question: "What result are you proud of?",
        answer: "15,000 followers.",
        kind: "proof",
        title: "What result are you proud of",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The interview card's persisted shape. A reloaded card must hydrate to
// EXACTLY the streamed card: any field the hydrator adds or drops is a field
// that visibly changes under the user when the post-ask reload reconciles
// (the "questions change a split second after the card appears" bug).
// ---------------------------------------------------------------------------

describe("interview card round-trip", () => {
  const questions = ["What changed your mind?", "Which result?", "What's wrong?"];
  const streamed: AskQuestion = {
    question: questions[0],
    options: [],
    allowOther: true,
    variant: "interview",
    questions,
    progress: { current: 1, total: 3 },
  };

  test("the card carries no options — no pre-filled example answers", () => {
    expect(streamed.options).toEqual([]);
    expect(AskQuestionSchema.safeParse(streamed).success).toBe(true);
  });

  test("hydrating the persisted card reproduces the streamed card exactly", () => {
    const rows = [
      {
        id: "m1",
        role: "assistant" as const,
        content: questions[0],
        tool_calls: [
          {
            id: "call-1",
            type: "function" as const,
            function: {
              name: "ask_user",
              arguments: JSON.stringify({
                question: streamed.question,
                options: [],
                allowOther: true,
                questions,
                variant: "interview",
                progress: streamed.progress,
              }),
            },
          },
        ],
      },
    ];
    const [message] = hydrate(rows as unknown as Parameters<typeof hydrate>[0]);
    // Deep equality, not a subset check: an injected doneOption or a
    // recovered choiceIds array would remount the card mid-answer.
    expect(message.ask).toEqual(streamed);
  });

  test("the card sends every Q/A pair as ONE message, marking passes", () => {
    const composed = composeInterviewAnswers(questions, [
      "I killed our best-performing lead magnet.",
      "",
      "  That you must post daily.  ",
    ]);
    expect(composed).toBe(
      [
        `Q1: ${questions[0]}\nA1: I killed our best-performing lead magnet.`,
        `Q2: ${questions[1]}\nA2: [skipped]`,
        `Q3: ${questions[2]}\nA3: That you must post daily.`,
      ].join("\n\n"),
    );
    // Every question appears exactly once — the save turn sees the full set.
    for (const question of questions) {
      expect(composed.split(question)).toHaveLength(2);
    }
  });

  test("a non-interview ask still requires two options to be a choice", () => {
    expect(
      AskQuestionSchema.safeParse({
        question: "Which draft?",
        options: ["only one"],
        allowOther: true,
      }).success,
    ).toBe(false);
  });

  test("an interview card without its planned questions is rejected", () => {
    expect(
      AskQuestionSchema.safeParse({
        question: "Q?",
        options: [],
        allowOther: true,
        variant: "interview",
      }).success,
    ).toBe(false);
  });
});

// isInterviewAskArgs is what setup.ts uses to compute `pendingInterviewAsk`,
// the signal that decides plan-vs-save. It stays live even though the old
// per-turn question counter is gone.
describe("isInterviewAskArgs", () => {
  test("detects the interview variant in persisted ask args", () => {
    expect(isInterviewAskArgs({ variant: "interview" })).toBe(true);
    expect(isInterviewAskArgs({ question: "Which?" })).toBe(false);
    expect(isInterviewAskArgs(null)).toBe(false);
  });

  test("only an UNANSWERED card marks the interview pending", () => {
    // The executor's plan-vs-save switch reads setup.pendingInterviewAsk,
    // which setup.ts derives from the LATEST assistant row. Deriving it from
    // a count of interview cards in the chat instead would leave a completed
    // interview's card counted forever, permanently refusing to start a
    // second interview in the same chat.
    const card = {
      role: "assistant" as const,
      tool_calls: [
        {
          function: {
            name: "ask_user",
            arguments: JSON.stringify({ variant: "interview" }),
          },
        },
      ],
    };
    const latestIsCard = (rows: typeof card[]) => {
      const latest = rows.find((row) => row.role === "assistant");
      const ask = (latest?.tool_calls ?? []).find(
        (call) => call.function.name === "ask_user",
      );
      if (!ask) return false;
      return isInterviewAskArgs(
        JSON.parse(ask.function.arguments) as Record<string, unknown>,
      );
    };
    // Newest-first, as setup.ts reads it: card outstanding → pending.
    expect(latestIsCard([card])).toBe(true);
    // A finished interview: the save reply is now newest, so a fresh
    // "interview me" plans again rather than trying to save nothing.
    const savedReply = { role: "assistant" as const, tool_calls: [] };
    expect(latestIsCard([savedReply, card])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compileTurnPlan routing: the interview trigger must outrank every other ask
// path (the coverage gate keeps this block honest — it is the only place the
// interview branch in compile.ts is exercised).
// ---------------------------------------------------------------------------

import { compileTurnPlan } from "@/lib/agent/turn/compile";
import type { TurnCompileContext } from "@/lib/agent/turn/state";

function compileSetup(overrides: Record<string, unknown>): TurnCompileContext {
  return {
    workspaceId: "ws-1",
    attachments: [],
    modelSourceId: null,
    existingArtifactIds: [],
    confirmedActionTargetIds: [],
    pendingInterviewAsk: false,
    modeledBatchContinuation: null,
    setupSignal: new AbortController().signal,
    coworkTelemetry: { configure() {}, finish: async () => {} },
    currentModelSource: null,
    modelSourceReference: null,
    currentTurnOperation: { kind: "ask" },
    composerTaskContext: null,
    effectiveUserInstruction: "Tell me about hooks",
    turnError: (message: string, status: number) =>
      new Response(message, { status }),
    ...overrides,
  } as unknown as TurnCompileContext;
}

const compileDeps = {
  actionOrchestratorEnabledForWorkspace: () => false,
  readOnlyOrchestratorEnabledForWorkspace: () => false,
  releaseChatTurn: async () => {},
  persistChatSetupFailure: async () => {},
};

describe("compileTurnPlan — interview routing", () => {
  test("the interview-me starter routes the ask turn to the interview lane", async () => {
    const plan = await compileTurnPlan(
      compileSetup({
        composerTaskContext: { starterId: "interview-me" },
      }),
      "chat-1",
      compileDeps,
    );
    expect(plan).toMatchObject({
      kind: "interview",
      route: "answer",
      contract: { kind: "answer", expectedCount: 1 },
    });
  });

  test("a pending interview ask routes follow-up turns back to the lane", async () => {
    const plan = await compileTurnPlan(
      compileSetup({ pendingInterviewAsk: true }),
      "chat-1",
      compileDeps,
    );
    expect(plan).toMatchObject({ kind: "interview", route: "answer" });
  });

  test("an explicit free-text 'interview me' routes to the interview lane", async () => {
    const plan = await compileTurnPlan(
      compileSetup({ effectiveUserInstruction: "Can you interview me about my founder journey?" }),
      "chat-1",
      compileDeps,
    );
    expect(plan).toMatchObject({ kind: "interview", route: "answer" });
  });
});

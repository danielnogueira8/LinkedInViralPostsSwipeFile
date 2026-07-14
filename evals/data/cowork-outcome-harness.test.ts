import { describe, expect, test, vi } from "vitest";
import {
  scriptedStreamChat,
  type ScriptedProviderScenario,
} from "@/evals/cowork-scripted-provider";
import { currentCoworkHarnessAdminClient } from "@/evals/cowork-harness-store";
import {
  runCoworkOutcomeScenario,
  runCoworkOutcomeSequence,
  safeCoworkReportLine,
  type CoworkOutcomeScenario,
} from "@/evals/cowork-outcome-harness";
import { INCOMPLETE_ORIGINAL_POST_BODY } from "@/evals/fixtures/cowork-incidents";

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...original,
    streamChat: scriptedStreamChat,
  };
});

vi.mock("@/lib/supabase", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/supabase")>();
  return {
    ...original,
    supabaseAdmin: currentCoworkHarnessAdminClient,
  };
});

const COMPLETE_POST = [
  "Building a personal brand is not a vanity project.",
  "It is career leverage you keep when your title, company, or market changes.",
  "A useful reputation compounds before you need it: people know how you think, what you can solve, and why they should trust you.",
  "Do the work in public. Teach the lesson while it is still fresh. Let proof accumulate.",
].join("\n\n");
const SECOND_POST = [
  "Your job title is rented. Your reputation is owned.",
  "A company can change your remit overnight, but it cannot take back the proof you published, the lessons you taught, or the trust you earned.",
  "Build the asset that follows you to the next role.",
].join("\n\n");

const usage = (input: number, output: number, cost: number) => ({
  prompt_tokens: input,
  completion_tokens: output,
  total_tokens: input + output,
  cost,
});

function renderProvider(
  bodies: string[],
  options: { sourcePostIds?: string[]; firstText?: string } = {},
): ScriptedProviderScenario {
  return {
    rounds: [
      {
        kind: "response",
        text: options.firstText ?? "Finished the requested deliverable.",
        toolCalls: bodies.map((body, index) => ({
          id: `call_render_${index}`,
          name: "render_post",
          args: {
            body,
            ...(options.sourcePostIds?.[index]
              ? { sourcePostId: options.sourcePostIds[index] }
              : {}),
          },
        })),
        usage: usage(321, 144, 0.0042),
      },
    ],
  };
}

function textProvider(content: string): ScriptedProviderScenario {
  return {
    rounds: [
      {
        kind: "response",
        text: content,
        finishReason: "stop",
        usage: usage(180, 60, 0.0018),
      },
    ],
  };
}

function originalScenario(
  id: string,
  provider: ScriptedProviderScenario = renderProvider([COMPLETE_POST]),
  actionNames: string[] = ["render_post", "ask_user"],
): CoworkOutcomeScenario {
  return {
    id,
    request: {
      message:
        "Write an original post in my voice about why a personal brand is career leverage.",
    },
    model: { provider },
    expected: {
      terminal: "ask",
      artifactBodies: [COMPLETE_POST],
      actionNames,
    },
  };
}

describe("production-shaped Cowork outcome harness", () => {
  test("runs the real agent through the authenticated route and canonical persistence", async () => {
    const report = await runCoworkOutcomeScenario(
      originalScenario("original-post"),
    );

    expect(
      report.pass,
      JSON.stringify({ safe: report.safe, actions: report.observed.actions }),
    ).toBe(true);
    expect(report.safe).toMatchObject({
      id: "original-post",
      status: 200,
      terminal: "ask",
      messageCount: 4,
      artifactCount: 1,
      actionCount: 2,
      inputTokens: 321,
      outputTokens: 144,
      costUsd: 0.000731,
      modelStages: [{ kind: "chat", model: "z-ai/glm-5.2" }],
    });
    expect(report.safe.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.persisted.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
    ]);
    expect(report.persisted.artifacts.map((artifact) => artifact.body)).toEqual([
      COMPLETE_POST,
    ]);
  });

  test("routes one original post through the tool-free writer and persists one canonical draft", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "direct-original-post",
      request: {
        message:
          "Write an original post in my voice about why a personal brand is career leverage.",
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(210, 95, 0.0001888),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST],
        actionNames: [],
      },
    });

    expect(
      report.pass,
      JSON.stringify({ safe: report.safe, failures: report.failureCodes }),
    ).toBe(true);
    expect(report.safe).toMatchObject({
      terminal: "done",
      artifactCount: 1,
      actionCount: 0,
      inputTokens: 210,
      outputTokens: 95,
      modelStages: [
        { kind: "cowork_direct_writer", model: "qwen/qwen3.7-plus" },
      ],
    });
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(report.observed.directWriterRequests[0]).toMatchObject({
      stage: "primary",
      model: "qwen/qwen3.7-plus",
      reasoning: "none",
    });
    expect(Object.keys(report.observed.directWriterRequests[0])).not.toContain(
      "tools",
    );
    expect(report.persisted.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(report.persisted.messages.some((message) => message.role === "tool"))
      .toBe(false);
  });

  test.each([
    ["model source", { modelSourceId: "00000000-0000-4000-8000-000000000401" }],
    ["creator style", { creatorStyleId: "00000000-0000-4000-8000-000000000402" }],
  ])(
    "keeps an explicitly requested but unresolved %s on the baseline path",
    async (_label, requestContext) => {
      const report = await runCoworkOutcomeScenario({
        id: `unresolved-${_label.replace(" ", "-")}`,
        request: {
          message:
            "Write an original post in my voice about why a personal brand is career leverage.",
          ...requestContext,
        },
        model: {
          provider: renderProvider([COMPLETE_POST]),
          directWriter: [
            {
              text: SECOND_POST,
              finishReason: "stop",
              usage: usage(210, 95, 0.0001888),
            },
          ],
        },
        expected: {
          terminal: "ask",
          artifactBodies: [COMPLETE_POST],
          actionNames: ["render_post", "ask_user"],
        },
      });

      expect(report.pass, report.failureCodes.join(", ")).toBe(true);
      expect(report.observed.agentProviderRounds).toBeGreaterThan(0);
      expect(report.observed.directWriterRequests).toHaveLength(0);
    },
  );

  test.each([
    "Write a post based on our conversation about pricing. Do not search.",
    "Write a post about the topic we covered yesterday. Do not search.",
    "Write a post from our call about founder-led sales. Do not search.",
  ])(
    "keeps conversation-dependent request on the history-aware baseline: %s",
    async (message) => {
      const report = await runCoworkOutcomeScenario({
        id: `conversation-dependent-${message.length}`,
        request: { message },
        model: {
          provider: renderProvider([COMPLETE_POST]),
          directWriter: [
            {
              text: SECOND_POST,
              finishReason: "stop",
              usage: usage(210, 95, 0.0001888),
            },
          ],
        },
        expected: {
          terminal: "ask",
          artifactBodies: [COMPLETE_POST],
          actionNames: ["render_post", "ask_user"],
        },
      });

      expect(report.pass, report.failureCodes.join(", ")).toBe(true);
      expect(report.observed.agentProviderRounds).toBeGreaterThan(0);
      expect(report.observed.directWriterRequests).toHaveLength(0);
    },
  );

  test.each([
    "Write a post about pricing and plan it for Friday.",
    "Write a post about pricing and queue it for Friday.",
    "Write a post about pricing and queue it.",
    "Write a post about pricing and put it on the calendar.",
    "Write a post about pricing and set it to ready.",
  ])(
    "keeps a combined writing and action request on the tool-capable baseline: %s",
    async (message) => {
      const report = await runCoworkOutcomeScenario({
        id: `writing-action-${message.length}`,
        request: { message },
        model: {
          provider: renderProvider([COMPLETE_POST]),
          directWriter: [
            {
              text: SECOND_POST,
              finishReason: "stop",
              usage: usage(210, 95, 0.0001888),
            },
          ],
        },
        expected: {
          terminal: "ask",
          artifactBodies: [COMPLETE_POST],
          actionNames: ["render_post", "ask_user"],
        },
      });

      expect(report.pass, report.failureCodes.join(", ")).toBe(true);
      expect(report.observed.agentProviderRounds).toBeGreaterThan(0);
      expect(report.observed.directWriterRequests).toHaveLength(0);
      expect(report.observed.actions.map((action) => action.name)).toContain(
        "render_post",
      );
    },
  );

  test.each([
    "Give me the opening line for a LinkedIn post about pricing. Do not search.",
    "Write a post explaining it. Do not search.",
    "Write a post about the idea. Do not search.",
    "Write a post about my idea. Do not search.",
    "Write a post about the point above. Do not search.",
  ])(
    "keeps a partial or topic-less request off the full-post engine: %s",
    async (message) => {
      const report = await runCoworkOutcomeScenario({
        id: `non-full-post-${message.length}`,
        request: { message },
        model: {
          provider: renderProvider([COMPLETE_POST]),
          directWriter: [
            {
              text: SECOND_POST,
              finishReason: "stop",
              usage: usage(210, 95, 0.0001888),
            },
          ],
        },
        expected: {
          terminal: "ask",
          artifactBodies: [COMPLETE_POST],
          actionNames: ["render_post", "ask_user"],
        },
      });

      expect(report.pass, report.failureCodes.join(", ")).toBe(true);
      expect(report.observed.agentProviderRounds).toBeGreaterThan(0);
      expect(report.observed.directWriterRequests).toHaveLength(0);
    },
  );

  test.each([
    "Research the latest LinkedIn trends and write a post about founder-led sales.",
    "Research B2B pricing strategies and write a post about pricing discipline.",
    "Research personal branding, then write a post about why it matters.",
    "Investigate how founder-led sales teams price services, then write a post about pricing discipline.",
  ])("keeps an explicit research-and-write request on the research-capable baseline: %s", async (message) => {
    const report = await runCoworkOutcomeScenario({
      id: `explicit-research-and-write-${message.length}`,
      request: { message },
      model: {
        provider: renderProvider([COMPLETE_POST]),
        directWriter: [
          {
            text: SECOND_POST,
            finishReason: "stop",
            usage: usage(210, 95, 0.0001888),
          },
        ],
      },
      expected: {
        terminal: "ask",
        artifactBodies: [COMPLETE_POST],
        actionNames: ["render_post", "ask_user"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBeGreaterThan(0);
    expect(report.observed.directWriterRequests).toHaveLength(0);
  });

  test("persists a typed direct-writer failure and succeeds on a same-chat retry", async () => {
    const message =
      "Write an original post in my voice about why a personal brand is career leverage.";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "direct-writer-exhausted",
        request: { message },
        model: {
          provider: { rounds: [] },
          directWriter: [
            { text: "", finishReason: "stop", usage: usage(120, 0, 0.00004) },
            { text: "", finishReason: "stop", usage: usage(140, 0, 0.00013) },
          ],
        },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: ["_recoverable"],
        },
      },
      {
        id: "direct-writer-retry",
        request: { message },
        model: {
          provider: { rounds: [] },
          directWriter: [
            {
              text: COMPLETE_POST,
              finishReason: "stop",
              usage: usage(210, 95, 0.0001888),
            },
          ],
        },
        expected: {
          terminal: "done",
          artifactBodies: [COMPLETE_POST],
          actionNames: [],
        },
      },
    ]);

    expect(
      sequence.pass,
      JSON.stringify(
        sequence.attempts.map((attempt) => ({
          safe: attempt.safe,
          failures: attempt.failureCodes,
        })),
      ),
    ).toBe(true);
    expect(sequence.recovered).toBe(true);
    expect(
      sequence.attempts[0]?.persisted.messages.at(-1)?.content.trim(),
    ).not.toBe("");
    expect(sequence.attempts[0]?.observed.agentProviderRounds).toBe(0);
    expect(sequence.attempts[1]?.observed.agentProviderRounds).toBe(0);
  });

  test("the durable Stop flag aborts a pending direct writer before repair, fallback, or persistence", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "direct-writer-durable-stop",
      request: {
        message:
          "Write an original post in my voice about why a personal brand is career leverage.",
      },
      model: {
        provider: { rounds: [] },
        directWriter: [{ cancelViaDatabase: true }],
      },
      expected: {
        terminal: "cancelled",
        artifactBodies: [],
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(report.persisted.artifacts).toHaveLength(0);
    expect(report.persisted.messages.at(-1)?.content).toBe(
      "Stopped before a draft was produced.",
    );
  });

  test("a Stop flag set as a valid writer response returns wins the acceptance race", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "direct-writer-stop-race",
      request: {
        message:
          "Write an original post in my voice about why a personal brand is career leverage.",
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            cancelViaDatabase: true,
            response: {
              text: COMPLETE_POST,
              finishReason: "stop",
              usage: usage(210, 95, 0.0001888),
            },
          },
        ],
      },
      expected: {
        terminal: "cancelled",
        artifactBodies: [],
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(report.persisted.artifacts).toHaveLength(0);
    expect(report.persisted.messages.at(-1)?.content).toBe(
      "Stopped before a draft was produced.",
    );
  });

  test("rejects the exact July 14 incomplete draft and persists only its provider-scripted repair", async () => {
    const report = await runCoworkOutcomeScenario(
      originalScenario("incomplete-draft-repair", {
        rounds: [
          {
            kind: "response",
            toolCalls: [
              {
                name: "render_post",
                args: { body: INCOMPLETE_ORIGINAL_POST_BODY },
              },
            ],
            usage: usage(300, 136, 0.0038),
          },
          {
            kind: "response",
            toolCalls: [
              { name: "render_post", args: { body: COMPLETE_POST } },
            ],
            usage: usage(350, 150, 0.0044),
          },
        ],
      }, ["render_post", "ask_user"]),
    );

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.artifacts).toHaveLength(1);
    expect(report.persisted.artifacts[0]?.body).toBe(COMPLETE_POST);
    expect(JSON.stringify(report.persisted)).not.toContain(
      INCOMPLETE_ORIGINAL_POST_BODY,
    );
    expect(report.safe.modelStages).toHaveLength(1);
  });

  test("persists a typed recoverable result instead of accepting an empty turn", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "empty-first-response",
      request: {
        message:
          "Write an original post in my voice about why a personal brand is career leverage.",
      },
      model: {
        provider: {
          rounds: [
            {
              kind: "response",
              text: "",
              finishReason: "stop",
              usage: usage(200, 0, 0.001),
            },
            {
              kind: "response",
              toolCalls: [
                { name: "render_post", args: { body: COMPLETE_POST } },
              ],
              usage: usage(250, 120, 0.0035),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["_recoverable"],
      },
    });

    expect(
      report.pass,
      JSON.stringify({ safe: report.safe, actions: report.observed.actions }),
    ).toBe(true);
    expect(report.failureCodes).not.toContain("empty_turn");
    expect(report.persisted.messages.at(-1)?.content.trim()).not.toBe("");
  });

  test("enforces an exact multi-draft count through the real deliverable contract", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "multi-deliverable",
      request: { message: "Write exactly two complete post variations." },
      model: {
        provider: {
          rounds: [
            {
              kind: "response",
              toolCalls: [
                { name: "render_post", args: { body: COMPLETE_POST } },
              ],
              usage: usage(260, 100, 0.003),
            },
            {
              kind: "response",
              toolCalls: [
                { name: "render_post", args: { body: SECOND_POST } },
              ],
              usage: usage(280, 110, 0.0033),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST, SECOND_POST],
        actionNames: ["render_post"],
      },
    });

    expect(
      report.pass,
      JSON.stringify({ safe: report.safe, actions: report.observed.actions }),
    ).toBe(true);
    expect(report.safe.artifactCount).toBe(2);
  });

  test("preserves verified provenance for an attached fixed source", async () => {
    const modelSourceId = "00000000-0000-4000-8000-000000000201";
    const sourcePostId = "00000000-0000-4000-8000-000000000202";
    const report = await runCoworkOutcomeScenario({
      id: "fixed-source-modeling",
      request: {
        message: "Model the attached source into one original post.",
        modelSourceId,
      },
      seed: {
        bookmarkModelSource: {
          id: modelSourceId,
          sourcePostId,
          postText:
            "A verified source explains why public proof compounds across career changes.",
          postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123",
        },
      },
      model: {
        sourceFidelity: [
          {
            pass: false,
            reasons: ["The first candidate did not preserve the source shape."],
            retryInstruction: "Use the source's hook-to-payoff sequence.",
          },
          { pass: true, reasons: [], retryInstruction: "" },
        ],
        provider: {
          rounds: [
            {
              kind: "response",
              toolCalls: [
                {
                  name: "render_post",
                  args: { body: SECOND_POST, sourcePostId },
                },
              ],
              usage: usage(250, 120, 0.0035),
            },
            {
              kind: "response",
              toolCalls: [
                {
                  name: "render_post",
                  args: { body: COMPLETE_POST, sourcePostId },
                },
              ],
              usage: usage(260, 122, 0.0036),
            },
          ],
        },
      },
      expected: {
        terminal: "ask",
        artifactBodies: [COMPLETE_POST],
        actionNames: ["render_post", "ask_user"],
        sourcePostIds: [sourcePostId],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
  });

  test("covers refine, partial writing, read-only, and planned-action journeys", async () => {
    const hooks =
      "1. Distribution compounds.\n2. Polish does not distribute itself.\n3. Reach is a product decision.";
    const analysis =
      "The strongest angle is durable career leverage because public proof compounds into inbound trust.";
    const scenarios: CoworkOutcomeScenario[] = [
      {
        ...originalScenario("refine-one-draft"),
        request: { message: "Make this draft tighter.", skipDecision: true },
        expected: {
          terminal: "done",
          artifactBodies: [COMPLETE_POST],
          actionNames: ["render_post"],
        },
      },
      {
        id: "partial-hooks",
        request: { message: "Give me exactly 3 hooks about distribution." },
        model: { provider: textProvider(hooks) },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: [],
          assistantContents: [hooks],
        },
      },
      {
        id: "read-only-analysis",
        request: { message: "Explain the strongest angle without changing anything." },
        model: { provider: textProvider(analysis) },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: [],
          assistantContents: [analysis],
        },
      },
      {
        id: "planned-action",
        request: {
          message:
            "Build a seven-day content campaign with seven posts and a repurposing schedule.",
        },
        model: {
          provider: {
            rounds: [
              {
                kind: "response",
                toolCalls: [
                  {
                    name: "write_plan",
                    args: {
                      steps: [
                        "Choose the angle",
                        "Draft the post",
                        "Review the CTA",
                      ],
                    },
                  },
                ],
                usage: usage(180, 40, 0.0014),
              },
              {
                kind: "response",
                text: "The plan is ready.",
                finishReason: "stop",
                usage: usage(210, 20, 0.0012),
              },
            ],
          },
        },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: ["write_plan"],
        },
      },
    ];

    for (const scenario of scenarios) {
      const report = await runCoworkOutcomeScenario(scenario);
      expect(report.pass, `${scenario.id}: ${report.failureCodes.join(", ")}`).toBe(true);
    }
  });

  test("turns red when an exact-count request persists too few drafts", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "wrong-deliverable-count",
      request: { message: "Write exactly two complete post variations." },
      model: {
        provider: {
          rounds: [
            {
              kind: "response",
              toolCalls: [
                { id: "call_only_one", name: "render_post", args: { body: COMPLETE_POST } },
              ],
              usage: usage(260, 100, 0.003),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST, SECOND_POST],
        actionNames: ["render_post"],
      },
    });

    expect(report.pass).toBe(false);
    expect(report.failureCodes).toContain("deliverable_count");
  });

  test("turns red when attached-source provenance is not verified", async () => {
    const modelSourceId = "00000000-0000-4000-8000-000000000301";
    const sourcePostId = "00000000-0000-4000-8000-000000000302";
    const report = await runCoworkOutcomeScenario({
      id: "unsupported-provenance",
      request: {
        message: "Model the attached source into one original post.",
        modelSourceId,
      },
      seed: {
        bookmarkModelSource: {
          id: modelSourceId,
          sourcePostId,
          postText: "A verified source about durable public proof.",
          postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:456",
        },
      },
      model: {
        provider: renderProvider([COMPLETE_POST], {
          sourcePostIds: ["invented-unverified-source"],
        }),
      },
      expected: {
        terminal: "ask",
        artifactBodies: [COMPLETE_POST],
        actionNames: ["render_post", "ask_user"],
        sourcePostIds: [sourcePostId],
      },
    });

    expect(report.pass).toBe(false);
    expect(report.failureCodes).toContain("provenance");
  });

  test("turns red for semantically duplicate actions with distinct ids", async () => {
    const duplicateArgs = { body: COMPLETE_POST };
    const report = await runCoworkOutcomeScenario({
      id: "semantic-duplicate-actions",
      request: { message: "Write one complete original post." },
      model: {
        provider: {
          rounds: [
            {
              kind: "response",
              toolCalls: [
                { id: "call_duplicate_a", name: "render_post", args: duplicateArgs },
                { id: "call_duplicate_b", name: "render_post", args: duplicateArgs },
              ],
              usage: usage(320, 160, 0.004),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST],
        actionNames: ["render_post", "render_post"],
      },
    });

    expect(report.pass).toBe(false);
    expect(report.failureCodes).toContain("duplicate_action");
  });

  test("turns red for duplicate persisted artifacts even when ids differ", async () => {
    const report = await runCoworkOutcomeScenario({
      ...originalScenario("duplicate-artifact-control"),
      negativeControl: { duplicatePersistedArtifact: true },
    });

    expect(report.pass).toBe(false);
    expect(report.failureCodes).toContain("duplicate_artifact");
  });

  test("completes a draft after a persisted clarification answer", async () => {
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "clarification-question",
        request: { message: "Write a post about my career, but ask which angle first." },
        model: {
          provider: {
            rounds: [
              {
                kind: "response",
                toolCalls: [
                  {
                    id: "call_clarify",
                    name: "ask_user",
                    args: {
                      question: "Which career angle should the post focus on?",
                      options: ["Career leverage", "Leadership lessons"],
                      allowOther: true,
                    },
                  },
                ],
                usage: usage(180, 40, 0.0012),
              },
            ],
          },
        },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
        },
      },
      {
        ...originalScenario("clarification-completion"),
        request: { message: "Career leverage." },
      },
    ]);

    expect(
      sequence.pass,
      JSON.stringify(
        sequence.attempts.map(({ safe, failureCodes }) => ({ safe, failureCodes })),
      ),
    ).toBe(true);
    expect(sequence.attempts.at(-1)?.safe.artifactCount).toBe(1);
  });

  test("honors an explicit no-search instruction on an original post", async () => {
    const report = await runCoworkOutcomeScenario({
      ...originalScenario("explicit-no-search"),
      request: {
        message:
          "Write one original post about career leverage. Do not search for or model any source.",
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(210, 95, 0.0001888),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST],
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(
      report.observed.actions.some((action) =>
        ["search_viral_posts", "get_top_from_batch", "search_news"].includes(
          action.name,
        ),
      ),
    ).toBe(false);
    expect(report.observed.agentProviderRounds).toBe(0);
  });

  test("fails closed when a news draft has no verified search result", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "news-fail-closed",
      request: { message: "Write a post about OpenAI's latest funding round." },
      model: {
        provider: {
          rounds: [
            {
              kind: "response",
              toolCalls: [
                { name: "render_post", args: { body: COMPLETE_POST } },
              ],
              usage: usage(260, 100, 0.003),
            },
            {
              kind: "response",
              text: "No verified fresh news was found, so I did not create a post.",
              finishReason: "stop",
              usage: usage(170, 25, 0.0009),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["render_post"],
        assistantContents: [
          "No verified fresh news was found, so I did not create a post.",
        ],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.artifacts).toHaveLength(0);
    expect(
      report.persisted.messages.find((message) => message.role === "tool")?.content,
    ).toContain("no fresh stories");
  });

  test("runs and persists a real draft-management side effect", async () => {
    const draftId = "00000000-0000-4000-8000-000000000401";
    const report = await runCoworkOutcomeScenario({
      id: "move-draft-ready",
      request: { message: "Move the saved Career leverage draft to ready." },
      seed: {
        draft: {
          id: draftId,
          title: "Career leverage",
          body: COMPLETE_POST,
          status: "drafting",
        },
      },
      model: {
        provider: {
          rounds: [
            {
              kind: "response",
              toolCalls: [
                {
                  id: "call_move_ready",
                  name: "move_on_board",
                  args: { id: draftId, status: "ready" },
                },
              ],
              usage: usage(220, 50, 0.0015),
            },
            {
              kind: "response",
              text: "Moved the draft to ready.",
              finishReason: "stop",
              usage: usage(170, 20, 0.0008),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["move_on_board"],
        assistantContents: ["Moved the draft to ready."],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.drafts.find((draft) => draft.id === draftId)?.status).toBe(
      "ready",
    );
  });

  test("aborts the real HTTP/model signal and persists a cancelled terminal outcome", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "cancelled",
      request: { message: "Write one post, then stop when I cancel." },
      model: { provider: { rounds: [{ kind: "cancel" }] } },
      expected: {
        terminal: "cancelled",
        artifactBodies: [],
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.messages.at(-1)?.role).toBe("assistant");
  });

  test("persists provider timeout and recovers on a same-chat retry", async () => {
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "timeout-first-attempt",
        request: { message: "Write one original post." },
        model: {
          provider: {
            rounds: [
              {
                kind: "error",
                message: "provider timed out",
                code: "ETIMEDOUT",
              },
            ],
          },
        },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: ["_recoverable"],
        },
      },
      originalScenario("successful-retry"),
    ]);

    expect(
      sequence.pass,
      JSON.stringify(
        sequence.attempts.map((attempt) => ({
          safe: attempt.safe,
          failures: attempt.failureCodes,
          actions: attempt.observed.actions,
        })),
      ),
    ).toBe(true);
    expect(sequence.recovered).toBe(true);
    expect(sequence.attempts.map((attempt) => attempt.safe.terminal)).toEqual([
      "done",
      "ask",
    ]);
  });

  test("safe report output cannot leak prompts, bodies, credentials, or errors", async () => {
    const secret = "sk-or-v1-abcdefghijklmnopqrstuvwxyz123456";
    const report = await runCoworkOutcomeScenario({
      ...originalScenario("safe-report"),
      request: { message: `Write a private post using ${secret}` },
    });
    const line = safeCoworkReportLine(report);

    expect(line).not.toContain(secret);
    expect(line).not.toContain(COMPLETE_POST);
    expect(line).not.toContain("Write a private post");
    expect(JSON.parse(line)).toEqual(report.safe);
  });
});

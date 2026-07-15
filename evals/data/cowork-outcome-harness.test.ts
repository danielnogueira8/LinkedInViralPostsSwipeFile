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
import { buildHookOnlyRefineMessage } from "@/lib/hook-splice";
import { POST_INTENTS } from "@/lib/post-intents";
import { PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL } from "@/lib/agent/read-only-orchestrator";
import {
  FALLBACK_ACTION_ORCHESTRATOR_MODEL,
  PRIMARY_ACTION_ORCHESTRATOR_MODEL,
} from "@/lib/agent/action-orchestrator";

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
const THIRD_POST = [
  "The safest time to build career leverage is before you need a new opportunity.",
  "Publish the decisions you make, the tradeoffs you notice, and the lessons your work keeps teaching you.",
  "That visible record gives future clients, teammates, and employers evidence they can inspect without waiting for an interview.",
  "A personal brand is simply useful proof made easy to find. Start documenting the work this week.",
].join("\n\n");
const FILE_GROUNDED_POST = [
  "Customer interviews are most useful when they change the workflow, not just the copy.",
  "The attached interview showed that onboarding delays were creating uncertainty before users reached the product's value.",
  "That is a product problem with a communication symptom. Shorten the path, make the next step visible, and measure where confidence drops.",
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
    expect(report.persisted.artifacts.map((artifact) => artifact.body)).toEqual(
      [COMPLETE_POST],
    );
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
        readOnlyOrchestrator: {
          plans: [
            {
              model: PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
              toolArgs: null,
              usage: usage(1, 1, 0.001),
            },
          ],
        },
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
    expect(report.observed.readOnlyPlannerRequests).toHaveLength(0);
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
    expect(
      report.persisted.messages.some((message) => message.role === "tool"),
    ).toBe(false);
  });

  test("routes the exact July 14 flagship prompt through the tool-free writer", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "direct-original-flagship-prompt",
      request: {
        message:
          "Write an original post in my voice about how building a personal brand is the biggest leverage you can build for your career. Choose a proven framework that fits the topic, but do not model it after one specific source post.",
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
      JSON.stringify({ failures: report.failureCodes, report }, null, 2),
    ).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(report.safe.modelStages).toEqual([
      { kind: "cowork_direct_writer", model: "qwen/qwen3.7-plus" },
    ]);
  });

  test("checkpoints a combined saved-draft move and planned date through the action lane", async () => {
    const draftId = "00000000-0000-4000-8000-000000000710";
    const report = await runCoworkOutcomeScenario({
      id: "action-move-and-plan",
      request: {
        message:
          "Move the pricing draft to ready and plan it for 2026-07-17.",
      },
      seed: {
        draft: {
          id: draftId,
          title: "Pricing discipline",
          body: COMPLETE_POST,
          status: "drafting",
        },
      },
      model: {
        provider: { rounds: [] },
        actionOrchestrator: {
          plans: [
            {
              model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
              toolArgs: {
                actions: [
                  {
                    id: "move",
                    type: "move_on_board",
                    draftId,
                    status: "ready",
                  },
                  {
                    id: "plan",
                    type: "schedule_post",
                    draftId,
                    date: "2026-07-17",
                  },
                ],
              },
              usage: usage(90, 18, 0.001),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["list_drafts", "move_on_board", "schedule_post"],
      },
    });

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, report }, null, 2),
    ).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.actionPlannerRequests).toHaveLength(1);
    expect(report.observed.actionTools.map((tool) => tool.name)).toEqual([
      "list_drafts",
    ]);
    expect(report.persisted.drafts[0]).toMatchObject({
      id: draftId,
      status: "ready",
      plan_to_post_on: "2026-07-17",
      lifecycle_version: 2,
    });
    expect(report.safe.modelStages).toEqual([
      {
        kind: "cowork_action_orchestrator",
        model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
      },
    ]);
  });

  test("provider fallback resumes a committed action checkpoint with zero replayed mutation", async () => {
    const draftId = "00000000-0000-4000-8000-000000000711";
    const report = await runCoworkOutcomeScenario({
      id: "action-fallback-resume",
      request: { message: "Move the pricing draft to ready." },
      seed: {
        draft: {
          id: draftId,
          title: "Pricing discipline",
          body: COMPLETE_POST,
          status: "drafting",
        },
      },
      model: {
        provider: { rounds: [] },
        actionOrchestrator: {
          precommitFirstMutation: true,
          allowNoModel: true,
          plans: [
            {
              model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
              error: "primary unavailable",
            },
            {
              model: FALLBACK_ACTION_ORCHESTRATOR_MODEL,
              toolArgs: {
                actions: [
                  {
                    id: "move",
                    type: "move_on_board",
                    draftId,
                    status: "ready",
                  },
                ],
              },
              usage: usage(75, 15, 0.0008),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["move_on_board"],
      },
    });

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, report }, null, 2),
    ).toBe(true);
    expect(report.observed.actionPlannerRequests).toHaveLength(0);
    expect(report.observed.actionTools).toHaveLength(0);
    expect(report.persisted.drafts[0]).toMatchObject({
      id: draftId,
      status: "ready",
      lifecycle_version: 0,
    });
    expect(JSON.stringify(report.persisted.messages)).toContain(
      "already committed",
    );
  });

  test("a Retry after an action clarification restores the expanded instruction", async () => {
    const draftId = "00000000-0000-4000-8000-000000000713";
    const report = await runCoworkOutcomeScenario({
      id: "action-clarification-retry",
      request: { message: "2026-07-20" },
      seed: {
        draft: {
          id: draftId,
          title: "Hiring discipline",
          body: COMPLETE_POST,
          status: "drafting",
        },
      },
      model: {
        provider: { rounds: [] },
        actionOrchestrator: {
          rolloutDisabled: true,
          retryEffectiveInstruction:
            "Schedule the hiring draft.\n\nClarification answer: 2026-07-20",
          plans: [
            {
              model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
              toolArgs: {
                actions: [
                  {
                    id: "plan",
                    type: "schedule_post",
                    draftId,
                    date: "2026-07-20",
                  },
                ],
              },
              usage: usage(75, 15, 0.0008),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["list_drafts", "schedule_post"],
      },
    });

    expect(
      report.pass,
      JSON.stringify({
        failures: report.failureCodes,
        actions: report.observed.actions,
        actionTools: report.observed.actionTools,
        messages: report.persisted.messages,
      }),
    ).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.persisted.drafts[0]).toMatchObject({
      id: draftId,
      plan_to_post_on: "2026-07-20",
      lifecycle_version: 1,
    });
  });

  test("a user can cancel a pending board clarification without any mutation", async () => {
    const draftId = "00000000-0000-4000-8000-000000000714";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "action-cancel-question",
        request: { message: "Move the pricing draft." },
        seed: {
          draft: {
            id: draftId,
            title: "Pricing discipline",
            body: COMPLETE_POST,
            status: "drafting",
          },
        },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: {
            plans: [],
            allowNoModel: true,
          },
        },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
        },
      },
      {
        id: "action-cancel-answer",
        request: { message: "Never mind" },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: { plans: [], allowNoModel: true },
        },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: [],
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[1]?.persisted.drafts[0]).toMatchObject({
      id: draftId,
      status: "drafting",
      lifecycle_version: 0,
    });
    expect(sequence.attempts[1]?.observed.actionPlannerRequests).toHaveLength(0);
  });

  test("nested action clarifications preserve the normalized route and exact selected ids", async () => {
    const pricingId = "00000000-0000-4000-8000-000000000715";
    const hiringId = "00000000-0000-4000-8000-000000000716";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "action-nested-count",
        request: { message: "Move all drafts to ready." },
        seed: {
          drafts: [
            {
              id: pricingId,
              title: "Pricing; strategy",
              body: COMPLETE_POST,
              status: "drafting",
            },
            {
              id: hiringId,
              title: "Hiring strategy",
              body: COMPLETE_POST,
              status: "drafting",
            },
          ],
        },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: { plans: [], allowNoModel: true },
        },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
        },
      },
      {
        id: "action-nested-targets",
        request: { message: "Two" },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: {
            rolloutDisabled: true,
            plans: [
              {
                model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
                toolArgs: {
                  actions: [
                    {
                      id: "choose",
                      type: "clarify_target",
                      candidateDraftIds: [pricingId, hiringId],
                    },
                  ],
                },
                usage: usage(75, 15, 0.0008),
              },
            ],
          },
        },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["list_drafts", "ask_user"],
        },
      },
      {
        id: "action-nested-selection",
        request: {
          message: "Pricing strategy; Hiring strategy",
          actionSelectionIds: [pricingId, hiringId],
        },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: {
            rolloutDisabled: true,
            plans: [
              {
                model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
                toolArgs: {
                  actions: [
                    {
                      id: "move-pricing",
                      type: "move_on_board",
                      draftId: pricingId,
                      status: "ready",
                    },
                    {
                      id: "move-hiring",
                      type: "move_on_board",
                      draftId: hiringId,
                      status: "ready",
                    },
                  ],
                },
                usage: usage(75, 15, 0.0008),
              },
            ],
          },
        },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: ["list_drafts", "move_on_board", "move_on_board"],
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[2]?.persisted.drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pricingId, status: "ready" }),
        expect.objectContaining({ id: hiringId, status: "ready" }),
      ]),
    );
    expect(
      sequence.attempts[2]?.observed.actionPlannerRequests[0]?.confirmedTargetIds,
    ).toEqual([pricingId, hiringId]);
  });

  test("nested schedule clarifications preserve the local absolute date through exact target selection", async () => {
    const pricingId = "00000000-0000-4000-8000-000000000725";
    const hiringId = "00000000-0000-4000-8000-000000000726";
    const clientTimezone = "Europe/Lisbon";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "action-schedule-needs-date",
        request: {
          message: "Schedule all drafts.",
          clientTimezone,
        },
        seed: {
          drafts: [
            {
              id: pricingId,
              title: "Pricing strategy",
              body: COMPLETE_POST,
              status: "ready",
            },
            {
              id: hiringId,
              title: "Hiring strategy",
              body: COMPLETE_POST,
              status: "ready",
            },
          ],
        },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: { plans: [], allowNoModel: true },
        },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
        },
      },
      {
        id: "action-schedule-needs-count",
        request: { message: "Tomorrow", clientTimezone },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: { plans: [], allowNoModel: true },
        },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
        },
      },
      {
        id: "action-schedule-needs-targets",
        request: { message: "Two", clientTimezone },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: {
            plans: [
              {
                model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
                toolArgs: {
                  actions: [
                    {
                      id: "choose",
                      type: "clarify_target",
                      candidateDraftIds: [pricingId, hiringId],
                    },
                  ],
                },
                usage: usage(75, 15, 0.0008),
              },
            ],
          },
        },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["list_drafts", "ask_user"],
        },
      },
      {
        id: "action-schedule-exact-targets",
        request: {
          message: "Pricing strategy; Hiring strategy",
          actionSelectionIds: [pricingId, hiringId],
          clientTimezone,
        },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: {
            plans: [
              {
                model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
                toolArgs: {
                  actions: [
                    {
                      id: "schedule-pricing",
                      type: "schedule_post",
                      draftId: pricingId,
                      date: "2026-07-16",
                    },
                    {
                      id: "schedule-hiring",
                      type: "schedule_post",
                      draftId: hiringId,
                      date: "2026-07-16",
                    },
                  ],
                },
                usage: usage(75, 15, 0.0008),
              },
            ],
          },
        },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: ["list_drafts", "schedule_post", "schedule_post"],
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[1]?.observed.actionPlannerRequests).toHaveLength(0);
    expect(sequence.attempts[2]?.observed.actionPlannerRequests[0]?.route).toEqual({
      kind: "action_management",
      targetCount: 2,
      requirements: [
        {
          type: "schedule_post",
          date: "2026-07-16",
          timeZone: clientTimezone,
        },
      ],
    });
    expect(sequence.attempts[3]?.observed.actionPlannerRequests[0]).toMatchObject({
      route: {
        kind: "action_management",
        targetCount: 2,
        requirements: [
          {
            type: "schedule_post",
            date: "2026-07-16",
            timeZone: clientTimezone,
          },
        ],
      },
      confirmedTargetIds: [pricingId, hiringId],
    });
    expect(sequence.attempts[3]?.persisted.drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pricingId,
          plan_to_post_on: "2026-07-16",
          lifecycle_version: 1,
        }),
        expect.objectContaining({
          id: hiringId,
          plan_to_post_on: "2026-07-16",
          lifecycle_version: 1,
        }),
      ]),
    );
  });

  test("a retry-context write failure releases the turn and a fresh request can succeed", async () => {
    const draftId = "00000000-0000-4000-8000-000000000717";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "action-context-write-failure",
        request: { message: "Move the pricing draft to ready." },
        seed: {
          draft: {
            id: draftId,
            title: "Pricing discipline",
            body: COMPLETE_POST,
            status: "drafting",
          },
        },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: {
            plans: [],
            failRetryContextSave: true,
          },
        },
        expected: {
          httpStatus: 503,
          terminal: "failure",
          artifactBodies: [],
          actionNames: [],
        },
      },
      {
        id: "action-context-write-recovery",
        request: { message: "Move the pricing draft to ready." },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: {
            plans: [
              {
                model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
                toolArgs: {
                  actions: [
                    {
                      id: "move",
                      type: "move_on_board",
                      draftId,
                      status: "ready",
                    },
                  ],
                },
                usage: usage(75, 15, 0.0008),
              },
            ],
          },
        },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: ["list_drafts", "move_on_board"],
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[0]?.persisted.messages.at(-1)?.content).toMatch(
      /safety context/i,
    );
    expect(sequence.attempts[1]?.persisted.drafts[0]).toMatchObject({
      id: draftId,
      status: "ready",
    });
  });

  test("Retrying a fresh repeated instruction never binds an older identical checkpoint", async () => {
    const draftId = "00000000-0000-4000-8000-000000000714";
    const report = await runCoworkOutcomeScenario({
      id: "action-fresh-identical-retry",
      request: { message: "Move the pricing draft to ready." },
      seed: {
        draft: {
          id: draftId,
          title: "Pricing discipline",
          body: COMPLETE_POST,
          status: "drafting",
        },
      },
      model: {
        provider: { rounds: [] },
        actionOrchestrator: {
          historicalIdenticalCheckpointBeforeRetry: true,
          plans: [
            {
              model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
              toolArgs: {
                actions: [
                  {
                    id: "move",
                    type: "move_on_board",
                    draftId,
                    status: "ready",
                  },
                ],
              },
              usage: usage(75, 15, 0.0008),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["list_drafts", "move_on_board"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.drafts[0]).toMatchObject({
      id: draftId,
      status: "ready",
      lifecycle_version: 1,
    });
    expect(JSON.stringify(report.persisted.messages)).not.toContain(
      "already committed",
    );
  });

  test("a cancellation after the first checkpoint prevents every later action", async () => {
    const draftId = "00000000-0000-4000-8000-000000000712";
    const report = await runCoworkOutcomeScenario({
      id: "action-cancel-between-mutations",
      request: {
        message:
          "Move the pricing draft to ready and plan it for 2026-07-17.",
      },
      seed: {
        draft: {
          id: draftId,
          title: "Pricing discipline",
          body: COMPLETE_POST,
          status: "drafting",
        },
      },
      model: {
        provider: { rounds: [] },
        actionOrchestrator: {
          cancelAfterMutationCount: 1,
          plans: [
            {
              model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
              toolArgs: {
                actions: [
                  {
                    id: "move",
                    type: "move_on_board",
                    draftId,
                    status: "ready",
                  },
                  {
                    id: "plan",
                    type: "schedule_post",
                    draftId,
                    date: "2026-07-17",
                  },
                ],
              },
              usage: usage(90, 18, 0.001),
            },
          ],
        },
      },
      expected: {
        terminal: "cancelled",
        artifactBodies: [],
        actionNames: ["list_drafts", "move_on_board"],
      },
    });

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, report }, null, 2),
    ).toBe(true);
    expect(report.observed.actionTools.map((tool) => tool.name)).toEqual([
      "list_drafts",
    ]);
    expect(report.persisted.drafts[0]).toMatchObject({
      status: "ready",
      plan_to_post_on: null,
      lifecycle_version: 1,
    });
  });

  test.each([
    [
      "publish",
      "Publish the pricing draft now.",
      "Cowork cannot publish without the existing explicit publishing flow. Open the saved draft in Posts when you are ready to schedule or publish it.",
    ],
    [
      "save",
      "Save the pricing draft.",
      "Use Save draft on the draft card first; Cowork cannot claim an unsaved preview is already on your board.",
    ],
  ])(
    "fails closed for a disallowed %s request without calling a model or mutation",
    async (kind, message, assistantContent) => {
      const report = await runCoworkOutcomeScenario({
        id: `action-disallowed-${kind}`,
        request: { message },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: {
            plans: [],
            allowNoModel: true,
          },
        },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: [],
          assistantContents: [assistantContent],
        },
      });

      expect(
        report.pass,
        JSON.stringify({ failures: report.failureCodes, report }, null, 2),
      ).toBe(true);
      expect(report.observed.actionPlannerRequests).toHaveLength(0);
      expect(report.observed.actionTools).toHaveLength(0);
      expect(report.safe.modelStages).toHaveLength(0);
    },
  );

  test("an unsaved draft referent cannot mutate an unrelated saved board row", async () => {
    const savedDraftId = "00000000-0000-4000-8000-000000000710";
    const report = await runCoworkOutcomeScenario({
      id: "unsaved-referent-fails-closed",
      request: { message: "Move this draft to ready." },
      seed: {
        messageArtifact: {
          id: "unsaved-preview",
          kind: "post",
          title: "Unsaved preview",
          body: COMPLETE_POST,
        },
        draft: {
          id: savedDraftId,
          title: "Unrelated saved draft",
          body: COMPLETE_POST,
          status: "drafting",
        },
      },
      model: {
        provider: { rounds: [] },
        actionOrchestrator: { plans: [], allowNoModel: true },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        assistantContents: [
          "Use Save draft on the draft card first; Cowork cannot claim an unsaved preview is already on your board.",
        ],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.drafts[0]).toMatchObject({
      id: savedDraftId,
      status: "drafting",
      lifecycle_version: 0,
    });
    expect(report.observed.actionPlannerRequests).toHaveLength(0);
  });

  test("a draft saved from the preview can be moved by its generic referent", async () => {
    const savedDraftId = "00000000-0000-4000-8000-000000000710";
    const report = await runCoworkOutcomeScenario({
      id: "saved-preview-referent-moves",
      request: { message: "Move this draft to ready." },
      seed: {
        messageArtifact: {
          id: "saved-preview",
          kind: "post",
          title: "Saved preview",
          body: COMPLETE_POST,
          meta: { board_draft_id: savedDraftId },
        },
        draft: {
          id: savedDraftId,
          title: "Saved preview",
          body: COMPLETE_POST,
          status: "drafting",
        },
      },
      model: {
        provider: { rounds: [] },
        actionOrchestrator: {
          plans: [
            {
              model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
              toolArgs: {
                actions: [
                  {
                    id: "move",
                    type: "move_on_board",
                    draftId: savedDraftId,
                    status: "ready",
                  },
                ],
              },
              usage: usage(75, 15, 0.0008),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["list_drafts", "move_on_board"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.drafts[0]).toMatchObject({
      id: savedDraftId,
      status: "ready",
      lifecycle_version: 1,
    });
  });

  test("a specifically named draft remains targetable beyond the 50 newest board rows", async () => {
    const targetId = "00000000-0000-4000-8000-000000000799";
    const fillers = Array.from({ length: 60 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 800).padStart(12, "0")}`,
      title: `Recent filler ${index + 1}`,
      body: COMPLETE_POST,
      status: "drafting" as const,
    }));
    const report = await runCoworkOutcomeScenario({
      id: "named-draft-beyond-recent-window",
      request: { message: "Move the Legacy pricing draft to ready." },
      seed: {
        drafts: [
          ...fillers,
          {
            id: targetId,
            title: "Legacy pricing",
            body: COMPLETE_POST,
            status: "drafting",
          },
        ],
      },
      model: {
        provider: { rounds: [] },
        actionOrchestrator: {
          plans: [
            {
              model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
              toolArgs: {
                actions: [
                  {
                    id: "move",
                    type: "move_on_board",
                    draftId: targetId,
                    status: "ready",
                  },
                ],
              },
              usage: usage(75, 15, 0.0008),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["list_drafts", "move_on_board"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.actionTools[0]).toMatchObject({
      name: "list_drafts",
      args: { title_query: "Legacy pricing" },
    });
    expect(report.persisted.drafts.find((draft) => draft.id === targetId)).toMatchObject({
      status: "ready",
      lifecycle_version: 1,
    });
  });

  test.each([
    ["model source", { modelSourceId: "00000000-0000-4000-8000-000000000401" }],
    [
      "creator style",
      { creatorStyleId: "00000000-0000-4000-8000-000000000402" },
    ],
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
  ])(
    "keeps an explicit research-and-write request on the research-capable baseline: %s",
    async (message) => {
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

      expect(
        report.pass,
        JSON.stringify({
          failures: report.failureCodes,
          safe: report.safe,
          actions: report.observed.actions,
          messages: report.persisted.messages,
          requests: report.observed.directWriterRequests,
        }),
      ).toBe(true);
      expect(report.observed.agentProviderRounds).toBeGreaterThan(0);
      expect(report.observed.directWriterRequests).toHaveLength(0);
    },
  );

  test("runs fresh-news writing through the typed orchestrator and tool-free draft engine", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "read-only-orchestrator-news",
      request: {
        message:
          "Research the latest OpenAI announcement and write a LinkedIn post about what it means for founders.",
      },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [
            {
              model: PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
              toolArgs: {
                actions: [
                  {
                    id: "news",
                    type: "search_news",
                    query: "latest OpenAI announcement founders",
                  },
                  {
                    id: "draft",
                    type: "draft_post",
                    evidenceActionIds: ["news"],
                  },
                ],
              },
              usage: usage(100, 20, 0.0012),
            },
          ],
          toolResults: {
            search_news: [
              {
                ok: true,
                max_age_days: 14,
                searched: 1,
                results: [
                  {
                    title: "OpenAI launches a verified product",
                    url: "https://openai.com/news/product",
                    source: "OpenAI",
                    published_at: "2026-07-14",
                    summary:
                      "OpenAI announced a product that makes workflow automation faster.",
                  },
                ],
              },
            ],
          },
        },
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
        actionNames: ["search_news", "write_grounded_post"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.readOnlyPlannerRequests).toHaveLength(1);
    expect(report.observed.readOnlyTools.map((tool) => tool.name)).toEqual([
      "search_news",
    ]);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(Object.keys(report.observed.directWriterRequests[0])).not.toContain(
      "tools",
    );
    expect(report.safe.modelStages).toEqual([
      {
        kind: "cowork_orchestrator",
        model: PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
      },
      { kind: "cowork_direct_writer", model: "qwen/qwen3.7-plus" },
    ]);
  });

  test("produces the exact plural draft count from one verified research checkpoint", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "read-only-orchestrator-news-multi-draft",
      request: {
        message:
          "Research the latest OpenAI announcement and write two LinkedIn posts.",
      },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [
            {
              model: PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
              toolArgs: {
                actions: [
                  {
                    id: "news",
                    type: "search_news",
                    query: "latest OpenAI announcement",
                  },
                  {
                    id: "draft",
                    type: "draft_post",
                    evidenceActionIds: ["news"],
                  },
                ],
              },
              usage: usage(100, 20, 0.0012),
            },
          ],
          toolResults: {
            search_news: [
              {
                ok: true,
                max_age_days: 14,
                results: [
                  {
                    title: "OpenAI launches a verified product",
                    url: "https://openai.com/news/product",
                    source: "OpenAI",
                    published_at: "2026-07-14",
                    summary: "OpenAI announced a verified product update.",
                  },
                ],
              },
            ],
          },
        },
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(210, 95, 0.0001888),
          },
          {
            text: SECOND_POST,
            finishReason: "stop",
            usage: usage(220, 100, 0.0002),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST, SECOND_POST],
        actionNames: ["search_news", "write_grounded_post"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.readOnlyTools).toHaveLength(1);
    expect(report.observed.directWriterRequests).toHaveLength(2);
  });

  test("runs multi-source swipe-file research once and persists verified provenance", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "read-only-orchestrator-multi-source",
      request: {
        message:
          "Find three viral SaaS posts, compare their patterns, and write one original LinkedIn post about pricing discipline.",
      },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [
            {
              model: PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
              toolArgs: {
                actions: [
                  {
                    id: "sources",
                    type: "search_viral_posts",
                    niche: "SaaS",
                    limit: 3,
                  },
                  {
                    id: "draft",
                    type: "draft_post",
                    evidenceActionIds: ["sources"],
                  },
                ],
              },
              usage: usage(90, 18, 0.001),
            },
          ],
          toolResults: {
            search_viral_posts: [
              {
                ok: true,
                count: 3,
                posts: [
                  {
                    id: "source-a",
                    text: "A pricing lesson.",
                    post_url: "https://linkedin.com/a",
                  },
                  {
                    id: "source-b",
                    text: "A positioning lesson.",
                    post_url: "https://linkedin.com/b",
                  },
                  {
                    id: "source-c",
                    text: "A packaging lesson.",
                    post_url: "https://linkedin.com/c",
                  },
                ],
              },
            ],
          },
        },
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(220, 100, 0.0002),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST],
        actionNames: ["search_viral_posts", "write_grounded_post"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(
      report.persisted.artifacts[0]?.meta?.research_provenance,
    ).toMatchObject({
      route: "workspace_research",
      sources: [
        { id: "source-a", url: "https://linkedin.com/a" },
        { id: "source-b", url: "https://linkedin.com/b" },
        { id: "source-c", url: "https://linkedin.com/c" },
      ],
    });
    expect(report.observed.readOnlyTools).toHaveLength(1);
  });

  test("inspects attached evidence before invoking the grounded writer", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "read-only-orchestrator-file",
      request: {
        message:
          "Inspect the attached customer interview and write a LinkedIn post from the verified lessons in it.",
        attachments: [
          {
            kind: "text",
            filename: "interview.txt",
            text: "The customer said onboarding delays made the next step unclear.",
          },
        ],
      },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [
            {
              model: PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
              toolArgs: {
                actions: [
                  { id: "file", type: "inspect_attachments" },
                  {
                    id: "draft",
                    type: "draft_post",
                    evidenceActionIds: ["file"],
                  },
                ],
              },
              usage: usage(80, 16, 0.0009),
            },
          ],
          attachmentSources: [
            {
              id: "interview-1",
              kind: "attachment",
              title: "interview.txt",
              text: "The customer said onboarding delays made the next step unclear.",
            },
          ],
        },
        directWriter: [
          {
            text: FILE_GROUNDED_POST,
            finishReason: "stop",
            usage: usage(230, 110, 0.00022),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [FILE_GROUNDED_POST],
        actionNames: ["inspect_attachments", "write_grounded_post"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.readOnlyTools).toHaveLength(0);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(
      JSON.stringify(report.observed.directWriterRequests[0].messages),
    ).toContain("customer said onboarding delays");
  });

  test("asks one typed question for an ambiguous complex read-only request", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "read-only-orchestrator-ambiguity",
      request: { message: "Research the latest OpenAI news." },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [],
        },
        directWriter: [],
      },
      expected: {
        terminal: "ask",
        artifactBodies: [],
        actionNames: ["ask_user"],
        assistantContents: ["What should I create from this research?"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.readOnlyPlannerRequests).toHaveLength(0);
    expect(report.observed.directWriterRequests).toHaveLength(0);
    expect(report.safe.modelStages).toHaveLength(0);
    expect(report.frames.some((frame) => frame.event === "ask")).toBe(true);
  });

  test("recompiles a persisted read-only clarification answer and completes the draft", async () => {
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "read-only-outcome-question",
        request: { message: "Research the latest OpenAI news." },
        model: {
          provider: { rounds: [] },
          readOnlyOrchestrator: { plans: [] },
          directWriter: [],
        },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
        },
      },
      {
        id: "read-only-outcome-answer",
        request: { message: "A LinkedIn post" },
        model: {
          provider: { rounds: [] },
          readOnlyOrchestrator: {
            plans: [
              {
                model: PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
                toolArgs: {
                  actions: [
                    {
                      id: "news",
                      type: "search_news",
                      query: "latest OpenAI news",
                    },
                    {
                      id: "draft",
                      type: "draft_post",
                      evidenceActionIds: ["news"],
                    },
                  ],
                },
                usage: usage(90, 18, 0.001),
              },
            ],
            toolResults: {
              search_news: [
                {
                  ok: true,
                  max_age_days: 14,
                  results: [
                    {
                      title: "OpenAI verified update",
                      url: "https://openai.com/news/update",
                      published_at: "2026-07-14",
                      summary: "OpenAI announced a verified update.",
                    },
                  ],
                },
              ],
            },
          },
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
          actionNames: ["search_news", "write_grounded_post"],
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[1]?.observed.agentProviderRounds).toBe(0);
    expect(sequence.attempts[1]?.observed.readOnlyPlannerRequests).toHaveLength(
      1,
    );
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
          actionNames: [],
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

    expect(
      report.pass,
      JSON.stringify({
        failures: report.failureCodes,
        safe: report.safe,
        actions: report.observed.actions,
        messages: report.persisted.messages,
        requests: report.observed.directWriterRequests,
      }),
    ).toBe(true);
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
      originalScenario(
        "incomplete-draft-repair",
        {
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
        },
        ["render_post", "ask_user"],
      ),
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
        actionNames: [],
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
              toolCalls: [{ name: "render_post", args: { body: SECOND_POST } }],
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
        provider: { rounds: [] },
        directWriter: [
          {
            text: SECOND_POST,
            finishReason: "stop",
            usage: usage(250, 120, 0.00025),
          },
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(260, 122, 0.00027),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST],
        actionNames: [],
        sourcePostIds: [sourcePostId],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(
      report.observed.directWriterRequests.map((request) => request.stage),
    ).toEqual(["primary", "repair"]);
  });

  test("routes exact partial text through the tool-free writer and repairs its shape", async () => {
    const exactHooks = [
      "1.",
      "Hook: Distribution is part of the product.",
      "",
      "2.",
      "Hook: Great work cannot compound while it stays invisible.",
      "",
      "3.",
      "Hook: Polish without reach is a private win.",
    ].join("\n");
    const report = await runCoworkOutcomeScenario({
      id: "direct-partial-hooks",
      request: {
        message:
          "Give me exactly 3 hooks about content distribution. Do not search.",
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: "Here are two hooks:\n1. Reach matters.\n2. Distribution wins.",
            finishReason: "stop",
            usage: usage(100, 35, 0.00008),
          },
          {
            text: exactHooks,
            finishReason: "stop",
            usage: usage(130, 60, 0.00012),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        assistantContents: [exactHooks],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(
      report.observed.directWriterRequests.map((request) => request.stage),
    ).toEqual(["primary", "repair"]);
  });

  test("routes exact multi-post work through the tool-free writer and repairs a duplicate", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "direct-multi-posts",
      request: {
        message:
          "Write exactly 2 different posts about why a personal brand is career leverage. Do not search.",
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(200, 90, 0.00018),
          },
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(210, 90, 0.00019),
          },
          {
            text: SECOND_POST,
            finishReason: "stop",
            usage: usage(230, 100, 0.00022),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST, SECOND_POST],
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(
      report.observed.directWriterRequests.map((request) => request.stage),
    ).toEqual(["primary", "primary", "repair"]);
  });

  test("the production variations action persists exactly three distinct source-tagged drafts", async () => {
    const modelSourceId = "00000000-0000-4000-8000-000000000211";
    const sourcePostId = "00000000-0000-4000-8000-000000000212";
    const report = await runCoworkOutcomeScenario({
      id: "production-source-variations",
      request: {
        message: POST_INTENTS.variations.prompt,
        modelSourceId,
      },
      seed: {
        bookmarkModelSource: {
          id: modelSourceId,
          sourcePostId,
          postText:
            "Build an owned asset before you need it. Show the work, explain why it matters, and close with a practical next step.",
          postUrl:
            "https://www.linkedin.com/feed/update/urn:li:activity:987",
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          { text: COMPLETE_POST, finishReason: "stop", usage: usage(200, 90, 0.00018) },
          { text: SECOND_POST, finishReason: "stop", usage: usage(220, 95, 0.0002) },
          { text: THIRD_POST, finishReason: "stop", usage: usage(240, 105, 0.00023) },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST, SECOND_POST, THIRD_POST],
        actionNames: [],
        sourcePostIds: [sourcePostId, sourcePostId, sourcePostId],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.persisted.artifacts).toHaveLength(3);
    expect(
      report.observed.directWriterRequests.map((request) => request.stage),
    ).toEqual(["primary", "primary", "primary"]);
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
        request: {
          message: "Explain the strongest angle without changing anything.",
        },
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
      expect(
        report.pass,
        `${scenario.id}: ${report.failureCodes.join(", ")}`,
      ).toBe(true);
    }
  });

  test("routes a typed refine through the tool-free writer and replaces the intended draft in place", async () => {
    const targetId = "00000000-0000-4000-8000-000000000501";
    const targetBody = COMPLETE_POST;
    const newHook = "Your title is rented. Your reputation is owned.";
    const modelRewrite = [
      newHook,
      "",
      "This body must be discarded by the trusted hook policy.",
      "",
      "Wrong ending.",
    ].join("\n");
    const expectedBody = [
      newHook,
      "It is career leverage you keep when your title, company, or market changes.",
      "A useful reputation compounds before you need it: people know how you think, what you can solve, and why they should trust you.",
      "Do the work in public. Teach the lesson while it is still fresh. Let proof accumulate.",
    ].join("\n\n");
    const report = await runCoworkOutcomeScenario({
      id: "direct-refine-hook",
      request: {
        message: `Refine this post: Tighten the hook.\n\nCurrent post:\n${targetBody}`,
        skipDecision: true,
        refineTargetId: targetId,
        refineInstruction: "Tighten the hook.",
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Career leverage",
          body: targetBody,
          meta: { skills: ["storytelling"] },
        },
        draft: {
          id: targetId,
          title: "Career leverage",
          body: targetBody,
          meta: { skills: ["storytelling"] },
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: modelRewrite,
            finishReason: "stop",
            usage: usage(220, 90, 0.00019),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [expectedBody],
        actionNames: [],
      },
    });

    expect(
      report.pass,
      JSON.stringify({
        failures: report.failureCodes,
        safe: report.safe,
        actions: report.observed.actions,
        messages: report.persisted.messages,
        requests: report.observed.directWriterRequests,
      }),
    ).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(report.persisted.artifacts).toEqual([
      expect.objectContaining({
        id: targetId,
        title: "Career leverage",
        body: expectedBody,
        meta: { skills: ["storytelling"] },
      }),
    ]);
    expect(report.persisted.drafts).toEqual([
      expect.objectContaining({ id: targetId, body: targetBody }),
    ]);
  });

  test.each([
    {
      label: "CTA",
      instruction: "Give it a stronger CTA.",
      targetBody: COMPLETE_POST,
      candidateBody: `${SECOND_POST}\n\nBuild proof before you need permission.`,
      expectedBody: COMPLETE_POST.replace(
        "Do the work in public. Teach the lesson while it is still fresh. Let proof accumulate.",
        "Build proof before you need permission.",
      ),
    },
    {
      label: "shorten",
      instruction: "Make it shorter.",
      targetBody: `${COMPLETE_POST}\n\n${"Useful public proof compounds over time. ".repeat(14).trim()}`,
      candidateBody: `${COMPLETE_POST}\n\n${"Useful public proof compounds. ".repeat(4).trim()}`,
      expectedBody: `${COMPLETE_POST}\n\n${"Useful public proof compounds. ".repeat(4).trim()}`,
    },
    {
      label: "general rewrite",
      instruction: "Make it more direct and more story-driven.",
      targetBody: COMPLETE_POST,
      candidateBody: SECOND_POST,
      expectedBody: SECOND_POST,
    },
  ])(
    "enforces one complete in-place $label replacement through the authenticated route",
    async ({ label, instruction, targetBody, candidateBody, expectedBody }) => {
      const suffix =
        label === "CTA" ? "511" : label === "shorten" ? "512" : "513";
      const targetId = `00000000-0000-4000-8000-000000000${suffix}`;
      const report = await runCoworkOutcomeScenario({
        id: `direct-refine-${label.replaceAll(" ", "-").toLowerCase()}`,
        request: {
          message: `Refine this post: ${instruction}\n\nCurrent post:\n${targetBody}`,
          skipDecision: true,
          refineTargetId: targetId,
          refineInstruction: instruction,
        },
        seed: {
          messageArtifact: {
            id: targetId,
            kind: "post",
            title: "Career leverage",
            body: targetBody,
            meta: { durable: true },
          },
          draft: {
            id: targetId,
            title: "Career leverage",
            body: targetBody,
            meta: { durable: true },
          },
        },
        model: {
          provider: { rounds: [] },
          directWriter: [
            {
              text: candidateBody,
              finishReason: "stop",
              usage: usage(220, 90, 0.00019),
            },
          ],
        },
        expected: {
          terminal: "done",
          artifactBodies: [expectedBody],
          actionNames: [],
        },
      });

      expect(report.pass, report.failureCodes.join(", ")).toBe(true);
      expect(report.observed.agentProviderRounds).toBe(0);
      expect(report.persisted.artifacts).toEqual([
        expect.objectContaining({
          id: targetId,
          title: "Career leverage",
          body: expectedBody,
          meta: { durable: true },
        }),
      ]);
    },
  );

  test("an unresolved typed target fails closed to the legacy route", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "unresolved-direct-refine-target",
      request: {
        message: "Refine this post: Make it more direct.",
        skipDecision: true,
        refineTargetId: "00000000-0000-4000-8000-000000000599",
        refineInstruction: "Make it more direct.",
      },
      model: {
        provider: renderProvider([SECOND_POST]),
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(220, 90, 0.00019),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [SECOND_POST],
        actionNames: ["render_post"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(2);
    expect(report.observed.directWriterRequests).toHaveLength(0);
  });

  test("a mixed-focus refine fails closed instead of silently applying only one request", async () => {
    const targetId = "00000000-0000-4000-8000-000000000598";
    const report = await runCoworkOutcomeScenario({
      id: "mixed-focus-refine-baseline",
      request: {
        message: buildHookOnlyRefineMessage(
          "Tighten the hook and strengthen the CTA.",
          COMPLETE_POST,
        ),
        skipDecision: true,
        refineTargetId: targetId,
        refineInstruction: "Tighten the hook and strengthen the CTA.",
        hookOnly: true,
        hookOnlyOriginalBody: COMPLETE_POST,
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Career leverage",
          body: COMPLETE_POST,
        },
      },
      model: {
        provider: renderProvider([SECOND_POST]),
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(220, 90, 0.00019),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [SECOND_POST],
        actionNames: ["render_post"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(2);
    expect(report.observed.directWriterRequests).toHaveLength(0);
  });

  test("cancelling a direct refine leaves the original unchanged and emits no replacement", async () => {
    const targetId = "00000000-0000-4000-8000-000000000502";
    const report = await runCoworkOutcomeScenario({
      id: "direct-refine-stop",
      request: {
        message: `Refine this post: Make it shorter.\n\nCurrent post:\n${COMPLETE_POST}`,
        skipDecision: true,
        refineTargetId: targetId,
        refineInstruction: "Make it shorter.",
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Career leverage",
          body: COMPLETE_POST,
        },
        draft: {
          id: targetId,
          title: "Career leverage",
          body: COMPLETE_POST,
        },
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
    expect(report.persisted.artifacts).toHaveLength(0);
    expect(report.persisted.drafts).toEqual([
      expect.objectContaining({ id: targetId, body: COMPLETE_POST }),
    ]);
  });

  test("the kill-switch baseline still handles a typed refine through the legacy agent", async () => {
    const targetId = "00000000-0000-4000-8000-000000000503";
    const report = await runCoworkOutcomeScenario({
      id: "legacy-refine-fallback",
      request: {
        message: `Refine this post: Make it more direct.\n\nCurrent post:\n${COMPLETE_POST}`,
        skipDecision: true,
        refineTargetId: targetId,
        refineInstruction: "Make it more direct.",
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Career leverage",
          body: COMPLETE_POST,
        },
        draft: {
          id: targetId,
          title: "Career leverage",
          body: COMPLETE_POST,
        },
      },
      model: { provider: renderProvider([SECOND_POST]) },
      expected: {
        terminal: "done",
        artifactBodies: [SECOND_POST],
        actionNames: ["render_post"],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(2);
    expect(report.observed.directWriterRequests).toHaveLength(0);
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
                {
                  id: "call_only_one",
                  name: "render_post",
                  args: { body: COMPLETE_POST },
                },
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
                {
                  id: "call_duplicate_a",
                  name: "render_post",
                  args: duplicateArgs,
                },
                {
                  id: "call_duplicate_b",
                  name: "render_post",
                  args: duplicateArgs,
                },
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
        request: {
          message: "Write a post about my career, but ask which angle first.",
        },
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
        sequence.attempts.map(({ safe, failureCodes }) => ({
          safe,
          failureCodes,
        })),
      ),
    ).toBe(true);
    expect(sequence.attempts.at(-1)?.safe.artifactCount).toBe(1);
  });

  test("resumes a pending clarification directly without repeating the question or running research", async () => {
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "direct-clarification-question",
        request: {
          message:
            "Help me write a LinkedIn post, but ask for the angle first.",
        },
        model: {
          provider: {
            rounds: [
              {
                kind: "response",
                toolCalls: [
                  {
                    id: "call_direct_clarify",
                    name: "ask_user",
                    args: {
                      question: "Which angle should the post focus on?",
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
        id: "direct-clarification-completion",
        request: { message: "Career leverage." },
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

    expect(sequence.pass).toBe(true);
    const resumed = sequence.attempts.at(-1)!;
    expect(resumed.observed.agentProviderRounds).toBe(0);
    expect(resumed.observed.directWriterRequests).toHaveLength(1);
    expect(resumed.persisted.actions).toHaveLength(0);
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
      report.persisted.messages.find((message) => message.role === "tool")
        ?.content,
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
    expect(
      report.persisted.drafts.find((draft) => draft.id === draftId)?.status,
    ).toBe("ready");
  });

  test("an enabled action workspace cannot fall through to an unfenced legacy mutation", async () => {
    const draftId = "00000000-0000-4000-8000-000000000721";
    const report = await runCoworkOutcomeScenario({
      id: "legacy-action-bypass-blocked",
      request: { message: "Reorganize the career leverage draft." },
      seed: {
        draft: {
          id: draftId,
          title: "Career leverage",
          body: COMPLETE_POST,
          status: "drafting",
        },
      },
      model: {
        actionOrchestrator: { plans: [] },
        provider: {
          rounds: [
            {
              kind: "response",
              toolCalls: [
                {
                  id: "call_unfenced_move",
                  name: "move_on_board",
                  args: { id: draftId, status: "ready" },
                },
              ],
              usage: usage(200, 40, 0.0012),
            },
            {
              kind: "response",
              text: "I couldn't safely infer that board action. Please say which stage you want.",
              finishReason: "stop",
              usage: usage(150, 25, 0.0007),
            },
          ],
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["move_on_board"],
        assistantContents: [
          "I couldn't safely infer that board action. Please say which stage you want.",
        ],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.drafts[0]).toMatchObject({
      id: draftId,
      status: "drafting",
      lifecycle_version: 0,
    });
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
          actionNames: [],
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

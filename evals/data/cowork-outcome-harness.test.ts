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
import {
  buildHookOnlyRefineMessage,
  splicePreservedBody,
} from "@/lib/hook-splice";
import { POST_INTENTS } from "@/lib/post-intents";
import { CHAT_MODEL } from "@/lib/openrouter";
import { PRIMARY_DRAFT_WRITER_MODEL } from "@/lib/agent/draft-writer";
import {
  FALLBACK_ACTION_ORCHESTRATOR_MODEL,
  PRIMARY_ACTION_ORCHESTRATOR_MODEL,
  PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
} from "@/lib/agent/execute/agent";

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
const FOURTH_POST = [
  "Consistency becomes useful when every post carries one clear decision.",
  "Readers do not need another broad lesson. They need a concrete tension, the choice it creates, and evidence that the choice matters.",
  "Build each post around that sequence and your ideas become easier to remember and apply.",
].join("\n\n");
const FIFTH_POST = [
  "A durable writing system should reduce decisions, not create more of them.",
  "Choose the audience, the problem, and the proof before drafting. Then let the structure carry the idea from hook to practical conclusion.",
  "The result is not formulaic writing. It is more attention available for the part only you can contribute.",
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

const MODELED_SOURCE_ROWS = [
  {
    id: "source-one",
    text: [
      "Useful work becomes visible when the opening makes one direct promise.",
      "The explanation builds trust by showing how the principle works in practice for the reader.",
      "A concrete middle connects the idea to a decision the audience already faces.",
      "Finish with a decision they can make today.",
    ].join("\n\n"),
    post_url: "https://linkedin.com/posts/source-one",
  },
  {
    id: "source-two",
    text: [
      "A portable reputation begins with evidence people can understand.",
      "The center of the story connects that evidence to a problem the audience already recognizes.",
      "End by naming the habit that keeps the asset growing.",
    ].join("\n\n"),
    post_url: "https://linkedin.com/posts/source-two",
  },
  {
    id: "source-three",
    text: [
      "Strong communication starts by narrowing the idea to one useful claim.",
      "Each following paragraph should move the reasoning forward without adding a second competing lesson.",
      "A final explanation shows why the idea matters in the reader's own work.",
      "Close by turning the claim into a practical next step.",
    ].join("\n\n"),
    post_url: "https://linkedin.com/posts/source-three",
  },
] as const;

const MODELED_FOUR_SOURCE_ROWS = [
  ...MODELED_SOURCE_ROWS,
  {
    id: "source-four",
    text: [
      "A credible point of view starts with a constraint the reader recognizes.",
      "The argument earns attention by connecting that constraint to a specific choice.",
      "Evidence in the middle keeps the lesson grounded instead of turning it into a slogan.",
      "Close with the smallest useful action the reader can take next.",
    ].join("\n\n"),
    post_url: "https://linkedin.com/posts/source-four",
  },
] as const;

const MODELED_FIVE_SOURCE_ROWS = [
  ...MODELED_FOUR_SOURCE_ROWS,
  {
    id: "source-five",
    text: [
      "A useful writing system protects the core claim from competing ideas.",
      "The middle earns trust by connecting the claim to an observable problem.",
      "A practical close turns the argument into a decision the reader can make.",
    ].join("\n\n"),
    post_url: "https://linkedin.com/posts/source-five",
  },
] as const;

const CREATOR_STYLE = {
  id: "00000000-0000-4000-8000-000000000402",
  name: "Evidence-led cadence",
  creatorName: "Fixture Creator",
  promptBlock:
    "CREATOR_STYLE_RETRY_SENTINEL: open with a concrete observation, then use short evidence-led paragraphs.",
} as const;

const CUSTOM_SKILL = {
  id: "00000000-0000-4000-8000-000000000403",
  name: "durable-cta",
  body: "CUSTOM_SKILL_RETRY_SENTINEL: end with one practical next step.",
} as const;

function modeledThreeScenario(id: string): CoworkOutcomeScenario {
  return {
    id,
    request: {
      message:
        "Find 3 top-performing regular posts in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original",
    },
    model: {
      provider: { rounds: [] },
      sourceFidelity: [
        { outcome: "verified" },
        { outcome: "verified" },
        { outcome: "verified" },
      ],
      readOnlyOrchestrator: {
        plans: [
          {
            model: PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
            toolArgs: null,
            usage: usage(90, 18, 0.001),
          },
        ],
        toolResults: {
          search_viral_posts: [
            {
              ok: true,
              count: MODELED_SOURCE_ROWS.length,
              posts: [...MODELED_SOURCE_ROWS],
            },
          ],
        },
      },
      directWriter: [
        { text: COMPLETE_POST, finishReason: "stop", usage: usage(210, 95, 0.00019) },
        { text: SECOND_POST, finishReason: "stop", usage: usage(220, 100, 0.0002) },
        { text: THIRD_POST, finishReason: "stop", usage: usage(240, 105, 0.00023) },
      ],
    },
    expected: {
      terminal: "done",
      artifactBodies: [COMPLETE_POST, SECOND_POST, THIRD_POST],
      actionNames: ["search_viral_posts", "write_grounded_post"],
      sourcePostIds: MODELED_SOURCE_ROWS.map((source) => source.id),
      sourceReferences: MODELED_SOURCE_ROWS.map((source) => ({
        id: source.id,
        url: source.post_url,
      })),
    },
  };
}

function modeledStructuredCountScenario(
  id: string,
  draftCount: 2 | 3 | 4 | 5,
): CoworkOutcomeScenario {
  const scenario = modeledThreeScenario(id);
  const sources = MODELED_FIVE_SOURCE_ROWS.slice(0, draftCount);
  const bodies = [
    COMPLETE_POST,
    SECOND_POST,
    THIRD_POST,
    FOURTH_POST,
    FIFTH_POST,
  ].slice(0, draftCount);
  scenario.request = {
    message:
      "Find top-performing regular posts in my swipe file and rewrite them in my voice on topics that fit me. Keep their structure and hook style, but make the content original.",
    generationConfig: { version: 1, draftCount },
  };
  scenario.model.sourceFidelity = sources.map(() => ({
    outcome: "verified" as const,
  }));
  scenario.model.readOnlyOrchestrator!.toolResults = {
    search_viral_posts: [
      { ok: true, count: sources.length, posts: sources },
    ],
  };
  scenario.model.directWriter = bodies.map((text, index) => ({
    text,
    finishReason: "stop" as const,
    usage: usage(
      210 + index * 10,
      95 + index * 5,
      0.00019 + index * 0.00001,
    ),
  }));
  scenario.expected = {
    terminal: "done",
    artifactBodies: bodies,
    actionNames: ["search_viral_posts", "write_grounded_post"],
    sourcePostIds: sources.map((source) => source.id),
    sourceReferences: sources.map((source) => ({
      id: source.id,
      url: source.post_url,
    })),
  };
  return scenario;
}

describe("production-shaped Cowork outcome harness", () => {
  test("runs the real agent through the authenticated answer lane and canonical persistence", async () => {
    const answer = "Finished the requested deliverable.";
    const report = await runCoworkOutcomeScenario({
      id: "original-post",
      request: {
        message:
          "Write an original post in my voice about why a personal brand is career leverage.",
      },
      model: { provider: textProvider(answer) },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        assistantContents: [answer],
        route: "answer",
      },
    });

    expect(
      report.pass,
      JSON.stringify({ safe: report.safe, actions: report.observed.actions }),
    ).toBe(true);
    expect(report.safe).toMatchObject({
      id: "original-post",
      status: 200,
      terminal: "done",
      messageCount: 2,
      artifactCount: 0,
      actionCount: 0,
      inputTokens: 180,
      outputTokens: 60,
      // Provider-reported usage cost is authoritative when present; the
      // pricing table is only the fallback for responses that omit it.
      costUsd: 0.0018,
      route: "answer",
      modelStages: [{ kind: "cowork_answer", model: CHAT_MODEL }],
    });
    expect(report.safe.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.persisted.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(report.persisted.artifacts).toHaveLength(0);
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
        { kind: "cowork_direct_writer", model: PRIMARY_DRAFT_WRITER_MODEL },
      ],
    });
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.readOnlyPlannerRequests).toHaveLength(0);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(report.observed.directWriterRequests[0]).toMatchObject({
      stage: "primary",
      model: PRIMARY_DRAFT_WRITER_MODEL,
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
      { kind: "cowork_direct_writer", model: PRIMARY_DRAFT_WRITER_MODEL },
    ]);
  });

  test("a follow-up direct-writer turn sees the prior conversation", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "direct-writer-follow-up-history",
      request: {
        message: "Write an original post in my voice about pricing instead.",
      },
      seed: {
        priorTurn: {
          user: "Write an original post in my voice about why personal branding compounds.",
          assistant: "Your draft about personal branding compounding is ready.",
        },
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
    const writerPrompt = JSON.stringify(
      report.observed.directWriterRequests[0].messages,
    );
    expect(writerPrompt).toContain("CONVERSATION HISTORY DATA");
    expect(writerPrompt).toContain("personal branding compounds");
    expect(writerPrompt).toContain(
      "Your draft about personal branding compounding is ready.",
    );
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
          disabled: true,
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
            disabled: true,
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
            disabled: true,
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

  test("routes an explicitly requested but unresolved model source to the answer lane", async () => {
    const answer =
      "I couldn't find the selected source in your workspace, so I can't model a post after it.";
    const report = await runCoworkOutcomeScenario({
      id: "unresolved-model-source",
      request: {
        message:
          "Write an original post in my voice about why a personal brand is career leverage.",
        modelSourceId: "00000000-0000-4000-8000-000000000401",
      },
      model: { provider: textProvider(answer) },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        assistantContents: [answer],
        route: "answer",
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
    expect(report.safe.route).toBe("answer");
  });

  test.each(["missing", "not ready"] as const)(
    "fails an explicitly selected creator style closed when it is %s",
    async (state) => {
      const report = await runCoworkOutcomeScenario({
        id: `creator-style-${state.replace(" ", "-")}`,
        request: {
          message:
            "Write an original post in my voice about why a personal brand is career leverage.",
          creatorStyleId: CREATOR_STYLE.id,
        },
        ...(state === "not ready"
          ? {
              seed: {
                creatorStyle: { ...CREATOR_STYLE, status: "pending" as const },
              },
            }
          : {}),
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
          terminal: "failure",
          httpStatus: 409,
          artifactBodies: [],
          actionNames: [],
          assistantContents: [
            "The selected creator style is unavailable or not ready. Choose another style and try again.",
          ],
        },
      });

      expect(report.pass, report.failureCodes.join(", ")).toBe(true);
      expect(report.observed.agentProviderRounds).toBe(0);
      expect(report.observed.directWriterRequests).toHaveLength(0);
    },
  );

  test.each(["write error", "missing claimed row"] as const)(
    "fails closed before generation when frozen creator-style persistence has a %s",
    async (failureMode) => {
      const scenario = modeledThreeScenario(
        `creator-style-marker-${failureMode.replaceAll(" ", "-")}`,
      );
      scenario.request.creatorStyleId = CREATOR_STYLE.id;
      scenario.seed = { creatorStyle: CREATOR_STYLE };
      if (failureMode === "write error") {
        scenario.model.creatorStyleMarkerPersistenceFails = true;
      } else {
        scenario.model.creatorStyleMarkerTargetMissing = true;
      }
      scenario.expected = {
        terminal: "failure",
        httpStatus: 503,
        artifactBodies: [],
        actionNames: [],
        assistantContents: [
          "I couldn’t save the selected creator style safely, so no draft was created. Send the request again to retry.",
        ],
      };

      const report = await runCoworkOutcomeScenario(scenario);

      expect(report.pass, report.failureCodes.join(", ")).toBe(true);
      expect(report.observed.readOnlyTools).toEqual([]);
      expect(report.observed.directWriterRequests).toEqual([]);
      expect(
        report.persisted.messages
          .find((message) => message.role === "user")
          ?.tool_calls?.some(
            (call) => call.function.name === "_creator_style_selected",
          ) ?? false,
      ).toBe(false);
    },
  );

  test.each([
    "Write a post based on our conversation about pricing. Do not search.",
    "Write a post about the topic we covered yesterday. Do not search.",
    "Write a post from our call about founder-led sales. Do not search.",
  ])(
    "routes conversation-dependent request through the answer lane: %s",
    async (message) => {
      const answer =
        "I need the topic or key points from our conversation to write this post.";
      const report = await runCoworkOutcomeScenario({
        id: `conversation-dependent-${message.length}`,
        request: { message },
        model: { provider: textProvider(answer) },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: [],
          assistantContents: [answer],
          route: "answer",
        },
      });

      expect(report.pass, report.failureCodes.join(", ")).toBe(true);
      expect(report.observed.directWriterRequests).toHaveLength(0);
      expect(report.safe.route).toBe("answer");
    },
  );

  test.each([
    "Write a post about pricing and plan it for Friday.",
    "Write a post about pricing and queue it for Friday.",
    "Write a post about pricing and queue it.",
    "Write a post about pricing and put it on the calendar.",
    "Write a post about pricing and set it to ready.",
  ])(
    "routes combined writing and action request through the answer lane: %s",
    async (message) => {
      const answer =
        "I can help with the writing or the board action, but not both in one turn. Which would you like to do first?";
      const report = await runCoworkOutcomeScenario({
        id: `writing-action-${message.length}`,
        request: { message },
        model: { provider: textProvider(answer) },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: [],
          assistantContents: [answer],
          route: "answer",
        },
      });

      expect(report.pass, report.failureCodes.join(", ")).toBe(true);
      expect(report.observed.directWriterRequests).toHaveLength(0);
      expect(report.observed.actions).toHaveLength(0);
      expect(report.safe.route).toBe("answer");
    },
  );

  test.each([
    "Write a post explaining it. Do not search.",
    "Write a post about the idea. Do not search.",
    "Write a post about my idea. Do not search.",
    "Write a post about the point above. Do not search.",
  ])(
    "routes partial or topic-less request through the answer lane: %s",
    async (message) => {
      const answer =
        "I need a clear topic to write a full post. What idea or angle should I focus on?";
      const report = await runCoworkOutcomeScenario({
        id: `non-full-post-${message.length}`,
        request: { message },
        model: { provider: textProvider(answer) },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: [],
          assistantContents: [answer],
          route: "answer",
        },
      });

      expect(report.pass, report.failureCodes.join(", ")).toBe(true);
      expect(report.observed.directWriterRequests).toHaveLength(0);
      expect(report.safe.route).toBe("answer");
    },
  );

  test.each([
    "Research the latest LinkedIn trends and write a post about founder-led sales.",
    "Research B2B pricing strategies and write a post about pricing discipline.",
    "Research personal branding, then write a post about why it matters.",
    "Investigate how founder-led sales teams price services, then write a post about pricing discipline.",
  ])(
    "routes explicit research-and-write request through the answer lane: %s",
    async (message) => {
      const answer =
        "I can answer questions about this topic, but I don't browse live sources.";
      const report = await runCoworkOutcomeScenario({
        id: `explicit-research-and-write-${message.length}`,
        request: { message },
        model: { provider: textProvider(answer) },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: [],
          assistantContents: [answer],
          route: "answer",
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
      expect(report.observed.directWriterRequests).toHaveLength(0);
      expect(report.safe.route).toBe("answer");
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
    expect(report.observed.readOnlyPlannerRequests).toHaveLength(0);
    expect(report.observed.readOnlyTools.map((tool) => tool.name)).toEqual([
      "search_news",
    ]);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(Object.keys(report.observed.directWriterRequests[0])).not.toContain(
      "tools",
    );
    expect(report.safe.modelStages).toEqual([
      { kind: "cowork_direct_writer", model: PRIMARY_DRAFT_WRITER_MODEL },
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

  test("keeps an ambiguous modeled mapping on the authenticated safe lane when rollout is disabled", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "modeled-ambiguous-rollout-off",
      request: {
        message:
          "Find 4 or 5 top-performing regular posts in my swipe file and rewrite them.",
      },
      model: {
        provider: renderProvider([COMPLETE_POST]),
        directWriter: [],
        readOnlyOrchestrator: {
          plans: [],
          disabled: true,
          allowNoModel: true,
        },
      },
      expected: {
        terminal: "ask",
        artifactBodies: [],
        actionNames: ["ask_user"],
        assistantContents: ["How many source posts should I use?"],
      },
    });

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.readOnlyPlannerRequests).toEqual([]);
    expect(report.observed.readOnlyTools).toEqual([]);
    expect(report.observed.directWriterRequests).toEqual([]);
  });

  test("keeps a shared-pool modeled request out of legacy when rollout is disabled", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "modeled-shared-pool-rollout-off",
      request: {
        message:
          "Find 4 top posts in my swipe file and rewrite them into 2 original posts.",
      },
      model: {
        provider: renderProvider([THIRD_POST]),
        sourceFidelity: [{ outcome: "verified" }, { outcome: "verified" }],
        readOnlyOrchestrator: {
          plans: [],
          disabled: true,
          toolResults: {
            search_viral_posts: [
              {
                ok: true,
                count: MODELED_FOUR_SOURCE_ROWS.length,
                posts: [...MODELED_FOUR_SOURCE_ROWS],
              },
            ],
          },
        },
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(210, 95, 0.00019),
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
        actionNames: ["search_viral_posts", "write_grounded_post"],
      },
    });

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.readOnlyPlannerRequests).toEqual([]);
    expect(report.observed.readOnlyTools).toEqual([
      expect.objectContaining({
        name: "search_viral_posts",
        args: expect.objectContaining({ limit: 4 }),
      }),
    ]);
    expect(report.observed.directWriterRequests).toHaveLength(2);
    expect(report.observed.modeledBatchOperationKeys).toEqual([]);
  });

  test("selects one source from a four-source modeled pool without entering legacy when rollout is disabled", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "modeled-four-to-one-rollout-off",
      request: {
        message:
          "Find 4 top-performing regular posts in my swipe file, choose the best, and rewrite it in my voice.",
      },
      model: {
        provider: renderProvider([SECOND_POST]),
        sourceFidelity: [{ outcome: "verified" }],
        readOnlyOrchestrator: {
          plans: [],
          disabled: true,
          toolResults: {
            search_viral_posts: [
              {
                ok: true,
                count: MODELED_FOUR_SOURCE_ROWS.length,
                posts: [...MODELED_FOUR_SOURCE_ROWS],
              },
            ],
          },
        },
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(210, 95, 0.00019),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST],
        actionNames: ["search_viral_posts", "write_grounded_post"],
        sourcePostIds: [MODELED_FOUR_SOURCE_ROWS[0].id],
      },
    });

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.readOnlyPlannerRequests).toEqual([]);
    expect(report.observed.readOnlyTools).toEqual([
      expect.objectContaining({
        name: "search_viral_posts",
        args: expect.objectContaining({ limit: 4 }),
      }),
    ]);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(report.observed.modeledBatchOperationKeys).toEqual([]);
  });

  test("fails a non-batch shared-pool modeled request before legacy when voice is unavailable", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "modeled-shared-pool-no-voice-rollout-off",
      request: {
        message:
          "Find 4 top posts in my swipe file and rewrite them into 2 original posts.",
      },
      model: {
        provider: renderProvider([THIRD_POST]),
        readOnlyOrchestrator: {
          plans: [],
          disabled: true,
          voiceUnavailable: true,
        },
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(210, 95, 0.00019),
          },
          {
            text: SECOND_POST,
            finishReason: "stop",
            usage: usage(220, 100, 0.0002),
          },
        ],
      },
      expected: {
        terminal: "failure",
        httpStatus: 422,
        artifactBodies: [],
        actionNames: [],
        assistantContents: [
          "⚠️ This needs a voice profile to write in your voice, and your workspace doesn't have one yet. Head to the Voice tab to generate one, then send this again.",
        ],
      },
    });

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.readOnlyPlannerRequests).toEqual([]);
    expect(report.observed.readOnlyTools).toEqual([]);
    expect(report.observed.directWriterRequests).toEqual([]);
    expect(report.observed.modeledBatchOperationKeys).toEqual([]);
  });

  test("returns the exact three-post modeled contract through the authenticated route", async () => {
    const report = await runCoworkOutcomeScenario(
      modeledThreeScenario("modeled-three"),
    );

    expect(
      report.pass,
      JSON.stringify({
        failures: report.failureCodes,
        safe: report.safe,
      }),
    ).toBe(true);
    expect(report.persisted.artifacts).toHaveLength(3);
    expect(
      report.persisted.artifacts.map(
        (artifact) => artifact.meta?.source_post_id,
      ),
    ).toEqual(MODELED_SOURCE_ROWS.map((source) => source.id));
    expect(
      report.observed.directWriterRequests.map((request) => request.stage),
    ).toEqual(["primary", "primary", "primary"]);
  });

  test.each([2, 3, 4, 5] as const)(
    "uses the structured draft control as the authenticated modeled-batch count: %i",
    async (draftCount) => {
      const scenario = modeledStructuredCountScenario(
        `modeled-${draftCount}-structured-count`,
        draftCount,
      );
      const report = await runCoworkOutcomeScenario(scenario);

      expect(report.pass, report.failureCodes.join(", ")).toBe(true);
      expect(report.persisted.artifacts).toHaveLength(draftCount);
      expect(
        report.persisted.artifacts.map(
          (artifact) => artifact.meta?.source_post_id,
        ),
      ).toEqual(
        MODELED_FIVE_SOURCE_ROWS.slice(0, draftCount).map(
          (source) => source.id,
        ),
      );
      const userRow = report.persisted.messages.find(
        (message) => message.role === "user",
      );
      expect(userRow?.generation_config).toEqual({
        version: 1,
        draftCount,
        draftCountSource: "ui",
        postTypeSource: "default",
      });
    },
  );

  test("the selected modeled-batch count supersedes a singular output in the message", async () => {
    const scenario = modeledStructuredCountScenario(
      "modeled-five-selected-over-singular-message",
      5,
    );
    scenario.request.message =
      "Find 5 top-performing regular posts in my swipe file and rewrite them in my voice into 1 original post.";

    const report = await runCoworkOutcomeScenario(scenario);

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.artifacts).toHaveLength(5);
    expect(report.observed.directWriterRequests).toHaveLength(5);
    expect(
      report.persisted.artifacts.map(
        (artifact) => artifact.meta?.source_post_id,
      ),
    ).toEqual(MODELED_FIVE_SOURCE_ROWS.map((source) => source.id));
  });

  test("a fresh server-selected modeled batch cannot activate a historical attached source", async () => {
    const scenario = modeledThreeScenario(
      "modeled-three-does-not-inherit-historical-source",
    );
    scenario.seed = {
      historicalBookmarkModelSource: {
        id: "00000000-0000-4000-8000-000000000404",
        sourcePostId: "historical-source-post",
        postText:
          "HISTORICAL_SOURCE_SENTINEL. This source belongs only to an earlier turn.",
        postUrl: "https://linkedin.com/posts/historical-source-post",
      },
    };

    const report = await runCoworkOutcomeScenario(scenario);

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    expect(
      report.persisted.artifacts.map(
        (artifact) => artifact.meta?.source_post_id,
      ),
    ).toEqual(MODELED_SOURCE_ROWS.map((source) => source.id));
    expect(
      report.persisted.artifacts.some(
        (artifact) =>
          artifact.meta?.source_post_id === "historical-source-post",
      ),
    ).toBe(false);
    expect(report.observed.savedPostReads).toBe(0);
  });

  test("honors the requested draft count via the shared-pool path when fewer distinct sources than requested exist", async () => {
    // The reported bug. A request for 3 drafts must produce 3 drafts even when
    // the workspace can only supply 2 distinct canonical sources. Rather than
    // the old fail-closed dead-end ("I couldn't complete the verified modeled
    // set safely"), the turn now falls through to the shared-pool multi path —
    // which reuses the available sources to write the number of drafts the
    // chip asked for. The durable one-source-per-draft batch is skipped (it
    // needs N distinct canonical sources), so no batch operation key is
    // recorded. (A url-less source no longer causes this shortfall on its
    // own — see the sibling test below — so this fixture returns fewer
    // sources than requested outright to keep exercising the fallback path.)
    const scenario = modeledThreeScenario("modeled-three-fewer-sources-than-requested");
    scenario.model.readOnlyOrchestrator!.allowNoModel = true;
    scenario.model.readOnlyOrchestrator!.toolResults = {
      search_viral_posts: [
        {
          ok: true,
          count: 2,
          posts: [MODELED_SOURCE_ROWS[0], MODELED_SOURCE_ROWS[1]],
        },
      ],
    };
    scenario.expected = {
      terminal: "done",
      artifactBodies: [COMPLETE_POST, SECOND_POST, THIRD_POST],
      actionNames: ["search_viral_posts", "write_grounded_post"],
    };

    const report = await runCoworkOutcomeScenario(scenario);

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    // The requested 3 drafts were delivered — not a dead-end.
    expect(report.persisted.artifacts).toHaveLength(3);
    // The strict durable batch did NOT run (fewer distinct canonical sources
    // than requested drafts); the shared-pool path handled it instead.
    expect(report.observed.modeledBatchOperationKeys).toEqual([]);
    // The shared-pool fallback succeeds silently; no recoverable error is
    // emitted because enough verified sources exist to fulfill the request.
    expect(
      report.frames.some(
        (frame) =>
          frame.event === "error" &&
          (frame.data as { code?: string })?.code ===
            "orchestrator_evidence_insufficient",
      ),
    ).toBe(false);
  });

  test("routes an output-count-only modeled request through the same exact batch", async () => {
    const scenario = modeledThreeScenario("modeled-three-output-count-only");
    scenario.request.message =
      "Find top-performing regular posts in my swipe file and write 3 original posts modeled after them.";

    const report = await runCoworkOutcomeScenario(scenario);

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    expect(report.persisted.artifacts).toHaveLength(3);
    expect(
      report.persisted.artifacts.map(
        (artifact) => artifact.meta?.source_post_id,
      ),
    ).toEqual(MODELED_SOURCE_ROWS.map((source) => source.id));
  });

  test("pins a modeled Retry to its durable lane when rollout is later disabled", async () => {
    const scenario = modeledThreeScenario("modeled-three-retry-rollout-off");
    Object.assign(scenario.model.readOnlyOrchestrator!, {
      retryModeledBatch: true,
      disabled: true,
      frozenModeledSources: MODELED_SOURCE_ROWS.map((source) => ({
        id: source.id,
        text: source.text,
        url: source.post_url,
      })),
    });

    const report = await runCoworkOutcomeScenario(scenario);

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    expect(report.observed.readOnlyTools).toEqual([]);
    expect(report.persisted.artifacts).toHaveLength(3);
    expect(
      report.persisted.artifacts.map(
        (artifact) => artifact.meta?.source_post_id,
      ),
    ).toEqual(MODELED_SOURCE_ROWS.map((source) => source.id));
  });

  test("terminates a modeled Retry with a non-recoverable message when there is no voice profile", async () => {
    // A missing voice profile is never transient — retrying re-runs the exact
    // same lookup and fails the exact same way every time. Offering "Retry"
    // here is a loop with no exit, so this must NOT carry a recoverable
    // marker (no Retry button) and must instead point at the fix: the Voice
    // tab. See lib/agent/chat-turn.ts's noReadyVoiceProfile branch.
    const scenario = modeledThreeScenario("modeled-three-retry-no-voice");
    Object.assign(scenario.model.readOnlyOrchestrator!, {
      retryModeledBatch: true,
      disabled: true,
      voiceUnavailable: true,
      frozenModeledSources: MODELED_SOURCE_ROWS.map((source) => ({
        id: source.id,
        text: source.text,
        url: source.post_url,
      })),
    });
    scenario.expected = {
      terminal: "failure",
      httpStatus: 422,
      artifactBodies: [],
      actionNames: [],
      assistantContents: [
        "⚠️ This needs a voice profile to write in your voice, and your workspace doesn't have one yet. Head to the Voice tab to generate one, then send this again.",
      ],
    };

    const report = await runCoworkOutcomeScenario(scenario);

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    expect(report.observed.directWriterRequests).toEqual([]);
    expect(report.observed.readOnlyTools).toEqual([]);
    const failureRow = report.persisted.messages.findLast(
      (m) => m.role === "assistant",
    );
    expect(
      failureRow?.tool_calls?.some((call) => call.id === "_recoverable") ??
        false,
    ).toBe(false);
  });

  test("a pre-batch evidence failure retries discovery instead of claiming a nonexistent frozen pool", async () => {
    const failed = modeledThreeScenario("modeled-three-evidence-failed");
    failed.model.readOnlyOrchestrator!.allowNoModel = true;
    failed.model.readOnlyOrchestrator!.toolResults = {
      search_viral_posts: [{ ok: true, count: 0, posts: [] }],
    };
    failed.expected = {
      terminal: "done",
      artifactBodies: [],
      actionNames: ["search_viral_posts"],
    };
    const recovered = modeledThreeScenario("modeled-three-evidence-retry");
    recovered.retryLatestUser = true;

    const sequence = await runCoworkOutcomeSequence([failed, recovered]);

    expect(
      sequence.pass,
      JSON.stringify(
        sequence.attempts.map((attempt) => ({
          failures: attempt.failureCodes,
          safe: attempt.safe,
        })),
      ),
    ).toBe(true);
    const firstRecoverableRow = sequence.attempts[0]?.persisted.messages.find(
      (message) => message.role === "assistant",
    );
    expect(firstRecoverableRow?.recoverable_error).toBeDefined();
    expect(firstRecoverableRow?.recoverable_error).toMatchObject({
      code: "orchestrator_evidence_unavailable",
      retryRootUserMessageId: "00000000-0000-4000-8000-000000000002",
    });
    expect(firstRecoverableRow?.recoverable_error).not.toHaveProperty(
      "continuation",
    );
    expect(sequence.attempts[1]?.observed.readOnlyTools).toHaveLength(1);
    expect(sequence.attempts[1]?.persisted.artifacts).toHaveLength(3);
  });

  test("Retry restores the frozen structured draft count after the UI returns to Auto", async () => {
    const failed = modeledStructuredCountScenario(
      "modeled-four-structured-evidence-failed",
      4,
    );
    failed.model.readOnlyOrchestrator!.allowNoModel = true;
    failed.model.readOnlyOrchestrator!.toolResults = {
      search_viral_posts: [{ ok: true, count: 0, posts: [] }],
    };
    failed.expected = {
      terminal: "done",
      artifactBodies: [],
      actionNames: ["search_viral_posts"],
    };

    const recovered = modeledStructuredCountScenario(
      "modeled-four-structured-evidence-retry",
      4,
    );
    recovered.retryLatestUser = true;
    delete recovered.request.generationConfig;

    const sequence = await runCoworkOutcomeSequence([failed, recovered]);

    expect(sequence.pass).toBe(true);
    expect(sequence.attempts[1]?.persisted.artifacts).toHaveLength(4);
    const retryUser = sequence.attempts[1]?.persisted.messages
      .filter((message) => message.role === "user")
      .at(-1);
    expect(retryUser?.generation_config).toEqual({
      version: 1,
      draftCount: 4,
      draftCountSource: "ui",
      postTypeSource: "default",
    });
  });

  test("a pre-batch Retry restores the server-validated creator style after the UI clears it", async () => {
    const failed = modeledThreeScenario("modeled-three-style-evidence-failed");
    failed.request.creatorStyleId = CREATOR_STYLE.id;
    failed.seed = { creatorStyle: CREATOR_STYLE };
    failed.model.readOnlyOrchestrator!.allowNoModel = true;
    failed.model.readOnlyOrchestrator!.toolResults = {
      search_viral_posts: [{ ok: true, count: 0, posts: [] }],
    };
    failed.expected = {
      terminal: "done",
      artifactBodies: [],
      actionNames: ["search_viral_posts"],
    };

    const recovered = modeledThreeScenario("modeled-three-style-evidence-retry");
    recovered.retryLatestUser = true;

    const sequence = await runCoworkOutcomeSequence([failed, recovered]);

    expect(
      sequence.pass,
      JSON.stringify(
        sequence.attempts.map((attempt) => ({
          failures: attempt.failureCodes,
          safe: attempt.safe,
        })),
      ),
    ).toBe(true);
    expect(recovered.request.creatorStyleId).toBeUndefined();
    const firstStyleRow = sequence.attempts[0]?.persisted.messages.find(
      (message) => message.role === "user",
    );
    expect(firstStyleRow?.creator_style_context).toMatchObject({
      id: CREATOR_STYLE.id,
    });
    const retriedStyleRow = sequence.attempts[1]?.persisted.messages.find(
      (message) => message.role === "user",
    );
    expect(retriedStyleRow?.creator_style_context).toMatchObject({
      id: CREATOR_STYLE.id,
    });
    expect(sequence.attempts[1]?.observed.directWriterRequests).toHaveLength(3);
    for (const request of
      sequence.attempts[1]?.observed.directWriterRequests ?? []) {
      expect(JSON.stringify(request.messages)).toContain(
        "CREATOR_STYLE_RETRY_SENTINEL",
      );
    }
  });

  test("repeated busy retries keep one batch identity and eventually resume its frozen sources", async () => {
    const first = modeledThreeScenario("modeled-three-busy-first");
    first.model.readOnlyOrchestrator!.modeledBatchOutcome = "busy";
    first.expected = {
      terminal: "failure",
      artifactBodies: [],
      actionNames: ["search_viral_posts", "write_grounded_post"],
    };

    const second = modeledThreeScenario("modeled-three-busy-second");
    Object.assign(second.model.readOnlyOrchestrator!, {
      modeledBatchOutcome: "busy",
      disabled: true,
    });
    second.retryLatestUser = true;
    second.expected = {
      terminal: "failure",
      artifactBodies: [],
      actionNames: ["search_viral_posts", "write_grounded_post"],
    };

    const completed = modeledThreeScenario("modeled-three-busy-completed");
    Object.assign(completed.model.readOnlyOrchestrator!, {
      disabled: true,
      frozenModeledSources: MODELED_SOURCE_ROWS.map((source) => ({
        id: source.id,
        text: source.text,
        url: source.post_url,
      })),
    });
    completed.retryLatestUser = true;

    const sequence = await runCoworkOutcomeSequence([
      first,
      second,
      completed,
    ]);

    expect(
      sequence.pass,
      JSON.stringify(
        sequence.attempts.map((attempt) => ({
          failures: attempt.failureCodes,
          safe: attempt.safe,
        })),
      ),
    ).toBe(true);
    const operationKeys = sequence.attempts.flatMap(
      (attempt) => attempt.observed.modeledBatchOperationKeys,
    );
    expect(operationKeys).toHaveLength(3);
    expect(new Set(operationKeys).size).toBe(1);
    expect(sequence.attempts[1]?.observed.readOnlyTools).toEqual([]);
    expect(sequence.attempts[2]?.observed.readOnlyTools).toEqual([]);
    expect(sequence.attempts[2]?.persisted.artifacts).toHaveLength(3);
  });

  test("suppresses the credit-usage marker on a recoverable, zero-artifact failed turn", async () => {
    // A failed turn that delivered nothing shouldn't show a credit line at
    // all — "~1 credit" next to a dead-end error reads as "you were charged
    // for nothing." A busy durable-batch coordinator is a genuine,
    // still-recoverable (Retry offered) failure that delivers zero
    // artifacts — exactly the case _turn_usage must be withheld on.
    const scenario = modeledThreeScenario("modeled-three-busy-usage-suppressed");
    scenario.model.readOnlyOrchestrator!.modeledBatchOutcome = "busy";
    scenario.expected = {
      terminal: "failure",
      artifactBodies: [],
      actionNames: ["search_viral_posts", "write_grounded_post"],
    };

    const report = await runCoworkOutcomeScenario(scenario);

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    expect(report.persisted.artifacts).toHaveLength(0);
    const failureRow = report.persisted.messages.findLast(
      (m) => m.role === "assistant",
    );
    expect(failureRow?.recoverable_error).toMatchObject({
      code: "modeled_batch_resumable_busy",
    });
    expect(failureRow?.turn_usage).toEqual({
      stages: [],
      total_cost_usd: 0,
      total_credits: 1,
    });
  });

  test("a post-checkpoint Retry preserves creator style and resumes the frozen modeled batch", async () => {
    const checkpointed = modeledThreeScenario("modeled-three-style-busy");
    checkpointed.request.creatorStyleId = CREATOR_STYLE.id;
    checkpointed.seed = { creatorStyle: CREATOR_STYLE };
    checkpointed.model.readOnlyOrchestrator!.modeledBatchOutcome = "busy";
    checkpointed.expected = {
      terminal: "failure",
      artifactBodies: [],
      actionNames: ["search_viral_posts", "write_grounded_post"],
    };

    const resumed = modeledThreeScenario("modeled-three-style-resumed");
    Object.assign(resumed.model.readOnlyOrchestrator!, {
      disabled: true,
      frozenModeledSources: MODELED_SOURCE_ROWS.map((source) => ({
        id: source.id,
        text: source.text,
        url: source.post_url,
      })),
    });
    resumed.seed = {
      creatorStyle: {
        ...CREATOR_STYLE,
        promptBlock:
          "MUTATED_CREATOR_STYLE_SENTINEL: this regenerated profile must not alter a checkpointed Retry.",
      },
    };
    resumed.retryLatestUser = true;

    const sequence = await runCoworkOutcomeSequence([checkpointed, resumed]);

    expect(
      sequence.pass,
      JSON.stringify(
        sequence.attempts.map((attempt) => ({
          failures: attempt.failureCodes,
          safe: attempt.safe,
        })),
      ),
    ).toBe(true);
    expect(resumed.request.creatorStyleId).toBeUndefined();
    expect(sequence.attempts[1]?.observed.readOnlyTools).toEqual([]);
    expect(sequence.attempts[1]?.observed.directWriterRequests).toHaveLength(3);
    for (const request of
      sequence.attempts[1]?.observed.directWriterRequests ?? []) {
      const messages = JSON.stringify(request.messages);
      expect(messages).toContain(
        "CREATOR_STYLE_RETRY_SENTINEL",
      );
      expect(messages).not.toContain("MUTATED_CREATOR_STYLE_SENTINEL");
    }
  });

  test("a modeled Retry restores frozen custom-skill bodies after the UI and database change", async () => {
    const checkpointed = modeledThreeScenario("modeled-three-skill-busy");
    checkpointed.request.skillIds = [CUSTOM_SKILL.id];
    checkpointed.seed = { customSkill: CUSTOM_SKILL };
    checkpointed.model.readOnlyOrchestrator!.modeledBatchOutcome = "busy";
    checkpointed.expected = {
      terminal: "failure",
      artifactBodies: [],
      actionNames: ["search_viral_posts", "write_grounded_post"],
    };

    const resumed = modeledThreeScenario("modeled-three-skill-resumed");
    Object.assign(resumed.model.readOnlyOrchestrator!, {
      disabled: true,
      frozenModeledSources: MODELED_SOURCE_ROWS.map((source) => ({
        id: source.id,
        text: source.text,
        url: source.post_url,
      })),
    });
    resumed.seed = {
      customSkill: {
        ...CUSTOM_SKILL,
        body: "MUTATED_CUSTOM_SKILL_SENTINEL: this must not enter a resumed batch.",
      },
    };
    resumed.retryLatestUser = true;

    const sequence = await runCoworkOutcomeSequence([checkpointed, resumed]);

    expect(
      sequence.pass,
      JSON.stringify(
        sequence.attempts.map((attempt) => ({
          failures: attempt.failureCodes,
          safe: attempt.safe,
        })),
      ),
    ).toBe(true);
    expect(resumed.request.skillIds).toBeUndefined();
    expect(sequence.attempts[1]?.observed.readOnlyTools).toEqual([]);
    expect(sequence.attempts[1]?.observed.directWriterRequests).toHaveLength(3);
    for (const request of
      sequence.attempts[1]?.observed.directWriterRequests ?? []) {
      const messages = JSON.stringify(request.messages);
      expect(messages).toContain("CUSTOM_SKILL_RETRY_SENTINEL");
      expect(messages).not.toContain("MUTATED_CUSTOM_SKILL_SENTINEL");
    }
  });

  test("an initial modeled request never falls into the legacy writer when voice is unavailable", async () => {
    const scenario = modeledThreeScenario("modeled-three-initial-no-voice");
    Object.assign(scenario.model.readOnlyOrchestrator!, {
      disabled: true,
      voiceUnavailable: true,
    });
    scenario.expected = {
      terminal: "failure",
      httpStatus: 422,
      artifactBodies: [],
      actionNames: [],
      assistantContents: [
        "⚠️ This needs a voice profile to write in your voice, and your workspace doesn't have one yet. Head to the Voice tab to generate one, then send this again.",
      ],
    };

    const report = await runCoworkOutcomeScenario(scenario);

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.directWriterRequests).toEqual([]);
    expect(report.observed.readOnlyTools).toEqual([]);
  });

  test.each(["root", "continuation", "root_only"] as const)(
    "fails a Retry closed when its modeled %s marker is malformed",
    async (malformedModeledRetry) => {
      const scenario = modeledThreeScenario(
        `modeled-three-malformed-${malformedModeledRetry}`,
      );
      Object.assign(scenario.model.readOnlyOrchestrator!, {
        malformedModeledRetry,
      });
      scenario.expected = {
        terminal: "failure",
        httpStatus: 409,
        artifactBodies: [],
        actionNames: [],
      };

      const report = await runCoworkOutcomeScenario(scenario);

      expect(
        report.pass,
        JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
      ).toBe(true);
      expect(report.observed.agentProviderRounds).toBe(0);
      expect(report.observed.directWriterRequests).toEqual([]);
      expect(report.observed.readOnlyTools).toEqual([]);
    },
  );

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

  test("follow-up turn re-injects persisted attachment text without a re-attach", async () => {
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "attachment-persist-first",
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
      },
      {
        id: "attachment-persist-follow-up",
        request: {
          message:
            "Write an original post in my voice about the onboarding problem from the interview.",
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
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    const firstUser = sequence.attempts[0]?.persisted.messages.find(
      (message) => message.role === "user",
    );
    expect(firstUser?.content_blocks).toBeDefined();
    expect(firstUser?.content_blocks?.length).toBeGreaterThan(0);
    expect(JSON.stringify(firstUser?.content_blocks)).toContain(
      "customer said onboarding delays",
    );
    const followUpPrompt = JSON.stringify(
      sequence.attempts[1]?.observed.directWriterRequests[0]?.messages,
    );
    expect(followUpPrompt).toContain("customer said onboarding delays");
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
      0,
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
          terminal: "failure",
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
        sourceFidelity: [{ outcome: "verified" }, { outcome: "verified" }],
        provider: { rounds: [] },
        directWriter: [
          {
            text: SECOND_POST,
            finishReason: "stop",
            usage: usage(250, 120, 0.00025),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [SECOND_POST],
        actionNames: [],
        sourcePostIds: [sourcePostId],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(
      report.observed.directWriterRequests.map((request) => request.stage),
    ).toEqual(["primary"]);
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
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(220, 95, 0.0002),
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
    ).toEqual(["primary", "primary", "repair", "fallback"]);
  });

  test("the original-post starter with two selected drafts retries only the duplicate slot", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "original-starter-two-drafts-production-regression",
      request: {
        message:
          "Write an original post in my voice about ai slop. Choose a proven framework that fits the topic, but do not model it after one specific source post.",
        generationConfig: { version: 1, draftCount: 2 },
      },
      model: {
        // Replays the production failure if this request leaks to the legacy
        // agent: it renders slot one, asks for feedback too early, then repeats
        // slot one in the forced completion instead of filling slot two.
        provider: {
          rounds: [
            {
              kind: "response",
              toolCalls: [
                {
                  id: "call_first_draft",
                  name: "render_post",
                  args: { body: COMPLETE_POST },
                },
                {
                  id: "call_premature_followup",
                  name: "ask_user",
                  args: {
                    question: "What would you like to do next?",
                    options: ["Draft a variation", "It's good — done"],
                    allowOther: true,
                  },
                },
              ],
              usage: usage(300, 120, 0.004),
            },
            {
              kind: "response",
              text: `\`\`\`post\n${COMPLETE_POST}\n\`\`\``,
              finishReason: "stop",
              usage: usage(300, 120, 0.004),
            },
          ],
        },
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
    expect(report.persisted.artifacts).toHaveLength(2);
  });

  test("starter metadata keeps edited prompt copy out of routing policy", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "typed-original-starter-context",
      request: {
        message: "AI slop for content writers.",
        starterId: "write-original",
        generationConfig: { version: 1, draftCount: 2 },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [COMPLETE_POST, SECOND_POST].map((text, index) => ({
          text,
          finishReason: "stop" as const,
          usage: usage(200 + index * 20, 90 + index * 10, 0.0002),
        })),
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST, SECOND_POST],
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.directWriterRequests).toHaveLength(2);
  });

  test("a terse modeled-post starter still selects one workspace source per draft", async () => {
    const scenario = modeledStructuredCountScenario(
      "typed-modeled-starter-terse-copy",
      2,
    );
    scenario.request = {
      message: "AI slop for content writers.",
      starterId: "model-top-viral",
      generationConfig: { version: 1, draftCount: 2 },
    };

    const report = await runCoworkOutcomeScenario(scenario);

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.readOnlyTools.map((tool) => tool.name)).toEqual([
      "search_viral_posts",
    ]);
    expect(report.persisted.artifacts).toHaveLength(2);
  });

  test("the default modeled-post starter preserves its source chip", async () => {
    const scenario = modeledThreeScenario(
      "typed-modeled-starter-default-count",
    );
    const [source] = MODELED_SOURCE_ROWS;
    scenario.request = {
      message: "AI slop for content writers.",
      starterId: "model-top-viral",
    };
    scenario.model.sourceFidelity = [{ outcome: "verified" }];
    scenario.model.readOnlyOrchestrator!.toolResults = {
      search_viral_posts: [
        { ok: true, count: 2, posts: MODELED_SOURCE_ROWS.slice(0, 2) },
      ],
    };
    scenario.model.directWriter = [
      {
        text: COMPLETE_POST,
        finishReason: "stop",
        usage: usage(210, 95, 0.00019),
      },
    ];
    scenario.expected = {
      terminal: "done",
      artifactBodies: [COMPLETE_POST],
      actionNames: ["search_viral_posts", "write_grounded_post"],
      sourcePostIds: [source.id],
      sourceReferences: [{ id: source.id, url: source.post_url }],
    };

    const report = await runCoworkOutcomeScenario(scenario);

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.artifacts[0]?.meta).toMatchObject({
      source_post_id: source.id,
      source_url: source.post_url,
    });
  });

  test("a terse newsjack starter cannot bypass verified news research", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "typed-newsjack-starter-terse-copy",
      request: {
        message: "OpenAI agents for small teams.",
        starterId: "newsjack",
        generationConfig: { version: 1, draftCount: 1 },
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
                    query: "OpenAI agents for small teams",
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
                    title: "OpenAI launches a verified agent product",
                    url: "https://openai.com/news/agents",
                    source: "OpenAI",
                    published_at: "2026-07-14",
                    summary:
                      "OpenAI announced agent tooling for small teams.",
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
    expect(report.observed.readOnlyTools.map((tool) => tool.name)).toEqual([
      "search_news",
    ]);
    expect(report.observed.agentProviderRounds).toBe(0);
  });

  test("Retry restores the original starter and draft count after one slot exhausts", async () => {
    const failed: CoworkOutcomeScenario = {
      id: "typed-original-starter-partial-failure",
      request: {
        message: "AI slop for content writers.",
        starterId: "write-original",
        generationConfig: { version: 1, draftCount: 2 },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          COMPLETE_POST,
          COMPLETE_POST,
          COMPLETE_POST,
          COMPLETE_POST,
        ].map((text, index) => ({
          text,
          finishReason: "stop" as const,
          usage: usage(200 + index * 20, 90 + index * 10, 0.0002),
        })),
      },
      expected: {
        terminal: "failure",
        artifactBodies: [COMPLETE_POST],
        actionNames: [],
      },
    };
    const recovered: CoworkOutcomeScenario = {
      id: "typed-original-starter-partial-retry",
      request: { message: "AI slop for content writers." },
      retryLatestUser: true,
      model: {
        provider: { rounds: [] },
        directWriter: [SECOND_POST, THIRD_POST].map((text, index) => ({
          text,
          finishReason: "stop" as const,
          usage: usage(210 + index * 20, 95 + index * 10, 0.0002),
        })),
      },
      expected: {
        terminal: "done",
        artifactBodies: [SECOND_POST, THIRD_POST],
        actionNames: [],
      },
    };

    const sequence = await runCoworkOutcomeSequence([failed, recovered]);

    expect(
      sequence.pass,
      JSON.stringify(
        sequence.attempts.map((attempt) => ({
          failures: attempt.failureCodes,
          safe: attempt.safe,
        })),
      ),
    ).toBe(true);
    expect(sequence.attempts[0]?.persisted.artifacts).toHaveLength(1);
    expect(sequence.attempts[1]?.observed.directWriterRequests).toHaveLength(2);
    const retriedUser = sequence.attempts[1]?.persisted.messages
      .filter((message) => message.role === "user")
      .at(-1);
    expect(retriedUser?.composer_starter_id).toBe("write-original");
    expect(retriedUser?.generation_config).toEqual({
      version: 1,
      draftCount: 2,
      draftCountSource: "ui",
      postTypeSource: "default",
    });
  });

  test("Retry rejects a starter that differs from the original task", async () => {
    const first: CoworkOutcomeScenario = {
      id: "typed-starter-retry-original",
      request: {
        message: "AI slop for content writers.",
        starterId: "write-original",
        generationConfig: { version: 1, draftCount: 2 },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [COMPLETE_POST, SECOND_POST].map((text, index) => ({
          text,
          finishReason: "stop" as const,
          usage: usage(200 + index * 20, 90 + index * 10, 0.0002),
        })),
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST, SECOND_POST],
        actionNames: [],
      },
    };
    const tampered: CoworkOutcomeScenario = {
      id: "typed-starter-retry-tampered",
      request: {
        message: "AI slop for content writers.",
        starterId: "newsjack",
      },
      retryLatestUser: true,
      model: { provider: { rounds: [] }, directWriter: [] },
      expected: {
        terminal: "failure",
        httpStatus: 409,
        artifactBodies: [],
        actionNames: [],
      },
    };

    const sequence = await runCoworkOutcomeSequence([first, tampered]);

    expect(sequence.pass).toBe(true);
    expect(sequence.attempts[1]?.observed.directWriterRequests).toEqual([]);
  });

  test.each([1, 2] as const)(
    "uses the structured draft control for an original %i-post request",
    async (draftCount) => {
    const bodies = [COMPLETE_POST, SECOND_POST].slice(0, draftCount);
    const report = await runCoworkOutcomeScenario({
      id: `direct-posts-structured-count-${draftCount}`,
      request: {
        message:
          "Write original LinkedIn posts about why a personal brand is career leverage. Do not search.",
        generationConfig: { version: 1, draftCount },
      },
      model: {
        provider: { rounds: [] },
        directWriter: bodies.map((text, index) => ({
          text,
          finishReason: "stop" as const,
          usage: usage(200 + index * 30, 90 + index * 10, 0.00018 + index * 0.00004),
        })),
      },
      expected: {
        terminal: "done",
        artifactBodies: bodies,
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.directWriterRequests).toHaveLength(draftCount);
    },
  );

  test("uses the selected draft count when the message asks for a different count", async () => {
    const bodies = [COMPLETE_POST, SECOND_POST, THIRD_POST, FOURTH_POST];
    const report = await runCoworkOutcomeScenario({
      id: "selected-draft-count-overrides-message",
      request: {
        message: "Write 2 original LinkedIn posts about content systems.",
        generationConfig: { version: 1, draftCount: 4 },
      },
      model: {
        provider: { rounds: [] },
        directWriter: bodies.map((text, index) => ({
          text,
          finishReason: "stop" as const,
          usage: usage(200 + index * 20, 90 + index * 10, 0.00018 + index * 0.00002),
        })),
      },
      expected: {
        terminal: "done",
        artifactBodies: bodies,
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(4);
    expect(report.observed.agentProviderRounds).toBe(0);
  });

  test("routes a plain question through the answer lane with no artifact", async () => {
    const answer = "A content system is a repeatable way to capture, shape, and publish ideas.";
    const report = await runCoworkOutcomeScenario({
      id: "plain-question-answer-lane",
      request: {
        message: "What is a content system?",
        generationConfig: { version: 1, draftCount: 5 },
      },
      model: { provider: textProvider(answer) },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        assistantContents: [answer],
        route: "answer",
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.artifacts).toEqual([]);
    expect(report.safe.route).toBe("answer");
  });

  test("routes an ideas/brainstorm starter through the answer lane", async () => {
    const answer =
      "A few angles: the hidden cost of context switching, why documentation is a retention tool, and how async rituals shape culture.";
    const report = await runCoworkOutcomeScenario({
      id: "brainstorm-starter-answer-lane",
      request: {
        message: "Help me brainstorm angles for a post about remote work culture.",
      },
      model: { provider: textProvider(answer) },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        assistantContents: [answer],
        route: "answer",
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.artifacts).toEqual([]);
    expect(report.safe.route).toBe("answer");
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
        meta: expect.objectContaining({ skills: ["storytelling"] }),
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
          meta: expect.objectContaining({ durable: true }),
        }),
      ]);
    },
  );



  test("refines a hook while preserving an exact tagged final line", async () => {
    const targetId = "00000000-0000-4000-8000-000000000597";
    const finalLine = "#SWIPEIN_QA_20260716.";
    const targetBody = `${COMPLETE_POST}\n\n${finalLine}`;
    const revisedBody = `${SECOND_POST}\n\n${finalLine}`;
    const expectedBody = splicePreservedBody(targetBody, revisedBody);
    const instruction =
      `Make the hook punchier and keep the exact final line ${finalLine}`;
    const report = await runCoworkOutcomeScenario({
      id: "hook-refine-preserve-exact-final-line",
      request: {
        message: buildHookOnlyRefineMessage(instruction, targetBody),
        skipDecision: true,
        refineTargetId: targetId,
        refineInstruction: instruction,
        hookOnly: true,
        hookOnlyOriginalBody: targetBody,
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Career leverage",
          body: targetBody,
        },
      },
      model: {
        provider: renderProvider([revisedBody]),
        directWriter: [
          {
            text: revisedBody,
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
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(report.persisted.artifacts[0]?.body.endsWith(finalLine)).toBe(true);
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

  test("a pinned read-only lane keeps an ambiguous follow-up out of the answer lane", async () => {
    const sequence = await runCoworkOutcomeSequence([
      modeledThreeScenario("pin-read-only-turn-1"),
      {
        id: "pin-read-only-turn-2",
        request: { message: "Keep going." },
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
                      limit: 1,
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
                  count: 2,
                  posts: [
                    {
                      id: "source-pinned-a",
                      text: "A sourcing lesson.",
                      post_url: "https://linkedin.com/pinned-a",
                    },
                    {
                      id: "source-pinned-b",
                      text: "Another sourcing lesson.",
                      post_url: "https://linkedin.com/pinned-b",
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
          actionNames: ["search_viral_posts", "write_grounded_post"],
          route: "read_only_orchestrator",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[0]?.safe.route).toBe("read_only_orchestrator");
    expect(sequence.attempts[1]?.safe.route).toBe("read_only_orchestrator");
  });

  test("a research starter overrides a pinned direct-writer lane so the search actually runs", async () => {
    // Regression: a chat pinned to direct_writer forced EVERY later turn into
    // the writer lane — including research-required starters — so a "model a
    // top viral post" request free-wrote with no swipe-file search (and no
    // research narration: the UI jumped from "Planning next moves" to draft).
    const report = await runCoworkOutcomeScenario({
      id: "pin-direct-writer-research-starter",
      seed: { pinnedCoworkRoute: "direct_writer" },
      request: {
        message:
          "Find a top-performing regular post in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original.",
        starterId: "model-top-viral",
      },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [
            {
              model: PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
              toolArgs: null,
              usage: usage(90, 18, 0.001),
            },
          ],
          toolResults: {
            search_viral_posts: [
              {
                ok: true,
                count: 1,
                posts: [
                  {
                    id: "source-pinned-starter",
                    text: "A sourcing lesson.",
                    post_url: "https://linkedin.com/pinned-starter",
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
        actionNames: ["search_viral_posts", "write_grounded_post"],
        route: "read_only_orchestrator",
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
  });

  test("a pinned action lane keeps an ambiguous follow-up out of the answer lane", async () => {
    const draftId = "00000000-0000-4000-8000-000000000800";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "pin-action-turn-1",
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
          route: "action_orchestrator",
        },
      },
      {
        id: "pin-action-turn-2",
        request: { message: "What about the other one?" },
        seed: {
          draft: {
            id: "00000000-0000-4000-8000-000000000801",
            title: "Hiring discipline",
            body: SECOND_POST,
            status: "drafting",
          },
        },
        model: {
          provider: { rounds: [] },
          actionOrchestrator: { plans: [], allowNoModel: true },
        },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
          route: "action_orchestrator",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[0]?.safe.route).toBe("action_orchestrator");
    expect(sequence.attempts[1]?.safe.route).toBe("action_orchestrator");
  });

  test("a pinned direct-writer lane keeps an ambiguous follow-up out of the answer lane", async () => {
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "pin-direct-writer-turn-1",
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
          route: "direct_writer",
        },
      },
      {
        id: "pin-direct-writer-turn-2",
        request: { message: "Another angle?" },
        model: {
          provider: { rounds: [] },
          directWriter: [
            {
              text: SECOND_POST,
              finishReason: "stop",
              usage: usage(220, 100, 0.0002),
            },
          ],
        },
        expected: {
          terminal: "done",
          artifactBodies: [SECOND_POST],
          actionNames: [],
          route: "direct_writer",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[0]?.safe.route).toBe("direct_writer");
    expect(sequence.attempts[1]?.safe.route).toBe("direct_writer");
  });
});

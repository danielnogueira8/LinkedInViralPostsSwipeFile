import { describe, expect, test, vi } from "vitest";
import {
  scriptedStreamChat,
} from "@/evals/cowork-scripted-provider";
import { currentCoworkHarnessAdminClient } from "@/evals/cowork-harness-store";
import {
  runCoworkOutcomeScenario,
  runCoworkOutcomeSequence,
  type CoworkOutcomeScenario,
} from "@/evals/cowork-outcome-harness";
import {
  buildCoworkRolloutEvidence,
  COWORK_CRITICAL_JOURNEYS,
  type CoworkCriticalJourney,
  type CoworkEvidenceRun,
} from "@/lib/agent/cowork-rollout-evidence";
import { PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL } from "@/lib/agent/read-only-orchestrator";
import { PRIMARY_ACTION_ORCHESTRATOR_MODEL } from "@/lib/agent/action-orchestrator";

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/openrouter")>();
  return { ...original, streamChat: scriptedStreamChat };
});

vi.mock("@/lib/supabase", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/supabase")>();
  return { ...original, supabaseAdmin: currentCoworkHarnessAdminClient };
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
const REFINED_POST = [
  "Your title is rented. Your reputation is owned.",
  "It is career leverage you keep when your title, company, or market changes.",
  "A useful reputation compounds before you need it: people know how you think, what you can solve, and why they should trust you.",
  "Do the work in public. Teach the lesson while it is still fresh. Let proof accumulate.",
].join("\n\n");
const EXACT_HOOKS = [
  "1.",
  "Hook: Distribution is part of the product.",
  "",
  "2.",
  "Hook: Great work cannot compound while it stays invisible.",
  "",
  "3.",
  "Hook: Polish without reach is a private win.",
].join("\n");

const usage = (input: number, output: number, cost: number) => ({
  prompt_tokens: input,
  completion_tokens: output,
  prompt_tokens_details: { cached_tokens: Math.floor(input / 5) },
  completion_tokens_details: { reasoning_tokens: 0 },
  cost,
});

function scenario(
  journey: CoworkCriticalJourney,
  repetition: number,
): CoworkOutcomeScenario {
  const id = `v2-gate-${journey}-${repetition}`;
  if (journey === "original_post") {
    return {
      id,
      request: {
        message:
          "Write an original post in my voice about why a personal brand is career leverage.",
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          { text: COMPLETE_POST, finishReason: "stop", usage: usage(210, 95, 0.00019) },
        ],
      },
      expected: { terminal: "done", artifactBodies: [COMPLETE_POST], actionNames: [] },
    };
  }
  if (journey === "refine") {
    const targetId = "00000000-0000-4000-8000-000000000501";
    return {
      id,
      request: {
        message: `Refine this post: Tighten the hook.\n\nCurrent post:\n${COMPLETE_POST}`,
        skipDecision: true,
        refineTargetId: targetId,
        refineInstruction: "Tighten the hook.",
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Career leverage",
          body: COMPLETE_POST,
        },
        draft: { id: targetId, title: "Career leverage", body: COMPLETE_POST },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          { text: REFINED_POST, finishReason: "stop", usage: usage(220, 90, 0.00019) },
        ],
      },
      expected: { terminal: "done", artifactBodies: [REFINED_POST], actionNames: [] },
    };
  }
  if (journey === "fixed_source") {
    const modelSourceId = "00000000-0000-4000-8000-000000000201";
    const sourcePostId = "00000000-0000-4000-8000-000000000202";
    return {
      id,
      request: { message: "Model the attached source into one original post.", modelSourceId },
      seed: {
        bookmarkModelSource: {
          id: modelSourceId,
          sourcePostId,
          postText: "A verified source explains why public proof compounds across career changes.",
          postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123",
        },
      },
      model: {
        provider: { rounds: [] },
        sourceFidelity: [{ pass: true, reasons: [], retryInstruction: "" }],
        directWriter: [
          { text: COMPLETE_POST, finishReason: "stop", usage: usage(250, 120, 0.00025) },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST],
        actionNames: [],
        sourcePostIds: [sourcePostId],
      },
    };
  }
  if (journey === "partial") {
    return {
      id,
      request: { message: "Give me exactly 3 hooks about content distribution. Do not search." },
      model: {
        provider: { rounds: [] },
        directWriter: [
          { text: EXACT_HOOKS, finishReason: "stop", usage: usage(130, 60, 0.00012) },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        assistantContents: [EXACT_HOOKS],
      },
    };
  }
  if (journey === "multi_post") {
    return {
      id,
      request: {
        message:
          "Write exactly 2 different posts about why a personal brand is career leverage. Do not search.",
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          { text: COMPLETE_POST, finishReason: "stop", usage: usage(200, 90, 0.00018) },
          { text: SECOND_POST, finishReason: "stop", usage: usage(230, 100, 0.00022) },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST, SECOND_POST],
        actionNames: [],
      },
    };
  }
  if (journey === "no_search") {
    return {
      id,
      request: {
        message:
          "Write one original post about career leverage. Do not search for or model any source.",
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          { text: COMPLETE_POST, finishReason: "stop", usage: usage(210, 95, 0.00019) },
        ],
      },
      expected: { terminal: "done", artifactBodies: [COMPLETE_POST], actionNames: [] },
    };
  }
  if (journey === "research_write") {
    return {
      id,
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
                  { id: "sources", type: "search_viral_posts", niche: "SaaS", limit: 3 },
                  { id: "draft", type: "draft_post", evidenceActionIds: ["sources"] },
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
                  { id: "source-a", text: "A pricing lesson.", post_url: "https://linkedin.com/a" },
                  { id: "source-b", text: "A positioning lesson.", post_url: "https://linkedin.com/b" },
                  { id: "source-c", text: "A packaging lesson.", post_url: "https://linkedin.com/c" },
                ],
              },
            ],
          },
        },
        directWriter: [
          { text: COMPLETE_POST, finishReason: "stop", usage: usage(220, 100, 0.0002) },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST],
        actionNames: ["search_viral_posts", "write_grounded_post"],
      },
    };
  }

  const draftId = "00000000-0000-4000-8000-000000000710";
  return {
    id,
    request: { message: "Move the pricing draft to ready and plan it for 2026-07-17." },
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
                { id: "move", type: "move_on_board", draftId, status: "ready" },
                { id: "plan", type: "schedule_post", draftId, date: "2026-07-17" },
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
  };
}

function resilienceScenarios(
  journey: Extract<
    CoworkCriticalJourney,
    | "clarification_completion"
    | "fresh_news_fail_closed"
    | "cancellation"
    | "retry_recovery"
  >,
  repetition: number,
): CoworkOutcomeScenario[] {
  const id = `v2-gate-${journey}-${repetition}`;
  if (journey === "clarification_completion") {
    return [
      {
        id: `${id}-question`,
        request: {
          message: "Help me write a LinkedIn post, but ask for the angle first.",
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
        expected: { terminal: "ask", artifactBodies: [], actionNames: ["ask_user"] },
      },
      {
        id: `${id}-answer`,
        request: { message: "Career leverage." },
        model: {
          provider: { rounds: [] },
          directWriter: [
            { text: COMPLETE_POST, finishReason: "stop", usage: usage(210, 95, 0.00019) },
          ],
        },
        expected: { terminal: "done", artifactBodies: [COMPLETE_POST], actionNames: [] },
      },
    ];
  }
  if (journey === "fresh_news_fail_closed") {
    return [
      {
        id,
        request: {
          message:
            "Research the latest OpenAI announcement and write a LinkedIn post about it.",
        },
        model: {
          provider: { rounds: [] },
          readOnlyOrchestrator: {
            plans: [
              {
                model: PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
                toolArgs: {
                  actions: [
                    { id: "news", type: "search_news", query: "latest OpenAI announcement" },
                    { id: "draft", type: "draft_post", evidenceActionIds: ["news"] },
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
                  searched: 4,
                  results: [],
                  note: "No fresh news. Do not invent or use older news.",
                },
              ],
            },
          },
          directWriter: [],
        },
        expected: { terminal: "done", artifactBodies: [], actionNames: ["search_news"] },
      },
    ];
  }
  if (journey === "cancellation") {
    return [
      {
        id,
        request: {
          message:
            "Write an original post in my voice about why a personal brand is career leverage.",
        },
        model: {
          provider: { rounds: [] },
          directWriter: [{ cancelViaDatabase: true }],
        },
        expected: { terminal: "cancelled", artifactBodies: [], actionNames: [] },
      },
    ];
  }
  const message =
    "Write an original post in my voice about why a personal brand is career leverage.";
  return [
    {
      id: `${id}-failed`,
      request: { message },
      model: {
        provider: { rounds: [] },
        directWriter: [
          { text: "", finishReason: "stop", usage: usage(120, 0, 0.00004) },
          { text: "", finishReason: "stop", usage: usage(140, 0, 0.00013) },
        ],
      },
      expected: { terminal: "done", artifactBodies: [], actionNames: [] },
    },
    {
      id: `${id}-recovered`,
      request: { message },
      model: {
        provider: { rounds: [] },
        directWriter: [
          { text: COMPLETE_POST, finishReason: "stop", usage: usage(210, 95, 0.00019) },
        ],
      },
      expected: { terminal: "done", artifactBodies: [COMPLETE_POST], actionNames: [] },
    },
  ];
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        output[index] = await worker(values[index]);
      }
    }),
  );
  return output;
}

const repeatedGate =
  process.env.RUN_COWORK_V2_REPEATED_GATE === "1" ? describe : describe.skip;

const RESILIENCE_JOURNEYS = new Set<CoworkCriticalJourney>([
  "clarification_completion",
  "fresh_news_fail_closed",
  "cancellation",
  "retry_recovery",
]);

repeatedGate("Cowork v2 repeated production-shaped gate", () => {
  test(
    "completes 300 authenticated route runs for every critical journey with zero hard failures",
    async () => {
      const repetitions = 300;
      const cases = COWORK_CRITICAL_JOURNEYS.flatMap((journey) =>
        Array.from({ length: repetitions }, (_, index) => ({ journey, index })),
      );
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const failureSamples: Array<{
        journey: CoworkCriticalJourney;
        failures: string[][];
      }> = [];
      let runs: CoworkEvidenceRun[];
      try {
        const runCase = async ({
          journey,
          index,
        }: {
          journey: CoworkCriticalJourney;
          index: number;
        }): Promise<CoworkEvidenceRun> => {
          const reports = RESILIENCE_JOURNEYS.has(journey)
            ? (
                await runCoworkOutcomeSequence(
                  resilienceScenarios(
                    journey as Parameters<typeof resilienceScenarios>[0],
                    index,
                  ),
                )
              ).attempts
            : [await runCoworkOutcomeScenario(scenario(journey, index))];
          const pass = reports.every((report) => report.pass);
          if (!pass && failureSamples.length < 5) {
            failureSamples.push({
              journey,
              failures: reports.map((report) => report.failureCodes),
            });
          }
          const modelStages = reports.flatMap((report) => report.safe.modelStages);
          const writerModel = modelStages.find(
            (stage) => stage.kind === "cowork_direct_writer",
          )?.model;
          const orchestratorModel = modelStages.find((stage) =>
            ["cowork_orchestrator", "cowork_action_orchestrator"].includes(stage.kind),
          )?.model;
          return {
            runId: `v2-gate-${journey}-${index}`,
            architecture: "v2",
            journey,
            variantId:
              [orchestratorModel, writerModel].filter(Boolean).join("+") ||
              "v2-server",
            evidenceSource: "scripted",
            productionShaped: true,
            costObserved: false,
            contractPassed: pass,
            terminalOutcome: !pass
              ? "hard_failure"
              : journey === "cancellation"
                ? "cancelled"
                : journey === "fresh_news_fail_closed"
                  ? "recoverable_error"
                  : "delivered",
            fallbackUsed: reports.some((report) => report.safe.fallbackUsed),
            latencyMs: reports.reduce(
              (total, report) => total + report.safe.latencyMs,
              0,
            ),
            inputTokens: reports.reduce(
              (total, report) => total + report.safe.inputTokens,
              0,
            ),
            outputTokens: reports.reduce(
              (total, report) => total + report.safe.outputTokens,
              0,
            ),
            reasoningTokens: reports.reduce(
              (total, report) => total + report.safe.reasoningTokens,
              0,
            ),
            cachedInputTokens: reports.reduce(
              (total, report) => total + report.safe.cachedInputTokens,
              0,
            ),
            chargedCostUsd: reports.reduce(
              (total, report) => total + report.safe.costUsd,
              0,
            ),
            ...(orchestratorModel ? { orchestratorModel } : {}),
            ...(writerModel ? { writerModel } : {}),
          } satisfies CoworkEvidenceRun;
        };
        const retryCases = cases.filter(
          ({ journey }) => journey === "retry_recovery",
        );
        const otherCases = cases.filter(
          ({ journey }) => journey !== "retry_recovery",
        );
        runs = [
          ...(await mapWithConcurrency(otherCases, 24, runCase)),
          // The two-turn retry scenario intentionally reuses one persistent
          // store. Serialize these cases because the test-only OpenRouter
          // usage adapter is process-scoped, while production persistence is
          // database-scoped and independently covered by its concurrency tests.
          ...(await mapWithConcurrency(retryCases, 1, runCase)),
        ];
      } finally {
        consoleLog.mockRestore();
      }
      const evidence = buildCoworkRolloutEvidence({
        runs,
        blindComparisons: [],
      });

      for (const journey of COWORK_CRITICAL_JOURNEYS) {
        expect(
          evidence.runs.byArchitectureAndJourney.v2[journey],
          `${journey}: ${JSON.stringify(failureSamples)}`,
        ).toMatchObject({
          runs: repetitions,
          productionShapedRuns: repetitions,
          completedProductionShapedRuns: repetitions,
          contractPassRate: 1,
          hardFailures: 0,
          hardFailureRate: 0,
        });
      }
      expect(evidence.promotion.status).toBe("blocked");
      expect(evidence.promotion.blockers).toEqual(
        expect.arrayContaining([
          "original_post:baseline_runs_below_300",
          "original:blind_comparisons_below_20",
          "browser:desktop_pending",
          "browser:mobile_pending",
        ]),
      );
      console.log(
        `COWORK_V2_SCRIPTED_GATE ${JSON.stringify({
          evidenceJourneys: runs.length,
          routeExecutions:
            runs.length +
            repetitions * 2,
          journeys: COWORK_CRITICAL_JOURNEYS.length,
          hardFailures: evidence.runs.overall.hardFailures,
          promotion: evidence.promotion.status,
        })}`,
      );
    },
    300_000,
  );
});

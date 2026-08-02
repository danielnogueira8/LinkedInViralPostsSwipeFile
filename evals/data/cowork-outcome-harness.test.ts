import { describe, expect, test, vi } from "vitest";
import {
  scriptedStreamChat,
  type ScriptedProviderScenario,
} from "@/evals/cowork-scripted-provider";

// Freshness-relative fixture date for news results: the executor filters
// news by age (NEWS_MAX_AGE_DAYS, default 14) against the REAL clock, so a
// hardcoded published_at silently goes stale — 2026-07-14 fixtures passed
// on 2026-07-27 and failed CI the next day.
const freshDate = (daysAgo = 3): string =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
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

const SELECTABLE_SOURCE_ROWS = [
  {
    id: "00000000-0000-4000-8000-000000000701",
    text: COMPLETE_POST,
    post_url:
      "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000701",
    author_name: "Fixture Creator",
    post_type: "regular",
  },
  {
    id: "00000000-0000-4000-8000-000000000702",
    text: SECOND_POST,
    post_url:
      "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000702",
    author_name: "Fixture Creator",
    post_type: "regular",
  },
  {
    id: "00000000-0000-4000-8000-000000000703",
    text: THIRD_POST,
    post_url:
      "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000703",
    author_name: "Fixture Creator",
    post_type: "regular",
  },
  {
    id: "00000000-0000-4000-8000-000000000704",
    text: FOURTH_POST,
    post_url:
      "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000704",
    author_name: "Fixture Creator",
    post_type: "regular",
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
  test("answers the exact swipe-file summary request without voice or a draft", async () => {
    const instruction =
      "Find one top-performing regular post in my swipe file about AI agents and summarize why it worked. Do not draft or rewrite.";
    const sourceUrl = "https://www.linkedin.com/posts/top-ai-agent-post";
    const answer = `The post worked because its concrete AI-agent failure hook made the risk immediately legible.\n\nSources:\n- [Top AI-agent post](${sourceUrl})`;
    const report = await runCoworkOutcomeScenario({
      id: "grounded-workspace-summary-no-voice",
      request: { message: instruction },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [],
          voiceUnavailable: true,
          groundedAnswer: { content: answer, usage: usage(80, 35, 0.0002) },
          toolResults: {
            search_viral_posts: [
              {
                ok: true,
                count: 1,
                posts: [
                  {
                    id: "top-ai-agent-post",
                    text: "AI agents fail when teams confuse permission with instruction.",
                    post_url: sourceUrl,
                    reactions: 840,
                    comments: 96,
                    post_type: "regular",
                  },
                ],
              },
            ],
          },
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["search_viral_posts"],
        assistantContents: [answer],
        route: "read_only_orchestrator",
      },
    });

    expect(report.pass, JSON.stringify(report.failureCodes)).toBe(true);
    expect(report.observed.directWriterRequests).toEqual([]);
    expect(report.observed.readOnlyTools).toEqual([
      {
        name: "search_viral_posts",
        args: {
          query: "AI agents",
          post_type: "regular",
          sort: "viral",
          dir: "desc",
          strict_ranking: true,
          limit: 2,
        },
      },
    ]);
    expect(report.persisted.artifacts).toEqual([]);
  });

  // Regression: an explicit Ask command (what the composer sends) + a bare
  // swipe-file search must run a real search, NOT fall to the tool-less answer
  // lane where the model hallucinates "I don't have access to a swipe file
  // database." The Ask branch only compiled a research route when a starter
  // supplied a researchRequirement; a free-typed "Find 5 lead magnet posts on
  // the swipe file..." had none, so it dead-ended in the answer lane.
  test("an explicit Ask + swipe-file search runs a real search, never the tool-less answer lane", async () => {
    const answer =
      "Here are lead-magnet posts from your swipe file you could adapt:\n\nSources:\n- [A post](https://www.linkedin.com/posts/lm-1)";
    const report = await runCoworkOutcomeScenario({
      id: "ask-swipe-file-search-not-answer-lane",
      request: {
        message:
          "Find 5 lead magnet posts on the swipe file that could be adapted for a resource about AI workflows for content creation",
        command: { kind: "ask" },
      },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [],
          groundedAnswer: { content: answer, usage: usage(80, 35, 0.0002) },
          toolResults: {
            search_viral_posts: [
              {
                ok: true,
                count: 1,
                posts: [
                  {
                    id: "lm-1",
                    text: "A lead magnet post about AI workflows.",
                    post_url: "https://www.linkedin.com/posts/lm-1",
                    reactions: 500,
                    comments: 40,
                    post_type: "lead_magnet",
                  },
                ],
              },
            ],
          },
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["search_viral_posts"],
        assistantContents: [answer],
        route: "read_only_orchestrator",
      },
    });

    expect(report.pass, JSON.stringify(report.failureCodes)).toBe(true);
    expect(report.safe.route).toBe("read_only_orchestrator");
    expect(report.observed.readOnlyTools.map((t) => t.name)).toContain(
      "search_viral_posts",
    );
  });

  // Same guarantee through the free-text send (no explicit command) — the other
  // entry into the pipeline. A swipe-file search must reach the search, not the
  // tool-less answer lane, regardless of how the composer submits it.
  test("a free-text swipe-file search (no command) also runs a real search", async () => {
    const answer =
      "Posts from your swipe file:\n\nSources:\n- [A post](https://www.linkedin.com/posts/sf-1)";
    const report = await runCoworkOutcomeScenario({
      id: "free-text-swipe-file-search",
      request: {
        message:
          "Can you find REAL posts from the swipe file that I could adapt?",
      },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [],
          groundedAnswer: { content: answer, usage: usage(80, 35, 0.0002) },
          toolResults: {
            search_viral_posts: [
              {
                ok: true,
                count: 1,
                posts: [
                  {
                    id: "sf-1",
                    text: "A swipe-file post worth adapting.",
                    post_url: "https://www.linkedin.com/posts/sf-1",
                    reactions: 620,
                    comments: 55,
                    post_type: "regular",
                  },
                ],
              },
            ],
          },
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["search_viral_posts"],
        assistantContents: [answer],
        route: "read_only_orchestrator",
      },
    });

    expect(report.pass, JSON.stringify(report.failureCodes)).toBe(true);
    expect(report.safe.route).toBe("read_only_orchestrator");
  });

  test("a negative LinkedIn-post phrase cannot turn a news summary into a draft", async () => {
    const instruction =
      "Research the latest official OpenAI product announcement and summarize what changed. Do not draft or rewrite a LinkedIn post.";
    const answer = "OpenAI changed the verified product workflow.";
    const report = await runCoworkOutcomeScenario({
      id: "grounded-news-summary-negative-draft-phrase",
      request: { message: instruction },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [],
          groundedAnswer: { content: answer, usage: usage(80, 35, 0.0002) },
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
                    published_at: freshDate(),
                    summary: "OpenAI announced a verified product update.",
                  },
                ],
              },
            ],
          },
        },
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["search_news"],
        assistantContents: [answer],
        route: "read_only_orchestrator",
      },
    });

    expect(report.pass, JSON.stringify(report.failureCodes)).toBe(true);
    expect(report.observed.directWriterRequests).toEqual([]);
    expect(report.persisted.artifacts).toEqual([]);
  });

  test("runs the real agent through the authenticated answer lane and canonical persistence", async () => {
    const answer = "Finished the requested deliverable.";
    const report = await runCoworkOutcomeScenario({
      id: "original-post",
      request: {
        message: "What makes a personal brand useful career leverage?",
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
        command: { kind: "create", count: 1 },
        generationConfig: {
          version: 1,
          draftCount: 1,
          explorationLane: "experimental",
        },
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
      reasoning: "sonnet-low",
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
    const userRow = report.persisted.messages.find(
      (message) => message.role === "user",
    );
    expect(userRow?.generation_config).toMatchObject({
      explorationLane: "experimental",
    });
    expect(report.persisted.artifacts[0]?.meta).toMatchObject({
      exploration_lane: "experimental",
    });
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

  test("an explicit Create fails closed when its selected source is missing", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "command-create-missing-model-source",
      request: {
        message: "Model the selected source into one Post.",
        command: { kind: "create", count: 1 },
        modelSourceId: "00000000-0000-4000-8000-000000000402",
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(180, 82, 0.00016),
          },
        ],
      },
      expected: {
        terminal: "failure",
        httpStatus: 409,
        artifactBodies: [],
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
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
                    published_at: freshDate(),
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

  // Regression: every composer send carries an explicit `create` command, and
  // that command used to claim the turn for the tool-less direct writer while
  // checking only voice/attachments/the starter-chip researchRequirement —
  // never the instruction text. A TYPED newsjacking brief ("Newsjack… search
  // verified news first") therefore landed on direct_writer, where the model
  // has no search_news tool and could only refuse. The command fast path now
  // applies the same live-news/research text gates as the free-text path, so
  // this turn must route to news_research (read_only_orchestrator) exactly
  // like the identical request sent without a command (test above).
  test("a typed newsjacking brief sent with an explicit create command routes to news_research, not the tool-less writer", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "typed-newsjacking-create-command",
      request: {
        message:
          "Newsjack a recent event about AI-generated content. Search for verified news from the last 14 days first, then write a LinkedIn post about what it means for founders.",
        command: { kind: "create", count: 1 },
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
                    query: "AI-generated content recent event",
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
                    title: "Major platform verifies AI-generated content labels",
                    url: "https://example.com/news/ai-content-labels",
                    source: "Example News",
                    published_at: freshDate(),
                    summary:
                      "A major platform announced verified labels for AI-generated content.",
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
        route: "read_only_orchestrator",
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.safe.route).toBe("read_only_orchestrator");
    expect(report.observed.readOnlyTools.map((tool) => tool.name)).toEqual([
      "search_news",
    ]);
    // The single draft-engine call is the grounded write AFTER the news
    // search — not a tool-less direct-writer turn.
    expect(report.observed.directWriterRequests).toHaveLength(1);
  });

  // Guard against over-correction: a plain typed post brief sent with the
  // same explicit create command must STILL take the tool-less direct-writer
  // fast path — no research wording, no tools, one canonical draft.
  test("a plain typed post brief sent with an explicit create command still routes to the direct writer", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "typed-plain-post-create-command",
      request: {
        message: "Write a post about remote work.",
        command: { kind: "create", count: 1 },
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
    });

    expect(
      report.pass,
      JSON.stringify({ failures: report.failureCodes, safe: report.safe }),
    ).toBe(true);
    expect(report.safe.route).toBe("direct_writer");
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.readOnlyPlannerRequests).toHaveLength(0);
    expect(report.observed.readOnlyTools).toEqual([]);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    expect(Object.keys(report.observed.directWriterRequests[0])).not.toContain(
      "tools",
    );
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
                    published_at: freshDate(),
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

  test("Create with an attachment produces its exact Post despite summary wording", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "command-create-file-summary-wording",
      request: {
        message: "Summarize this attachment.",
        command: { kind: "create", count: 1 },
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
              id: "interview-create-1",
              kind: "attachment",
              title: "interview.txt",
              text: "The customer said onboarding delays made the next step unclear.",
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
        actionNames: ["inspect_attachments", "write_grounded_post"],
        route: "read_only_orchestrator",
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
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
                      published_at: freshDate(),
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

  test("Retry replays the original modeled source and provenance", async () => {
    const modelSourceId = "00000000-0000-4000-8000-000000000231";
    const sourcePostId = "00000000-0000-4000-8000-000000000232";
    const message = "Model the attached source into one original post.";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "modeled-source-retry-failure",
        request: {
          message,
          command: { kind: "create", count: 1 },
          modelSourceId,
        },
        seed: {
          bookmarkModelSource: {
            id: modelSourceId,
            sourcePostId,
            postText:
              "A verified source explains why public proof compounds across career changes.",
            postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:231",
          },
        },
        model: {
          sourceFidelity: [{ outcome: "verified" }, { outcome: "verified" }],
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
        id: "modeled-source-retry-success",
        request: { message },
        retryLatestUser: true,
        model: {
          sourceFidelity: [{ outcome: "verified" }, { outcome: "verified" }],
          provider: { rounds: [] },
          directWriter: [
            {
              text: SECOND_POST,
              finishReason: "stop",
              usage: usage(210, 95, 0.0001888),
            },
          ],
        },
        expected: {
          terminal: "done",
          artifactBodies: [SECOND_POST],
          actionNames: [],
          sourcePostIds: [sourcePostId],
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[1]?.persisted.artifacts[0]?.meta).toMatchObject({
      source_post_id: sourcePostId,
    });
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

  test("persists only the repaired draft when a prepared Model Source fails semantic fidelity", async () => {
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
        modelSourcePreparation: {
          outcome: "ready",
          blueprint: {
            schemaVersion: 1,
            coreTheme: "Public proof compounds across career changes.",
            communicativeJob: "Prove a durable career principle through experience.",
            readerEffect: "Confidence to publish useful work.",
            hook: {
              function: "Contrast temporary titles with durable proof.",
              evidenceType: "verified experience",
            },
            emotionalArc: ["risk", "clarity", "agency"],
            beats: [
              {
                role: "contrast",
                purpose: "Contrast a temporary role with durable public proof.",
              },
              {
                role: "action",
                purpose: "Give the reader a concrete publishing action.",
              },
            ],
            requiredEvidence: [],
          },
          userMappings: [],
        },
        sourceFidelity: [
          {
            outcome: "rejected",
            reasons: ["The first draft performs a different communicative job."],
            retryInstruction:
              "Restore the temporary-title versus durable-proof contrast.",
          },
          { outcome: "verified" },
        ],
        provider: { rounds: [] },
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(220, 100, 0.0002),
          },
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
    ).toEqual(["primary", "repair"]);
    expect(report.persisted.artifacts.map((artifact) => artifact.body)).toEqual([
      SECOND_POST,
    ]);
    expect(JSON.stringify(report.persisted.messages)).not.toContain(COMPLETE_POST);
  });

  test("a Model Source clarification answer resumes Create without another command", async () => {
    const modelSourceId = "00000000-0000-4000-8000-000000000241";
    const sourcePostId = "00000000-0000-4000-8000-000000000242";
    const question =
      "What milestone and meaningful outcome should anchor your version?";
    const secondQuestion =
      "Great—I’ll build around Claude, ChatGPT, and SwipeIn. What specific use case and measurable result can you vouch for with each?";
    const needsInput = {
      outcome: "needs_input" as const,
      blueprint: {
        schemaVersion: 1 as const,
        coreTheme: "A milestone matters because of the people behind it.",
        communicativeJob: "Celebrate and humanize an achieved milestone.",
        readerEffect: "Shared pride and trust.",
        hook: {
          function: "Lead with a completed outcome.",
          evidenceType: "measurable milestone",
        },
        emotionalArc: ["pride", "gratitude", "commitment"],
        beats: [
          { role: "win", purpose: "State the milestone." },
          { role: "meaning", purpose: "Explain the impact behind it." },
        ],
        requiredEvidence: [
          {
            role: "anchor achievement",
            semanticRequirement: "A completed milestone and its impact.",
            sourceExample: "104,000 followers and resulting opportunities",
          },
        ],
      },
      userMappings: [],
      missingEvidence: ["a completed milestone and its impact"],
      question,
    };

    const sequence = await runCoworkOutcomeSequence([
      {
        id: "modeled-source-one-clarification",
        request: {
          message: "Model the attached post for me.",
          command: { kind: "create", count: 1 },
          modelSourceId,
        },
        seed: {
          bookmarkModelSource: {
            id: modelSourceId,
            sourcePostId,
            postText:
              "I reached 104,000 followers. The people and opportunities behind the number matter most.",
            postUrl:
              "https://www.linkedin.com/feed/update/urn:li:activity:241",
          },
        },
        model: {
          provider: { rounds: [] },
          modelSourcePreparation: needsInput,
          directWriter: [],
        },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: [],
          assistantContents: [question],
        },
      },
      {
        id: "modeled-source-answer-auto-resumes-create",
        request: {
          message:
            "I reached 2,000 followers through content writing and it has brought me clients.",
          modelSourceId,
        },
        model: {
          provider: { rounds: [] },
          // Reproduce the writer ignoring its no-more-questions prompt after
          // the analyzer's one clarification. The server must reject that
          // second question internally and continue autonomously.
          modelSourcePreparation: needsInput,
          directWriter: [
            {
              text: secondQuestion,
              finishReason: "stop",
              usage: usage(180, 40, 0.00014),
            },
            {
              text: SECOND_POST,
              finishReason: "stop",
              usage: usage(240, 105, 0.00023),
            },
          ],
        },
        expected: {
          terminal: "done",
          artifactBodies: [SECOND_POST],
          actionNames: [],
          sourcePostIds: [sourcePostId],
        },
      },
    ]);

    expect(
      sequence.attempts[1]?.pass,
      JSON.stringify(sequence.attempts[1]),
    ).toBe(true);
    expect(
      sequence.attempts[0]?.persisted.messages.at(-1)?.terminal_reason,
    ).toBe("ask");
    expect(sequence.attempts[1]?.observed.directWriterRequests).toHaveLength(2);
    expect(sequence.attempts[1]?.persisted.artifacts).toHaveLength(1);
    expect(sequence.attempts[1]?.persisted.messages.at(-1)?.content).not.toBe(
      question,
    );
    expect(JSON.stringify(sequence.attempts[1]?.persisted.messages)).not.toContain(
      secondQuestion,
    );
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

  test("the series starter produces one separate draft per part", async () => {
    // Regression: the message-count parser reads no number from "3-part", and
    // the parser's IMPLICIT single-post fallback used to beat the starter's
    // default of 3 — so the turn collapsed to ONE draft with all three parts
    // crammed in instead of three separate drafts.
    const report = await runCoworkOutcomeScenario({
      id: "typed-series-starter-three-drafts",
      request: {
        message:
          "Turn my morning routine framework into a 3-part LinkedIn post series in my voice — 3 separate posts, one draft per part. Part 1 sets up the problem, Part 2 delivers the core insight or method, Part 3 lands the takeaway. Each part must stand alone but build on the last, keeping the arc connected without repeating yourself.",
        starterId: "series",
      },
      model: {
        provider: { rounds: [] },
        directWriter: [COMPLETE_POST, SECOND_POST, THIRD_POST].map(
          (text, index) => ({
            text,
            finishReason: "stop" as const,
            usage: usage(200 + index * 10, 90 + index * 5, 0.0002),
          }),
        ),
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST, SECOND_POST, THIRD_POST],
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.directWriterRequests).toHaveLength(3);
    expect(report.persisted.artifacts).toHaveLength(3);
    // Each slot prompt is scoped to its own part, so slot 1 cannot satisfy the
    // whole series brief in a single collapsed draft.
    const firstSystemPrompt =
      report.observed.directWriterRequests[0]?.messages.find(
        (message) => message.role === "system",
      )?.content ?? "";
    expect(firstSystemPrompt).toContain("part 1 of the 3-part series");
  });

  test("the series starter honors a UI-picked draft count over its default", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "typed-series-starter-ui-count",
      request: {
        message:
          "Turn my morning routine framework into a LinkedIn post series in my voice.",
        starterId: "series",
        generationConfig: { version: 1, draftCount: 2 },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [COMPLETE_POST, SECOND_POST].map((text, index) => ({
          text,
          finishReason: "stop" as const,
          usage: usage(200 + index * 10, 90 + index * 5, 0.0002),
        })),
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST, SECOND_POST],
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.artifacts).toHaveLength(2);
  });

  test("a multi-draft modeled campaign searches regular posts only", async () => {
    // Campaign/series modeling must never pull lead magnets as source
    // material. The message names no post type, so the search used to run
    // unfiltered; it must now be pinned to regular posts.
    const scenario = modeledThreeScenario(
      "typed-modeled-campaign-regular-sources",
    );
    scenario.request = {
      message:
        "Select 3 top posts from my swipe file and adapt them into 3 original posts in my voice.",
    };

    const report = await runCoworkOutcomeScenario(scenario);

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.artifacts).toHaveLength(3);
    expect(report.observed.readOnlyTools.map((tool) => tool.name)).toEqual([
      "search_viral_posts",
    ]);
    expect(report.observed.readOnlyTools[0]?.args).toMatchObject({
      post_type: "regular",
    });
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

  test("the default modeled-post starter shows candidates and preserves the chosen source", async () => {
    const selected = SELECTABLE_SOURCE_ROWS[1];
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "typed-modeled-starter-choose-source",
        request: {
          message: "AI slop for content writers.",
          starterId: "model-top-viral",
        },
        model: {
          provider: { rounds: [] },
          readOnlyOrchestrator: {
            plans: [],
            toolResults: {
              search_viral_posts: [
                {
                  ok: true,
                  count: SELECTABLE_SOURCE_ROWS.length,
                  posts: [...SELECTABLE_SOURCE_ROWS],
                },
              ],
            },
          },
          directWriter: [],
        },
        expected: {
          terminal: "ask",
          artifactBodies: SELECTABLE_SOURCE_ROWS.map(() => ""),
          actionNames: ["search_viral_posts", "ask_user"],
          route: "read_only_orchestrator",
        },
      },
      {
        id: "typed-modeled-starter-write-chosen-source",
        request: {
          message: "Post 2",
          clarificationChoiceIndex: 1,
        },
        model: {
          provider: { rounds: [] },
          sourceFidelity: [{ outcome: "verified" }],
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
          actionNames: [],
          sourcePostIds: [selected.id],
          route: "direct_writer",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[0]?.observed.directWriterRequests).toEqual([]);
    expect(sequence.attempts[1]?.persisted.artifacts[0]?.meta).toMatchObject({
      source_post_id: selected.id,
      source_url: selected.post_url,
    });
  });

  test("a free-text modeled-post request keeps create authority across source selection", async () => {
    const selected = SELECTABLE_SOURCE_ROWS[2];
    const originalRequest =
      "Find one top-performing regular post in my swipe file and rewrite it in my voice.";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "free-text-modeled-post-choose-source",
        request: { message: originalRequest },
        model: {
          provider: { rounds: [] },
          readOnlyOrchestrator: {
            plans: [],
            toolResults: {
              search_viral_posts: [
                {
                  ok: true,
                  count: SELECTABLE_SOURCE_ROWS.length,
                  posts: [...SELECTABLE_SOURCE_ROWS],
                },
              ],
            },
          },
          directWriter: [],
        },
        expected: {
          terminal: "ask",
          artifactBodies: SELECTABLE_SOURCE_ROWS.map(() => ""),
          actionNames: ["search_viral_posts", "ask_user"],
          route: "read_only_orchestrator",
        },
      },
      {
        id: "free-text-modeled-post-write-chosen-source",
        request: {
          message: "Post 3",
          clarificationChoiceIndex: 2,
        },
        model: {
          provider: { rounds: [] },
          sourceFidelity: [{ outcome: "verified" }],
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
          actionNames: [],
          sourcePostIds: [selected.id],
          route: "direct_writer",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[0]?.observed.directWriterRequests).toEqual([]);
    expect(sequence.attempts[1]?.persisted.artifacts[0]?.meta).toMatchObject({
      source_post_id: selected.id,
      source_url: selected.post_url,
    });
  });

  test("a terse newsjack starter cannot bypass verified news research", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "typed-newsjack-starter-terse-copy",
      request: {
        message: "OpenAI agents for small teams.",
        command: { kind: "create", count: 1 },
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
                    published_at: freshDate(),
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

  test("an explicit Create never persists a partial Post set", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "command-create-atomic-partial-failure",
      request: {
        message: "Create two distinct Posts about AI slop.",
        command: { kind: "create", count: 2 },
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
        artifactBodies: [],
        actionNames: [],
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.persisted.artifacts).toHaveLength(0);
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

  test("a shape-rejected refine (compound/removal on the hook) still edits the draft in place via the general fallback, not a new post", async () => {
    // The exact regression: "edit the draft, remove the … sentence on the hook"
    // is rejected by the STRICT direct-refine lane (compound clause), which used
    // to dump it into the tool-less answer lane → a fresh unrelated post. The
    // general-refine fallback now routes it to the writer as a full-post rewrite
    // that replaces the SAME artifact in place.
    const targetId = "00000000-0000-4000-8000-000000000601";
    const targetBody = COMPLETE_POST;
    // The whole revised post the writer returns (a full rewrite, NOT a splice).
    const rewritten = [
      "Your reputation is the only career asset you truly own.",
      "It is leverage you keep when your title, company, or market changes.",
      "Do the work in public. Teach while it is fresh. Let proof accumulate.",
    ].join("\n\n");
    const report = await runCoworkOutcomeScenario({
      id: "general-refine-fallback",
      request: {
        message:
          "edit the draft, remove the serious question sentence on the hook",
        skipDecision: true,
        refineTargetId: targetId,
        refineInstruction:
          "edit the draft, remove the serious question sentence on the hook",
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Career leverage",
          body: targetBody,
        },
        draft: {
          id: targetId,
          title: "Career leverage",
          body: targetBody,
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: rewritten,
            finishReason: "stop",
            usage: usage(220, 90, 0.00019),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [rewritten],
        actionNames: [],
      },
    });

    expect(
      report.pass,
      JSON.stringify({
        failures: report.failureCodes,
        requests: report.observed.directWriterRequests,
        messages: report.persisted.messages,
      }),
    ).toBe(true);
    // Routed to the tool-free direct WRITER (a full-post refine), not the
    // answer lane / agent provider — so no fresh post, no extra card.
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.directWriterRequests).toHaveLength(1);
    // The SAME artifact id is updated in place with the rewritten body.
    expect(report.persisted.artifacts).toEqual([
      expect.objectContaining({ id: targetId, body: rewritten }),
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
      targetBody: `${COMPLETE_POST}\n\n${[
        "Useful public proof compounds over time.",
        "Buyers can inspect it before the call.",
        "A visible record keeps explaining how you think.",
        "That evidence works between conversations.",
      ].join(" ").concat(" ").repeat(4).trim()}`,
      candidateBody: `${COMPLETE_POST}\n\n${[
        "Useful public proof compounds over time.",
        "Buyers can inspect it before the call.",
        "A visible record keeps explaining how you think.",
        "That evidence works between conversations.",
      ].join(" ")}`,
      expectedBody: `${COMPLETE_POST}\n\n${[
        "Useful public proof compounds over time.",
        "Buyers can inspect it before the call.",
        "A visible record keeps explaining how you think.",
        "That evidence works between conversations.",
      ].join(" ")}`,
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

  test("a completed read-only lane cannot guess the meaning of an ambiguous follow-up", async () => {
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
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
          route: "answer",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[0]?.safe.route).toBe("read_only_orchestrator");
    expect(sequence.attempts[1]?.safe.route).toBe("answer");
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
                count: SELECTABLE_SOURCE_ROWS.length,
                posts: [...SELECTABLE_SOURCE_ROWS],
              },
            ],
          },
        },
        directWriter: [],
      },
      expected: {
        terminal: "ask",
        artifactBodies: SELECTABLE_SOURCE_ROWS.map(() => ""),
        actionNames: ["search_viral_posts", "ask_user"],
        route: "read_only_orchestrator",
      },
    });

    expect(report.pass, report.failureCodes.join(", ")).toBe(true);
    expect(report.observed.directWriterRequests).toEqual([]);
  });

  test("a completed action lane cannot authorize a second action from an ambiguous follow-up", async () => {
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
          route: "answer",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[0]?.safe.route).toBe("action_orchestrator");
    expect(sequence.attempts[1]?.safe.route).toBe("answer");
  });

  test("a completed writer lane cannot turn an ambiguous follow-up into a new draft", async () => {
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
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
          route: "answer",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[0]?.safe.route).toBe("direct_writer");
    expect(sequence.attempts[1]?.safe.route).toBe("answer");
  });

  test("an OPINION question after a post draft is answered, not written into a new post", async () => {
    // The reported bug: turn 1 writes a post,
    // then "why do you think this post is good or bad?" produced ANOTHER post
    // instead of an answer. The opinion guard must send it to the answer lane
    // regardless of the lane used by the previous turn.
    const opinion = "This post opens strong but the middle drags a little.";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "opinion-after-draft-turn-1",
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
        id: "opinion-after-draft-turn-2",
        request: { message: "why do you think this post is good or bad?" },
        model: { provider: textProvider(opinion) },
        expected: {
          terminal: "done",
          artifactBodies: [], // NO new post
          actionNames: [],
          assistantContents: [opinion],
          route: "answer",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[0]?.safe.route).toBe("direct_writer");
    // The question is answered on the answer lane — not written into a new post.
    expect(sequence.attempts[1]?.safe.route).toBe("answer");
    expect(sequence.attempts[1]?.safe.artifactCount).toBe(0);
  });

  test("an imperative feedback request after a draft answers with feedback and creates no artifact", async () => {
    const feedback = "The hook is clear, but the middle needs a more concrete example.";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "feedback-command-turn-1",
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
        id: "feedback-command-turn-2",
        request: {
          message:
            "Review this post and give me feedback only. Do not rewrite or edit the draft.",
        },
        model: { provider: textProvider(feedback) },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: [],
          assistantContents: [feedback],
          route: "answer",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[1]?.safe.artifactCount).toBe(0);
    const persistedReview = sequence.attempts[1]?.persisted.messages
      .find((message) => message.role === "user")
      ?.tool_calls?.find((call) => call.id === "_turn_operation");
    expect(JSON.parse(persistedReview?.function.arguments ?? "null")).toMatchObject({
      version: 1,
      kind: "review_artifact",
    });
  });

  test("an Ask turn can see every Post generated in the chat", async () => {
    const postBodies = [
      "POST ONE — deterministic systems expose every boundary.",
      "POST TWO — retries must preserve the original operation.",
      "POST THREE — explicit targets prevent accidental rewrites.",
      "POST FOUR — safe defaults turn uncertainty into clarification.",
    ];
    const report = await runCoworkOutcomeScenario({
      id: "ask-sees-all-chat-posts",
      request: {
        message: "Compare all four posts and tell me which one is strongest.",
        command: { kind: "ask" },
      },
      seed: {
        messageArtifacts: postBodies.map((body, index) => ({
          id: `00000000-0000-4000-8000-00000000071${index}`,
          kind: "post" as const,
          title: `Post ${index + 1}`,
          body,
        })),
      },
      model: {
        provider: textProvider("Post four is strongest because its outcome is clearest."),
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    const providerInput = JSON.stringify(
      report.observed.agentProviderRequests.at(-1)?.messages ?? [],
    );
    for (const body of postBodies) expect(providerInput).toContain(body);
  });

  test("a large Post history stays bounded while representing every Post", async () => {
    const postBodies = Array.from({ length: 30 }, (_, index) =>
      `UNIQUE-POST-${index + 1}\n${"x".repeat(3_480)}`,
    );
    const report = await runCoworkOutcomeScenario({
      id: "ask-sees-bounded-large-chat-post-history",
      request: {
        message: "Compare every Post in this chat.",
        command: { kind: "ask" },
      },
      seed: {
        messageArtifacts: postBodies.map((body, index) => ({
          id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          kind: "post" as const,
          title: `Post ${index + 1}`,
          body,
        })),
      },
      model: { provider: textProvider("I compared every Post.") },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    const providerInput = JSON.stringify(
      report.observed.agentProviderRequests.at(-1)?.messages ?? [],
    );
    for (let index = 1; index <= postBodies.length; index += 1) {
      expect(providerInput).toContain(`UNIQUE-POST-${index}`);
    }
    expect(providerInput).toContain("[truncated]");
    expect(providerInput.length).toBeLessThan(90_000);
  });

  test("a card-scoped Ask never receives another Post through variation wording", async () => {
    const selectedId = "20000000-0000-4000-8000-000000000001";
    const report = await runCoworkOutcomeScenario({
      id: "scoped-ask-variation-stays-on-target",
      request: {
        message: "Could you create another variation and explain the tradeoffs?",
        command: { kind: "ask", contextPostId: selectedId },
      },
      seed: {
        messageArtifacts: [
          {
            id: selectedId,
            kind: "post",
            title: "Selected Post",
            body: "SELECTED POST BODY — discuss only this one.",
          },
          {
            id: "20000000-0000-4000-8000-000000000002",
            kind: "post",
            title: "Newer Post",
            body: "NEWER POST BODY — must stay outside scoped context.",
          },
        ],
      },
      model: { provider: textProvider("Here are the tradeoffs.") },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    const providerInput = JSON.stringify(
      report.observed.agentProviderRequests.at(-1)?.messages ?? [],
    );
    expect(providerInput).toContain("SELECTED POST BODY");
    expect(providerInput).not.toContain("NEWER POST BODY");
  });

  test("Ask loads Posts beyond the recent window and keeps only the latest version of each ID", async () => {
    const revisedId = "30000000-0000-4000-8000-000000000001";
    const fillerTurns = Array.from({ length: 35 }, (_, index) => ({
      turn: {
        user: `Earlier question ${index + 1}`,
        assistant: `Earlier answer ${index + 1}`,
      },
    }));
    const report = await runCoworkOutcomeScenario({
      id: "ask-loads-complete-deduplicated-post-history",
      request: {
        message: "Compare every Post this chat has made.",
        command: { kind: "ask" },
      },
      seed: {
        messageSequence: [
          {
            artifact: {
              id: "30000000-0000-4000-8000-000000000000",
              kind: "post",
              title: "Oldest Post",
              body: "OLDEST POST OUTSIDE THE RECENT WINDOW",
            },
          },
          {
            artifact: {
              id: revisedId,
              kind: "post",
              title: "Original version",
              body: "STALE VERSION MUST NOT REACH THE MODEL",
            },
          },
          ...fillerTurns,
          {
            artifact: {
              id: revisedId,
              kind: "post",
              title: "Revised version",
              body: "LATEST VERSION MUST REACH THE MODEL",
            },
          },
        ],
      },
      model: { provider: textProvider("I compared the complete current set.") },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    const providerInput = JSON.stringify(
      report.observed.agentProviderRequests.at(-1)?.messages ?? [],
    );
    expect(providerInput).toContain("OLDEST POST OUTSIDE THE RECENT WINDOW");
    expect(providerInput).toContain("LATEST VERSION MUST REACH THE MODEL");
    expect(providerInput).not.toContain("STALE VERSION MUST NOT REACH THE MODEL");
  });

  test("a review request without a post asks for the missing post, not a research outcome", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "targetless-post-review",
      request: { message: "Review this draft and give feedback only." },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: { plans: [] },
        directWriter: [],
      },
      expected: {
        terminal: "ask",
        artifactBodies: [],
        actionNames: ["ask_user"],
        assistantContents: ["I couldn't find a Post to review in this chat."],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
    expect(report.observed.readOnlyPlannerRequests).toHaveLength(0);
  });

  test("free text resolves a numbered Artifact once and edits that exact id", async () => {
    const firstId = "00000000-0000-4000-8000-000000000601";
    const secondId = "00000000-0000-4000-8000-000000000602";
    const revised = COMPLETE_POST.replace(
      "Building a personal brand",
      "Your personal brand",
    );
    const report = await runCoworkOutcomeScenario({
      id: "server-free-text-numbered-edit",
      request: {
        message: "Review Draft 1 and make it punchier.",
        selectedArtifactId: secondId,
      },
      seed: {
        messageArtifacts: [
          { id: firstId, kind: "post", title: "First", body: COMPLETE_POST },
          { id: secondId, kind: "post", title: "Second", body: SECOND_POST },
        ],
      },
      model: {
        provider: { rounds: [] },
        directWriter: [{
          text: revised,
          finishReason: "stop",
          usage: usage(180, 82, 0.00016),
        }],
      },
      expected: {
        terminal: "done",
        artifactBodies: [revised],
        actionNames: [],
        route: "direct_writer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.persisted.artifacts[0]?.id).toBe(firstId);
    const operation = report.persisted.messages
      .find((message) => message.role === "user")
      ?.tool_calls?.find((call) => call.id === "_turn_operation");
    expect(JSON.parse(operation?.function.arguments ?? "null")).toMatchObject({
      version: 1,
      kind: "edit_artifact",
      artifactId: firstId,
    });
  });

  test("an unavailable compound ordinal asks instead of creating another post", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "server-free-text-unavailable-compound-ordinal",
      request: {
        message: "Rewrite the twenty-first draft.",
      },
      seed: {
        messageArtifacts: [
          {
            id: "00000000-0000-4000-8000-000000000611",
            kind: "post",
            title: "First",
            body: COMPLETE_POST,
          },
          {
            id: "00000000-0000-4000-8000-000000000612",
            kind: "post",
            title: "Second",
            body: SECOND_POST,
          },
        ],
      },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: { plans: [] },
        directWriter: [{
          text: THIRD_POST,
          finishReason: "stop",
          usage: usage(180, 82, 0.00016),
        }],
      },
      expected: {
        terminal: "ask",
        artifactBodies: [],
        actionNames: ["ask_user"],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
  });

  test("an invalid post target overrides an older pending research question", async () => {
    const messageArtifacts = [
      {
        id: "00000000-0000-4000-8000-000000000621",
        kind: "post" as const,
        title: "First",
        body: COMPLETE_POST,
      },
      {
        id: "00000000-0000-4000-8000-000000000622",
        kind: "post" as const,
        title: "Second",
        body: SECOND_POST,
      },
    ];
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "pending-research-question-before-invalid-target",
        request: { message: "Research the latest OpenAI news." },
        seed: { messageArtifacts },
        model: {
          provider: { rounds: [] },
          readOnlyOrchestrator: { plans: [] },
          directWriter: [],
        },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
          assistantContents: ["What should I create from this research?"],
          route: "read_only_orchestrator",
        },
      },
      {
        id: "invalid-target-after-pending-research-question",
        request: { message: "Rewrite the twenty-first draft." },
        model: {
          provider: { rounds: [] },
          readOnlyOrchestrator: { plans: [] },
          directWriter: [{
            text: THIRD_POST,
            finishReason: "stop",
            usage: usage(180, 82, 0.00016),
          }],
        },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
          assistantContents: [
            "I couldn't find Post 21. Which Post should I edit?",
          ],
          route: "answer",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[1]?.observed.directWriterRequests).toHaveLength(0);
    expect(sequence.attempts[1]?.observed.readOnlyPlannerRequests).toHaveLength(0);
  });

  test("numbered free text resolves from canonical history beyond the routing and context windows", async () => {
    const artifacts = Array.from({ length: 310 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      kind: "post" as const,
      title: `Artifact ${index + 1}`,
      body: index === 1 ? COMPLETE_POST : SECOND_POST,
    }));
    const report = await runCoworkOutcomeScenario({
      id: "server-free-text-full-history-numbered-edit",
      request: {
        message: "Rewrite Draft 2.",
        selectedArtifactId: artifacts.at(-1)?.id,
      },
      seed: { messageArtifacts: artifacts },
      model: {
        provider: { rounds: [] },
        directWriter: [{
          text: THIRD_POST,
          finishReason: "stop",
          usage: usage(180, 82, 0.00016),
        }],
      },
      expected: {
        terminal: "done",
        artifactBodies: [THIRD_POST],
        actionNames: [],
        route: "direct_writer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.persisted.artifacts[0]?.id).toBe(artifacts[1]?.id);
  });

  test("a typed edit inherits the target Artifact's custom skill", async () => {
    const targetId = "00000000-0000-4000-8000-000000000606";
    const report = await runCoworkOutcomeScenario({
      id: "typed-edit-inherited-skill",
      request: {
        message: "Make this punchier.",
        operation: {
          kind: "edit_artifact",
          artifactId: targetId,
          instruction: "Make this punchier.",
        },
      },
      seed: {
        customSkill: CUSTOM_SKILL,
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Skilled draft",
          body: COMPLETE_POST,
          meta: { skills: [CUSTOM_SKILL.name] },
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [{
          text: SECOND_POST,
          finishReason: "stop",
          usage: usage(180, 82, 0.00016),
        }],
      },
      expected: {
        terminal: "done",
        artifactBodies: [SECOND_POST],
        actionNames: [],
        route: "direct_writer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(
      JSON.stringify(report.observed.directWriterRequests[0]?.messages ?? []),
    ).toContain("CUSTOM_SKILL_RETRY_SENTINEL");
  });

  test("a complete legacy refine request converges on the typed edit path", async () => {
    const targetId = "00000000-0000-4000-8000-000000000607";
    const report = await runCoworkOutcomeScenario({
      id: "legacy-edit-normalized-to-operation",
      request: {
        message: "Make this punchier.",
        skipDecision: true,
        refineTargetId: targetId,
        refineInstruction: "Make this punchier.",
      },
      seed: {
        customSkill: CUSTOM_SKILL,
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Legacy target",
          body: COMPLETE_POST,
          meta: { skills: [CUSTOM_SKILL.name] },
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [{
          text: SECOND_POST,
          finishReason: "stop",
          usage: usage(180, 82, 0.00016),
        }],
      },
      expected: {
        terminal: "done",
        artifactBodies: [SECOND_POST],
        actionNames: [],
        route: "direct_writer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(
      JSON.stringify(report.observed.directWriterRequests[0]?.messages ?? []),
    ).toContain("CUSTOM_SKILL_RETRY_SENTINEL");
    const operation = report.persisted.messages
      .find((message) => message.role === "user")
      ?.tool_calls?.find((call) => call.id === "_turn_operation");
    expect(JSON.parse(operation?.function.arguments ?? "null")).toMatchObject({
      version: 1,
      kind: "edit_artifact",
      artifactId: targetId,
    });
  });

  test("an incomplete legacy refine request fails before generation", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "legacy-edit-incomplete",
      request: {
        message: "Make this punchier.",
        skipDecision: true,
      },
      model: { provider: { rounds: [] } },
      expected: {
        terminal: "failure",
        httpStatus: 400,
        artifactBodies: [],
        actionNames: [],
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
    expect(report.observed.agentProviderRounds).toBe(0);
  });

  test("legacy hook-only fragments fail before generation", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "legacy-hook-only-incomplete",
      request: {
        message: "Make this hook stronger.",
        hookOnly: true,
        hookOnlyOriginalBody: COMPLETE_POST,
      },
      model: { provider: { rounds: [] } },
      expected: {
        terminal: "failure",
        httpStatus: 400,
        artifactBodies: [],
        actionNames: [],
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
    expect(report.observed.agentProviderRounds).toBe(0);
  });

  test("stale selected-card context clarifies instead of editing another Artifact", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "server-free-text-stale-selected-edit",
      request: {
        message: "Make this punchier.",
        selectedArtifactId: "deleted-draft",
      },
      seed: {
        messageArtifact: {
          id: "00000000-0000-4000-8000-000000000605",
          kind: "post",
          title: "Current",
          body: COMPLETE_POST,
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [{
          text: SECOND_POST,
          finishReason: "stop",
          usage: usage(180, 82, 0.00016),
        }],
      },
      expected: {
        terminal: "ask",
        artifactBodies: [],
        actionNames: ["ask_user"],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
  });

  test("a server-resolved typed edit updates the newest draft, never an older draft", async () => {
    const revised = SECOND_POST.replace("Most people", "Too many people");
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "newest-refine-turn-1",
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
        id: "newest-refine-turn-2",
        request: {
          message:
            "Write another original post about why distribution beats perfection. Do not search.",
        },
        model: {
          provider: { rounds: [] },
          directWriter: [
            {
              text: SECOND_POST,
              finishReason: "stop",
              usage: usage(215, 98, 0.00019),
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
      {
        id: "newest-refine-turn-3",
        request: { message: "Make it punchier." },
        model: {
          provider: { rounds: [] },
          directWriter: [
            {
              text: revised,
              finishReason: "stop",
              usage: usage(180, 82, 0.00016),
            },
          ],
        },
        expected: {
          terminal: "done",
          artifactBodies: [revised],
          actionNames: [],
          route: "direct_writer",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    const firstId = sequence.attempts[0]?.persisted.artifacts[0]?.id;
    const secondId = sequence.attempts[1]?.persisted.artifacts[0]?.id;
    const refinedId = sequence.attempts[2]?.persisted.artifacts[0]?.id;
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    expect(refinedId).toBe(secondId);
  });

  test("a creator-style edit preserves artifact identity on the writer lane", async () => {
    const targetId = "00000000-0000-4000-8000-000000000615";
    const revised = SECOND_POST.replace("Most people", "Too many people");
    const report = await runCoworkOutcomeScenario({
      id: "direct-refine-creator-style",
      request: {
        message: "Make this draft more direct.",
        operation: {
          kind: "edit_artifact",
          artifactId: targetId,
          instruction: "Make this draft more direct.",
        },
        creatorStyleId: CREATOR_STYLE.id,
      },
      seed: {
        creatorStyle: CREATOR_STYLE,
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Distribution",
          body: SECOND_POST,
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: revised,
            finishReason: "stop",
            usage: usage(180, 82, 0.00016),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [revised],
        actionNames: [],
        route: "direct_writer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.persisted.artifacts[0]?.id).toBe(targetId);
  });

  test("an edit with an unresolved target clarifies instead of drafting or answering", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "refine-missing-target",
      request: {
        message: "Make this draft sharper.",
        operation: {
          kind: "edit_artifact",
          artifactId: "00000000-0000-4000-8000-000000000999",
          instruction: "Make this draft sharper.",
        },
      },
      model: {
        provider: { rounds: [] },
        // Supplies the ready voice fixture; the response must remain unused.
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(90, 20, 0.00008),
          },
        ],
      },
      expected: {
        terminal: "ask",
        artifactBodies: [],
        actionNames: ["ask_user"],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
  });

  test("a clear writing request fails before execution when voice is unavailable", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "direct-original-no-voice",
      request: {
        message:
          "Write an original post in my voice about why a personal brand is career leverage.",
      },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [],
          disabled: true,
          voiceUnavailable: true,
        },
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

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.agentProviderRounds).toBe(0);
    expect(report.observed.directWriterRequests).toHaveLength(0);
  });

  test("a typed review operation cannot be reinterpreted as an edit", async () => {
    const targetId = "00000000-0000-4000-8000-000000000620";
    const feedback = "The opening is clear; the final paragraph needs a firmer point.";
    const report = await runCoworkOutcomeScenario({
      id: "typed-review-not-edit",
      request: {
        message: "Make it punchier.",
        operation: { kind: "review_artifact", artifactId: targetId },
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Career leverage",
          body: COMPLETE_POST,
        },
      },
      model: { provider: textProvider(feedback) },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        assistantContents: [feedback],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.persisted.artifacts).toHaveLength(0);
  });

  test("an Ask command cannot be reinterpreted as Create by any wording", async () => {
    const answer = "I can help you choose an angle before you create the post.";
    const report = await runCoworkOutcomeScenario({
      id: "command-ask-denies-create-wording",
      request: {
        message: "Write three new posts and replace the current one.",
        command: { kind: "ask" },
      },
      model: {
        provider: textProvider(answer),
        directWriter: [{
          text: COMPLETE_POST,
          finishReason: "stop",
          usage: usage(180, 82, 0.00016),
        }],
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: [],
        assistantContents: [answer],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
    expect(report.observed.readOnlyPlannerRequests).toHaveLength(0);
  });

  test("an Ask starter may research but still cannot emit a post", async () => {
    const answer = "Five evidence-backed angles are ready to explore.";
    const report = await runCoworkOutcomeScenario({
      id: "command-ask-read-only-research",
      request: {
        message: "Write five posts immediately.",
        command: { kind: "ask" },
        starterId: "brainstorm",
      },
      model: {
        provider: { rounds: [] },
        readOnlyOrchestrator: {
          plans: [],
          groundedAnswer: { content: answer, usage: usage(80, 35, 0.0002) },
          toolResults: {
            search_viral_posts: [
              {
                ok: true,
                count: MODELED_FIVE_SOURCE_ROWS.length,
                posts: [...MODELED_FIVE_SOURCE_ROWS],
              },
            ],
          },
        },
        directWriter: [{
          text: COMPLETE_POST,
          finishReason: "stop",
          usage: usage(180, 82, 0.00016),
        }],
      },
      expected: {
        terminal: "done",
        artifactBodies: [],
        actionNames: ["search_viral_posts"],
        assistantContents: [answer],
        route: "read_only_orchestrator",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
  });

  test("a pending Ask clarification preserves Ask authority on its answer turn", async () => {
    const missingPostId = "00000000-0000-4000-8000-000000000629";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "command-ask-missing-context",
        request: {
          message: "Review this post.",
          command: { kind: "ask", contextPostId: missingPostId },
        },
        model: { provider: { rounds: [] }, directWriter: [] },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
          route: "answer",
        },
      },
      {
        id: "command-ask-missing-context-answer",
        request: {
          message: "Ask without a Post",
          clarificationChoiceIndex: 0,
        },
        model: {
          provider: textProvider("I can review the idea without a Post attached."),
          directWriter: [
            {
              text: COMPLETE_POST,
              finishReason: "stop",
              usage: usage(180, 82, 0.00016),
            },
            {
              text: SECOND_POST,
              finishReason: "stop",
              usage: usage(170, 70, 0.00014),
            },
          ],
        },
        expected: {
          terminal: "done",
          artifactBodies: [],
          actionNames: [],
          route: "answer",
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[1]?.observed.directWriterRequests).toHaveLength(0);
    expect(sequence.attempts[1]?.observed.readOnlyPlannerRequests).toHaveLength(0);
  });

  test("a stale Ask card cannot answer the latest pending command", async () => {
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "command-ask-owner-binding-pending",
        request: {
          message: "Review this Post.",
          command: {
            kind: "ask",
            contextPostId: "00000000-0000-4000-8000-000000000636",
          },
        },
        model: { provider: { rounds: [] }, directWriter: [] },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
          route: "answer",
        },
      },
      {
        id: "command-ask-owner-binding-stale",
        request: {
          message: "Ask without a Post",
          clarificationChoiceIndex: 0,
          clarificationAssistantMessageId:
            "00000000-0000-4000-8000-000000000637",
        },
        model: {
          provider: { rounds: [] },
          directWriter: [
            {
              text: COMPLETE_POST,
              finishReason: "stop",
              usage: usage(180, 82, 0.00016),
            },
          ],
        },
        expected: {
          terminal: "failure",
          httpStatus: 409,
          artifactBodies: [],
          actionNames: [],
        },
      },
    ]);

    expect(sequence.pass, JSON.stringify(sequence.attempts)).toBe(true);
    expect(sequence.attempts[1]?.observed.directWriterRequests).toHaveLength(0);
  });

  test("an Edit clarification can bind the saved command to the latest Post", async () => {
    const latestId = "00000000-0000-4000-8000-000000000633";
    const missingId = "00000000-0000-4000-8000-000000000634";
    const sequence = await runCoworkOutcomeSequence([
      {
        id: "command-edit-missing-target",
        request: {
          message: "Make the opening sharper.",
          command: {
            kind: "edit",
            targetPostId: missingId,
            scope: "full_post",
          },
        },
        seed: {
          messageArtifact: {
            id: latestId,
            kind: "post",
            title: "Current",
            body: COMPLETE_POST,
          },
        },
        model: { provider: { rounds: [] }, directWriter: [] },
        expected: {
          terminal: "ask",
          artifactBodies: [],
          actionNames: ["ask_user"],
          route: "answer",
        },
      },
      {
        id: "command-edit-latest-target-answer",
        request: {
          message: "Edit the latest chat Post",
          clarificationChoiceIndex: 0,
        },
        model: {
          provider: { rounds: [] },
          directWriter: [
            {
              text: SECOND_POST,
              finishReason: "stop",
              usage: usage(190, 88, 0.00018),
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
    expect(sequence.attempts[1]?.persisted.artifacts).toEqual([
      expect.objectContaining({ id: latestId, body: SECOND_POST }),
    ]);
  });

  test("a Create command produces its exact count despite review wording", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "command-create-denies-review-wording",
      request: {
        message: "Review the current post and tell me whether it works.",
        command: { kind: "create", count: 2 },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: COMPLETE_POST,
            finishReason: "stop",
            usage: usage(180, 82, 0.00016),
          },
          {
            text: SECOND_POST,
            finishReason: "stop",
            usage: usage(170, 70, 0.00014),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [COMPLETE_POST, SECOND_POST],
        actionNames: [],
        route: "direct_writer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(2);
  });

  test("an Edit command updates only its target despite feedback wording", async () => {
    const targetId = "00000000-0000-4000-8000-000000000624";
    const report = await runCoworkOutcomeScenario({
      id: "command-edit-denies-ask-wording",
      request: {
        message: "Tell me what you think about the opening.",
        command: {
          kind: "edit",
          targetPostId: targetId,
          scope: "full_post",
        },
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Current Post",
          body: COMPLETE_POST,
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [{
          text: SECOND_POST,
          finishReason: "stop",
          usage: usage(180, 82, 0.00016),
        }],
      },
      expected: {
        terminal: "done",
        artifactBodies: [SECOND_POST],
        actionNames: [],
        route: "direct_writer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.persisted.artifacts).toHaveLength(1);
    expect(report.persisted.artifacts[0]?.id).toBe(targetId);
  });

  test("an Edit command rejects a Hook target instead of mutating it", async () => {
    const targetId = "00000000-0000-4000-8000-000000000635";
    const report = await runCoworkOutcomeScenario({
      id: "command-edit-rejects-hook-target",
      request: {
        message: "Rewrite this.",
        command: {
          kind: "edit",
          targetPostId: targetId,
          scope: "full_post",
        },
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "hook",
          title: "Current Hook",
          body: "A short opening hook.",
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: SECOND_POST,
            finishReason: "stop",
            usage: usage(180, 82, 0.00016),
          },
        ],
      },
      expected: {
        terminal: "ask",
        artifactBodies: [],
        actionNames: ["ask_user"],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
  });

  test("a targetless typed review clarifies instead of guessing an Artifact", async () => {
    const report = await runCoworkOutcomeScenario({
      id: "typed-review-missing-target",
      request: {
        message: "Review the post.",
        operation: { kind: "review_artifact" },
      },
      seed: {
        messageArtifact: {
          id: "00000000-0000-4000-8000-000000000623",
          kind: "post",
          title: "Current Artifact",
          body: COMPLETE_POST,
        },
      },
      model: {
        provider: textProvider("This response must not be generated."),
        directWriter: [{
          text: SECOND_POST,
          finishReason: "stop",
          usage: usage(180, 82, 0.00016),
        }],
      },
      expected: {
        terminal: "ask",
        artifactBodies: [],
        actionNames: ["ask_user"],
        route: "answer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.observed.directWriterRequests).toHaveLength(0);
    expect(report.observed.agentProviderRounds).toBe(0);
  });

  test("Retry restores the original typed artifact target after a newer artifact appears", async () => {
    const originalTargetId = "00000000-0000-4000-8000-000000000621";
    const newerTargetId = "00000000-0000-4000-8000-000000000622";
    const instruction = "Make Draft 1 punchier.";
    const failed: CoworkOutcomeScenario = {
      id: "typed-edit-target-retry-failed",
      request: {
        message: instruction,
        operation: {
          kind: "edit_artifact",
          artifactId: originalTargetId,
          instruction,
        },
      },
      seed: {
        messageArtifacts: [
          {
            id: originalTargetId,
            kind: "post",
            title: "Original target",
            body: COMPLETE_POST,
          },
          {
            id: newerTargetId,
            kind: "post",
            title: "Newer artifact",
            body: SECOND_POST,
          },
        ],
      },
      model: {
        provider: { rounds: [] },
        directWriter: Array.from({ length: 4 }, () => ({
          text: "",
          finishReason: "stop" as const,
          usage: usage(100, 0, 0.0001),
        })),
      },
      expected: {
        terminal: "failure",
        artifactBodies: [],
        actionNames: [],
      },
    };
    const revised = COMPLETE_POST.replace(
      "Building a personal brand",
      "A personal brand",
    );
    const recovered: CoworkOutcomeScenario = {
      id: "typed-edit-target-retry-recovered",
      retryLatestUser: true,
      request: {
        message: instruction,
        // Simulate a client heuristic now pointing at the newer visible card.
        // Retry must still replay the server-persisted original operation.
        operation: {
          kind: "edit_artifact",
          artifactId: newerTargetId,
          instruction,
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: revised,
            finishReason: "stop",
            usage: usage(180, 82, 0.00016),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [revised],
        actionNames: [],
        route: "direct_writer",
      },
    };

    const sequence = await runCoworkOutcomeSequence([failed, recovered]);

    expect(
      sequence.pass,
      JSON.stringify(
        sequence.attempts.map((attempt) => ({
          safe: attempt.safe,
          failures: attempt.failureCodes,
        })),
      ),
    ).toBe(true);
    expect(sequence.attempts[1]?.persisted.artifacts[0]?.id).toBe(
      originalTargetId,
    );
  });

  test("a typed create operation overrides conflicting legacy edit fields", async () => {
    const legacyTargetId = "00000000-0000-4000-8000-000000000630";
    const report = await runCoworkOutcomeScenario({
      id: "typed-create-authoritative",
      request: {
        message: "Write an original post in my voice about durable systems.",
        operation: { kind: "create_post" },
        skipDecision: true,
        refineTargetId: legacyTargetId,
        refineInstruction: "Replace the old draft.",
      },
      seed: {
        messageArtifact: {
          id: legacyTargetId,
          kind: "post",
          title: "Old draft",
          body: SECOND_POST,
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
        route: "direct_writer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.persisted.artifacts[0]?.id).not.toBe(legacyTargetId);
  });

  test("an explicit general edit mode overrides conflicting legacy hook-only fields", async () => {
    const targetId = "00000000-0000-4000-8000-000000000634";
    const report = await runCoworkOutcomeScenario({
      id: "typed-general-edit-authoritative",
      request: {
        message: "Make this stronger.",
        operation: {
          kind: "edit_artifact",
          artifactId: targetId,
          instruction: "Make this stronger.",
          editMode: "general",
        },
        hookOnly: true,
        hookOnlyOriginalBody: COMPLETE_POST,
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Original target",
          body: COMPLETE_POST,
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: SECOND_POST,
            finishReason: "stop",
            usage: usage(180, 82, 0.00016),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [SECOND_POST],
        actionNames: [],
        route: "direct_writer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.persisted.artifacts[0]?.id).toBe(targetId);
  });

  test("a typed edit without an edit mode ignores conflicting legacy hook fields", async () => {
    const targetId = "00000000-0000-4000-8000-000000000635";
    const report = await runCoworkOutcomeScenario({
      id: "typed-edit-ignores-legacy-hook-mode",
      request: {
        message: "Make this stronger.",
        operation: {
          kind: "edit_artifact",
          artifactId: targetId,
          instruction: "Make this stronger.",
        },
        hookOnly: true,
        hookOnlyOriginalBody: COMPLETE_POST,
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Original target",
          body: COMPLETE_POST,
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [{
          text: SECOND_POST,
          finishReason: "stop",
          usage: usage(180, 82, 0.00016),
        }],
      },
      expected: {
        terminal: "done",
        artifactBodies: [SECOND_POST],
        actionNames: [],
        route: "direct_writer",
      },
    });

    expect(report.pass, JSON.stringify(report.safe)).toBe(true);
    expect(report.persisted.artifacts[0]?.id).toBe(targetId);
  });

  test("fails closed before generation when typed operation persistence fails", async () => {
    const targetId = "00000000-0000-4000-8000-000000000631";
    const report = await runCoworkOutcomeScenario({
      id: "typed-operation-marker-write-failure",
      request: {
        message: "Make Draft 1 punchier.",
        operation: {
          kind: "edit_artifact",
          artifactId: targetId,
          instruction: "Make Draft 1 punchier.",
        },
      },
      seed: {
        messageArtifact: {
          id: targetId,
          kind: "post",
          title: "Original target",
          body: COMPLETE_POST,
        },
      },
      model: {
        provider: { rounds: [] },
        turnOperationMarkerPersistenceFails: true,
        directWriter: [
          {
            text: SECOND_POST,
            finishReason: "stop",
            usage: usage(180, 82, 0.00016),
          },
        ],
      },
      expected: {
        terminal: "failure",
        httpStatus: 503,
        artifactBodies: [],
        actionNames: [],
        assistantContents: [
          "I couldn’t save the turn operation safely, so the request was not executed. Send it again as a new message.",
        ],
      },
    });

    expect(
      report.pass,
      JSON.stringify({
        safe: report.safe,
        failures: report.failureCodes,
        assistant: report.persisted.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content),
      }),
    ).toBe(true);
    expect(report.observed.directWriterRequests).toEqual([]);
  });

  test("Retry preserves hook-only edit mode and the original target atomically", async () => {
    const originalTargetId = "00000000-0000-4000-8000-000000000632";
    const newerTargetId = "00000000-0000-4000-8000-000000000633";
    const instruction = "Make this stronger.";
    const failed: CoworkOutcomeScenario = {
      id: "typed-hook-only-retry-failed",
      request: {
        message: instruction,
        operation: {
          kind: "edit_artifact",
          artifactId: originalTargetId,
          instruction,
          editMode: "hook_only",
        },
      },
      seed: {
        messageArtifacts: [
          {
            id: originalTargetId,
            kind: "post",
            title: "Original target",
            body: COMPLETE_POST,
          },
          {
            id: newerTargetId,
            kind: "post",
            title: "Newer target",
            body: THIRD_POST,
          },
        ],
      },
      model: {
        provider: { rounds: [] },
        directWriter: Array.from({ length: 4 }, () => ({
          text: "",
          finishReason: "stop" as const,
          usage: usage(100, 0, 0.0001),
        })),
      },
      expected: {
        terminal: "failure",
        artifactBodies: [],
        actionNames: [],
      },
    };
    const expectedBody = splicePreservedBody(COMPLETE_POST, SECOND_POST);
    const recovered: CoworkOutcomeScenario = {
      id: "typed-hook-only-retry-recovered",
      retryLatestUser: true,
      request: {
        message: instruction,
        operation: {
          kind: "edit_artifact",
          artifactId: newerTargetId,
          instruction,
        },
      },
      model: {
        provider: { rounds: [] },
        directWriter: [
          {
            text: SECOND_POST,
            finishReason: "stop",
            usage: usage(180, 82, 0.00016),
          },
        ],
      },
      expected: {
        terminal: "done",
        artifactBodies: [expectedBody],
        actionNames: [],
        route: "direct_writer",
      },
    };

    const sequence = await runCoworkOutcomeSequence([failed, recovered]);

    expect(sequence.pass, JSON.stringify(sequence.attempts.map((a) => a.safe))).toBe(true);
    expect(sequence.attempts[1]?.persisted.artifacts[0]?.id).toBe(originalTargetId);
  });

});

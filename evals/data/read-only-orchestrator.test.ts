import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "@/lib/agent/contracts";

// Freshness-relative fixture date for news results: the executor filters
// news by age (NEWS_MAX_AGE_DAYS, default 14) against the REAL clock, so a
// hardcoded published_at silently goes stale — 2026-07-14 fixtures passed
// on 2026-07-27 and failed CI the next day.
const freshDate = (daysAgo = 3): string =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
import type { WriterInput } from "@/lib/agent/execute/writer";
import type { ExecuteModeledDraftBatchInput } from "@/lib/agent/execute/writer";
import {
  CHAT_MODEL,
  UsagePersistenceError,
  type ChatMessage,
  type Usage,
} from "@/lib/openrouter";
import {
  FALLBACK_READ_ONLY_ORCHESTRATOR_MODEL,
  PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
  PRIMARY_WEB_RESEARCH_MODEL,
  ReadOnlyPlanSchema,
  authoritativeResearchQuery,
  inspectAttachmentEvidence,
  parseReadOnlyPlan,
  planSearchQueriesMatchInstruction,
  runGroundedWebResearch,
  runReadOnlyOrchestrator,
  type ReadOnlyOrchestratorDependencies,
  type ReadOnlyOrchestratorInput,
  type ReadOnlyPlannerRequest,
} from "@/lib/agent/execute/agent";
import { AdapterHealthRegistry } from "@/lib/agent/adapter-health";
import { createCoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import {
  wrapScrapedPostText,
  type ToolExecutionContext,
} from "@/lib/agent/tools";
import { compileReadOnlyOrchestratorRoute } from "@/lib/agent/turn/compile";
import { continuationForModeledDraftRoute } from "@/lib/agent/modeled-draft-continuation";

/**
 * Test-only stand-ins for the LLM read-only planner adapter interface removed
 * from lib/agent/read-only-orchestrator.ts (production plans are always
 * server-compiled — see compileServerReadOnlyPlan). ScriptedPlanner below is
 * inert: runReadOnlyOrchestrator never reads a dependency-injected planner,
 * so these types exist only to keep ScriptedPlanner's shape self-documenting.
 */
type TestReadOnlyPlannerRequest = {
  route: unknown;
  userInstruction: string;
  history: ChatMessage[];
  attachmentNames: string[];
  signal?: AbortSignal;
};

type ReadOnlyOrchestratorAdapter = {
  readonly model: string;
  createPlan(request: TestReadOnlyPlannerRequest): Promise<{
    toolArgs: Record<string, unknown> | null;
    usage?: Usage;
    model?: string;
  }>;
};

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const COMPLETE_POST = [
  "The newest product announcement is not the lesson.",
  "",
  "The lesson is how quickly a useful workflow becomes table stakes once the interface gets easier.",
  "",
  "Founders should study the behavior change, not repeat the press release. Build around the job customers can now finish faster.",
].join("\n");

const usage = (input: number, output: number): Usage => ({
  prompt_tokens: input,
  completion_tokens: output,
  cost: 0.001,
});

class ScriptedPlanner implements ReadOnlyOrchestratorAdapter {
  readonly requests: ReadOnlyPlannerRequest[] = [];

  constructor(
    readonly model: string,
    private readonly script: Array<
      | { toolArgs: Record<string, unknown> | null; usage?: Usage }
      | Error
    >,
  ) {}

  async createPlan(request: ReadOnlyPlannerRequest) {
    this.requests.push(request);
    const step = this.script.shift();
    if (!step) throw new Error("planner script exhausted");
    if (step instanceof Error) throw step;
    return step;
  }
}

function input(
  overrides: Partial<ReadOnlyOrchestratorInput> = {},
): ReadOnlyOrchestratorInput {
  return {
    workspaceId: "ws-1",
    turnMessageId: "root-user-message-1",
    userInstruction:
      "Research the latest OpenAI announcement and write a LinkedIn post about what it means for founders.",
    history: [
      {
        role: "user",
        content:
          "Research the latest OpenAI announcement and write a LinkedIn post about what it means for founders.",
      },
    ],
    route: { kind: "news_research", outcome: { kind: "draft", expectedDrafts: 1 } },
    attachmentNames: [],
    attachmentBlocks: [],
    writerInput: {
      workspaceId: "ws-1",
      userInstruction:
        "Research the latest OpenAI announcement and write a LinkedIn post about what it means for founders.",
      voiceResult: { ok: true, voice: { summary: "Direct and useful." } },
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
    },
    ...overrides,
  };
}

async function* successfulDraft(
  draftInput: WriterInput,
): AsyncGenerator<AgentEvent> {
  expect(draftInput.task).toMatchObject({ kind: "grounded" });
  yield {
    type: "artifact",
    artifact: {
      id: "draft-grounded",
      kind: "post",
      title: "Draft",
      body: COMPLETE_POST,
    },
  };
  yield {
    type: "done",
    terminalReason: "done",
    message: {
      content: "Here’s your draft.",
      tool_calls: null,
      artifacts: [],
      toolMessages: [],
      inputTokens: 210,
      outputTokens: 95,
    },
  };
}

async function collect(
  orchestratorInput: ReadOnlyOrchestratorInput,
  _adapters: ReadOnlyOrchestratorAdapter[],
  runTool: (
    name: string,
    args: Record<string, unknown>,
    workspaceId: string,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ) => Promise<Record<string, unknown>>,
  dependencyOverrides: Partial<ReadOnlyOrchestratorDependencies> = {},
) {
  const events: AgentEvent[] = [];
  const recorded: unknown[][] = [];
  const draftInputs: WriterInput[] = [];
  for await (const event of runReadOnlyOrchestrator(orchestratorInput, {
    runTool,
    runProse: (draftInput) => {
      draftInputs.push(draftInput);
      return successfulDraft(draftInput);
    },
    recordUsage: vi.fn(async (...args: unknown[]) => {
      recorded.push(args);
    }),
    idFactory: (() => {
      let n = 0;
      return () => `orchestrator_${++n}`;
    })(),
    ...dependencyOverrides,
  })) {
    events.push(event);
  }
  return { events, recorded, draftInputs };
}

describe("read-only orchestrator plan contract", () => {
  test("primary follows the one app-wide chat model; fallback is independent", () => {
    // Normalized: the orchestrator primary defaults to OPENROUTER_CHAT_MODEL so
    // every text-LLM call uses the SAME model. The fallback stays its own model.
    expect(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL).toBe(CHAT_MODEL);
    expect(FALLBACK_READ_ONLY_ORCHESTRATOR_MODEL).toBe(
      "google/gemini-3.5-flash",
    );
  });

  test("source-selection routes always show modelable cards and stop before drafting", async () => {
    const posts = Array.from({ length: 5 }, (_, index) => ({
      id: `${index + 1}0000000-0000-4000-8000-000000000000`,
      text: wrapScrapedPostText({
        text: [
          `Candidate ${index + 1} has a useful opening line.`,
          "",
          "This source has enough concrete prose to expose a real structure, a meaningful setup, a clear progression, and a conclusion worth adapting without copying any claims or personal details from the original author into the user's new post.",
        ].join("\n"),
      }).text,
      post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${index + 1}`,
      reactions: 500 - index,
      comments: 40 - index,
      media_type: "image",
      media_urls: [`https://media.example/candidate-${index + 1}.jpg`],
      visual_kind: "graphic",
      accounts: {
        name: `Author ${index + 1}`,
        niche: "B2B SaaS",
        profile_pic_url: `https://media.example/author-${index + 1}.jpg`,
      },
    }));
    const shortPosts = Array.from({ length: 5 }, (_, index) => ({
      id: `9000000${index}-0000-4000-8000-000000000000`,
      text: wrapScrapedPostText({ text: "Too short to model well." }).text,
      post_url: `https://www.linkedin.com/posts/short-${index + 1}`,
      accounts: { name: `Short Author ${index + 1}` },
    }));
    const runTool = vi.fn(async () => ({
      ok: true,
      posts: [...shortPosts, ...posts],
    }));

    const result = await collect(
      input({
        userInstruction:
          "Find a top-performing regular post in my swipe file and rewrite it in my voice.",
        route: {
          kind: "workspace_research",
          outcome: {
            kind: "source_selection",
            candidateCount: 5,
            searchPoolSize: 10,
          },
          minimumSources: 3,
          workspacePostType: "regular",
          workspaceSearchMode: "strict_top",
        },
      }),
      [],
      runTool,
    );

    expect(result.draftInputs).toHaveLength(0);
    expect(runTool).toHaveBeenCalledWith(
      "search_viral_posts",
      expect.objectContaining({ limit: 10, post_type: "regular" }),
      "ws-1",
      expect.any(AbortSignal),
      expect.objectContaining({
        autoSelectModelingSources: true,
        requireModelableSources: true,
        includeSourceCardMedia: true,
      }),
    );
    const ask = result.events.find((event) => event.type === "ask");
    expect(ask).toMatchObject({
      type: "ask",
      ask: {
        question: "Which post should I model?",
        allowOther: false,
      },
    });
    if (ask?.type !== "ask") throw new Error("Expected source selection ask");
    expect(ask.ask.options).toHaveLength(5);
    expect(ask.ask.choiceIds).toHaveLength(5);
    expect(ask.ask.choiceIds?.[0]).toBe(
      "model-source:10000000-0000-4000-8000-000000000000",
    );
    expect(ask.ask.options).toEqual([
      "Post 1",
      "Post 2",
      "Post 3",
      "Post 4",
      "Post 5",
    ]);
    expect(JSON.stringify(ask.ask)).not.toContain("Author 1");
    expect(JSON.stringify(ask.ask)).not.toContain("useful opening line");
    expect(
      result.events
        .filter(
          (event): event is Extract<AgentEvent, { type: "plan_update" }> =>
            event.type === "plan_update",
        )
        .flatMap((event) =>
          event.steps
            .filter((step) => step.status === "active")
            .map((step) => step.label),
        ),
    ).toContain("Selecting distinct, model-ready posts");

    const done = result.events.findLast((event) => event.type === "done");
    expect(done).toMatchObject({
      type: "done",
      terminalReason: "ask",
      message: {
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            kind: "cite",
            meta: expect.objectContaining({
              postId: "10000000-0000-4000-8000-000000000000",
              card: expect.objectContaining({
                id: "10000000-0000-4000-8000-000000000000",
                authorName: "Author 1",
                mediaType: "image",
                mediaUrls: ["https://media.example/candidate-1.jpg"],
              }),
            }),
          }),
        ]),
      },
    });
    if (done?.type !== "done") throw new Error("Expected completed ask");
    expect(JSON.stringify(done.message.toolMessages)).not.toContain(
      "media.example",
    );
  });

  test("web research rejects uncited prose and switches providers for grounded citations", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const requestedModels: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const native = String(_url).includes("api.openai.com");
        requestedModels.push(native ? `openai/${body.model}` : body.model);
        if (requestedModels.length === 1) {
          return Response.json(native ? {
            model: body.model,
            status: "completed",
            output_text: "A plausible answer with no citation.",
            output: [],
            usage: { input_tokens: 20, output_tokens: 10 },
          } : {
            choices: [
              {
                message: { content: "A plausible answer with no citation." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          });
        }
        return Response.json({
          choices: [
            {
              message: {
                content: "Grounded answer.",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      url: "https://example.com/research",
                      title: "Primary research",
                      content: "Verified evidence from the source.",
                    },
                  },
                ],
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        });
      }),
    );

    const result = await runGroundedWebResearch({
      query: "B2B pricing strategy evidence",
    });

    expect(requestedModels).toEqual([
      PRIMARY_WEB_RESEARCH_MODEL,
      FALLBACK_READ_ONLY_ORCHESTRATOR_MODEL,
    ]);
    expect(result.attempts).toHaveLength(2);
    expect(result.sources).toEqual([
      {
        id: "https://example.com/research",
        kind: "web",
        title: "Primary research",
        url: "https://example.com/research",
        text: "Verified evidence from the source.",
      },
    ]);
    expect(JSON.stringify(result.sources)).not.toContain("plausible answer");
  });

  test("web research accepts grounded prose when URL annotations omit optional excerpts", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const requestedModels: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const native = String(_url).includes("api.openai.com");
        requestedModels.push(native ? `openai/${body.model}` : body.model);
        return Response.json(native ? {
          model: body.model,
          status: "completed",
          output_text:
            "Model Context Protocol is an open standard for connecting AI applications to external systems.",
          output: [{
            type: "message",
            content: [{
              type: "output_text",
              text: "Model Context Protocol is an open standard for connecting AI applications to external systems.",
              annotations: [{
                type: "url_citation",
                url: "https://modelcontextprotocol.io/docs/getting-started/intro",
                title: "What is the Model Context Protocol?",
              }],
            }],
          }],
          usage: { input_tokens: 30, output_tokens: 12 },
        } : {
          choices: [
            {
              message: {
                content:
                  "Model Context Protocol is an open standard for connecting AI applications to external systems.",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      url: "https://modelcontextprotocol.io/docs/getting-started/intro",
                      title: "What is the Model Context Protocol?",
                    },
                  },
                ],
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        });
      }),
    );

    const result = await runGroundedWebResearch({
      query: "official definition of Model Context Protocol",
    });

    expect(requestedModels).toEqual([PRIMARY_WEB_RESEARCH_MODEL]);
    expect(result.sources).toEqual([
      {
        id: "https://modelcontextprotocol.io/docs/getting-started/intro",
        kind: "web",
        title: "What is the Model Context Protocol?",
        url: "https://modelcontextprotocol.io/docs/getting-started/intro",
        text: "Model Context Protocol is an open standard for connecting AI applications to external systems.",
      },
    ]);
  });

  test("web research never attributes one combined review to multiple excerptless sources", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        const native = String(_url).includes("api.openai.com");
        return Response.json(native ? {
          model: "gpt-5.6-luna",
          status: "completed",
          output_text: "Source A supports one claim. Source B supports another claim.",
          output: [{
            type: "message",
            content: [{
              type: "output_text",
              text: "Source A supports one claim. Source B supports another claim.",
              annotations: [
                { type: "url_citation", url: "https://example.com/source-a", title: "Source A" },
                { type: "url_citation", url: "https://example.com/source-b", title: "Source B" },
              ],
            }],
          }],
          usage: { input_tokens: 30, output_tokens: 12 },
        } : {
          choices: [
            {
              message: {
                content:
                  "Source A supports one claim. Source B supports another claim.",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      url: "https://example.com/source-a",
                      title: "Source A",
                    },
                  },
                  {
                    type: "url_citation",
                    url_citation: {
                      url: "https://example.com/source-b",
                      title: "Source B",
                    },
                  },
                ],
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        });
      }),
    );

    const result = await runGroundedWebResearch({
      query: "compare the evidence from source A and source B",
    });

    expect(requestBodies).toHaveLength(2);
    expect(result.sources).toEqual([]);
  });

  test("web research tells the search model to ignore instructions in source pages", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    let systemPrompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        systemPrompt = String(body.messages?.[0]?.content ?? "");
        return Response.json({
          choices: [
            {
              message: {
                content: "Verified evidence.",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      url: "https://example.com/source",
                      title: "Source",
                      content: "Verified evidence.",
                    },
                  },
                ],
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        });
      }),
    );

    await runGroundedWebResearch({ query: "safe research" });

    expect(systemPrompt).toMatch(/untrusted (?:content|data)/i);
    expect(systemPrompt).toMatch(/ignore (?:any )?(?:instructions|directives)/i);
  });

  test("text attachment inspection stays deterministic and preserves its source name", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await inspectAttachmentEvidence({
      userInstruction: "Inspect the interview and write a post.",
      attachmentNames: ["interview.txt"],
      attachmentBlocks: [
        {
          type: "text",
          text: [
            "--- ATTACHED FILE: interview.txt ---",
            "The customer could not see the next onboarding step.",
            "--- END FILE ---",
          ].join("\n"),
        },
      ],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.attempts).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.sources).toEqual([
      expect.objectContaining({
        kind: "attachment",
        title: "interview.txt",
        text: expect.stringContaining("next onboarding step"),
      }),
    ]);
  });

  test("an already-cancelled web research stage never invokes primary or fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runGroundedWebResearch({
        query: "unused",
        signal: controller.signal,
        adapterHealth: new AdapterHealthRegistry(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("cancellation during primary web research never invokes fallback", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runGroundedWebResearch({
        query: "unused",
        signal: controller.signal,
        adapterHealth: new AdapterHealthRegistry(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("an already-cancelled attachment stage never invokes primary or fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      inspectAttachmentEvidence({
        userInstruction: "Inspect this file.",
        attachmentNames: ["brief.pdf"],
        attachmentBlocks: [
          {
            type: "file",
            file: {
              filename: "brief.pdf",
              file_data: "data:application/pdf;base64,BRIEF",
            },
          },
        ],
        signal: controller.signal,
        adapterHealth: new AdapterHealthRegistry(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an image skipped by the vision cap is not accepted as attachment evidence", async () => {
    const result = await inspectAttachmentEvidence({
      userInstruction: "Inspect the attached image and write a post.",
      attachmentNames: ["screen.png"],
      attachmentBlocks: [
        {
          type: "text",
          text: [
            "--- ATTACHED IMAGE (not described): screen.png ---",
            "Image attached but skipped vision analysis this turn.",
            "--- END IMAGE ---",
          ].join("\n"),
        },
      ],
    });

    expect(result.complete).toBe(false);
    expect(result.sources).toEqual([]);
  });

  test("rejects duplicate attachment filenames before paid inspection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await inspectAttachmentEvidence({
      userInstruction: "Inspect both reports and write a post.",
      attachmentNames: ["report.pdf", "report.pdf"],
      attachmentBlocks: [
        {
          type: "file",
          file: {
            filename: "report.pdf",
            file_data: "data:application/pdf;base64,FIRST",
          },
        },
        {
          type: "file",
          file: {
            filename: "REPORT.PDF",
            file_data: "data:application/pdf;base64,SECOND",
          },
        },
      ],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ sources: [], attempts: [], complete: false });
  });

  test("rejects filenames that collide after safe display normalization", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await inspectAttachmentEvidence({
      userInstruction: "Inspect both reports and write a post.",
      attachmentNames: ["report—.pdf", "report—.pdf"],
      attachmentBlocks: [
        {
          type: "file",
          file: {
            filename: "report---.pdf",
            file_data: "data:application/pdf;base64,FIRST",
          },
        },
        {
          type: "file",
          file: {
            filename: "report—.pdf",
            file_data: "data:application/pdf;base64,SECOND",
          },
        },
      ],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ sources: [], attempts: [], complete: false });
  });

  test("multi-file inspection falls back and remains incomplete unless every file is covered", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (url: string) => {
      const args = JSON.stringify({
        evidence: [
          {
            sourceName: "brief.pdf",
            claim: "The brief names onboarding as the bottleneck.",
            supportingExcerpt: "Onboarding remains the bottleneck.",
          },
        ],
      });
      return Response.json(String(url).includes("api.openai.com") ? {
        model: "gpt-5.6-luna",
        status: "completed",
        output_text: "",
        output: [{
          type: "function_call",
          call_id: "call_1",
          name: "report_attachment_evidence",
          arguments: args,
        }],
        usage: { input_tokens: 40, output_tokens: 15 },
      } : {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "report_attachment_evidence",
                    arguments: args,
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 15 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await inspectAttachmentEvidence({
      userInstruction: "Inspect both files and write a post.",
      attachmentNames: ["brief.pdf", "notes.pdf"],
      attachmentBlocks: [
        {
          type: "file",
          file: {
            filename: "brief.pdf",
            file_data: "data:application/pdf;base64,BRIEF",
          },
        },
        {
          type: "file",
          file: {
            filename: "notes.pdf",
            file_data: "data:application/pdf;base64,NOTES",
          },
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.complete).toBe(false);
    expect(result.sources).toEqual([
      expect.objectContaining({ title: "brief.pdf" }),
    ]);
  });

  test("groups multiple claims by file so a comparison cannot drop a requested attachment", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    function: {
                      name: "report_attachment_evidence",
                      arguments: JSON.stringify({
                        evidence: [
                          {
                            sourceName: "brief.pdf",
                            claim: "The brief names onboarding as the bottleneck.",
                            supportingExcerpt: "Onboarding remains the bottleneck.",
                          },
                          {
                            sourceName: "brief.pdf",
                            claim: "The brief recommends a checklist.",
                            supportingExcerpt: "Use a five-step checklist.",
                          },
                          {
                            sourceName: "notes.pdf",
                            claim: "The notes recommend guided setup.",
                            supportingExcerpt: "Guide every customer through setup.",
                          },
                        ],
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 60, completion_tokens: 30 },
        }),
      ),
    );

    const result = await inspectAttachmentEvidence({
      userInstruction: "Compare both files.",
      attachmentNames: ["brief.pdf", "notes.pdf"],
      attachmentBlocks: [
        {
          type: "file",
          file: {
            filename: "brief.pdf",
            file_data: "data:application/pdf;base64,BRIEF",
          },
        },
        {
          type: "file",
          file: {
            filename: "notes.pdf",
            file_data: "data:application/pdf;base64,NOTES",
          },
        },
      ],
    });

    expect(result.complete).toBe(true);
    expect(result.sources).toHaveLength(2);
    expect(result.sources).toEqual([
      expect.objectContaining({
        title: "brief.pdf",
        text: expect.stringContaining("five-step checklist"),
      }),
      expect.objectContaining({
        title: "notes.pdf",
        text: expect.stringContaining("guided setup"),
      }),
    ]);
  });

  test("does not require query matching for plans with no external query", () => {
    const plan = parseReadOnlyPlan(
      {
        kind: "file_inspection",
        outcome: { kind: "draft", expectedDrafts: 1 },
        allowExternalSearch: false,
      },
      {
        actions: [
          { id: "inspect", type: "inspect_attachments" },
          {
            id: "write",
            type: "draft_post",
            evidenceActionIds: ["inspect"],
          },
        ],
      },
    );
    expect(planSearchQueriesMatchInstruction(plan, "AI")).toBe(true);
  });

  test("rejects external search when an attachment request forbids it", () => {
    expect(() =>
      parseReadOnlyPlan(
        {
          kind: "file_inspection",
          outcome: { kind: "draft", expectedDrafts: 1 },
          allowExternalSearch: false,
        },
        {
          actions: [
            { id: "inspect", type: "inspect_attachments" },
            { id: "search", type: "search_web", query: "AI evidence" },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["inspect", "search"],
            },
          ],
        },
      ),
    ).toThrow(/forbids search/i);
  });

  test("rejects repeated all-file inspection actions", () => {
    expect(() =>
      parseReadOnlyPlan(
        {
          kind: "file_inspection",
          outcome: { kind: "draft", expectedDrafts: 1 },
          allowExternalSearch: false,
        },
        {
          actions: [
            { id: "inspect_a", type: "inspect_attachments" },
            { id: "inspect_b", type: "inspect_attachments" },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["inspect_a", "inspect_b"],
            },
          ],
        },
      ),
    ).toThrow(/inspect/i);
  });

  test.each(["search_news", "search_web"] as const)(
    "rejects repeated %s actions in a file plan",
    (searchType) => {
      expect(() =>
        parseReadOnlyPlan(
          {
            kind: "file_inspection",
            outcome: { kind: "draft", expectedDrafts: 1 },
            allowExternalSearch: true,
            allowedSearchKinds: [searchType === "search_news" ? "news" : "web"],
          },
          {
            actions: [
              { id: "inspect", type: "inspect_attachments" },
              { id: "search_a", type: searchType, query: "OpenAI evidence" },
              { id: "search_b", type: searchType, query: "OpenAI evidence" },
              {
                id: "write",
                type: "draft_post",
                evidenceActionIds: ["inspect", "search_a", "search_b"],
              },
            ],
          },
        ),
      ).toThrow(/inspect|search/i);
    },
  );

  test("rejects both unrequested and omitted searches in a file plan", () => {
    expect(() =>
      parseReadOnlyPlan(
        {
          kind: "file_inspection",
          outcome: { kind: "draft", expectedDrafts: 1 },
          allowedSearchKinds: [],
        },
        {
          actions: [
            { id: "inspect", type: "inspect_attachments" },
            { id: "search", type: "search_web", query: "OpenAI evidence" },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["inspect", "search"],
            },
          ],
        },
      ),
    ).toThrow(/not requested|forbids/i);

    expect(() =>
      parseReadOnlyPlan(
        {
          kind: "file_inspection",
          outcome: { kind: "draft", expectedDrafts: 1 },
          allowedSearchKinds: ["news"],
        },
        {
          actions: [
            { id: "inspect", type: "inspect_attachments" },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["inspect"],
            },
          ],
        },
      ),
    ).toThrow(/requires search_news/i);
  });

  test("rejects a file-plus-workspace plan below the requested source count", () => {
    expect(() =>
      parseReadOnlyPlan(
        {
          kind: "file_inspection",
          outcome: { kind: "draft", expectedDrafts: 1 },
          allowedSearchKinds: ["workspace"],
          minimumSources: 5,
          workspaceSearchMode: "strict_top",
        },
        {
          actions: [
            { id: "inspect", type: "inspect_attachments" },
            {
              id: "sources",
              type: "search_viral_posts",
              niche: "SaaS",
              limit: 2,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["inspect", "sources"],
            },
          ],
        },
      ),
    ).toThrow(/at least 5 workspace sources/i);
  });

  test("does not expose any field where a model can return the finished post", () => {
    expect(
      ReadOnlyPlanSchema.safeParse({
        actions: [
          { id: "news", type: "search_news", query: "OpenAI announcement" },
          {
            id: "write",
            type: "draft_post",
            evidenceActionIds: ["news"],
            body: COMPLETE_POST,
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects post prose disguised as a clarification question or option", () => {
    expect(
      ReadOnlyPlanSchema.safeParse({
        actions: [
          {
            id: "clarify",
            type: "clarify",
            question:
              "What should I create?\n\nPricing is not a number. It is the story positioning tells before sales begins?",
            options: ["A LinkedIn post", "A complete post. With prose"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects a workspace plan whose limits cannot satisfy the requested source count", () => {
    expect(() =>
      parseReadOnlyPlan(
        {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 3,
        },
        {
          actions: [
            {
              id: "sources",
              type: "search_viral_posts",
              niche: "SaaS",
              limit: 2,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
      ),
    ).toThrow(/at least 3 sources/i);
  });

  test("rejects a planner-authored workspace window that the user did not request", () => {
    expect(() =>
      parseReadOnlyPlan(
        {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 3,
        },
        {
          actions: [
            {
              id: "sources",
              type: "search_viral_posts",
              niche: "SaaS",
              since: "1d",
              limit: 3,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
      ),
    ).toThrow(/time window/i);
  });

  test("rejects an action sequence that does not match the deterministic route", () => {
    expect(() =>
      parseReadOnlyPlan(
        { kind: "news_research", outcome: { kind: "draft", expectedDrafts: 1 } },
        {
          actions: [
            { id: "search", type: "search_viral_posts", limit: 3 },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["search"],
            },
          ],
        },
      ),
    ).toThrow(/news/i);
  });

  test("rejects search queries that drift away from the authoritative request", () => {
    const plan = parseReadOnlyPlan(
      { kind: "news_research", outcome: { kind: "draft", expectedDrafts: 1 } },
      {
        actions: [
          { id: "news", type: "search_news", query: "cryptocurrency prices" },
          {
            id: "write",
            type: "draft_post",
            evidenceActionIds: ["news"],
          },
        ],
      },
    );
    expect(
      planSearchQueriesMatchInstruction(
        plan,
        "Research the latest OpenAI announcement and write a post.",
      ),
    ).toBe(false);
  });

  test("rejects a workspace niche unrelated to the authoritative request", () => {
    const plan = parseReadOnlyPlan(
      {
        kind: "workspace_research",
        outcome: { kind: "draft", expectedDrafts: 1 },
        minimumSources: 3,
      },
      {
        actions: [
          {
            id: "sources",
            type: "search_viral_posts",
            niche: "cryptocurrency",
            limit: 3,
          },
          {
            id: "write",
            type: "draft_post",
            evidenceActionIds: ["sources"],
          },
        ],
      },
    );
    expect(
      planSearchQueriesMatchInstruction(
        plan,
        "Find three viral SaaS posts and write one post about pricing.",
      ),
    ).toBe(false);
  });

  test("rejects a workspace niche that adds drift to an overlapping term", () => {
    const plan = parseReadOnlyPlan(
      {
        kind: "workspace_research",
        outcome: { kind: "draft", expectedDrafts: 1 },
        minimumSources: 3,
      },
      {
        actions: [
          {
            id: "sources",
            type: "search_viral_posts",
            niche: "B2B cryptocurrency",
            limit: 3,
          },
          {
            id: "write",
            type: "draft_post",
            evidenceActionIds: ["sources"],
          },
        ],
      },
    );
    expect(
      planSearchQueriesMatchInstruction(
        plan,
        "Find three viral B2B SaaS posts and write one post about pricing.",
      ),
    ).toBe(false);
  });

  test("binds a workspace niche across sentence-separated research and writing clauses", () => {
    const request =
      "Find three viral SaaS posts. Write one post about pricing.";
    const valid = parseReadOnlyPlan(
      {
        kind: "workspace_research",
        outcome: { kind: "draft", expectedDrafts: 1 },
        minimumSources: 3,
      },
      {
        actions: [
          {
            id: "sources",
            type: "search_viral_posts",
            niche: "SaaS",
            limit: 3,
          },
          {
            id: "write",
            type: "draft_post",
            evidenceActionIds: ["sources"],
          },
        ],
      },
    );
    const writingTopicAsNiche = parseReadOnlyPlan(
      {
        kind: "workspace_research",
        outcome: { kind: "draft", expectedDrafts: 1 },
        minimumSources: 3,
      },
      {
        actions: [
          {
            id: "sources",
            type: "search_viral_posts",
            niche: "pricing",
            limit: 3,
          },
          {
            id: "write",
            type: "draft_post",
            evidenceActionIds: ["sources"],
          },
        ],
      },
    );

    expect(planSearchQueriesMatchInstruction(valid, request)).toBe(true);
    expect(planSearchQueriesMatchInstruction(writingTopicAsNiche, request)).toBe(
      false,
    );
  });

  test("requires the planner to preserve an explicit workspace source niche", () => {
    const plan = parseReadOnlyPlan(
      {
        kind: "workspace_research",
        outcome: { kind: "draft", expectedDrafts: 1 },
        minimumSources: 3,
      },
      {
        actions: [
          { id: "sources", type: "search_viral_posts", limit: 3 },
          {
            id: "write",
            type: "draft_post",
            evidenceActionIds: ["sources"],
          },
        ],
      },
    );

    expect(
      planSearchQueriesMatchInstruction(
        plan,
        "Find three viral SaaS posts and write one post about pricing.",
      ),
    ).toBe(false);
  });

  test("keeps an output-first research niche separate from the next writing sentence", () => {
    const request =
      "Write one LinkedIn post after finding three viral SaaS posts. Make it about pricing.";
    const planFor = (niche: string) =>
      parseReadOnlyPlan(
        {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 3,
        },
        {
          actions: [
            {
              id: "sources",
              type: "search_viral_posts",
              niche,
              limit: 3,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
      );

    expect(planSearchQueriesMatchInstruction(planFor("SaaS"), request)).toBe(
      true,
    );
    expect(planSearchQueriesMatchInstruction(planFor("pricing"), request)).toBe(
      false,
    );
  });

  test("allows a cross-niche workspace search from bookmarks", () => {
    const plan = parseReadOnlyPlan(
      {
        kind: "workspace_research",
        outcome: { kind: "draft", expectedDrafts: 1 },
        minimumSources: 3,
      },
      {
        actions: [
          { id: "sources", type: "search_viral_posts", limit: 3 },
          {
            id: "write",
            type: "draft_post",
            evidenceActionIds: ["sources"],
          },
        ],
      },
    );

    expect(
      planSearchQueriesMatchInstruction(
        plan,
        "Find three viral posts from my bookmarks and write one LinkedIn post.",
      ),
    ).toBe(true);
  });

  test.each([
    "Write one post after finding three of the best viral posts.",
    "Find three top-performing posts and write one LinkedIn post.",
    "Find three high performing posts and write one LinkedIn post.",
    "Find three highest-engagement posts from my bookmarks and write one LinkedIn post.",
    "Find three viral posts for inspiration and write one LinkedIn post.",
    "Find three original LinkedIn posts and write one LinkedIn post.",
  ])("does not invent a niche from generic source-ranking language: %s", (request) => {
    const plan = parseReadOnlyPlan(
      {
        kind: "workspace_research",
        outcome: { kind: "draft", expectedDrafts: 1 },
        minimumSources: 3,
      },
      {
        actions: [
          { id: "sources", type: "search_viral_posts", limit: 3 },
          {
            id: "write",
            type: "draft_post",
            evidenceActionIds: ["sources"],
          },
        ],
      },
    );

    expect(planSearchQueriesMatchInstruction(plan, request)).toBe(true);
  });

  test("preserves founders as an explicit workspace niche", () => {
    const request =
      "Find three viral posts about founders and write one LinkedIn post about pricing.";
    const planFor = (niche?: string) =>
      parseReadOnlyPlan(
        {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 3,
        },
        {
          actions: [
            {
              id: "sources",
              type: "search_viral_posts",
              ...(niche ? { niche } : {}),
              limit: 3,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
      );

    expect(
      planSearchQueriesMatchInstruction(planFor("founders"), request),
    ).toBe(true);
    expect(planSearchQueriesMatchInstruction(planFor(), request)).toBe(false);
  });

  test("cuts a same-sentence output-first writing continuation from the niche", () => {
    const request =
      "Write one post after finding three viral SaaS posts, then make it about pricing.";
    const planFor = (niche: string) =>
      parseReadOnlyPlan(
        {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 3,
        },
        {
          actions: [
            {
              id: "sources",
              type: "search_viral_posts",
              niche,
              limit: 3,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
      );

    expect(planSearchQueriesMatchInstruction(planFor("SaaS"), request)).toBe(
      true,
    );
    expect(planSearchQueriesMatchInstruction(planFor("pricing"), request)).toBe(
      false,
    );
  });

  test("allows a cross-niche workspace search when no source niche was requested", () => {
    const plan = parseReadOnlyPlan(
      {
        kind: "workspace_research",
        outcome: { kind: "draft", expectedDrafts: 1 },
        minimumSources: 3,
      },
      {
        actions: [
          {
            id: "sources",
            type: "search_viral_posts",
            limit: 3,
          },
          {
            id: "write",
            type: "draft_post",
            evidenceActionIds: ["sources"],
          },
        ],
      },
    );

    expect(
      planSearchQueriesMatchInstruction(
        plan,
        "Find three posts from my swipe file and write one post about pricing.",
      ),
    ).toBe(true);
  });
});

describe("read-only orchestrator execution", () => {
  test("compiles the exact newsjacking request into search_news then draft_post without a planner", async () => {
    const instruction =
      "Newsjack the most significant AI product announcement from the last 24 hours. Search the web and verify the event with current sources, then write one original LinkedIn post in my voice connecting it to what founders should do differently. Return one complete post.";
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      new Error("the deterministic news route must not invoke a planner"),
    ]);
    const runTool = vi.fn(
      async (name: string, args: Record<string, unknown>) => {
        void name;
        void args;
        return {
          ok: true,
          max_age_days: 14,
          searched: 1,
          results: [
            {
              title: "A verified AI product announcement",
              url: "https://example.com/verified-announcement",
              published_at: freshDate(),
              summary: "A current, verified product announcement.",
            },
          ],
        };
      },
    );

    const result = await collect(
      input({
        userInstruction: instruction,
        history: [{ role: "user", content: instruction }],
        writerInput: {
          ...input().writerInput,
          userInstruction: instruction,
        },
      }),
      [planner],
      runTool,
    );

    expect(planner.requests).toHaveLength(0);
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0][0]).toBe("search_news");
    expect(runTool.mock.calls[0][1]).toEqual({
      query: authoritativeResearchQuery(instruction),
    });
    expect(result.draftInputs).toHaveLength(1);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "artifact",
        artifact: expect.objectContaining({ kind: "post" }),
      }),
    );
  });

  test("aborts the entire complex lane at one route-wide deadline", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      new Error("the server-compiled route must not invoke a planner"),
    ]);
    const result = await collect(
      input({ route: { kind: "web_research", outcome: { kind: "draft", expectedDrafts: 1 } } }),
      [planner],
      vi.fn(async () => ({ ok: false })),
      {
        turnDeadlineMs: 5,
        runWebResearch: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("deadline", "AbortError")),
            { once: true },
          );
        }),
      },
    );

    expect(planner.requests).toHaveLength(0);
    const done = result.events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.terminalReason).toBe("deadline");
    expect(done?.type === "done" && done.message.content).toMatch(
      /reliable time limit/i,
    );
    expect(result.draftInputs).toHaveLength(0);
  });

  test("aborts an in-flight workspace research executor at the route deadline", async () => {
    const instruction =
      "Find the top two posts from my swipe file and write a LinkedIn post about pricing.";
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            { id: "sources", type: "search_viral_posts", limit: 2 },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);
    const result = await collect(
      input({
        userInstruction: instruction,
        history: [{ role: "user", content: instruction }],
        route: {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 2,
          workspaceSearchMode: "strict_top",
        },
        writerInput: {
          ...input().writerInput,
          userInstruction: instruction,
        },
      }),
      [planner],
      (_name, _args, _workspaceId, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("deadline", "AbortError")),
            { once: true },
          );
        }),
      { turnDeadlineMs: 5 },
    );

    expect(result.draftInputs).toHaveLength(0);
    expect(result.events.some((event) => event.type === "artifact")).toBe(false);
    const done = result.events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.terminalReason).toBe("deadline");
    expect(done?.type === "done" && done.message.content).toMatch(
      /reliable time limit/i,
    );
  });

  test("dispatches the original authoritative niche and server-owned strict ranking", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            {
              id: "sources",
              type: "search_viral_posts",
              niche: "AI SaaS",
              limit: 2,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);
    const dispatched: Record<string, unknown>[] = [];
    const result = await collect(
      input({
        route: {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 2,
          workspaceSearchMode: "strict_top",
        },
        userInstruction:
          "Find the top two AI & SaaS posts and write one LinkedIn post.",
      }),
      [planner],
      async (_name, args) => {
        dispatched.push(args);
        return {
          ok: true,
          posts: [
            { id: "a", text: "First verified post." },
            { id: "b", text: "Second verified post." },
          ],
        };
      },
    );

    expect(dispatched).toEqual([
      {
        niche: "AI & SaaS",
        sort: "viral",
        dir: "desc",
        strict_ranking: true,
        limit: 2,
      },
    ]);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_start",
        name: "search_viral_posts",
        args: JSON.stringify({
          niche: "AI & SaaS",
          sort: "viral",
          dir: "desc",
          strict_ranking: true,
          limit: 2,
        }),
      }),
    );
  });

  test("returns a grounded swipe-file summary with a read-only source citation and no draft", async () => {
    const instruction =
      "Find one top-performing regular post in my swipe file about AI agents and summarize why it worked. Do not draft or rewrite.";
    const synthesizeGroundedAnswer = vi.fn(async () => ({
      content:
        "The strongest post used a concrete AI-agent failure as its hook, then converted it into a practical three-step lesson.",
      model: CHAT_MODEL,
      usage: usage(80, 35),
    }));

    const result = await collect(
      input({
        userInstruction: instruction,
        history: [{ role: "user", content: instruction }],
        route: {
          kind: "workspace_research",
          minimumSources: 1,
          workspaceSearchMode: "strict_top",
          workspacePostType: "regular",
          outcome: {
            kind: "grounded_answer",
            format: "summary",
            resultCount: 1,
          },
        },
        writerInput: {
          ...input().writerInput,
          userInstruction: instruction,
        },
      }),
      [],
      async () => ({
        ok: true,
        posts: [
          {
            id: "10000000-0000-4000-8000-000000000001",
            text: "AI agents fail when teams confuse permission with instruction.",
            post_url: "https://www.linkedin.com/posts/top-ai-agent-post",
            reactions: 840,
            comments: 96,
          },
          {
            id: "10000000-0000-4000-8000-000000000002",
            text: "A second verified AI-agent post.",
            reactions: 510,
            comments: 42,
          },
        ],
      }),
      { synthesizeGroundedAnswer },
    );

    expect(synthesizeGroundedAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction,
        format: "summary",
        sourcePresentation: "structured_workspace",
        evidence: [
          expect.objectContaining({
            id: "10000000-0000-4000-8000-000000000001",
            text: "AI agents fail when teams confuse permission with instruction.",
            url: "https://www.linkedin.com/posts/top-ai-agent-post",
            metrics: expect.objectContaining({ reactions: 840, comments: 96 }),
          }),
        ],
      }),
    );
    expect(result.draftInputs).toHaveLength(0);
    expect(result.events.some((event) => event.type === "artifact")).toBe(false);
    expect(
      result.events.some(
        (event) =>
          event.type === "plan_update" &&
          event.steps.some(
            (step) =>
              step.status === "active" &&
              step.label === "Synthesizing the verified findings",
          ),
      ),
    ).toBe(true);
    const done = result.events.find((event) => event.type === "done");
    expect(done).toMatchObject({
      type: "done",
      message: {
        content:
          "The strongest post used a concrete AI-agent failure as its hook, then converted it into a practical three-step lesson.",
        artifacts: [
          {
            id: "grounded-source:10000000-0000-4000-8000-000000000001",
            kind: "cite",
            title: "Verified source post",
            body: "",
            meta: {
              postId: "10000000-0000-4000-8000-000000000001",
              presentation: "grounded_answer_source",
              sourceUrl: "https://www.linkedin.com/posts/top-ai-agent-post",
            },
          },
        ],
      },
    });
  });

  test("closes grounded synthesis progress when summarization fails", async () => {
    const instruction =
      "Find one top-performing post in my swipe file and summarize why it worked.";
    const result = await collect(
      input({
        userInstruction: instruction,
        route: {
          kind: "workspace_research",
          minimumSources: 1,
          workspaceSearchMode: "strict_top",
          outcome: {
            kind: "grounded_answer",
            format: "summary",
            resultCount: 1,
          },
        },
      }),
      [],
      async () => ({
        ok: true,
        posts: [{ id: "grounded-source", text: "A verified source post." }],
      }),
      {
        synthesizeGroundedAnswer: vi.fn(async () => {
          throw new Error("synthesis unavailable");
        }),
      },
    );

    const synthesisUpdates = result.events.filter(
      (event): event is Extract<AgentEvent, { type: "plan_update" }> =>
        event.type === "plan_update" &&
        event.steps.some(
          (step) => step.label === "Synthesizing the verified findings",
        ),
    );
    expect(
      synthesisUpdates.some((event) =>
        event.steps.some(
          (step) =>
            step.status === "active" &&
            step.label === "Synthesizing the verified findings",
        ),
      ),
    ).toBe(true);
    expect(
      synthesisUpdates.at(-1)?.steps.every((step) => step.status === "done"),
    ).toBe(true);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "grounded_answer_failed",
      }),
    );
  });

  test("fails a grounded answer honestly when verified workspace evidence is unavailable", async () => {
    const instruction =
      "Find one top-performing regular post in my swipe file about AI agents and summarize why it worked. Do not draft or rewrite.";
    const result = await collect(
      input({
        userInstruction: instruction,
        route: {
          kind: "workspace_research",
          outcome: {
            kind: "grounded_answer",
            format: "summary",
            resultCount: 1,
          },
          minimumSources: 1,
          workspaceSearchMode: "strict_top",
          workspacePostType: "regular",
        },
      }),
      [],
      async () => ({ ok: true, posts: [] }),
    );

    expect(result.events.some((event) => event.type === "artifact")).toBe(false);
    const done = result.events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.message.content).toBe(
      "I couldn’t retrieve enough verified evidence to answer this request.",
    );
  });

  test("does not synthesize a partial grounded comparison when fewer sources exist than requested", async () => {
    const instruction =
      "Find 4 top posts in my swipe file, but don't rewrite them; just compare them.";
    const synthesizeGroundedAnswer = vi.fn();
    const result = await collect(
      input({
        userInstruction: instruction,
        route: {
          kind: "workspace_research",
          outcome: {
            kind: "grounded_answer",
            format: "comparison",
            resultCount: 4,
          },
          minimumSources: 4,
          workspaceSearchMode: "strict_top",
        },
      }),
      [],
      async () => ({
        ok: true,
        posts: [
          { id: "one", text: "First verified post." },
          { id: "two", text: "Second verified post." },
        ],
      }),
      { synthesizeGroundedAnswer },
    );

    expect(synthesizeGroundedAnswer).not.toHaveBeenCalled();
    const done = result.events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.message.content).toBe(
      "I found only 2 of the 4 verified sources you requested, so I did not return an incomplete comparison.",
    );
  });

  test("logs how many raw search_viral_posts rows were dropped as unusable candidates", async () => {
    // Live incident: a workspace has posts classified viral with a NULL body
    // (a real scraping/ingestion gap) — normalizeModelingSourceCandidate
    // correctly drops them via workspaceSources()'s flatMap, but until this
    // fix there was no visibility into that drop, so "search succeeded but
    // produced zero usable sources" was undiagnosable from logs alone.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            {
              id: "sources",
              type: "search_viral_posts",
              niche: "AI SaaS",
              limit: 2,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);
    await collect(
      input({
        route: {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 1,
          workspaceSearchMode: "strict_top",
        },
        userInstruction: "Find the top AI & SaaS post and write one LinkedIn post.",
      }),
      [planner],
      async () => ({
        ok: true,
        posts: [
          { id: "usable-1", text: "A real post with real content." },
          { id: "null-body", text: null },
          { id: "", text: "Has text but a blank id" },
        ],
      }),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("search_viral_posts_candidates_dropped"),
    );
    const logged = warnSpy.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes("search_viral_posts_candidates_dropped"));
    const parsed = JSON.parse(logged!);
    expect(parsed.search_viral_posts_candidates_dropped).toMatchObject({
      raw_count: 3,
      usable_count: 1,
      dropped_count: 2,
    });
    warnSpy.mockRestore();
  });

  test("records successful and failed direct research-tool stages safely", async () => {
    const validPlan = () =>
      new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
        {
          toolArgs: {
            actions: [
              {
                id: "news",
                type: "search_news",
                query: "OpenAI announcement",
              },
              {
                id: "write",
                type: "draft_post",
                evidenceActionIds: ["news"],
              },
            ],
          },
          usage: usage(80, 20),
        },
      ]);
    const successSink = vi.fn();
    const successTelemetry = createCoworkTurnTelemetry(
      {
        traceId: "research-success",
        workspaceId: "ws-1",
        route: "read_only_orchestrator",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      successSink,
    );
    const adapterHealth = new AdapterHealthRegistry();
    const toolContexts: Array<ToolExecutionContext | undefined> = [];
    await collect(
      input({ telemetry: successTelemetry }),
      [validPlan()],
      async (_name, _args, _workspaceId, _signal, context) => {
        toolContexts.push(context);
        return {
          ok: true,
          results: [
            {
              title: "OpenAI announcement",
              url: "https://openai.com/news/announcement",
              published_at: freshDate(),
              summary: "OpenAI announced a product update.",
            },
          ],
        };
      },
      { adapterHealth },
    );
    successTelemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 1 },
      provenanceStatus: "verified",
      terminalOutcome: "delivered",
    });
    expect(successSink.mock.calls[0][0].stage_attempts).toContainEqual(
      expect.objectContaining({
        stage: "research_search_news",
        provider: "server",
        outcome: "accepted",
      }),
    );
    expect(toolContexts).toEqual([
      {
        telemetry: successTelemetry,
        adapterHealth,
        deadlineAtMs: expect.any(Number),
      },
    ]);

    const failureSink = vi.fn();
    const failureTelemetry = createCoworkTurnTelemetry(
      {
        traceId: "research-failed",
        workspaceId: "ws-1",
        route: "read_only_orchestrator",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      failureSink,
    );
    const failed = await collect(
      input({ telemetry: failureTelemetry }),
      [validPlan()],
      async () => ({ ok: false, error: "private provider response" }),
    );
    failureTelemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 0 },
      provenanceStatus: "missing",
      terminalOutcome: "recoverable_error",
    });
    expect(failed.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "orchestrator_action_failed",
      }),
    );
    expect(failureSink.mock.calls[0][0].stage_attempts).toContainEqual(
      expect.objectContaining({
        stage: "research_search_news",
        provider: "server",
        outcome: "failed",
        reason_code: "research_search_news_failed",
      }),
    );
    expect(JSON.stringify(failureSink.mock.calls[0][0])).not.toContain(
      "private provider response",
    );
  });

  test("does not convert evidence usage persistence failure into a recoverable terminal", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            { id: "research", type: "search_web", query: "B2B pricing" },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["research"],
            },
          ],
        },
        usage: usage(80, 20),
      },
    ]);
    await expect(
      collect(
        input({
          route: { kind: "web_research", outcome: { kind: "draft", expectedDrafts: 1 } },
          userInstruction:
            "Research B2B pricing and write a LinkedIn post about it.",
        }),
        [planner],
        vi.fn(async () => ({ ok: false })),
        {
          runWebResearch: async () => ({
            attempts: [
              {
                model: "anthropic/claude-haiku-4.5",
                usage: usage(100, 20),
              },
            ],
            sources: [
              {
                id: "https://example.com/pricing",
                kind: "web",
                title: "Pricing evidence",
                url: "https://example.com/pricing",
                text: "A verified pricing finding.",
              },
            ],
          }),
          recordUsage: vi.fn(async () => {
            throw new UsagePersistenceError("evidence usage insert failed");
          }),
        },
      ),
    ).rejects.toThrow("evidence usage insert failed");
  });

  test("does not swallow authoritative usage failure from the grounded writer", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            { id: "news", type: "search_news", query: "OpenAI announcement" },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["news"],
            },
          ],
        },
        usage: usage(80, 20),
      },
    ]);

    await expect(
      collect(
        input(),
        [planner],
        async () => ({
          ok: true,
          max_age_days: 14,
          results: [
            {
              title: "OpenAI announcement",
              url: "https://openai.com/news/announcement",
              published_at: freshDate(),
              summary: "OpenAI announced a product update.",
            },
          ],
        }),
        {
          runProse: async function* () {
            throw new UsagePersistenceError("writer usage insert failed");
          },
        },
      ),
    ).rejects.toThrow("writer usage insert failed");
  });

  test("fails closed when news search returns no verified fresh result", async () => {
    const events: AgentEvent[] = [];
    const runProse = vi.fn(successfulDraft);
    for await (const event of runReadOnlyOrchestrator(input(), {
      runTool: async () => ({
        ok: true,
        max_age_days: 14,
        searched: 4,
        results: [],
        note: "No fresh news. Do not invent or use older news.",
      }),
      runProse,
      recordUsage: vi.fn(async () => {}),
      idFactory: () => "fixed",
    })) {
      events.push(event);
    }

    expect(runProse).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "artifact")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "orchestrator_evidence_unavailable",
        recovery: "continue",
      }),
    );
    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.message.content).toMatch(/fresh/i);
  });

  test("does not draft when attachment inspection is only partially complete", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            { id: "inspect", type: "inspect_attachments" },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["inspect"],
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);

    const result = await collect(
      input({
        route: {
          kind: "file_inspection",
          outcome: { kind: "draft", expectedDrafts: 1 },
          allowExternalSearch: false,
        },
        userInstruction: "Inspect the attached file and write a post. Do not search.",
        attachmentNames: ["brief.pdf", "screen.png"],
      }),
      [planner],
      vi.fn(async () => ({ ok: false })),
      {
        inspectAttachments: async () => ({
          attempts: [],
          complete: false,
          sources: [
            {
              id: "brief",
              kind: "attachment",
              title: "brief.pdf",
              text: "One file was inspected, but the image was skipped.",
            },
          ],
        }),
      },
    );

    expect(result.draftInputs).toHaveLength(0);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "orchestrator_evidence_unavailable",
      }),
    );
  });

  test("persists completed evidence calls when a later read-only action throws", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      new Error("the server-compiled route must not invoke a planner"),
    ]);
    const result = await collect(
      input({
        route: {
          kind: "file_inspection",
          outcome: { kind: "draft", expectedDrafts: 1 },
          allowExternalSearch: true,
          allowedSearchKinds: ["web"],
        },
        userInstruction:
          "Inspect the attached pricing brief, verify it on the web, and write one post.",
        attachmentNames: ["pricing-brief.pdf"],
      }),
      [planner],
      vi.fn(async () => ({ ok: false })),
      {
        inspectAttachments: async () => ({
          attempts: [],
          complete: true,
          sources: [
            {
              id: "pricing-brief.pdf",
              kind: "attachment",
              title: "Pricing brief",
              text: "A verified pricing lesson from the attached brief.",
            },
          ],
        }),
        runWebResearch: async () => {
          throw new Error("search unavailable");
        },
      },
    );

    expect(result.draftInputs).toHaveLength(0);
    const done = result.events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.message.tool_calls).toHaveLength(2);
    expect(done?.type === "done" && done.message.toolMessages).toHaveLength(2);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "orchestrator_action_failed",
      }),
    );
  });

  test("database cancellation stops after a completed research boundary and preserves it", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            { id: "news", type: "search_news", query: "OpenAI announcement" },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["news"],
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);
    let cancelRequested = false;
    const result = await collect(
      input({
        cancellationProbe: async () => cancelRequested,
      }),
      [planner],
      async () => {
        cancelRequested = true;
        return {
          ok: true,
          max_age_days: 14,
          results: [
            {
              title: "OpenAI announcement",
              url: "https://openai.com/news/announcement",
              published_at: freshDate(),
              summary: "OpenAI announced a product update.",
            },
          ],
        };
      },
    );

    expect(result.draftInputs).toHaveLength(0);
    const done = result.events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.terminalReason).toBe("cancelled");
    expect(done?.type === "done" && done.message.tool_calls).toHaveLength(1);
    expect(done?.type === "done" && done.message.toolMessages).toHaveLength(1);
  });

  test("counts completed writer tokens when database cancellation wins the delivery boundary", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            { id: "news", type: "search_news", query: "OpenAI announcement" },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["news"],
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);
    let cancelRequested = false;
    const result = await collect(
      input({ cancellationProbe: async () => cancelRequested }),
      [planner],
      async () => ({
        ok: true,
        max_age_days: 14,
        results: [
          {
            title: "OpenAI announcement",
            url: "https://openai.com/news/announcement",
            published_at: freshDate(),
            summary: "OpenAI announced a product update.",
          },
        ],
      }),
      {
        runProse: async function* () {
          yield {
            type: "artifact",
            artifact: {
              id: "cancelled-draft",
              kind: "post",
              title: "Draft",
              body: COMPLETE_POST,
            },
          };
          cancelRequested = true;
          yield {
            type: "done",
            terminalReason: "done",
            message: {
              content: "Here’s your draft.",
              tool_calls: null,
              artifacts: [],
              toolMessages: [],
              inputTokens: 321,
              outputTokens: 123,
            },
          };
        },
      },
    );

    expect(result.events.some((event) => event.type === "artifact")).toBe(false);
    const done = result.events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.terminalReason).toBe("cancelled");
    expect(done?.type === "done" && done.message).toMatchObject({
      inputTokens: 321,
      outputTokens: 123,
    });
  });

  test("classifies cancellation correctly when an executor absorbs AbortError", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            { id: "news", type: "search_news", query: "OpenAI announcement" },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["news"],
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);
    let cancelRequested = false;
    const result = await collect(
      input({ cancellationProbe: async () => cancelRequested }),
      [planner],
      async () => {
        cancelRequested = true;
        return { ok: false, error: "request aborted" };
      },
    );

    expect(result.draftInputs).toHaveLength(0);
    expect(
      result.events.some(
        (event) =>
          event.type === "error" &&
          event.code === "orchestrator_evidence_unavailable",
      ),
    ).toBe(false);
    const done = result.events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.terminalReason).toBe("cancelled");
  });

  test("a writer exception presents drafts completed before the failure with an honest message", async () => {
    // The buffered artifact came through the engine's artifact channel, which
    // only carries finalizer-accepted drafts — dropping it would lose accepted
    // work and leave the chat text claiming nothing exists. Present it instead.
    const events: AgentEvent[] = [];
    for await (const event of runReadOnlyOrchestrator(input(), {
      runTool: async () => ({
        ok: true,
        max_age_days: 14,
        results: [
          {
            title: "OpenAI announcement",
            url: "https://openai.com/news/announcement",
            published_at: freshDate(),
            summary: "OpenAI announced a product update.",
          },
        ],
      }),
      runProse: async function* () {
        yield {
          type: "artifact",
          artifact: {
            id: "partial",
            kind: "post",
            title: "Partial",
            body: "This accepted draft survives the crash.",
          },
        };
        throw new Error("writer disconnected");
      },
      recordUsage: vi.fn(async () => {}),
      idFactory: (() => {
        let id = 0;
        return () => `call-${++id}`;
      })(),
    })) {
      events.push(event);
    }

    const artifacts = events.filter((event) => event.type === "artifact");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      type: "artifact",
      artifact: { id: "partial" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "orchestrator_writer_failed",
      }),
    );
    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.message.content).toContain(
      "had already completed safely",
    );
    expect(done?.type === "done" && done.message.tool_calls).toHaveLength(2);
    expect(done?.type === "done" && done.message.toolMessages).toHaveLength(2);
  });

  test("fails closed when fewer distinct workspace sources return than requested", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            {
              id: "sources",
              type: "search_viral_posts",
              niche: "SaaS",
              limit: 3,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);
    const result = await collect(
      input({
        route: {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 3,
        },
        userInstruction:
          "Find three viral SaaS posts and write one post about pricing.",
      }),
      [planner],
      async () => ({
        ok: true,
        posts: [
          { id: "a", text: "One lesson." },
          { id: "b", text: "Another lesson." },
        ],
      }),
    );

    expect(result.draftInputs).toHaveLength(0);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "orchestrator_evidence_insufficient",
      }),
    );
  });

  test("hands verified multi-source evidence to the draft engine and preserves provenance", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            {
              id: "sources",
              type: "search_viral_posts",
              niche: "SaaS",
              limit: 3,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);
    const result = await collect(
      input({
        route: {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 3,
        },
        userInstruction:
          "Find three viral SaaS posts, compare their patterns, and write one original post about pricing.",
      }),
      [planner],
      async () => ({
        ok: true,
        count: 3,
        posts: [
          { id: "post-a", text: "A pricing lesson.", url: "https://linkedin.com/a" },
          { id: "post-b", text: "A positioning lesson.", url: "https://linkedin.com/b" },
          { id: "post-c", text: "A packaging lesson.", url: "https://linkedin.com/c" },
        ],
      }),
    );

    const task = result.draftInputs[0]?.task;
    expect(task?.kind === "grounded" && task.sources).toEqual([
      expect.objectContaining({ id: "post-a", kind: "workspace_post" }),
      expect.objectContaining({ id: "post-b", kind: "workspace_post" }),
      expect.objectContaining({ id: "post-c", kind: "workspace_post" }),
    ]);
    const artifact = result.events.find((event) => event.type === "artifact");
    expect(artifact?.type === "artifact" && artifact.artifact.meta).toMatchObject({
      research_provenance: {
        route: "workspace_research",
        sources: [
          expect.objectContaining({ id: "post-a", url: "https://linkedin.com/a" }),
          expect.objectContaining({ id: "post-b", url: "https://linkedin.com/b" }),
          expect.objectContaining({ id: "post-c", url: "https://linkedin.com/c" }),
        ],
      },
    });
  });

  test("stamps meta.explicit_post_type on the artifact when the route carries a genuine user choice", async () => {
    // The reported bug: selecting REGULAR explicitly, then writing original
    // posts whose body legitimately discusses lead magnets as a topic, must
    // not let classifyPost()'s body-text regex reclassify the saved draft.
    // taggedWithResearchProvenance is the choke point that has to carry the
    // route's explicitPostType through to the artifact the client saves.
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            {
              id: "sources",
              type: "search_viral_posts",
              niche: "SaaS",
              limit: 2,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);
    const result = await collect(
      input({
        route: {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 2,
          explicitPostType: "regular",
        },
        userInstruction:
          "Find 2 top posts and write an original post about why lead magnets work, in my voice.",
      }),
      [planner],
      async () => ({
        ok: true,
        count: 2,
        posts: [
          { id: "post-a", text: "A pricing lesson.", url: "https://linkedin.com/a" },
          { id: "post-b", text: "A positioning lesson.", url: "https://linkedin.com/b" },
        ],
      }),
    );

    const artifact = result.events.find((event) => event.type === "artifact");
    expect(artifact?.type === "artifact" && artifact.artifact.meta).toMatchObject({
      explicit_post_type: "regular",
    });
  });

  test("does not stamp meta.explicit_post_type when the route has no genuine user choice", async () => {
    // The default (no starter, no Generation Settings pick) case must be
    // byte-identical to before this field existed — no explicit_post_type
    // in meta, so the client continues to auto-classify from the body.
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            {
              id: "sources",
              type: "search_viral_posts",
              niche: "SaaS",
              limit: 2,
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["sources"],
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);
    const result = await collect(
      input({
        route: {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 1 },
          minimumSources: 2,
        },
        userInstruction:
          "Find 2 top posts and write an original post about pricing, in my voice.",
      }),
      [planner],
      async () => ({
        ok: true,
        count: 2,
        posts: [
          { id: "post-a", text: "A pricing lesson.", url: "https://linkedin.com/a" },
          { id: "post-b", text: "A positioning lesson.", url: "https://linkedin.com/b" },
        ],
      }),
    );

    const artifact = result.events.find((event) => event.type === "artifact");
    expect(
      (artifact?.type === "artifact"
        ? artifact.artifact.meta
        : undefined) as { explicit_post_type?: unknown } | undefined,
    ).toEqual(
      expect.not.objectContaining({
        explicit_post_type: expect.anything(),
      }),
    );
  });

  test("models one draft from the top selected source after a larger discovery pool", async () => {
    const userInstruction =
      "Find 4 top-performing regular posts in my swipe file, choose the best, and rewrite it in my voice.";
    const route = compileReadOnlyOrchestratorRoute({
      userInstruction,
      isRefine: false,
      hasModelSource: false,
      hasAttachments: false,
      hasLeadMagnet: false,
      hasCreatorStyle: false,
    });
    expect(route).toMatchObject({
      outcome: { kind: "draft", expectedDrafts: 1 },
      minimumSources: 4,
      workspaceDraftSourceMode: "one_to_one",
    });
    if (!route) return;

    let modeledSourceId: string | null = null;
    const result = await collect(
      input({ route, userInstruction }),
      [],
      async () => ({
        ok: true,
        count: 4,
        posts: [
          { id: "best", text: "Best source.", url: "https://linkedin.com/best" },
          { id: "second", text: "Second source.", url: "https://linkedin.com/second" },
          { id: "third", text: "Third source.", url: "https://linkedin.com/third" },
          { id: "fourth", text: "Fourth source.", url: "https://linkedin.com/fourth" },
        ],
      }),
      {
        runProse: (draftInput) => {
          modeledSourceId =
            draftInput.task?.kind === "source"
              ? draftInput.task.source.id
              : null;
          return (async function* () {
            draftInput.onProgressStage?.({
              kind: "writing",
              id: "write_post",
              label: "Writing your post",
            });
            draftInput.onProgressStage?.({
              kind: "quality_check",
              id: "check_ai_tells_1",
              label: "Checking for AI tells",
            });
            yield {
              type: "artifact" as const,
              artifact: {
                id: "draft-selected",
                kind: "post" as const,
                title: "Draft",
                body: COMPLETE_POST,
              },
            };
            yield {
              type: "done" as const,
              terminalReason: "done" as const,
              message: {
                content: "Here’s your draft.",
                tool_calls: null,
                artifacts: [],
                toolMessages: [],
                inputTokens: 210,
                outputTokens: 95,
              },
            };
          })();
        },
      },
    );

    expect(modeledSourceId).toBe("best");
    expect(
      result.events.some(
        (event) =>
          event.type === "plan_update" &&
          event.steps.some(
            (step) =>
              step.status === "active" && step.label === "Checking for AI tells",
          ),
      ),
    ).toBe(true);
  });

  test("turns four sources into four drafts and bounds an oversized reserve pool", async () => {
    const userInstruction =
      "Find 4 top-performing regular posts in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original";
    const route = compileReadOnlyOrchestratorRoute({
      userInstruction,
      isRefine: false,
      hasModelSource: false,
      hasAttachments: false,
      hasLeadMagnet: false,
      hasCreatorStyle: false,
    });
    expect(route).not.toBeNull();
    if (!route) return;

    const batchInputs: ExecuteModeledDraftBatchInput[] = [];
    const selectionContexts: Array<ToolExecutionContext | undefined> = [];
    const result = await collect(
      input({
        route,
        userInstruction,
        writerInput: {
          ...input().writerInput,
          userInstruction,
        },
      }),
      [],
      async (_name, args, _workspaceId, _signal, context) => {
        selectionContexts.push(context);
        return args.post_type === "regular" && args.niche === undefined
          ? {
              ok: true,
              count: 4,
              posts: [
                {
                  id: "source-1",
                  text: wrapScrapedPostText({ text: "Source one." }).text,
                  url: "https://linkedin.com/posts/source-1",
                },
                {
                  id: "source-2",
                  text: wrapScrapedPostText({ text: "Source two." }).text,
                  url: "https://linkedin.com/posts/source-2",
                },
                {
                  id: "source-3",
                  text: wrapScrapedPostText({ text: "Source three." }).text,
                  url: "https://linkedin.com/posts/source-3",
                },
                {
                  id: "source-4",
                  text: wrapScrapedPostText({ text: "Source four." }).text,
                  url: "https://linkedin.com/posts/source-4",
                },
              ],
              reserve_posts: [
                {
                  id: "source-5",
                  text: wrapScrapedPostText({ text: "Reserve source five." })
                    .text,
                  url: "https://linkedin.com/posts/source-5",
                },
                ...Array.from({ length: 7 }, (_, offset) => ({
                  id: `source-${offset + 6}`,
                  text: wrapScrapedPostText({
                    text: `Excess reserve source ${offset + 6}.`,
                  }).text,
                  url: `https://linkedin.com/posts/source-${offset + 6}`,
                })),
              ],
            }
          : { ok: true, count: 0, posts: [] };
      },
      {
        executeModeledDraftBatch: async (batchInput) => {
          batchInputs.push(batchInput);
          batchInput.engineInput.onProgressStage?.({
            kind: "writing",
            id: "write_post",
            label: "Writing your post",
          });
          batchInput.engineInput.onProgressStage?.({
            kind: "quality_check",
            id: "check_ai_tells_1",
            label: "Checking for AI tells",
          });
          return {
            kind: "complete" as const,
            batchId: "batch-1",
            artifacts: Array.from({ length: batchInput.count }, (_, sourceIndex) => {
              const source =
                sourceIndex === 2
                  ? batchInput.sources[batchInput.count]
                  : batchInput.sources[sourceIndex];
              return {
                id: `draft-${sourceIndex + 1}`,
                kind: "post" as const,
                title: `Draft ${sourceIndex + 1}`,
                body: `${COMPLETE_POST}\n\nVariant ${sourceIndex + 1}.`,
                meta: {
                  modeled_draft_slot_id: `batch-1:slot-${sourceIndex}`,
                  modeled_draft_slot_index: sourceIndex,
                  source: "model_source",
                  source_post_id: source.id,
                  source_url: source.url,
                  research_provenance: {
                    route: "workspace_research",
                    sources: [
                      {
                        id: source.id,
                        kind: "workspace_post",
                        url: source.url,
                      },
                    ],
                  },
                },
              };
            }),
            usage: { inputTokens: 210, outputTokens: 380 },
          };
        },
      },
    );

    expect(batchInputs[0]).toMatchObject({
      operationKey: "root-user-message-1",
      count: 4,
      sources: [
        { id: "source-1" },
        { id: "source-2" },
        { id: "source-3" },
        { id: "source-4" },
        { id: "source-5" },
        { id: "source-6" },
        { id: "source-7" },
        { id: "source-8" },
        { id: "source-9" },
      ],
    });
    expect(batchInputs[0].sources.map((source) => source.text)).toEqual([
      "Source one.",
      "Source two.",
      "Source three.",
      "Source four.",
      "Reserve source five.",
      "Excess reserve source 6.",
      "Excess reserve source 7.",
      "Excess reserve source 8.",
      "Excess reserve source 9.",
    ]);
    expect(selectionContexts).toEqual([
      expect.objectContaining({
        autoSelectModelingSources: true,
        modelingReserveCount: 4,
      }),
    ]);
    const artifacts = result.events.filter(
      (event) => event.type === "artifact",
    );
    expect(artifacts).toHaveLength(4);
    expect(
      result.events.some(
        (event) =>
          event.type === "plan_update" &&
          event.steps.some(
            (step) =>
              step.status === "active" && step.label === "Checking for AI tells",
          ),
      ),
    ).toBe(true);
    expect(
      new Set(
        artifacts.map((event) =>
          event.type === "artifact" ? event.artifact.id : "",
        ),
      ).size,
    ).toBe(4);
    expect(
      artifacts.map((event) =>
        event.type === "artifact"
          ? {
              sourcePostId: event.artifact.meta?.source_post_id,
              sourceUrl: event.artifact.meta?.source_url,
              provenance: event.artifact.meta?.research_provenance,
            }
          : null,
      ),
    ).toEqual(
      [1, 2, 5, 4].map((index) => ({
        sourcePostId: `source-${index}`,
        sourceUrl: `https://linkedin.com/posts/source-${index}`,
        provenance: {
          route: "workspace_research",
          sources: [
            expect.objectContaining({
              id: `source-${index}`,
              url: `https://linkedin.com/posts/source-${index}`,
            }),
          ],
        },
      })),
    );
  });

  test("honors the requested draft count when fewer distinct canonical sources exist: falls through to the shared-pool multi path, never dead-ends", async () => {
    // The reported bug: the draft-count chip is authoritative — a request for N
    // drafts must produce N drafts even when the workspace can't supply N
    // DISTINCT canonical sources (e.g. the workspace's search only turned up 2
    // usable posts for a 3-draft request). Rather than dead-ending with
    // "I couldn't complete the verified modeled set safely", the turn now falls
    // through to the shared-pool multi path, which writes the requested number
    // of drafts by reusing the sources that ARE available. The durable
    // one-source-per-draft batch is reserved for when there genuinely are N
    // distinct canonical sources. (A url-less source no longer causes this
    // shortfall on its own — see the sibling test below — so this fixture
    // returns fewer sources than requested outright to keep exercising the
    // fallback path.)
    const userInstruction =
      "Find 3 top-performing regular posts in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original";
    const route = {
      kind: "workspace_research" as const,
      outcome: { kind: "draft" as const, expectedDrafts: 3 },
      minimumSources: 3,
      workspacePostType: "regular" as const,
      workspaceDraftSourceMode: "one_to_one" as const,
      authoritativeInstruction: userInstruction,
    };
    const executeModeledDraftBatch = vi.fn(async () => {
      throw new Error(
        "the strict one-source-per-draft batch must NOT run when distinct canonical sources < requested drafts",
      );
    });
    let capturedTask: WriterInput["task"] | undefined;

    const result = await collect(
      input({
        route,
        userInstruction,
        writerInput: { ...input().writerInput, userInstruction },
      }),
      [],
      async () => ({
        ok: true,
        count: 2,
        // Only 2 sources for a 3-draft request — genuinely short on distinct
        // canonical sources regardless of url-optionality (both have a url).
        posts: [
          {
            id: "source-1",
            text: "Source one has a complete modelable argument.",
            url: "https://linkedin.com/posts/source-1",
          },
          {
            id: "source-2",
            text: "Source two has a complete modelable argument.",
            url: "https://linkedin.com/posts/source-2",
          },
        ],
      }),
      {
        executeModeledDraftBatch,
        runProse: (draftInput) => {
          capturedTask = draftInput.task;
          return (async function* () {
            for (let i = 0; i < 3; i += 1) {
              yield {
                type: "artifact" as const,
                artifact: {
                  id: `draft-${i}`,
                  kind: "post" as const,
                  title: `Draft ${i}`,
                  body: COMPLETE_POST,
                },
              };
            }
            yield {
              type: "done" as const,
              terminalReason: "done" as const,
              message: {
                content: "Here are your 3 drafts.",
                tool_calls: null,
                artifacts: [],
                toolMessages: [],
                inputTokens: 300,
                outputTokens: 150,
              },
            };
          })();
        },
      },
    );

    // The strict batch did NOT run (not enough distinct canonical sources)…
    expect(executeModeledDraftBatch).not.toHaveBeenCalled();
    // …instead the shared-pool multi path ran for the requested count…
    expect(capturedTask).toMatchObject({ kind: "multi", expectedCount: 3 });
    // …and delivered the requested number of drafts, not a dead-end.
    expect(
      result.events.filter((event) => event.type === "artifact"),
    ).toHaveLength(3);
    expect(result.events).not.toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "orchestrator_evidence_insufficient",
      }),
    );
  });

  test("a URL-less source is a fully valid batch candidate: reaches durable acquisition alongside url-bearing sources", async () => {
    // A url is not required to model a source — only to stamp the "Open on
    // LinkedIn" chip on the finished draft. A scraped post whose url column is
    // null (a real, common condition) must still count toward the verified
    // source pool, not be silently dropped from it — with 3 sources (one
    // url-less) satisfying a 3-draft request, the strict batch runs directly
    // and never needs the chip-authoritative fallback above.
    const userInstruction =
      "Find 3 top-performing regular posts in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original";
    const route = {
      kind: "workspace_research" as const,
      outcome: { kind: "draft" as const, expectedDrafts: 3 },
      minimumSources: 3,
      workspacePostType: "regular" as const,
      workspaceDraftSourceMode: "one_to_one" as const,
      authoritativeInstruction: userInstruction,
    };
    const executeModeledDraftBatch = vi.fn(async (batchInput) => ({
      kind: "complete" as const,
      batchId: "batch-1",
      artifacts: batchInput.sources
        .slice(0, 3)
        .map((source: { id: string }, index: number) => ({
          id: `draft-${index + 1}`,
          kind: "post" as const,
          title: `Draft ${index + 1}`,
          body: `${COMPLETE_POST}\n\nVariant ${index + 1}.`,
          meta: { source_post_id: source.id },
        })),
      usage: { inputTokens: 210, outputTokens: 380 },
    }));

    const result = await collect(
      input({
        route,
        userInstruction,
        writerInput: { ...input().writerInput, userInstruction },
      }),
      [],
      async () => ({
        ok: true,
        count: 3,
        posts: [
          {
            id: "source-1",
            text: "Source one has a complete modelable argument.",
            url: "https://linkedin.com/posts/source-1",
          },
          // No url — must still count toward the canonical pool.
          {
            id: "source-2",
            text: "Source two has a complete modelable argument.",
          },
          {
            id: "source-3",
            text: "Source three has a complete modelable argument.",
            url: "https://linkedin.com/posts/source-3",
          },
        ],
      }),
      {
        executeModeledDraftBatch,
        runProse: () => {
          throw new Error(
            "the shared-pool multi path must NOT run when 3 distinct canonical sources satisfy a 3-draft request",
          );
        },
      },
    );

    expect(executeModeledDraftBatch).toHaveBeenCalledTimes(1);
    const batchCall = executeModeledDraftBatch.mock.calls[0][0];
    expect(batchCall.sources).toHaveLength(3);
    expect(batchCall.sources.map((source: { id: string }) => source.id)).toEqual(
      ["source-1", "source-2", "source-3"],
    );
    // The url-less source carries no `url` field at all — not an empty string.
    const urlLessSource = batchCall.sources.find(
      (source: { id: string }) => source.id === "source-2",
    );
    expect(urlLessSource).not.toHaveProperty("url");
    expect(
      result.events.filter((event) => event.type === "artifact"),
    ).toHaveLength(3);
    expect(result.events).not.toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "orchestrator_evidence_insufficient",
      }),
    );
  });

  test("still uses the strict one-source-per-draft batch when every requested draft has a distinct canonical source", async () => {
    // Guard the happy path: when the workspace DOES supply a distinct canonical
    // source per requested draft, the durable batch (with its resumable slots)
    // still runs — the fall-through only fires on a genuine source shortfall.
    const userInstruction =
      "Find 3 top-performing regular posts in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original";
    const route = {
      kind: "workspace_research" as const,
      outcome: { kind: "draft" as const, expectedDrafts: 3 },
      minimumSources: 3,
      workspacePostType: "regular" as const,
      workspaceDraftSourceMode: "one_to_one" as const,
      authoritativeInstruction: userInstruction,
    };
    const executeModeledDraftBatch = vi.fn(async () => ({
      kind: "complete" as const,
      batchId: "batch-1",
      artifacts: [
        { id: "d1", kind: "post" as const, title: "D1", body: COMPLETE_POST },
        { id: "d2", kind: "post" as const, title: "D2", body: COMPLETE_POST },
        { id: "d3", kind: "post" as const, title: "D3", body: COMPLETE_POST },
      ],
      usage: { inputTokens: 300, outputTokens: 150 },
    }));

    const result = await collect(
      input({
        route,
        userInstruction,
        writerInput: { ...input().writerInput, userInstruction },
      }),
      [],
      async () => ({
        ok: true,
        count: 3,
        posts: [
          { id: "source-1", text: "Source one modelable argument.", url: "https://linkedin.com/posts/source-1" },
          { id: "source-2", text: "Source two modelable argument.", url: "https://linkedin.com/posts/source-2" },
          { id: "source-3", text: "Source three modelable argument.", url: "https://linkedin.com/posts/source-3" },
        ],
      }),
      { executeModeledDraftBatch },
    );

    expect(executeModeledDraftBatch).toHaveBeenCalledTimes(1);
    expect(
      result.events.filter((event) => event.type === "artifact"),
    ).toHaveLength(3);
  });

  test("resumes a frozen modeled batch without re-running source discovery", async () => {
    const userInstruction =
      "Find 2 top-performing regular posts in my swipe file and rewrite each in my voice.";
    const route = compileReadOnlyOrchestratorRoute({
      userInstruction,
      isRefine: false,
      hasModelSource: false,
      hasAttachments: false,
      hasLeadMagnet: false,
      hasCreatorStyle: false,
    });
    const continuation = continuationForModeledDraftRoute(route);
    expect(route).not.toBeNull();
    expect(continuation).not.toBeNull();
    if (!route || !continuation) return;
    const batchInputs: ExecuteModeledDraftBatchInput[] = [];
    const runTool = vi.fn(async () => {
      throw new Error("Retry must not rediscover a frozen source pool");
    });

    const result = await collect(
      input({
        route,
        modeledBatchContinuation: continuation,
        userInstruction,
        writerInput: { ...input().writerInput, userInstruction },
      }),
      [],
      runTool,
      {
        executeModeledDraftBatch: async (batchInput) => {
          batchInputs.push(batchInput);
          return {
            kind: "complete" as const,
            batchId: "batch-frozen",
            artifacts: [1, 2].map((index) => ({
              id: `draft-${index}`,
              kind: "post" as const,
              title: `Draft ${index}`,
              body: `${COMPLETE_POST}\n\nVariant ${index}.`,
              meta: {
                modeled_draft_slot_id: `batch-frozen:slot-${index - 1}`,
                modeled_draft_slot_index: index - 1,
                source: "model_source",
                source_post_id: `frozen-source-${index}`,
                source_url: `https://linkedin.com/posts/frozen-source-${index}`,
              },
            })),
            usage: { inputTokens: 20, outputTokens: 40 },
          };
        },
      },
    );

    expect(runTool).not.toHaveBeenCalled();
    expect(batchInputs).toHaveLength(1);
    expect(batchInputs[0].sources).toEqual([]);
    expect(result.events.filter((event) => event.type === "artifact")).toHaveLength(2);
    expect(
      result.events.some(
        (event) =>
          event.type === "plan_update" &&
          event.steps.some(
            (step) =>
              step.status === "active" &&
              step.label.startsWith("Applying "),
          ),
      ),
    ).toBe(false);
  });

  test.each([
    [
      "a durable checkpoint",
      {
        kind: "incomplete" as const,
        batchId: "batch-saved",
        reason: "reviewer_unavailable" as const,
        preservedSlots: 1,
        preservedArtifacts: [
          {
            id: "draft-preserved",
            kind: "post" as const,
            title: "Preserved draft",
            body: COMPLETE_POST,
            meta: {
              modeled_draft_slot_id: "batch-saved:slot-0",
              modeled_draft_slot_index: 0,
              source: "model_source",
              source_post_id: "source-1",
              source_url: "https://linkedin.com/posts/source-1",
            },
          },
        ],
        requestedCount: 2,
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      "modeled_batch_resumable_reviewer_unavailable",
    ],
    [
      "a pre-claim storage failure",
      {
        kind: "incomplete" as const,
        reason: "store_unavailable" as const,
        preservedSlots: 0,
        preservedArtifacts: [],
        requestedCount: 2,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      "modeled_batch_store_unavailable",
    ],
    [
      "a busy durable batch",
      {
        kind: "incomplete" as const,
        batchId: "batch-busy",
        reason: "busy" as const,
        preservedSlots: 0,
        preservedArtifacts: [],
        requestedCount: 2,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      "modeled_batch_resumable_busy",
    ],
  ])("classifies modeled coordinator failure: %s", async (_name, batchResult, code) => {
    const userInstruction =
      "Find 2 top-performing regular posts in my swipe file and rewrite each in my voice.";
    const route = compileReadOnlyOrchestratorRoute({
      userInstruction,
      isRefine: false,
      hasModelSource: false,
      hasAttachments: false,
      hasLeadMagnet: false,
      hasCreatorStyle: false,
    });
    expect(route).not.toBeNull();
    if (!route) return;

    const result = await collect(
      input({
        route,
        userInstruction,
        writerInput: { ...input().writerInput, userInstruction },
      }),
      [],
      async () => ({
        ok: true,
        count: 2,
        posts: [1, 2].map((index) => ({
          id: `source-${index}`,
          text: `Source ${index} contains a complete modelable argument.`,
          url: `https://linkedin.com/posts/source-${index}`,
        })),
      }),
      { executeModeledDraftBatch: async () => batchResult },
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "error", code, recovery: "continue" }),
    );
    const artifactEvents = result.events.filter(
      (event) => event.type === "artifact",
    );
    expect(artifactEvents).toHaveLength(batchResult.preservedArtifacts.length);
    if (batchResult.preservedArtifacts.length > 0) {
      expect(artifactEvents[0]).toMatchObject({
        artifact: { id: "draft-preserved" },
      });
      expect(result.events.at(-1)).toMatchObject({
        type: "done",
        message: {
          content: expect.stringContaining(
            "I completed 1 of 2 verified drafts",
          ),
        },
      });
    } else {
      expect(result.events.at(-1)).toMatchObject({
        type: "done",
        message: {
          content: expect.not.stringContaining("verified drafts"),
        },
      });
    }
  });

  test("terminates a FRESH insufficient_sources batch failure with no Retry offer", async () => {
    // insufficient_sources on a fresh (non-resuming) turn means the
    // workspace genuinely does not have enough distinct verified sources —
    // no durable batch was ever created, so there is nothing a Retry could
    // resume. Retrying re-runs the identical acquisition against the
    // identical pool and fails identically every time. This must NOT emit a
    // recoverable "error" event (the resuming case already gets its own
    // terminal message; this asserts the FRESH case gets the same
    // treatment, not the generic "Retry will resume..." fallback).
    const userInstruction =
      "Find 2 top-performing regular posts in my swipe file and rewrite each in my voice.";
    const route = compileReadOnlyOrchestratorRoute({
      userInstruction,
      isRefine: false,
      hasModelSource: false,
      hasAttachments: false,
      hasLeadMagnet: false,
      hasCreatorStyle: false,
    });
    expect(route).not.toBeNull();
    if (!route) return;

    const result = await collect(
      input({
        route,
        userInstruction,
        writerInput: { ...input().writerInput, userInstruction },
      }),
      [],
      async () => ({
        ok: true,
        count: 2,
        posts: [1, 2].map((index) => ({
          id: `source-${index}`,
          text: `Source ${index} contains a complete modelable argument.`,
          url: `https://linkedin.com/posts/source-${index}`,
        })),
      }),
      {
        executeModeledDraftBatch: async () => ({
          kind: "failed" as const,
          reason: "insufficient_sources" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      },
    );

    expect(
      result.events.some((event) => event.type === "error"),
    ).toBe(false);
    const finished = result.events.find(
      (event): event is Extract<AgentEvent, { type: "done" }> =>
        event.type === "done",
    );
    expect(finished?.message.content).toContain(
      "I don’t have enough distinct verified sources",
    );
    expect(finished?.message.content).not.toContain("Retry");
  });

  test("does not publish a completed modeled set after the turn is cancelled", async () => {
    const userInstruction =
      "Find 2 top-performing regular posts in my swipe file and rewrite each in my voice.";
    const route = compileReadOnlyOrchestratorRoute({
      userInstruction,
      isRefine: false,
      hasModelSource: false,
      hasAttachments: false,
      hasLeadMagnet: false,
      hasCreatorStyle: false,
    });
    expect(route).not.toBeNull();
    if (!route) return;
    const controller = new AbortController();
    const sourceRows = [1, 2].map((index) => ({
      id: `source-${index}`,
      text: `Source ${index} has a clear hook and complete argument.`,
      url: `https://linkedin.com/posts/source-${index}`,
    }));

    const result = await collect(
      input({
        route,
        userInstruction,
        signal: controller.signal,
        writerInput: { ...input().writerInput, userInstruction },
      }),
      [],
      async () => ({ ok: true, count: 2, posts: sourceRows }),
      {
        executeModeledDraftBatch: async () => {
          controller.abort();
          return {
            kind: "complete" as const,
            batchId: "batch-cancelled",
            artifacts: sourceRows.map((source, index) => ({
              id: `draft-${index}`,
              kind: "post" as const,
              title: `Draft ${index + 1}`,
              body: `${COMPLETE_POST}\n\nVariant ${index + 1}.`,
              meta: {
                modeled_draft_slot_id: `batch-cancelled:slot-${index}`,
                modeled_draft_slot_index: index,
                source: "model_source",
                source_post_id: source.id,
                source_url: source.url,
              },
            })),
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        },
      },
    );

    expect(result.events.filter((event) => event.type === "artifact")).toEqual(
      [],
    );
    expect(result.events.at(-1)).toMatchObject({
      type: "done",
      terminalReason: "cancelled",
    });
  });

  test("marks a post-completion modeled deadline as recoverable before done", async () => {
    const userInstruction =
      "Find 2 top-performing regular posts in my swipe file and rewrite each in my voice.";
    const route = compileReadOnlyOrchestratorRoute({
      userInstruction,
      isRefine: false,
      hasModelSource: false,
      hasAttachments: false,
      hasLeadMagnet: false,
      hasCreatorStyle: false,
    });
    expect(route).not.toBeNull();
    if (!route) return;
    const sourceRows = [1, 2].map((index) => ({
      id: `source-${index}`,
      text: `Source ${index} has a clear hook and complete argument.`,
      url: `https://linkedin.com/posts/source-${index}`,
    }));

    const result = await collect(
      input({
        route,
        userInstruction,
        writerInput: { ...input().writerInput, userInstruction },
      }),
      [],
      async () => ({ ok: true, count: 2, posts: sourceRows }),
      {
        turnDeadlineMs: 1,
        executeModeledDraftBatch: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            kind: "complete" as const,
            batchId: "batch-deadline",
            artifacts: sourceRows.map((source, index) => ({
              id: `draft-${index}`,
              kind: "post" as const,
              title: `Draft ${index + 1}`,
              body: `${COMPLETE_POST}\n\nVariant ${index + 1}.`,
              meta: {
                modeled_draft_slot_id: `batch-deadline:slot-${index}`,
                modeled_draft_slot_index: index,
                source: "model_source",
                source_post_id: source.id,
                source_url: source.url,
              },
            })),
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        },
      },
    );

    expect(result.events.filter((event) => event.type === "artifact")).toEqual(
      [],
    );
    expect(result.events.slice(-2)).toEqual([
      expect.objectContaining({
        type: "error",
        code: "modeled_batch_resumable_deadline",
        recovery: "continue",
      }),
      expect.objectContaining({ type: "done", terminalReason: "deadline" }),
    ]);
  });

  test.each([
    ["too few artifacts", ["only-draft"], 1],
    ["duplicate artifact identities", ["same", "same", "same", "same"], 1],
  ] as const)(
    "presents the accepted partial set on %s",
    async (_case, artifactIds, expectedPresented) => {
    const result = await collect(
      input({
        route: {
          kind: "workspace_research",
          outcome: { kind: "draft", expectedDrafts: 4 },
          minimumSources: 4,
          workspacePostType: "regular",
        },
        userInstruction:
          "Find four regular posts in my swipe file and rewrite them into four original posts.",
      }),
      [],
      async () => ({
        ok: true,
        count: 4,
        posts: [
          { id: "source-1", text: "Source one." },
          { id: "source-2", text: "Source two." },
          { id: "source-3", text: "Source three." },
          { id: "source-4", text: "Source four." },
        ],
      }),
      {
        runProse: async function* () {
          for (const [index, id] of artifactIds.entries()) {
            yield {
              type: "artifact",
              artifact: {
                id,
                kind: "post",
                title: `Draft ${index + 1}`,
                body: `${COMPLETE_POST}\n\nVariant ${index + 1}.`,
              },
            };
          }
          yield {
            type: "done",
            terminalReason: "done",
            message: {
              content: "Here is your draft.",
              tool_calls: null,
              artifacts: [],
              toolMessages: [],
              inputTokens: 210,
              outputTokens: 95,
            },
          };
        },
      },
    );

    expect(result.events.filter((event) => event.type === "artifact")).toHaveLength(
      expectedPresented,
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "orchestrator_draft_count_mismatch",
      }),
    );
    const done = result.events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.message.content).toContain(
      `completed ${expectedPresented} of the 4 requested drafts`,
    );
  });

  test("uses only cited web evidence for a general research turn", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            {
              id: "research",
              type: "search_web",
              query: "B2B pricing strategy evidence",
            },
            {
              id: "write",
              type: "draft_post",
              evidenceActionIds: ["research"],
            },
          ],
        },
        usage: usage(65, 14),
      },
    ]);
    const result = await collect(
      input({
        route: { kind: "web_research", outcome: { kind: "draft", expectedDrafts: 1 } },
        userInstruction:
          "Research B2B pricing strategies and write one LinkedIn post about pricing discipline.",
      }),
      [planner],
      vi.fn(async () => ({ ok: false })),
      {
        runWebResearch: async () => ({
          attempts: [
            {
              model: "anthropic/claude-haiku-4.5",
              usage: usage(100, 20),
            },
          ],
          sources: [
            {
              id: "https://example.com/pricing",
              kind: "web",
              title: "Pricing research",
              url: "https://example.com/pricing",
              text: "Buyers evaluate price in the context of perceived value.",
            },
          ],
        }),
      },
    );

    expect(result.draftInputs[0]?.task).toMatchObject({
      kind: "grounded",
      sources: [
        expect.objectContaining({
          id: "https://example.com/pricing",
          url: "https://example.com/pricing",
        }),
      ],
    });
    expect(result.recorded.map((args) => args[0])).toEqual([
      "cowork_web_research",
    ]);
  });

  test("uses a server-owned clarification without invoking a planner or writer", async () => {
    const planner = new ScriptedPlanner(PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            {
              id: "clarify",
              type: "clarify",
              question:
                "OpenAI just changed the rules for every founder building with AI?",
              options: ["Agree", "Disagree"],
            },
          ],
        },
        usage: usage(60, 12),
      },
    ]);
    const events: AgentEvent[] = [];
    const writer = vi.fn(successfulDraft);
    for await (const event of runReadOnlyOrchestrator(
      input({
        route: { kind: "ambiguous_read_only" },
        userInstruction: "Research the latest OpenAI news.",
      }),
      {
        runTool: vi.fn(async () => ({ ok: true })),
        runProse: writer,
        recordUsage: vi.fn(async () => {}),
        idFactory: () => "clarify-call",
      },
    )) {
      events.push(event);
    }

    expect(writer).not.toHaveBeenCalled();
    expect(planner.requests).toHaveLength(0);
    expect(events).toContainEqual({
      type: "ask",
      ask: {
        question: "What should I create from this research?",
        options: [
          "A LinkedIn post",
          "A short list of takeaways",
          "A detailed research summary",
        ],
        allowOther: true,
      },
    });
    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.terminalReason).toBe("ask");
  });

  test("asks for the unresolved modeled source count instead of repeating a mapping question", async () => {
    const events: AgentEvent[] = [];
    for await (const event of runReadOnlyOrchestrator(
      input({
        route: {
          kind: "ambiguous_read_only",
          clarificationReason: "modeled_mapping",
          modeledAmbiguityReason: "source_count",
        },
        userInstruction:
          "Find 4 or 5 top posts in my swipe file and rewrite them.",
      }),
      {
        runTool: vi.fn(async () => ({ ok: true })),
        runProse: vi.fn(successfulDraft),
        recordUsage: vi.fn(async () => {}),
        idFactory: () => "modeled-count-clarify",
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "ask",
      ask: {
        question: "How many source posts should I use?",
        options: ["2 sources", "3 sources", "4 sources", "5 sources"],
        allowOther: true,
      },
    });
  });
});

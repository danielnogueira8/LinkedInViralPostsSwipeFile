import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/agent/tools", () => ({ runTool: vi.fn() }));
vi.mock("@/lib/agent/turn/execute-interview", () => ({
  INTERVIEW_REQUEST_RE: /\binterview\b/i,
}));

import { compileTurnPlan } from "@/lib/agent/turn/compile";
import type { TurnCompileContext } from "@/lib/agent/turn/state";

function compileSetup(
  overrides: Record<string, unknown> = {},
): TurnCompileContext {
  return {
    workspaceId: "ws-1",
    sbRaw: null,
    attachments: [],
    modelSourceId: "trend-source-1",
    skipDecision: false,
    refineInstruction: undefined,
    trustedRefineTarget: null,
    existingArtifactIds: [],
    creatorStyleId: undefined,
    hasModelSource: true,
    turnCostOperationKey: null,
    claimedUserMessageId: "message-1",
    actionTurnMessageId: null,
    normalizedActionRoute: null,
    confirmedActionTargetIds: [],
    actionRetryRepository: null,
    persistedActionContinuation: false,
    pendingAskOnly: false,
    pendingInterviewAsk: false,
    artifactClarification: null,
    fallthroughClarification: null,
    modeledBatchContinuation: null,
    modeledBatchContractRequested: false,
    setupDeadline: null,
    setupSignal: new AbortController().signal,
    postClarificationPostCount: null,
    coworkTelemetry: { configure() {}, finish: async () => {} },
    currentModelSource: {
      id: "trend-source-1",
      post_text: "A verified Trend Radar signal.",
      source: "trend",
      source_post_id: null,
      post_type: "regular",
    },
    modelSourceReference: null,
    effectiveUserInstruction:
      "Newsjack this verified trend in my voice. Use the attached evidence only for facts, add an original perspective, and do not repeat the source wording.",
    currentTurnOperation: { kind: "create_post", delivery: "atomic" },
    composerTaskContext: null,
    activeDraftCountOverride: undefined,
    shouldAttachLeadMagnet: false,
    appliedLeadMagnet: null,
    activeLeadMagnetCampaign: null,
    leadMagnetBlock: "",
    creatorStyleBlock: "",
    preloadedVoiceResult: { ok: true },
    resolvedGenerationConfig: null,
    turnError: (message: string, status: number) =>
      new Response(message, { status }),
    structureMatch: null,
    ...overrides,
  } as unknown as TurnCompileContext;
}

const compileDeps = {
  actionOrchestratorEnabledForWorkspace: () => false,
  readOnlyOrchestratorEnabledForWorkspace: () => false,
  releaseChatTurn: async () => {},
  persistChatSetupFailure: async () => {},
};

describe("Trend Radar draft handoff", () => {
  test("treats a verified Trend Radar source as sufficient for a create turn", async () => {
    const plan = await compileTurnPlan(
      compileSetup(),
      "chat-1",
      compileDeps,
    );

    expect(plan).toMatchObject({
      kind: "write",
      route: "direct_writer",
      task: { kind: "source" },
      contract: { kind: "post", expectedCount: 1 },
    });
  });

  test("does not relax the freshness gate for an ordinary attached source", async () => {
    const plan = await compileTurnPlan(
      compileSetup({
        currentModelSource: {
          id: "swipe-source-1",
          post_text: "An attached swipe-file post.",
          source: "swipe",
          source_post_id: "post-1",
          post_type: "regular",
        },
      }),
      "chat-1",
      compileDeps,
    );

    expect(plan).toMatchObject({
      kind: "clarify",
      route: "answer",
      contract: { kind: "answer", expectedCount: 0 },
    });
  });
});

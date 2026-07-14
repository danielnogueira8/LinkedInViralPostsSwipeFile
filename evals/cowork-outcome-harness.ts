import {
  createChatStreamPost,
} from "@/app/api/chats/[id]/stream/route";
import {
  executeChatTurn,
  type ChatTurnDependencies,
  type ChatTurnRequest,
} from "@/lib/agent/chat-turn";
import type { Artifact } from "@/lib/agent/contracts";
import type { ChatTurnTerminal } from "@/lib/agent/chat-turn-lifecycle";
import {
  parseChatSseFrame,
  type ChatSseFrame,
} from "@/lib/transport/contracts";
import {
  ScriptedProviderSession,
  type ScriptedProviderScenario,
} from "@/evals/cowork-scripted-provider";
import {
  CoworkHarnessStore,
  type PersistedHarnessDraft,
  type PersistedHarnessMessage,
  type PersistedHarnessUsage,
} from "@/evals/cowork-harness-store";
import type { SourceFidelityVerdict } from "@/lib/agent/specialists/source-fidelity";

export type CoworkOutcomeScenario = {
  id: string;
  request: ChatTurnRequest;
  model: {
    provider: ScriptedProviderScenario;
    sourceFidelity?: SourceFidelityVerdict[];
  };
  seed?: {
    bookmarkModelSource?: {
      id: string;
      sourcePostId: string;
      postText: string;
      postUrl: string;
    };
    draft?: {
      id: string;
      title: string;
      body: string;
      status?: "idea" | "drafting" | "ready";
    };
  };
  negativeControl?: {
    duplicatePersistedArtifact?: boolean;
  };
  expected: {
    terminal: ChatTurnTerminal;
    artifactBodies: string[];
    actionNames: string[];
    assistantContents?: string[];
    sourcePostIds?: string[];
  };
};

export type CoworkOutcomeFailureCode =
  | "http_status"
  | "terminal"
  | "deliverable_count"
  | "draft_body"
  | "action_count"
  | "action_name"
  | "action_persistence"
  | "assistant_content"
  | "provenance"
  | "duplicate_artifact"
  | "duplicate_action"
  | "model_usage"
  | "transport_terminal"
  | "empty_turn";

export type CoworkObservedAction = {
  id: string;
  name: string;
  arguments: string;
  operationKey: string;
};

export type CoworkOutcomeReport = {
  pass: boolean;
  failureCodes: CoworkOutcomeFailureCode[];
  safe: {
    id: string;
    status: number;
    terminal: ChatTurnTerminal;
    messageCount: number;
    artifactCount: number;
    actionCount: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    costUsd: number;
    modelStages: Array<{ kind: string; model: string }>;
  };
  persisted: {
    messages: PersistedHarnessMessage[];
    artifacts: Artifact[];
    actions: CoworkObservedAction[];
    drafts: PersistedHarnessDraft[];
    usage: PersistedHarnessUsage[];
  };
  observed: {
    actions: CoworkObservedAction[];
  };
  frames: ChatSseFrame[];
};

function parseFrames(raw: string): ChatSseFrame[] {
  const frames: ChatSseFrame[] = [];
  for (const record of raw.split("\n\n")) {
    const event = record
      .split("\n")
      .find((line) => line.startsWith("event: "))
      ?.slice("event: ".length);
    const dataText = record
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (!event || !dataText) continue;
    try {
      const frame = parseChatSseFrame(event, JSON.parse(dataText));
      if (frame) frames.push(frame);
    } catch {
      // Malformed transport is observable as a missing expected terminal frame.
    }
  }
  return frames;
}

function sameStrings(actual: readonly string[], expected: readonly string[]) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function duplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function duplicateOutcomeFailureCodes(input: {
  artifacts: readonly Artifact[];
  actions: readonly CoworkObservedAction[];
}): CoworkOutcomeFailureCode[] {
  const failureCodes: CoworkOutcomeFailureCode[] = [];
  if (
    duplicates(input.artifacts.map((artifact) => artifact.id)) ||
    duplicates(
      input.artifacts.map((artifact) => `${artifact.kind}:${artifact.body}`),
    )
  ) {
    failureCodes.push("duplicate_artifact");
  }
  if (duplicates(input.actions.map((action) => action.operationKey))) {
    failureCodes.push("duplicate_action");
  }
  return failureCodes;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function observedAction(input: {
  id: string;
  name: string;
  arguments?: string;
}): CoworkObservedAction {
  const argumentsText = input.arguments ?? "{}";
  let normalizedArguments = argumentsText;
  try {
    normalizedArguments = canonicalJson(JSON.parse(argumentsText));
  } catch {
    // Malformed arguments remain byte-comparable and fail the tool contract.
  }
  return {
    id: input.id,
    name: input.name,
    arguments: argumentsText,
    operationKey: `${input.name}:${normalizedArguments}`,
  };
}

async function runCoworkOutcomeScenarioWithStore(
  store: CoworkHarnessStore,
  scenario: CoworkOutcomeScenario,
): Promise<CoworkOutcomeReport> {
  const messageOffset = store.messages().length;
  const usageOffset = store.usages().length;
  let terminalPromise: Promise<{ terminal: ChatTurnTerminal }> | null = null;
  const requestController = new AbortController();
  if (scenario.seed?.bookmarkModelSource) {
    store.seedBookmarkModelSource(scenario.seed.bookmarkModelSource);
  }
  if (scenario.seed?.draft) {
    store.seedDraft(scenario.seed.draft);
  }
  const providerSession = new ScriptedProviderSession(
    scenario.model.provider,
    () => requestController.abort(),
  );
  const sourceFidelity = [...(scenario.model.sourceFidelity ?? [])];

  const dependencies: Partial<ChatTurnDependencies> = {
    scopedSupabase: (async () => ({
      workspaceId: store.workspaceId,
      raw: store.client,
    })) as unknown as ChatTurnDependencies["scopedSupabase"],
    checkChatRateLimit: async () => ({ ok: true }),
    claimChatTurn: async (_workspaceId, _chatId, content) =>
      store.claim(content),
    releaseChatTurn: async () => store.release(),
    completeChat: (async () => ({
      text: "",
      toolArgs: null,
      finishReason: "stop",
      usage: undefined,
      citations: [],
    })) as ChatTurnDependencies["completeChat"],
    fetchRecentPostDrafts: async () => [],
    generateLeadMagnetResource: (async () => {
      throw new Error("Lead-magnet generation is not scripted for this scenario.");
    }) as ChatTurnDependencies["generateLeadMagnetResource"],
    draftFinalizerSpecialists: {
      reviewSourceFidelity: async () =>
        sourceFidelity.shift() ?? {
          pass: true,
          reasons: [],
          retryInstruction: "",
        },
    },
  };

  const handler = createChatStreamPost({
    authenticate: async () => ({ userId: store.userId }),
    execute: (async (input) => {
      const result = await executeChatTurn(input, dependencies);
      if (!(result instanceof Response)) terminalPromise = result.terminal;
      return result;
    }) as typeof executeChatTurn,
  });

  const startedAt = performance.now();
  const { response, raw, terminal } = await store.run(() =>
    providerSession.run(async () => {
      const response = await handler(
        new Request(`http://test.local/api/chats/${store.chatId}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(scenario.request),
          signal: requestController.signal,
        }),
        { params: Promise.resolve({ id: store.chatId }) },
      );
      const raw = await response.text();
      const settledTerminal = terminalPromise as Promise<{
        terminal: ChatTurnTerminal;
      }> | null;
      const terminal = settledTerminal
        ? (await settledTerminal).terminal
        : "failure";
      return { response, raw, terminal };
    }),
  );
  const latencyMs = Math.max(0, performance.now() - startedAt);
  if (scenario.negativeControl?.duplicatePersistedArtifact) {
    store.duplicateLastPersistedArtifact();
  }
  const messages = store.messages().slice(messageOffset);
  const assistantMessages = messages.filter(
    (message) => message.role === "assistant",
  );
  const artifacts = assistantMessages.flatMap(
    (message) => message.artifacts ?? [],
  );
  const frames = parseFrames(raw);
  const providerCallsById = new Map(
    providerSession.toolCallRecords().map((call) => [call.id, call]),
  );
  const streamedActions = frames
    .filter((frame) => frame.event === "tool_start")
    .map((frame) => observedAction(providerCallsById.get(frame.data.id) ?? frame.data));
  const streamedActionIds = new Set(streamedActions.map((action) => action.id));
  const persistedOnlyActions = assistantMessages.flatMap((message) =>
    (message.tool_calls ?? [])
      .filter((call) => !streamedActionIds.has(call.id))
      .map((call) =>
        observedAction({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        }),
      ),
  );
  // The stream proves which normal actions were dispatched across all rounds;
  // the provider trace enriches those actions with exact arguments. Canonical
  // persistence adds intercepted/finalizer actions such as plans and ask_user.
  const actions = [...streamedActions, ...persistedOnlyActions];
  const persistedActions = assistantMessages.flatMap((message) =>
    (message.tool_calls ?? []).map((call) =>
      observedAction({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }),
    ),
  );
  const persistedToolMessageIds = messages.flatMap((message) =>
    message.role === "tool" && message.tool_call_id
      ? [message.tool_call_id]
      : [],
  );
  const usage = store.usages().slice(usageOffset);
  const assistantInputTokens = assistantMessages.reduce(
    (total, message) => total + (message.input_tokens ?? 0),
    0,
  );
  const assistantOutputTokens = assistantMessages.reduce(
    (total, message) => total + (message.output_tokens ?? 0),
    0,
  );
  const inputTokens = usage.reduce(
    (total, row) => total + row.input_tokens,
    0,
  );
  const outputTokens = usage.reduce(
    (total, row) => total + row.output_tokens,
    0,
  );
  const costUsd = Number(
    usage.reduce((total, row) => total + row.cost_usd, 0).toFixed(6),
  );
  const modelStages = usage.map(({ kind, model }) => ({ kind, model }));
  const failureCodes: CoworkOutcomeFailureCode[] = [];
  if (response.status !== 200) failureCodes.push("http_status");
  if (terminal !== scenario.expected.terminal) failureCodes.push("terminal");
  const actualArtifactBodies = artifacts.map((artifact) => artifact.body);
  if (artifacts.length !== scenario.expected.artifactBodies.length) {
    failureCodes.push("deliverable_count");
  } else if (!sameStrings(actualArtifactBodies, scenario.expected.artifactBodies)) {
    failureCodes.push("draft_body");
  }
  const actualActionNames = persistedActions.map((action) => action.name);
  if (persistedActions.length !== scenario.expected.actionNames.length) {
    failureCodes.push("action_count");
  } else if (!sameStrings(actualActionNames, scenario.expected.actionNames)) {
    failureCodes.push("action_name");
  }
  if (
    persistedActions
      .filter((action) => !action.name.startsWith("_"))
      .some(
        (action) =>
          persistedToolMessageIds.filter((id) => id === action.id).length !== 1,
      ) ||
    persistedToolMessageIds.some(
      (id) => !persistedActions.some((action) => action.id === id),
    )
  ) {
    failureCodes.push("action_persistence");
  }
  if (scenario.expected.assistantContents) {
    const actualContents = assistantMessages.map((message) => message.content);
    if (!sameStrings(actualContents, scenario.expected.assistantContents)) {
      failureCodes.push("assistant_content");
    }
  }
  if (scenario.expected.sourcePostIds) {
    const sourcePostIds = artifacts.map((artifact) => {
      const value = artifact.meta?.source_post_id ?? artifact.meta?.sourcePostId;
      return typeof value === "string" ? value : "";
    });
    if (!sameStrings(sourcePostIds, scenario.expected.sourcePostIds)) {
      failureCodes.push("provenance");
    }
  }
  failureCodes.push(
    ...duplicateOutcomeFailureCodes({ artifacts, actions }),
  );
  if (
    (["done", "ask"].includes(terminal) && modelStages.length === 0) ||
    usage.some(
      (row) =>
        row.provider !== "openrouter" ||
        row.workspace_id !== store.workspaceId,
    ) ||
    assistantInputTokens !== inputTokens ||
    assistantOutputTokens !== outputTokens
  ) {
    failureCodes.push("model_usage");
  }
  if (
    terminal !== "failure" &&
    !frames.some((frame) => frame.event === "done")
  ) {
    failureCodes.push("transport_terminal");
  }
  if (
    terminal === "done" &&
    assistantMessages.every(
      (message) =>
        message.content.trim().length === 0 &&
        (message.artifacts?.length ?? 0) === 0,
    )
  ) {
    failureCodes.push("empty_turn");
  }

  return {
    pass: failureCodes.length === 0,
    failureCodes,
    safe: {
      id: scenario.id,
      status: response.status,
      terminal,
      messageCount: messages.length,
      artifactCount: artifacts.length,
      actionCount: persistedActions.length,
      inputTokens,
      outputTokens,
      latencyMs: Number(latencyMs.toFixed(3)),
      costUsd,
      modelStages,
    },
    persisted: {
      messages,
      artifacts,
      actions: persistedActions,
      drafts: store.drafts(),
      usage,
    },
    observed: { actions },
    frames,
  };
}

export async function runCoworkOutcomeScenario(
  scenario: CoworkOutcomeScenario,
): Promise<CoworkOutcomeReport> {
  return runCoworkOutcomeScenarioWithStore(
    new CoworkHarnessStore(),
    scenario,
  );
}

export async function runCoworkOutcomeSequence(
  scenarios: readonly CoworkOutcomeScenario[],
): Promise<{
  pass: boolean;
  recovered: boolean;
  attempts: CoworkOutcomeReport[];
}> {
  const store = new CoworkHarnessStore();
  const attempts: CoworkOutcomeReport[] = [];
  for (const scenario of scenarios) {
    attempts.push(await runCoworkOutcomeScenarioWithStore(store, scenario));
  }
  return {
    pass: attempts.every((attempt) => attempt.pass),
    recovered:
      attempts.length >= 2 &&
      attempts[0]?.safe.artifactCount === 0 &&
      (attempts.at(-1)?.safe.artifactCount ?? 0) > 0 &&
      ["done", "ask"].includes(attempts.at(-1)?.safe.terminal ?? "failure"),
    attempts,
  };
}

/** Serialize only the explicit safe projection; never stringify the report. */
export function safeCoworkReportLine(report: CoworkOutcomeReport): string {
  return JSON.stringify(report.safe);
}

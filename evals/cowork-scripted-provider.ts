import { AsyncLocalStorage } from "node:async_hooks";
import type { StreamDelta, Usage } from "@/lib/openrouter";

export type ScriptedProviderResponseRound = {
  kind: "response";
  text?: string;
  toolCalls?: Array<{
    id?: string;
    name: string;
    args: Record<string, unknown> | string;
  }>;
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter";
  usage?: Usage;
};

export type ScriptedProviderRound =
  | ScriptedProviderResponseRound
  | { kind: "error"; message: string; code?: string | number }
  | { kind: "cancel" };

export type ScriptedProviderScenario = {
  rounds: ScriptedProviderRound[];
};

export type ScriptedToolCallRecord = {
  id: string;
  name: string;
  arguments: string;
};

type ScriptedProviderState = {
  scenario: ScriptedProviderScenario;
  round: number;
  abortRequest: (() => void) | null;
  toolCalls: ScriptedToolCallRecord[];
};

const scriptedProviderContext = new AsyncLocalStorage<ScriptedProviderState>();

export class ScriptedProviderSession {
  private readonly state: ScriptedProviderState;

  constructor(
    scenario: ScriptedProviderScenario,
    abortRequest?: () => void,
  ) {
    this.state = {
      scenario,
      round: 0,
      abortRequest: abortRequest ?? null,
      toolCalls: [],
    };
  }

  run<T>(work: () => T): T {
    return scriptedProviderContext.run(this.state, work);
  }

  toolCallRecords(): ScriptedToolCallRecord[] {
    return this.state.toolCalls.slice();
  }

  roundCount(): number {
    return this.state.round;
  }
}

function activeState(): ScriptedProviderState {
  const state = scriptedProviderContext.getStore();
  if (!state) {
    throw new Error("Scripted provider called outside a scenario session.");
  }
  return state;
}

/** OpenRouter transport adapter used by the production-shaped harness. */
export async function* scriptedStreamChat(): AsyncGenerator<StreamDelta> {
  const state = activeState();
  const round = state.scenario.rounds[state.round] ?? {
    kind: "response" as const,
    finishReason: "stop" as const,
  };
  state.round += 1;

  if (round.kind === "cancel") {
    state.abortRequest?.();
    throw new DOMException("The scripted request was cancelled.", "AbortError");
  }
  if (round.kind === "error") {
    const error = new Error(round.message) as Error & {
      code?: string | number;
    };
    error.code = round.code;
    throw error;
  }
  if (round.text) yield { text: round.text };
  if (round.toolCalls?.length) {
    const toolCalls = round.toolCalls.map((toolCall, index) => ({
      index,
      id: toolCall.id ?? `call_scripted_${state.round}_${index}`,
      name: toolCall.name,
      argumentsFragment:
        typeof toolCall.args === "string"
          ? toolCall.args
          : JSON.stringify(toolCall.args),
    }));
    state.toolCalls.push(
      ...toolCalls.map(({ id, name, argumentsFragment }) => ({
        id,
        name,
        arguments: argumentsFragment,
      })),
    );
    yield { toolCalls };
  }
  yield {
    finishReason:
      round.finishReason ??
      (round.toolCalls?.length ? "tool_calls" : "stop"),
    ...(round.usage ? { usage: round.usage } : {}),
  };
}

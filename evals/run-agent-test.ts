import { vi } from "vitest";
import type { StubScript } from "./stub-model";
import type {
  AgentEvent,
  Artifact,
} from "@/lib/agent/run";
import type { ChatMessage } from "@/lib/openrouter";

// Test harness — runs the agent loop against a stubbed model and stubbed tool
// dispatch, returns the full event stream + a few derived summary fields.
//
// Use vi.mock at the test file's TOP LEVEL (mocks must be hoisted) to wire
// the stub:
//
//   vi.mock("@/lib/openrouter", async (orig) => {
//     const m = await orig<typeof import("@/lib/openrouter")>();
//     return { ...m, streamChat: streamChatRef.current };
//   });
//
// Then call setStubScript(script) before each test to swap in the recipe.

// Module-level state the mocked streamChat reads from at call time, so tests
// can swap scripts between cases without re-mocking. We track the round
// counter HERE (not inside makeStubModel) because the loop calls streamChat()
// multiple times per turn, once per round — and each call must return the
// NEXT round of the script, not replay round 0.
const state: { script: StubScript; round: number } = {
  script: { rounds: [] },
  round: 0,
};

export function setStubScript(script: StubScript): void {
  state.script = script;
  state.round = 0;
}

// Returns a streamChat-shaped async generator that yields the NEXT round of
// the current script (state.round advances per call). Wire into vi.mock.
export async function* stubStreamChat(): AsyncGenerator<
  import("@/lib/openrouter").StreamDelta
> {
  const r = state.script.rounds[state.round] ?? { finishReason: "stop" as const };
  state.round++;
  if (r.throws) {
    const err = new Error(r.throws.message) as Error & { code?: string | number };
    if (r.throws.code !== undefined) err.code = r.throws.code;
    throw err;
  }
  if (r.text) {
    yield { text: r.text };
  }
  if (r.toolCalls && r.toolCalls.length > 0) {
    yield {
      toolCalls: r.toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id ?? `call_stub_${state.round}_${i}`,
        name: tc.name,
        argumentsFragment:
          typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args),
      })),
    };
  }
  yield {
    finishReason:
      r.finishReason ?? (r.toolCalls?.length ? "tool_calls" : "stop"),
    ...(r.usage ? { usage: r.usage } : {}),
  };
}

// In-memory tool dispatch — overrides what real tools would do. Keyed by tool
// name; returns a JSON-able result. Lets us simulate "voice profile exists"
// vs "doesn't" cases without touching the DB. Caller sets this per scenario.
const toolResults: Map<string, Record<string, unknown>> = new Map();

export function setToolResult(
  toolName: string,
  result: Record<string, unknown>,
): void {
  toolResults.set(toolName, result);
}

export function resetToolResults(): void {
  toolResults.clear();
}

// stub for runTool — returns the canned result by name, or a generic ok:true.
// `args` and `workspaceId` are accepted to match the real signature but the
// stub ignores them (assertions check tool_calls events for the args).
export async function stubRunTool(
  name: string,
  args: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  void args;
  void workspaceId;
  return toolResults.get(name) ?? { ok: true };
}

// stub for resolveCitedPosts — returns an empty array unless setCiteResults
// pre-populated. Mirrors the real fn's never-throws contract.
const citeResults: Map<string, { id: string; authorName: string; text: string }> =
  new Map();
export function setCiteResult(
  postId: string,
  card: { authorName?: string; text?: string } = {},
): void {
  citeResults.set(postId, {
    id: postId,
    authorName: card.authorName ?? "Stub Author",
    text: card.text ?? "Stub post text.",
  });
}
export function resetCiteResults(): void {
  citeResults.clear();
}
// `workspaceId` accepted to match the real signature; the stub doesn't need
// it (the resolution is keyed only on postId for tests).
export async function stubResolveCitedPosts(
  ids: string[],
  workspaceId: string,
): Promise<unknown[]> {
  void workspaceId;
  return ids
    .map((id) => citeResults.get(id))
    .filter((c): c is { id: string; authorName: string; text: string } => !!c)
    .map((c) => ({
      id: c.id,
      text: c.text,
      postUrl: null,
      postedAt: null,
      reactions: 0,
      comments: 0,
      reposts: 0,
      mediaType: "none",
      mediaUrls: [],
      visualKind: null,
      authorName: c.authorName,
      authorNiche: null,
      authorAvatar: null,
    }));
}

// Drive the agent loop with the current script + tool/cite stubs, collect all
// events, and return them for assertions.
//
// `streamedText` is the concatenation of `text` SSE deltas — this is what the
// client SEES while streaming, BEFORE its stripPostFences runs (so it can
// contain raw fences mid-stream; that's expected). `finalContent` is the
// `done` event's `message.content` — what gets PERSISTED to chat_messages,
// stripped server-side by stripArtifactFences. The "no raw fence" assertion
// checks `finalContent`, not `streamedText`.
export async function runStubbedAgent(
  history: ChatMessage[] = [{ role: "user", content: "test prompt" }],
): Promise<{
  events: AgentEvent[];
  streamedText: string;
  finalContent: string;
  artifacts: Artifact[];
  toolCalls: { name: string; args: string }[];
  toolResults: { name: string; ok: boolean }[];
  errors: { message: string; code?: string | number; recovery?: string }[];
  done: boolean;
}> {
  // Import lazily so vi.mock has taken effect.
  const { runAgent } = await import("@/lib/agent/run");

  const events: AgentEvent[] = [];
  for await (const ev of runAgent({
    history,
    workspaceId: "test-workspace",
  })) {
    events.push(ev);
  }
  let streamedText = "";
  let finalContent = "";
  const artifacts: Artifact[] = [];
  const toolCalls: { name: string; args: string }[] = [];
  const toolResultEvts: { name: string; ok: boolean }[] = [];
  const errors: {
    message: string;
    code?: string | number;
    recovery?: string;
  }[] = [];
  let done = false;
  for (const ev of events) {
    if (ev.type === "text") streamedText += ev.delta;
    else if (ev.type === "tool_start")
      toolCalls.push({ name: ev.name, args: ev.args });
    else if (ev.type === "tool_end")
      toolResultEvts.push({ name: ev.name, ok: ev.ok });
    else if (ev.type === "artifact") artifacts.push(ev.artifact);
    else if (ev.type === "error")
      errors.push({ message: ev.message, code: ev.code, recovery: ev.recovery });
    else if (ev.type === "done") {
      done = true;
      finalContent = ev.message.content;
    }
  }
  return {
    events,
    streamedText,
    finalContent,
    artifacts,
    toolCalls,
    toolResults: toolResultEvts,
    errors,
    done,
  };
}

// Reference-export for vi.mock to read at call time. Tests should NOT import
// this directly — they go through the helpers above.
export const __internal = { stubStreamChat, stubRunTool, stubResolveCitedPosts };
// vi is imported so vi.mock's typing works in tests that wire these stubs.
void vi;

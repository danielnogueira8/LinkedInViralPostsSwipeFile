import { vi } from "vitest";
import type { StubScript } from "./stub-model";
import type { AgentEvent, Artifact } from "@/lib/agent/contracts";
import type { ChatMessage, ToolCall } from "@/lib/openrouter";

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
const toolInvocations: Array<{ name: string; args: Record<string, unknown> }> = [];

export function setToolResult(
  toolName: string,
  result: Record<string, unknown>,
): void {
  toolResults.set(toolName, result);
}

export function resetToolResults(): void {
  toolResults.clear();
  toolInvocations.length = 0;
}

export function getToolInvocations(): Array<{
  name: string;
  args: Record<string, unknown>;
}> {
  return [...toolInvocations];
}

// stub for runTool — returns the canned result by name, or a generic ok:true.
// `args` and `workspaceId` are accepted to match the real signature but the
// stub ignores them (assertions check tool_calls events for the args).
export async function stubRunTool(
  name: string,
  args: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  toolInvocations.push({ name, args });
  void workspaceId;
  return toolResults.get(name) ?? { ok: true };
}

// stub for resolveCitedPosts — returns an empty array unless setCiteResults
// pre-populated. Mirrors the real fn's never-throws contract.
const citeResults: Map<string, { id: string; authorName: string; text: string; postUrl?: string }> =
  new Map();
export function setCiteResult(
  postId: string,
  card: { authorName?: string; text?: string; postUrl?: string } = {},
): void {
  citeResults.set(postId, {
    id: postId,
    authorName: card.authorName ?? "Stub Author",
    text: card.text ?? "Stub post text.",
    postUrl: card.postUrl,
  });
}
export function resetCiteResults(): void {
  citeResults.clear();
}
// Per-test stub for the Stop-button cancel poll. The loop calls
// isCancelRequested(chatId, turnStartedAt) between rounds + on each delta;
// setStubCancel(true) flips it on so the next poll trips. setStubCancel(false)
// in beforeEach for a clean slate per test.
let stubCancelled = false;
// Optional gate: cancel only AFTER this many isCancelRequested polls. Lets a
// test trip cancel during a specific PHASE — e.g. the forced-final completion,
// which only polls after the main loop's rounds. null = the simple boolean gate.
let stubCancelAfterPolls: number | null = null;
let stubCancelPollCount = 0;
export function setStubCancel(v: boolean): void {
  stubCancelled = v;
}
// Trip cancel only on the Nth+ poll (1-based). Use to cancel mid-forced-final:
// set N high enough to clear the main-loop rounds. Implies cancellation.
export function setStubCancelAfterPolls(n: number): void {
  stubCancelAfterPolls = n;
  stubCancelPollCount = 0;
}
export function resetStubCancel(): void {
  stubCancelled = false;
  stubCancelAfterPolls = null;
  stubCancelPollCount = 0;
}
export async function stubIsCancelRequested(): Promise<boolean> {
  stubCancelPollCount++;
  if (stubCancelAfterPolls !== null) {
    return stubCancelPollCount >= stubCancelAfterPolls;
  }
  return stubCancelled;
}

// Optional throw-hook for resolveCitedPosts, so a test can make cite resolution
// THROW (not just return []) — exercising the loop's inFlightTools cleanup +
// synthetic tool_end{ok:false} on a thrown tool dispatch. null = never throw.
let stubCiteThrow: Error | null = null;
export function setStubCiteThrow(err: Error | null): void {
  stubCiteThrow = err;
}
export function resetStubCiteThrow(): void {
  stubCiteThrow = null;
}

// `workspaceId` accepted to match the real signature; the stub doesn't need
// it (the resolution is keyed only on postId for tests).
export async function stubResolveCitedPosts(
  ids: string[],
  workspaceId: string,
): Promise<unknown[]> {
  void workspaceId;
  if (stubCiteThrow) throw stubCiteThrow;
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
  // Pass chatId to exercise the cancel-poll path (the loop only polls when
  // it's set). Tests that don't care about cancel can leave it undefined.
  chatId?: string,
  // Extra runAgent opts (e.g. isRefine, skipDecision) for tests that exercise
  // the refine-specific paths (1-draft cap, leaked-draft net).
  extraOpts?: { isRefine?: boolean; skipDecision?: boolean },
): Promise<{
  events: AgentEvent[];
  streamedText: string;
  finalContent: string;
  artifacts: Artifact[];
  toolCalls: { name: string; args: string }[];
  toolResults: { name: string; ok: boolean }[];
  errors: { message: string; code?: string | number; recovery?: string }[];
  finalToolCalls: ToolCall[] | null;
  done: boolean;
}> {
  // Import lazily so vi.mock has taken effect.
  const { runAgent } = await import("@/lib/agent");

  const events: AgentEvent[] = [];
  for await (const ev of runAgent({
    history,
    workspaceId: "test-workspace",
    chatId,
    ...extraOpts,
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
  let finalToolCalls: ToolCall[] | null = null;
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
      finalToolCalls = ev.message.tool_calls;
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
    finalToolCalls,
    done,
  };
}

// Reference-export for vi.mock to read at call time. Tests should NOT import
// this directly — they go through the helpers above.
export const __internal = {
  stubStreamChat,
  stubRunTool,
  stubResolveCitedPosts,
  stubIsCancelRequested,
};
// vi is imported so vi.mock's typing works in tests that wire these stubs.
void vi;

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  __internal,
  resetCiteResults,
  resetStubCancel,
  resetStubCiteThrow,
  resetToolResults,
  runStubbedAgent,
  setStubScript,
} from "../run-agent-test";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// Bug-hunt fix (task #190): when a round's tool_calls push totalToolCalls over
// MAX_TOTAL_TOOL_CALLS (40), the assistant message (WITH its tool_calls array)
// is appended to `working` BEFORE the cap check, then the loop breaks BEFORE
// the dispatch loop that would append matching `role: "tool"` responses. The
// forced-final call then reused that malformed `working` as-is — an assistant
// tool_calls entry with zero matching tool responses, the exact shape most
// OpenAI-compatible providers reject outright on transcript-shape validation.
// The bare catch{} around that call swallowed the failure silently, so the
// turn fell through to the generic "I reached my tool-use limit" fallback
// instead of ever attempting the intended graceful delivery.
//
// This captures the ACTUAL messages array sent to streamChat on every call
// (unlike the shared stub, which discards it) so we can assert the forced-
// final call's transcript is well-formed regardless of which round tripped
// the cap.
// ---------------------------------------------------------------------------

const capturedMessages: ChatMessage[][] = [];

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...orig,
    streamChat: (opts: { messages: ChatMessage[] }) => {
      capturedMessages.push(opts.messages);
      return __internal.stubStreamChat();
    },
    logOpenRouterUsage: async () => undefined,
  };
});
vi.mock("@/lib/agent/tools", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/agent/tools")>();
  return { ...orig, runTool: __internal.stubRunTool };
});
vi.mock("@/lib/cite-resolve", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/cite-resolve")>();
  return { ...orig, resolveCitedPosts: __internal.stubResolveCitedPosts };
});
vi.mock("@/lib/agent/cancel", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/agent/cancel")>();
  return { ...orig, isCancelRequested: __internal.stubIsCancelRequested };
});

beforeEach(() => {
  resetToolResults();
  resetCiteResults();
  resetStubCancel();
  resetStubCiteThrow();
  capturedMessages.length = 0;
});

// Every `role: "assistant"` message with a non-empty `tool_calls` array must
// be immediately followed by exactly one `role: "tool"` message per call id —
// the shape every OpenAI-compatible provider requires. Used to assert BOTH
// the main-loop transcript and (critically) the forced-final call's own
// transcript are well-formed.
function assertWellFormedToolProtocol(messages: ChatMessage[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const ids = m.tool_calls.map((tc) => tc.id);
    const following = messages.slice(i + 1, i + 1 + ids.length);
    expect(
      following.every(
        (f, idx) => f.role === "tool" && f.tool_call_id === ids[idx],
      ),
      `assistant message at index ${i} has tool_calls [${ids.join(", ")}] with no matching tool responses immediately following — malformed transcript shape`,
    ).toBe(true);
  }
}

describe("forced-final call after MAX_TOTAL_TOOL_CALLS — transcript shape (bug-hunt fix #190)", () => {
  test("a single round emitting enough tool_calls to trip the cap still produces a well-formed forced-final transcript", async () => {
    // One round with 41 tool_calls (> MAX_TOTAL_TOOL_CALLS=40) trips the cap
    // on round 0 itself — the break happens before ANY of them are
    // dispatched, so `working`'s last message is exactly the malformed shape
    // this bug produces: 41 tool_calls, 0 matching tool responses.
    const manyToolCalls = Array.from({ length: 41 }, (_, i) => ({
      name: "search_viral_posts",
      args: { niche: `topic-${i}` },
    }));
    setStubScript({
      rounds: [
        { toolCalls: manyToolCalls, finishReason: "tool_calls" },
        // The forced-final call itself (no tools) — a plain text reply.
        { text: "Here is your post.\n\nSecond line.", finishReason: "stop" },
      ],
    });

    const turn = await runStubbedAgent([
      { role: "user", content: "Find me a great post idea and write it up" },
    ]);

    // Two streamChat calls happened: the capped main-loop round, then the
    // forced-final call. Assert the SECOND one (the forced-final call) has a
    // well-formed transcript — this is the exact call the bug corrupted.
    expect(capturedMessages.length).toBeGreaterThanOrEqual(2);
    const forcedFinalMessages = capturedMessages[capturedMessages.length - 1];
    assertWellFormedToolProtocol(forcedFinalMessages);

    // The malformed assistant message (41 tool_calls, no responses) must not
    // survive verbatim into the forced-final transcript — it's either
    // stripped down to text-only or dropped, never left with its orphaned
    // tool_calls array intact.
    const lastAssistantWithCalls = [...forcedFinalMessages]
      .reverse()
      .find((m) => m.role === "assistant" && m.tool_calls?.length);
    if (lastAssistantWithCalls) {
      // If any assistant/tool_calls message survived, it must have its
      // matching tool responses immediately after (checked above) — i.e. it
      // is NOT the orphaned 41-call message from the capped round.
      expect(lastAssistantWithCalls.tool_calls?.length).not.toBe(41);
    }

    // The turn still completed and produced a real reply (didn't crash).
    expect(turn.finalContent.length).toBeGreaterThan(0);
  });

  test("a normal round with fully-resolved tool_calls is untouched by the sanitizer", async () => {
    // Sanity check: a WELL-FORMED transcript (tool_calls immediately followed
    // by matching tool responses) must survive the forced-final call intact —
    // sanitizeToolProtocolHistory only strips orphaned calls, never legitimate
    // completed ones.
    setStubScript({
      rounds: [
        {
          toolCalls: [{ name: "get_voice", args: {} }],
          finishReason: "tool_calls",
        },
        { text: "Final answer.", finishReason: "stop" },
      ],
    });

    await runStubbedAgent([
      { role: "user", content: "Write me a post" },
    ]);

    // Every call's transcript must be well-formed — this run never hits the
    // tool cap, so this just confirms the sanitizer (now unconditionally
    // applied) doesn't corrupt a normal, healthy transcript.
    for (const messages of capturedMessages) {
      assertWellFormedToolProtocol(messages);
    }
  });
});

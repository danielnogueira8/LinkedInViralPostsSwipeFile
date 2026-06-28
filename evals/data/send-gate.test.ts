import { describe, test, expect } from "vitest";
import {
  shouldAcceptSend,
  SEND_DEDUPE_WINDOW_MS,
} from "@/app/(app)/dashboard/chat-workspace";

// ---------------------------------------------------------------------------
// The send-gate decision (chat-workspace.tsx shouldAcceptSend). Each layer here
// is behind a real shipped bug: the in-flight lock + 10s dedupe guard the
// rapid-double-submit cost incident (#346), and the Stop→Send fix relies on the
// lock NOT outliving the stream. These pin the accept/reject logic precisely.
// ---------------------------------------------------------------------------

const base = {
  lockKey: "chat-1",
  text: "hello",
  now: 1_000_000,
  inFlight: new Set<string>(),
  lastSend: undefined,
  runStreaming: false,
};

describe("shouldAcceptSend", () => {
  test("a fresh send is accepted", () => {
    expect(shouldAcceptSend(base)).toEqual({ accept: true, reason: "ok" });
  });

  test("rejects when this chat already has an in-flight send (the sync lock)", () => {
    expect(
      shouldAcceptSend({ ...base, inFlight: new Set(["chat-1"]) }),
    ).toEqual({ accept: false, reason: "in-flight" });
  });

  test("a lock on a DIFFERENT chat doesn't block this one", () => {
    expect(
      shouldAcceptSend({ ...base, inFlight: new Set(["other-chat"]) }),
    ).toEqual({ accept: true, reason: "ok" });
  });

  test("rejects when the chat is currently streaming", () => {
    expect(shouldAcceptSend({ ...base, runStreaming: true })).toEqual({
      accept: false,
      reason: "streaming",
    });
  });

  test("rejects an identical resend within the dedupe window", () => {
    expect(
      shouldAcceptSend({
        ...base,
        lastSend: { text: "hello", at: base.now - (SEND_DEDUPE_WINDOW_MS - 1) },
      }),
    ).toEqual({ accept: false, reason: "duplicate" });
  });

  test("accepts an identical resend AFTER the dedupe window (deliberate retry)", () => {
    expect(
      shouldAcceptSend({
        ...base,
        lastSend: { text: "hello", at: base.now - (SEND_DEDUPE_WINDOW_MS + 1) },
      }),
    ).toEqual({ accept: true, reason: "ok" });
  });

  test("accepts DIFFERENT text even within the window (an edited message)", () => {
    expect(
      shouldAcceptSend({
        ...base,
        text: "hello there",
        lastSend: { text: "hello", at: base.now - 500 },
      }),
    ).toEqual({ accept: true, reason: "ok" });
  });

  test("the lock takes precedence over the dedupe check (order matters)", () => {
    // Both an in-flight lock AND a duplicate — the lock reason wins (it's checked
    // first), which is the send()-equivalent behavior.
    expect(
      shouldAcceptSend({
        ...base,
        inFlight: new Set(["chat-1"]),
        lastSend: { text: "hello", at: base.now - 100 },
      }),
    ).toEqual({ accept: false, reason: "in-flight" });
  });

  test("the Stop→resend case: cleared lastSend lets the same text resend immediately", () => {
    // stopActiveRun deletes the chat's lastSend entry, so an immediate resend of
    // the SAME text is accepted (no longer dropped by the dedupe). Modeled by
    // lastSend === undefined.
    expect(
      shouldAcceptSend({ ...base, lastSend: undefined, runStreaming: false }),
    ).toEqual({ accept: true, reason: "ok" });
  });
});

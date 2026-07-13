import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CHAT_SEND_DEDUPE_WINDOW_MS,
  ChatSession,
  type ChatSendLease,
} from "@/lib/chat-session";

type Run = { streaming: boolean; ctrl: AbortController };
const createSession = () => new ChatSession<never, never, Run>();

afterEach(() => vi.restoreAllMocks());

describe("ChatSession.send", () => {
  test("accepts a fresh send and holds the lock until its lease is released", async () => {
    const session = createSession();
    const lease = await session.send({ lockKey: "chat-1", text: "hello" }) as ChatSendLease;
    expect(lease).toBeDefined();
    expect(await session.send({ lockKey: "chat-1", text: "different" })).toBeUndefined();
    lease.release();
  });

  test("a lock on a different chat does not block this conversation", async () => {
    const session = createSession();
    const first = await session.send({ lockKey: "chat-1", text: "hello" }) as ChatSendLease;
    const second = await session.send({ lockKey: "chat-2", text: "hello" });
    expect(second).toBeDefined();
    first.release();
  });

  test("rejects a conversation that already has a streaming run", async () => {
    const session = createSession();
    session.registerRun("chat-1", { streaming: true, ctrl: new AbortController() });
    expect(await session.send({ lockKey: "chat-1", text: "hello" })).toBeUndefined();
  });

  test("rejects an identical resend inside the dedupe window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const session = createSession();
    const lease = await session.send({ lockKey: "chat-1", text: "hello" }) as ChatSendLease;
    lease.release();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000 + CHAT_SEND_DEDUPE_WINDOW_MS - 1);
    expect(await session.send({ lockKey: "chat-1", text: "hello" })).toBeUndefined();
  });

  test("accepts the same text after the window and edited text immediately", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const session = createSession();
    const first = await session.send({ lockKey: "chat-1", text: "hello" }) as ChatSendLease;
    first.release();
    expect(await session.send({ lockKey: "chat-1", text: "edited" })).toBeDefined();
    session.releaseSend("chat-1");
    vi.spyOn(Date, "now").mockReturnValue(1_000_000 + CHAT_SEND_DEDUPE_WINDOW_MS + 1);
    expect(await session.send({ lockKey: "chat-1", text: "hello" })).toBeDefined();
  });

  test("stop clears dedupe so the same prompt can be resent immediately", async () => {
    const session = createSession();
    const lease = await session.send({ lockKey: "chat-1", text: "hello" }) as ChatSendLease;
    lease.release();
    session.stop("chat-1");
    expect(await session.send({ lockKey: "chat-1", text: "hello" })).toBeDefined();
  });
});

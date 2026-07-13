import { describe, expect, it, vi } from "vitest";
import { ChatSession, consumeChatSSE } from "@/lib/chat-session";

type Message = { id: string; text: string };
type Artifact = { id: string };
type Run = {
  streaming: boolean;
  ctrl: AbortController;
  turnStartedAt?: string;
  overlay: Message[];
};

describe("ChatSession", () => {
  it("publishes selected conversation snapshots after canonical loading", async () => {
    const session = new ChatSession<Message, Artifact, Run>();
    const revisions: number[] = [];
    session.subscribe(() => revisions.push(session.snapshot().revision));

    await session.select("chat-1", async () => ({
      messages: [{ id: "m1", text: "hello" }],
      artifacts: [{ id: "a1" }],
      running: true,
      livePlan: [{ step: "Research" }],
    }));

    const snapshot = session.snapshot();
    expect(snapshot.activeId).toBe("chat-1");
    expect(snapshot.loadingChatId).toBeNull();
    expect(snapshot.reattachingChatId).toBe("chat-1");
    expect(snapshot.baseByChat.get("chat-1")).toEqual([{ id: "m1", text: "hello" }]);
    expect(revisions.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps background runs alive when another conversation is selected", async () => {
    const session = new ChatSession<Message, Artifact, Run>();
    const run = { streaming: true, ctrl: new AbortController(), overlay: [] };
    session.registerRun("chat-1", run);

    await session.select("chat-2", async () => ({ messages: [], artifacts: [] }));

    expect(session.snapshot().activeId).toBe("chat-2");
    expect(session.snapshot().runsByChat.get("chat-1")).toBe(run);
    expect(run.ctrl.signal.aborted).toBe(false);
  });

  it("does not let a slow prior selection replace the active reattach state", async () => {
    const session = new ChatSession<Message, Artifact, Run>();
    let resolveFirst!: (value: {
      messages: Message[];
      artifacts: Artifact[];
      running: boolean;
      livePlan: unknown[];
    }) => void;
    const first = session.select("chat-1", () => new Promise((resolve) => {
      resolveFirst = resolve;
    }));
    await session.select("chat-2", async () => ({
      messages: [],
      artifacts: [],
      running: true,
      livePlan: [{ step: "Current" }],
    }));

    resolveFirst({
      messages: [],
      artifacts: [],
      running: true,
      livePlan: [{ step: "Stale" }],
    });
    await first;

    expect(session.snapshot().activeId).toBe("chat-2");
    expect(session.snapshot().reattachingChatId).toBe("chat-2");
    expect(session.snapshot().reattachPlan).toEqual([{ step: "Current" }]);
  });

  it("deduplicates concurrent and rapid identical send commands", async () => {
    const session = new ChatSession<Message, Artifact, Run>();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => pending);

    const first = session.send({ lockKey: "chat-1", text: "draft", execute });
    const duplicate = await session.send({ lockKey: "chat-1", text: "draft", execute });
    expect(duplicate).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(await session.send({ lockKey: "chat-1", text: "draft", execute })).toBeUndefined();
  });

  it("stops only the owned run, folds its overlay, and sends the turn token", () => {
    const session = new ChatSession<Message, Artifact, Run>({
      activeId: "chat-1",
      initialMessages: [{ id: "base", text: "before" }],
    });
    const run = {
      streaming: true,
      ctrl: new AbortController(),
      turnStartedAt: "2026-07-13T10:00:00Z",
      overlay: [{ id: "live", text: "partial" }],
    };
    const serverStop = vi.fn(async () => undefined);
    session.registerRun("chat-1", run);

    session.stop("chat-1", {
      foldRun: (ownedRun, base) => [...base, ...ownedRun.overlay],
      serverStop,
    });

    expect(run.ctrl.signal.aborted).toBe(true);
    expect(session.snapshot().runsByChat.has("chat-1")).toBe(false);
    expect(session.snapshot().baseByChat.get("chat-1")).toHaveLength(2);
    expect(serverStop).toHaveBeenCalledWith("2026-07-13T10:00:00Z");
  });

  it("rejects a stale canonical handoff after an immediate follow-up takes ownership", () => {
    const session = new ChatSession<Message, Artifact, Run>({ activeId: "chat-1" });
    const first = { streaming: false, ctrl: new AbortController(), overlay: [] };
    const followUp = { streaming: true, ctrl: new AbortController(), overlay: [] };
    session.registerRun("chat-1", first);
    session.registerRun("chat-1", followUp);

    expect(session.reconcileOwned(
      "chat-1",
      first,
      [{ id: "stale", text: "old canonical reply" }],
      [],
    )).toBe(false);
    expect(session.retireRun("chat-1", first)).toBe(false);
    expect(session.snapshot().runsByChat.get("chat-1")).toBe(followUp);
    expect(session.snapshot().baseByChat.get("chat-1") ?? []).toEqual([]);
  });

  it("atomically hands an owned run to its canonical snapshot", () => {
    const session = new ChatSession<Message, Artifact, Run>({ activeId: "chat-1" });
    const run = { streaming: false, ctrl: new AbortController(), overlay: [] };
    session.registerRun("chat-1", run);
    const observed: Array<{ base: number; hasRun: boolean }> = [];
    session.subscribe(() => observed.push({
      base: session.snapshot().baseByChat.get("chat-1")?.length ?? 0,
      hasRun: session.snapshot().runsByChat.has("chat-1"),
    }));

    expect(session.completeRun(
      "chat-1",
      run,
      [{ id: "persisted", text: "canonical reply" }],
      [{ id: "draft" }],
    )).toBe(true);
    expect(session.snapshot().baseByChat.get("chat-1")).toEqual([
      { id: "persisted", text: "canonical reply" },
    ]);
    expect(session.snapshot().artifactsByChat.get("chat-1")).toEqual([{ id: "draft" }]);
    expect(observed).toEqual([{ base: 1, hasRun: false }]);
  });
});

describe("consumeChatSSE", () => {
  it("parses CRLF and multi-line data frames", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: text\r\ndata: {"delta":\r\ndata: "hello"}\r\n\r\n'));
        controller.close();
      },
    });
    const events: unknown[] = [];
    await consumeChatSSE(body, (event, data) => events.push({ event, data }));
    expect(events).toEqual([{ event: "text", data: { delta: "hello" } }]);
  });

  it("parses a frame when CRLF is split across stream chunks", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: text\r'));
        controller.enqueue(encoder.encode('\ndata: {"delta":"split"}\r'));
        controller.enqueue(encoder.encode('\n\r'));
        controller.enqueue(encoder.encode('\n'));
        controller.close();
      },
    });
    const events: unknown[] = [];
    await consumeChatSSE(body, (event, data) => events.push({ event, data }));
    expect(events).toEqual([{ event: "text", data: { delta: "split" } }]);
  });

  it("cancels a pending reader when the run is aborted", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const ctrl = new AbortController();
    const consuming = consumeChatSSE(body, () => {}, ctrl.signal);
    ctrl.abort();
    await consuming;
    expect(cancelled).toBe(true);
  });
});

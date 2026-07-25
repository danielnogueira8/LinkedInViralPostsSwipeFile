import { describe, expect, it, vi } from "vitest";
import {
  ChatSession,
  consumeChatSSE,
  fetchChatStream,
  type ChatSendLease,
} from "@/lib/chat-session";
import {
  configuredSseHeartbeatInterval,
  startSseHeartbeat,
} from "@/lib/transport/sse-heartbeat";

type Message = { id: string; text: string };
type Artifact = { id: string };
type Run = {
  streaming: boolean;
  ctrl: AbortController;
  clientTurnId?: string;
  stopPending?: boolean;
  turnStartedAt?: string;
  recoverable?: boolean;
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
    expect(snapshot).not.toHaveProperty("baseByChat");
    expect(snapshot).not.toHaveProperty("artifactsByChat");
    expect(snapshot).not.toHaveProperty("runsByChat");
    expect(session.baseMessages("chat-1")).toEqual([{ id: "m1", text: "hello" }]);
    expect(session.artifactsFor("chat-1")).toEqual([{ id: "a1" }]);
    expect(revisions.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps background runs alive when another conversation is selected", async () => {
    const session = new ChatSession<Message, Artifact, Run>();
    const run = { streaming: true, ctrl: new AbortController(), overlay: [] };
    session.beginTurn("chat-1", run);

    await session.select("chat-2", async () => ({ messages: [], artifacts: [] }));

    expect(session.snapshot().activeId).toBe("chat-2");
    expect(session.runFor("chat-1")).toBe(run);
    expect(session.streamingRunIds()).toEqual(new Set(["chat-1"]));
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

  it("allows an explicit immediate Retry while preserving live-run ownership", async () => {
    const session = new ChatSession<Message, Artifact, Run>();
    const first = (await session.send({
      lockKey: "chat-1",
      text: "draft",
    })) as ChatSendLease | undefined;
    expect(first).toBeDefined();
    first?.release();

    const retry = (await session.send({
      lockKey: "chat-1",
      text: "draft",
      bypassDedupeWindow: true,
    })) as ChatSendLease | undefined;
    expect(retry).toBeDefined();
    retry?.release();

    session.beginTurn("chat-1", {
      streaming: true,
      ctrl: new AbortController(),
      overlay: [],
    });
    expect(
      await session.send({
        lockKey: "chat-1",
        text: "draft",
        bypassDedupeWindow: true,
      }),
    ).toBeUndefined();
  });

  it("retires and folds a run only after the server confirms Stop", async () => {
    const session = new ChatSession<Message, Artifact, Run>({
      activeId: "chat-1",
      initialMessages: [{ id: "base", text: "before" }],
    });
    const run: Run = {
      streaming: true,
      ctrl: new AbortController(),
      clientTurnId: "00000000-0000-4000-8000-000000000701",
      turnStartedAt: "2026-07-13T10:00:00Z",
      recoverable: true,
      overlay: [{ id: "live", text: "partial" }],
    };
    const serverStop = vi.fn(async () => undefined);
    session.beginTurn("chat-1", run);

    const stopped = await session.stop("chat-1", {
      onStopConfirmed: (ownedRun) => {
        ownedRun.recoverable = undefined;
      },
      foldRun: (ownedRun, base) => [...base, ...ownedRun.overlay],
      serverStop,
    });

    expect(stopped).toBe(true);
    expect(run.ctrl.signal.aborted).toBe(true);
    expect(run.recoverable).toBeUndefined();
    expect(session.hasRun("chat-1")).toBe(false);
    expect(session.baseMessages("chat-1")).toHaveLength(2);
    expect(serverStop).toHaveBeenCalledWith({
      clientTurnId: "00000000-0000-4000-8000-000000000701",
      turnStartedAt: "2026-07-13T10:00:00Z",
    });
  });

  it("keeps an unconfirmed Stop visible and retryable", async () => {
    const session = new ChatSession<Message, Artifact, Run>({ activeId: "chat-1" });
    const run: Run = {
      streaming: true,
      ctrl: new AbortController(),
      clientTurnId: "00000000-0000-4000-8000-000000000701",
      overlay: [{ id: "live", text: "partial" }],
    };
    session.beginTurn("chat-1", run);

    const stopped = await session.stop("chat-1", {
      serverStop: async () => {
        throw new Error("network unavailable");
      },
      onStopFailure: (ownedRun) => {
        ownedRun.overlay = [{ id: "warning", text: "Stop not confirmed" }];
      },
    });

    expect(stopped).toBe(false);
    expect(run.ctrl.signal.aborted).toBe(true);
    expect(run.stopPending).toBe(false);
    expect(run.streaming).toBe(true);
    expect(session.runFor("chat-1")).toBe(run);
    expect(run.overlay).toEqual([{ id: "warning", text: "Stop not confirmed" }]);
  });

  it("reconciles a turn that completed just before the Stop fence", async () => {
    const session = new ChatSession<Message, Artifact, Run>({ activeId: "chat-1" });
    const run: Run = {
      streaming: true,
      ctrl: new AbortController(),
      clientTurnId: "00000000-0000-4000-8000-000000000701",
      overlay: [{ id: "live", text: "partial" }],
    };
    const turn = session.beginTurn("chat-1", run);
    const canonical = [{ id: "done", text: "Completed before Stop" }];

    const settled = await session.stop("chat-1", {
      serverStop: async () => {
        throw new Error("no active turn");
      },
      onStopFailure: async (ownedRun) => {
        expect(ownedRun).toBe(run);
        turn.complete(canonical, []);
      },
    });

    expect(settled).toBe(true);
    expect(session.hasRun("chat-1")).toBe(false);
    expect(session.baseMessages("chat-1")).toEqual(canonical);
  });

  it("rejects a stale canonical handoff after an immediate follow-up takes ownership", () => {
    const session = new ChatSession<Message, Artifact, Run>({ activeId: "chat-1" });
    const first = { streaming: false, ctrl: new AbortController(), overlay: [] };
    const followUp = { streaming: true, ctrl: new AbortController(), overlay: [] };
    const firstTurn = session.beginTurn("chat-1", first);
    session.beginTurn("chat-1", followUp);

    expect(firstTurn.reconcile(
      [{ id: "stale", text: "old canonical reply" }],
      [],
    )).toBe(false);
    expect(firstTurn.retire()).toBe(false);
    expect(session.runFor("chat-1")).toBe(followUp);
    expect(session.baseMessages("chat-1")).toEqual([]);
  });

  it("rejects an artifact rollback when a replacement run took ownership", () => {
    const session = new ChatSession<Message, Artifact, Run>({ activeId: "chat-1" });
    const first = { streaming: true, ctrl: new AbortController(), overlay: [] };
    const replacement = {
      streaming: true,
      ctrl: new AbortController(),
      overlay: [{ id: "replacement", text: "new owner's artifact" }],
    };
    const firstTurn = session.beginTurn("chat-1", first);
    session.beginTurn("chat-1", replacement);

    expect(firstTurn.update((owned) => {
      owned.overlay = [{ id: "deleted", text: "old artifact rollback" }];
    })).toBe(false);
    expect(session.runFor("chat-1")?.overlay).toEqual(replacement.overlay);
  });

  it("atomically hands an owned run to its canonical snapshot", () => {
    const session = new ChatSession<Message, Artifact, Run>({ activeId: "chat-1" });
    const run = { streaming: false, ctrl: new AbortController(), overlay: [] };
    const turn = session.beginTurn("chat-1", run);
    const observed: Array<{ base: number; hasRun: boolean }> = [];
    session.subscribe(() => observed.push({
      base: session.baseMessages("chat-1").length,
      hasRun: session.hasRun("chat-1"),
    }));

    expect(turn.complete(
      [{ id: "persisted", text: "canonical reply" }],
      [{ id: "draft" }],
    )).toBe(true);
    expect(session.baseMessages("chat-1")).toEqual([
      { id: "persisted", text: "canonical reply" },
    ]);
    expect(session.artifactsFor("chat-1")).toEqual([{ id: "draft" }]);
    expect(observed).toEqual([{ base: 1, hasRun: false }]);
  });

  it("encapsulates one turn's ownership through a stale-safe transaction", async () => {
    const session = new ChatSession<Message, Artifact, Run>({ activeId: "chat-1" });
    const firstRun = { streaming: true, ctrl: new AbortController(), overlay: [] };
    const firstTurn = session.beginTurn("chat-1", firstRun);

    expect(firstTurn.isCurrent()).toBe(true);
    expect(firstTurn.update((run) => {
      run.overlay = [{ id: "live", text: "first response" }];
    })).toBe(true);

    const replacementRun = {
      streaming: true,
      ctrl: new AbortController(),
      overlay: [{ id: "replacement", text: "new response" }],
    };
    const replacementTurn = session.beginTurn("chat-1", replacementRun);

    expect(firstTurn.isCurrent()).toBe(false);
    expect(firstTurn.update((run) => {
      run.overlay = [{ id: "stale", text: "must not land" }];
    })).toBe(false);
    expect(firstTurn.complete(
      [{ id: "stale", text: "old canonical response" }],
      [],
    )).toBe(false);
    expect(firstTurn.retire()).toBe(false);

    expect(replacementTurn.complete(
      [{ id: "canonical", text: "new canonical response" }],
      [{ id: "draft" }],
    )).toBe(true);
    expect(session.baseMessages("chat-1")).toEqual([
      { id: "canonical", text: "new canonical response" },
    ]);
    expect(session.artifactsFor("chat-1")).toEqual([{ id: "draft" }]);
    expect(session.hasRun("chat-1")).toBe(false);
  });
});

describe("consumeChatSSE", () => {
  it("falls back from invalid heartbeat configuration instead of hot-looping", () => {
    expect(configuredSseHeartbeatInterval(Number.NaN)).toBe(15_000);
    expect(configuredSseHeartbeatInterval(0)).toBe(15_000);
    expect(configuredSseHeartbeatInterval(-1)).toBe(15_000);
    expect(configuredSseHeartbeatInterval(60_000)).toBe(15_000);
    expect(configuredSseHeartbeatInterval(12_000)).toBe(12_000);
  });

  it("keeps a silent model round alive until its terminal event arrives", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const events: unknown[] = [];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const stopHeartbeat = startSseHeartbeat({
            intervalMs: 5,
            write: () => controller.enqueue(encoder.encode(": heartbeat\n\n")),
          });
          setTimeout(() => {
            controller.enqueue(
              encoder.encode('event: done\ndata: {"artifacts":[]}\n\n'),
            );
            stopHeartbeat();
            controller.close();
          }, 40);
        },
      });

      const result = consumeChatSSE(
        body,
        (event, data) => events.push({ event, data }),
        undefined,
        { idleTimeoutMs: 12 },
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toEqual({ ok: true });
      expect(events).toEqual([
        { event: "done", data: { artifacts: [] } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses CRLF and multi-line data frames", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: text\r\ndata: {"delta":\r\ndata: "hello"}\r\n\r\n'));
        controller.enqueue(encoder.encode('event: done\r\ndata: {"artifacts":[]}\r\n\r\n'));
        controller.close();
      },
    });
    const events: unknown[] = [];
    await consumeChatSSE(body, (event, data) => events.push({ event, data }));
    expect(events).toEqual([
      { event: "text", data: { delta: "hello" } },
      { event: "done", data: { artifacts: [] } },
    ]);
  });

  it("parses a frame when CRLF is split across stream chunks", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: text\r'));
        controller.enqueue(encoder.encode('\ndata: {"delta":"split"}\r'));
        controller.enqueue(encoder.encode('\n\r'));
        controller.enqueue(encoder.encode('\n'));
        controller.enqueue(encoder.encode('event: done\ndata: {"artifacts":[]}\n\n'));
        controller.close();
      },
    });
    const events: unknown[] = [];
    await consumeChatSSE(body, (event, data) => events.push({ event, data }));
    expect(events).toEqual([
      { event: "text", data: { delta: "split" } },
      { event: "done", data: { artifacts: [] } },
    ]);
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

  it("fails recoverably when an open stream stops producing frames", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });

    await expect(
      consumeChatSSE(body, () => {}, undefined, { idleTimeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "stream_stalled" });
    expect(cancelled).toBe(true);
  });

  it("rejects an EOF that arrives without a terminal done or error frame", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: text\ndata: {"delta":"partial"}\n\n'),
        );
        controller.close();
      },
    });

    await expect(
      consumeChatSSE(body, () => {}),
    ).rejects.toMatchObject({ code: "stream_ended_early" });
  });

  it("still requires done after a recoverable error frame", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: error\ndata: {"code":"stream_stalled","message":"quiet","recovery":"continue"}\n\n',
          ),
        );
        controller.close();
      },
    });

    await expect(
      consumeChatSSE(body, () => {}),
    ).rejects.toMatchObject({ code: "stream_ended_early" });
  });
});

describe("fetchChatStream", () => {
  it("aborts and classifies a request that never reaches response headers", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
    );

    await expect(
      fetchChatStream(
        "/api/chats/chat-1/stream",
        { method: "POST" },
        new AbortController().signal,
        { timeoutMs: 5, fetchImpl: fetchImpl as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "stream_stalled" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("disarms the start deadline once response headers arrive", async () => {
    let requestSignal: AbortSignal | null = null;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      return Promise.resolve(new Response("started"));
    });

    await fetchChatStream(
      "/api/chats/chat-1/stream",
      { method: "POST" },
      new AbortController().signal,
      { timeoutMs: 5, fetchImpl: fetchImpl as typeof fetch },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect((requestSignal as AbortSignal | null)?.aborted).toBe(false);
  });
});

import { parseChatSseFrame } from "@/lib/transport/contracts";

/**
 * Framework-independent client runtime for Cowork chat sessions.
 *
 * React subscribes to snapshots; this object owns the mutable concurrency state
 * that must survive conversation switches and long-running stream callbacks.
 */
export type ChatSessionRun = {
  streaming: boolean;
  ctrl: AbortController;
  clientTurnId?: string;
  stopPending?: boolean;
  turnStartedAt?: string;
};

export type ChatSessionSnapshot = {
  revision: number;
  activeId: string | null;
  loadingChatId: string | null;
  reattachingChatId: string | null;
  reattachPlan: readonly unknown[];
};

export type LoadedConversation<Message, Artifact> = {
  messages: Message[];
  artifacts: Artifact[];
  running?: boolean;
  livePlan?: readonly unknown[];
};

type SendCommand<Result> = {
  lockKey: string;
  text: string;
  execute?: () => Promise<Result>;
  dedupeWindowMs?: number;
  bypassDedupeWindow?: boolean;
};

export type ChatSendLease = { release: () => void };
export const CHAT_SEND_DEDUPE_WINDOW_MS = 10_000;
export const CHAT_STREAM_IDLE_TIMEOUT_MS = 55_000;

export class ChatStreamError extends Error {
  readonly code: "stream_stalled" | "stream_ended_early";

  constructor(
    code: "stream_stalled" | "stream_ended_early",
    message: string,
  ) {
    super(message);
    this.name = "ChatStreamError";
    this.code = code;
  }
}

export async function fetchChatStream(
  input: RequestInfo | URL,
  init: RequestInit,
  signal: AbortSignal,
  options: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Response> {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, options.timeoutMs ?? CHAT_STREAM_IDLE_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);
  try {
    return await (options.fetchImpl ?? fetch)(input, {
      ...init,
      signal: combinedSignal,
    });
  } catch (error) {
    if (timedOut && !signal.aborted) {
      throw new ChatStreamError(
        "stream_stalled",
        "Cowork took too long to start the response.",
      );
    }
    throw error;
  } finally {
    // This deadline covers only time-to-response-headers. Once fetch resolves,
    // the SSE body owns its own reset-on-each-frame idle watchdog below; leaving
    // this timer armed would accidentally impose a total turn-duration cap.
    clearTimeout(timer);
  }
}

export function normalizeLivePlan(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value): PlanStep[] => {
    if (!value || typeof value !== "object") return [];
    const step = value as Record<string, unknown>;
    const status = step.status === "pending" || step.status === "active" || step.status === "done"
      ? step.status
      : null;
    return typeof step.id === "string" && typeof step.label === "string" && status
      ? [{ id: step.id, label: step.label, status }]
      : [];
  });
}

type StopOptions<Message, Run extends ChatSessionRun> = {
  foldRun?: (run: Run, base: readonly Message[]) => Message[];
  onStopConfirmed?: (run: Run) => void;
  onStopFailure?: (run: Run) => void | Promise<void>;
  serverStop?: (identity: {
    clientTurnId?: string;
    turnStartedAt?: string;
  }) => Promise<unknown>;
};

export class ChatSession<
  Message,
  Artifact,
  Run extends ChatSessionRun,
> {
  private revision = 0;
  private activeId: string | null;
  private loadingChatId: string | null = null;
  private reattachingChatId: string | null = null;
  private reattachPlan: readonly unknown[] = [];
  private readonly base = new Map<string, Message[]>();
  private readonly artifacts = new Map<string, Artifact[]>();
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<() => void>();
  private readonly inFlight = new Set<string>();
  private readonly lastSend = new Map<string, { text: string; at: number }>();
  private snapshotValue: ChatSessionSnapshot;

  constructor(options: {
    activeId?: string | null;
    initialMessages?: Message[];
    initialArtifacts?: Artifact[];
  } = {}) {
    this.activeId = options.activeId ?? null;
    if (this.activeId) {
      this.base.set(this.activeId, options.initialMessages ?? []);
      this.artifacts.set(this.activeId, options.initialArtifacts ?? []);
    }
    this.snapshotValue = this.createSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): ChatSessionSnapshot => this.snapshotValue;

  baseMessages(id: string | null): readonly Message[] {
    return id ? (this.base.get(id) ?? []) : [];
  }

  artifactsFor(id: string | null): readonly Artifact[] {
    return id ? (this.artifacts.get(id) ?? []) : [];
  }

  runFor(id: string | null): Readonly<Run> | undefined {
    return id ? this.runs.get(id) : undefined;
  }

  hasRun(id: string): boolean {
    return this.runs.has(id);
  }

  streamingRunIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const [id, run] of this.runs) {
      if (run.streaming) ids.add(id);
    }
    return ids;
  }

  selectLocal(id: string | null): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.publish();
  }

  async select(
    id: string,
    load: () => Promise<LoadedConversation<Message, Artifact>>,
    maxCached = 30,
  ): Promise<LoadedConversation<Message, Artifact>> {
    this.activeId = id;
    if (!this.hasVisibleContent(id)) this.loadingChatId = id;
    this.publish();
    try {
      const loaded = await load();
      this.reconcile(id, loaded.messages, loaded.artifacts);
      const reattaching = loaded.running === true && !this.runs.has(id);
      if (this.activeId === id) {
        this.reattachingChatId = reattaching
          ? id
          : this.reattachingChatId === id
            ? null
            : this.reattachingChatId;
        if (reattaching) this.reattachPlan = loaded.livePlan ?? [];
      }
      this.evict(maxCached, id);
      return loaded;
    } finally {
      if (this.loadingChatId === id) this.loadingChatId = null;
      this.publish();
    }
  }

  async send<Result>(
    command: SendCommand<Result>,
  ): Promise<Result | ChatSendLease | undefined> {
    const now = Date.now();
    const prior = this.lastSend.get(command.lockKey);
    const windowMs = command.dedupeWindowMs ?? CHAT_SEND_DEDUPE_WINDOW_MS;
    if (
      this.inFlight.has(command.lockKey) ||
      this.runs.get(command.lockKey)?.streaming === true ||
      (!command.bypassDedupeWindow &&
        prior?.text === command.text &&
        now - prior.at < windowMs)
    ) {
      return undefined;
    }
    this.inFlight.add(command.lockKey);
    this.lastSend.set(command.lockKey, { text: command.text, at: now });
    if (!command.execute) {
      return { release: () => this.inFlight.delete(command.lockKey) };
    }
    try {
      return await command.execute();
    } finally {
      this.inFlight.delete(command.lockKey);
    }
  }

  moveSendOwnership(from: string, to: string, text: string): void {
    this.inFlight.delete(from);
    this.lastSend.delete(from);
    this.inFlight.add(to);
    this.lastSend.set(to, { text, at: Date.now() });
  }

  releaseSend(key: string): void {
    this.inFlight.delete(key);
  }

  recordLastSend(key: string, text: string): void {
    this.lastSend.set(key, { text, at: Date.now() });
  }

  registerRun(id: string, run: Run): void {
    this.runs.set(id, run);
    this.publish();
  }

  ownsRun(id: string, run: Readonly<Run>): boolean {
    return this.runs.get(id) === run;
  }

  retireRun(id: string, run?: Readonly<Run>): boolean {
    if (run && this.runs.get(id) !== run) return false;
    const deleted = this.runs.delete(id);
    if (deleted) this.publish();
    return deleted;
  }

  async stop(
    id: string | null = this.activeId,
    options: StopOptions<Message, Run> = {},
  ): Promise<boolean> {
    if (!id) return false;
    const run = this.runs.get(id);
    if (!run) {
      this.lastSend.delete(id);
      this.inFlight.delete(id);
      this.inFlight.delete("__new__");
      this.publish();
      return false;
    }
    run.stopPending = true;
    run.ctrl.abort();
    this.lastSend.delete(id);
    this.inFlight.delete(id);
    this.inFlight.delete("__new__");
    this.publish();

    try {
      if (!options.serverStop) {
        throw new Error("The server Stop handler is unavailable.");
      }
      await options.serverStop({
        clientTurnId: run.clientTurnId,
        turnStartedAt: run.turnStartedAt,
      });
      if (this.runs.get(id) !== run) return false;
      run.stopPending = false;
      run.streaming = false;
      options.onStopConfirmed?.(run);
      if (options.foldRun) {
        this.base.set(id, options.foldRun(run, this.base.get(id) ?? []));
      }
      this.runs.delete(id);
      this.publish();
      return true;
    } catch {
      if (this.runs.get(id) !== run) return false;
      run.stopPending = false;
      await options.onStopFailure?.(run);
      if (this.runs.get(id) !== run) return true;
      run.streaming = true;
      this.publish();
      return false;
    }
  }

  reconcile(id: string, messages: Message[], artifacts: Artifact[]): void {
    this.base.set(id, messages);
    this.artifacts.set(id, artifacts);
    this.publish();
  }

  reconcileOwned(
    id: string,
    run: Readonly<Run>,
    messages: Message[],
    artifacts: Artifact[],
  ): boolean {
    if (!this.ownsRun(id, run)) return false;
    this.base.set(id, messages);
    this.artifacts.set(id, artifacts);
    this.publish();
    return true;
  }

  completeRun(
    id: string,
    run: Readonly<Run>,
    messages: Message[],
    artifacts: Artifact[],
  ): boolean {
    if (!this.ownsRun(id, run)) return false;
    this.base.set(id, messages);
    this.artifacts.set(id, artifacts);
    this.runs.delete(id);
    this.publish();
    return true;
  }

  setMessages(id: string, messages: Message[]): void {
    this.base.set(id, messages);
    this.publish();
  }

  setArtifacts(id: string, artifacts: readonly Artifact[]): void {
    this.artifacts.set(id, [...artifacts]);
    this.publish();
  }

  updateRun(
    id: string,
    run: Readonly<Run>,
    update: (ownedRun: Run) => void,
  ): boolean {
    const ownedRun = this.runs.get(id);
    if (!ownedRun || ownedRun !== run) return false;
    update(ownedRun);
    this.publish();
    return true;
  }

  async consumeRun(
    id: string,
    run: Run,
    body: ReadableStream<Uint8Array>,
    reduce: (ownedRun: Run, event: string, data: Record<string, unknown>) => void,
    signal: AbortSignal = run.ctrl.signal,
  ): Promise<void> {
    await consumeChatSSE(body, (event, data) => {
      if (!this.ownsRun(id, run)) return;
      reduce(run, event, data);
      this.publish();
    }, signal);
  }

  ensureConversation(id: string): void {
    if (!this.base.has(id)) this.base.set(id, []);
    if (!this.artifacts.has(id)) this.artifacts.set(id, []);
    this.publish();
  }

  deleteConversation(id: string): void {
    this.runs.get(id)?.ctrl.abort();
    this.runs.delete(id);
    this.base.delete(id);
    this.artifacts.delete(id);
    this.lastSend.delete(id);
    this.inFlight.delete(id);
    if (this.activeId === id) this.activeId = null;
    this.publish();
  }

  setLoadingChatId(id: string | null): void {
    this.loadingChatId = id;
    this.publish();
  }

  setReattaching(id: string | null, plan: readonly unknown[] = []): void {
    this.reattachingChatId = id;
    this.reattachPlan = plan;
    this.publish();
  }

  lastSendFor(key: string): { text: string; at: number } | undefined {
    return this.lastSend.get(key);
  }
  clearLastSend(key: string): void { this.lastSend.delete(key); }

  hasVisibleContent(id: string): boolean {
    return (this.base.get(id)?.length ?? 0) > 0 || this.runs.has(id);
  }

  private evict(maxCached: number, selectedId: string): void {
    if (this.base.size <= maxCached) return;
    for (const key of this.base.keys()) {
      if (this.base.size <= maxCached) break;
      if (key === selectedId || this.runs.has(key)) continue;
      this.base.delete(key);
      this.artifacts.delete(key);
    }
  }

  private publish(): void {
    this.revision += 1;
    this.snapshotValue = this.createSnapshot();
    for (const listener of this.listeners) listener();
  }

  private createSnapshot(): ChatSessionSnapshot {
    return {
      revision: this.revision,
      activeId: this.activeId,
      loadingChatId: this.loadingChatId,
      reattachingChatId: this.reattachingChatId,
      reattachPlan: this.reattachPlan,
    };
  }
}

/** Parse SSE frames without any dependency on React or rendering code. */
export async function consumeChatSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: Record<string, unknown>) => void,
  signal?: AbortSignal,
  options: {
    idleTimeoutMs?: number;
    requireTerminalEvent?: boolean;
  } = {},
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminalEvent = false;
  const idleTimeoutMs = options.idleTimeoutMs ?? CHAT_STREAM_IDLE_TIMEOUT_MS;
  if (signal?.aborted) {
    await reader.cancel().catch(() => {});
    return;
  }
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal?.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ChatStreamError(
              "stream_stalled",
              "The Cowork stream stopped producing updates.",
            ),
          );
        }, idleTimeoutMs);
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), idle]);
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const { done, value } = result;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize after appending so a CRLF split across chunks is handled.
      buffer = buffer.replace(/\r\n/g, "\n");
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        try {
          const frame = parseChatSseFrame(event, JSON.parse(dataLines.join("\n")));
          if (frame) {
            if (
              frame.event === "done" ||
              (frame.event === "error" && frame.data.recovery !== "continue")
            ) {
              sawTerminalEvent = true;
            }
            onEvent(frame.event, frame.data);
          }
        } catch { /* malformed frame */ }
      }
    }
    if (
      !signal?.aborted &&
      options.requireTerminalEvent !== false &&
      !sawTerminalEvent
    ) {
      throw new ChatStreamError(
        "stream_ended_early",
        "The Cowork stream ended before the response finished.",
      );
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
import type { PlanStep } from "@/lib/agent/contracts";

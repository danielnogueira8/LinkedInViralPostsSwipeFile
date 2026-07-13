/**
 * Framework-independent client runtime for Cowork chat sessions.
 *
 * React subscribes to snapshots; this object owns the mutable concurrency state
 * that must survive conversation switches and long-running stream callbacks.
 */
export type ChatSessionRun = {
  streaming: boolean;
  ctrl: AbortController;
  turnStartedAt?: string;
};

export type ChatSessionSnapshot<Message, Artifact, Run extends ChatSessionRun> = {
  revision: number;
  activeId: string | null;
  loadingChatId: string | null;
  reattachingChatId: string | null;
  reattachPlan: readonly unknown[];
  baseByChat: ReadonlyMap<string, Message[]>;
  artifactsByChat: ReadonlyMap<string, Artifact[]>;
  runsByChat: ReadonlyMap<string, Run>;
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
};

export type ChatSendLease = { release: () => void };
export const CHAT_SEND_DEDUPE_WINDOW_MS = 10_000;

type StopOptions<Message, Run extends ChatSessionRun> = {
  foldRun?: (run: Run, base: readonly Message[]) => Message[];
  serverStop?: (turnStartedAt: string) => Promise<unknown>;
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
  private snapshotValue: ChatSessionSnapshot<Message, Artifact, Run>;

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

  snapshot = (): ChatSessionSnapshot<Message, Artifact, Run> =>
    this.snapshotValue;

  /** Notify subscribers after a run object or cached list was mutated in place. */
  changed(): void {
    this.publish();
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
      (prior?.text === command.text && now - prior.at < windowMs)
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

  ownsRun(id: string, run: Run): boolean {
    return this.runs.get(id) === run;
  }

  retireRun(id: string, run?: Run): boolean {
    if (run && this.runs.get(id) !== run) return false;
    const deleted = this.runs.delete(id);
    if (deleted) this.publish();
    return deleted;
  }

  stop(id: string | null = this.activeId, options: StopOptions<Message, Run> = {}): void {
    if (!id) return;
    const run = this.runs.get(id);
    if (run) run.streaming = false;
    if (run && options.foldRun) {
      this.base.set(id, options.foldRun(run, this.base.get(id) ?? []));
    }
    if (run) {
      this.runs.delete(id);
      run.ctrl.abort();
    }
    this.lastSend.delete(id);
    this.inFlight.delete(id);
    this.inFlight.delete("__new__");
    this.publish();
    if (run?.turnStartedAt && options.serverStop) {
      void options.serverStop(run.turnStartedAt).catch(() => {});
    }
  }

  reconcile(id: string, messages: Message[], artifacts: Artifact[]): void {
    this.base.set(id, messages);
    this.artifacts.set(id, artifacts);
    this.publish();
  }

  reconcileOwned(
    id: string,
    run: Run,
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
    run: Run,
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

  setArtifacts(id: string, artifacts: Artifact[]): void {
    this.artifacts.set(id, artifacts);
    this.publish();
  }

  updateRun(id: string, run: Run, update: (ownedRun: Run) => void): boolean {
    if (!this.ownsRun(id, run)) return false;
    update(run);
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
      if (this.ownsRun(id, run)) reduce(run, event, data);
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

  private hasVisibleContent(id: string): boolean {
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

  private createSnapshot(): ChatSessionSnapshot<Message, Artifact, Run> {
    return {
      revision: this.revision,
      activeId: this.activeId,
      loadingChatId: this.loadingChatId,
      reattachingChatId: this.reattachingChatId,
      reattachPlan: this.reattachPlan,
      baseByChat: this.base,
      artifactsByChat: this.artifacts,
      runsByChat: this.runs,
    };
  }
}

/** Parse SSE frames without any dependency on React or rendering code. */
export async function consumeChatSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  if (signal?.aborted) {
    await reader.cancel().catch(() => {});
    return;
  }
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
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
        try { onEvent(event, JSON.parse(dataLines.join("\n"))); } catch { /* malformed frame */ }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

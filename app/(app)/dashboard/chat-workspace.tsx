"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";
import {
  Plus,
  Send,
  Loader2,
  Trash2,
  Copy,
  Check,
  Wrench,
  PanelRightClose,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Claude-Cowork-style chat workspace.
//
// Three regions: chat-history sidebar (left), streaming conversation (center),
// artifact panel (right). The conversation streams from
// POST /api/chats/[id]/stream via SSE; generated posts surface as artifacts in
// the right panel where they can be copied or saved.
// ---------------------------------------------------------------------------

type ChatSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type Artifact = {
  id: string;
  kind: "post";
  title: string;
  body: string;
  meta?: Record<string, unknown>;
};

type ToolChip = { id: string; name: string; ok?: boolean };

type Message = {
  id: string;
  role: "user" | "assistant";
  // assistant text with ```post fences stripped (those become artifacts)
  text: string;
  tools?: ToolChip[];
  artifacts?: Artifact[];
  streaming?: boolean;
};

type RawDbMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  artifacts: Artifact[] | null;
};

// Strip ```post fenced blocks out of assistant text for display (the bodies
// already surface as artifacts). Leaves all other text intact.
function stripPostFences(text: string): string {
  return text.replace(/```post\s*\n[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function ChatWorkspace({
  initialChats,
  initialChatId,
  initialMessages,
}: {
  initialChats: ChatSummary[];
  initialChatId: string | null;
  initialMessages: RawDbMessage[];
}) {
  const [chats, setChats] = useState<ChatSummary[]>(initialChats);
  const [activeId, setActiveId] = useState<string | null>(initialChatId);
  const [messages, setMessages] = useState<Message[]>(() =>
    hydrate(initialMessages),
  );
  const [artifacts, setArtifacts] = useState<Artifact[]>(() =>
    initialMessages.flatMap((m) => m.artifacts ?? []),
  );
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // ----- chat list management -----

  const loadChat = useCallback(
    async (id: string) => {
      if (id === activeId) return;
      abortRef.current?.abort();
      setActiveId(id);
      try {
        const res = await fetch(`/api/chats/${id}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to load chat");
        setMessages(hydrate(data.messages));
        setArtifacts(
          (data.messages as RawDbMessage[]).flatMap((m) => m.artifacts ?? []),
        );
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [activeId],
  );

  const newChat = useCallback(async () => {
    abortRef.current?.abort();
    try {
      const res = await fetch("/api/chats", { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to create chat");
      setChats((c) => [data.chat, ...c]);
      setActiveId(data.chat.id);
      setMessages([]);
      setArtifacts([]);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  const deleteChat = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to delete chat");
        setChats((c) => c.filter((x) => x.id !== id));
        if (id === activeId) {
          setActiveId(null);
          setMessages([]);
          setArtifacts([]);
        }
        toast.success("Chat deleted");
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [activeId],
  );

  // ----- sending a message (SSE stream) -----

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    let chatId = activeId;
    // Lazily create a chat on the first message if none is active.
    if (!chatId) {
      try {
        const res = await fetch("/api/chats", { method: "POST" });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to create chat");
        chatId = data.chat.id;
        setChats((c) => [data.chat, ...c]);
        setActiveId(chatId);
      } catch (e) {
        toast.error((e as Error).message);
        return;
      }
    }

    setInput("");
    setSending(true);
    const userMsg: Message = { id: `u_${Date.now()}`, role: "user", text };
    const assistantId = `a_${Date.now()}`;
    setMessages((m) => [
      ...m,
      userMsg,
      { id: assistantId, role: "assistant", text: "", tools: [], streaming: true },
    ]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let rawText = ""; // includes fences; we strip for display each tick
    // True once the SSE stream opens. A failure BEFORE this (e.g. a 429 rate
    // limit) means the server persisted nothing, so we roll back the optimistic
    // bubbles and restore the input for an easy retry; a failure AFTER means we
    // already showed partial content and keep it.
    let streamStarted = false;

    try {
      const res = await fetch(`/api/chats/${chatId}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Stream failed (${res.status})`);
      }
      streamStarted = true;

      await consumeSSE(res.body, (event, data) => {
        if (event === "text") {
          rawText += data.delta as string;
          const display = stripPostFences(rawText);
          setMessages((m) =>
            m.map((x) => (x.id === assistantId ? { ...x, text: display } : x)),
          );
        } else if (event === "tool_start") {
          setMessages((m) =>
            m.map((x) =>
              x.id === assistantId
                ? {
                    ...x,
                    tools: [
                      ...(x.tools ?? []),
                      { id: data.id as string, name: data.name as string },
                    ],
                  }
                : x,
            ),
          );
        } else if (event === "tool_end") {
          setMessages((m) =>
            m.map((x) =>
              x.id === assistantId
                ? {
                    ...x,
                    tools: (x.tools ?? []).map((t) =>
                      t.id === data.id ? { ...t, ok: data.ok as boolean } : t,
                    ),
                  }
                : x,
            ),
          );
        } else if (event === "artifact") {
          const art = data as unknown as Artifact;
          setArtifacts((a) => [...a, art]);
          setPanelOpen(true);
        } else if (event === "error") {
          toast.error((data.message as string) || "The assistant hit an error");
        }
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        toast.error((e as Error).message);
      }
      // Pre-stream failure (rate limit, auth, validation): nothing was saved
      // server-side. Remove the optimistic bubbles and give the text back.
      if (!streamStarted) {
        setMessages((m) => m.filter((x) => x.id !== userMsg.id && x.id !== assistantId));
        setInput(text);
      }
    } finally {
      setMessages((m) =>
        m.map((x) => (x.id === assistantId ? { ...x, streaming: false } : x)),
      );
      setSending(false);
      abortRef.current = null;
      // Bump this chat to the top of the list (it just got activity).
      setChats((c) => {
        const idx = c.findIndex((x) => x.id === chatId);
        if (idx <= 0) return c;
        const next = [...c];
        const [moved] = next.splice(idx, 1);
        return [moved, ...next];
      });
    }
  }, [input, sending, activeId]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[520px] gap-0 rounded-xl border border-border/60 overflow-hidden bg-background">
      {/* Left: chat history */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-border/60 bg-sidebar/40">
        <div className="p-3">
          <Button onClick={newChat} className="w-full justify-start gap-2" size="sm">
            <Plus className="h-4 w-4" /> New chat
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-px">
          {chats.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              No chats yet. Start one below.
            </p>
          ) : (
            chats.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "group flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors",
                  c.id === activeId
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                onClick={() => loadChat(c.id)}
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="truncate flex-1">{c.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteChat(c.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive"
                  aria-label="Delete chat"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Center: conversation */}
      <section className="flex-1 min-w-0 flex flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-8 py-6">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="max-w-3xl mx-auto flex flex-col gap-6">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
            </div>
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={onSubmit}
          className="border-t border-border/60 p-3 sm:p-4 bg-background"
        >
          <div className="max-w-3xl mx-auto flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask for a post, search the swipe file, mimic a viral hook…"
              className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring/40 max-h-40 min-h-[44px]"
              disabled={sending}
            />
            <Button
              type="submit"
              size="icon"
              disabled={!input.trim() || sending}
              className="h-11 w-11 shrink-0"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </form>
      </section>

      {/* Right: artifact panel */}
      {panelOpen && artifacts.length > 0 && (
        <aside className="hidden lg:flex w-80 xl:w-96 shrink-0 flex-col border-l border-border/60 bg-sidebar/30">
          <div className="flex items-center justify-between px-4 h-12 border-b border-border/60">
            <span className="text-sm font-medium">Drafts ({artifacts.length})</span>
            <button
              onClick={() => setPanelOpen(false)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close panel"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
            {[...artifacts].reverse().map((a) => (
              <ArtifactCard key={a.id} artifact={a} chatId={activeId} />
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {message.tools && message.tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.tools.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
            >
              {t.ok === undefined ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Wrench className="h-3 w-3" />
              )}
              {prettyToolName(t.name)}
            </span>
          ))}
        </div>
      )}
      <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
        {message.text}
        {message.streaming && !message.text && (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
          </span>
        )}
      </div>
    </div>
  );
}

function ArtifactCard({ artifact, chatId }: { artifact: Artifact; chatId: string | null }) {
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(artifact.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const save = async () => {
    if (!chatId || saving || saved) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/chats/${chatId}/artifacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: artifact.title, body: artifact.body }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save");
      setSaved(true);
      toast.success("Draft saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/60 bg-background p-3 flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground truncate">{artifact.title}</p>
      <div className="text-sm whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
        {artifact.body}
      </div>
      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8"
          onClick={save}
          disabled={saving || saved || !chatId}
        >
          {saved ? <Check className="h-3.5 w-3.5" /> : null}
          {saved ? "Saved" : saving ? "Saving…" : "Save draft"}
        </Button>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center gap-3 px-6">
      <div className="h-12 w-12 rounded-xl bg-accent flex items-center justify-center">
        <MessageSquare className="h-6 w-6 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-medium">What should we write today?</h2>
      <p className="text-sm text-muted-foreground max-w-md">
        Search your viral swipe file, mimic a proven hook, or draft an original post
        in your voice. Just ask.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prettyToolName(name: string): string {
  return name.replace(/_/g, " ");
}

// Convert persisted DB rows into display messages. Tool rows are dropped from
// the visible transcript (they're internal); assistant artifacts attach to the
// assistant message. Post fences are stripped from assistant text for display.
function hydrate(rows: RawDbMessage[]): Message[] {
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({
      id: r.id,
      role: r.role as "user" | "assistant",
      text: r.role === "assistant" ? stripPostFences(r.content) : r.content,
      artifacts: r.artifacts ?? undefined,
    }));
}

// Parse an SSE stream, invoking cb(eventName, jsonData) per frame.
async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  cb: (event: string, data: Record<string, unknown>) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let dataStr = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      try {
        cb(event, JSON.parse(dataStr));
      } catch {
        // ignore malformed frame
      }
    }
  }
}

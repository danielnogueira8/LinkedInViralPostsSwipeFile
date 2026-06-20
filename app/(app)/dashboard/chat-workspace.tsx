"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useSearchParams, useRouter } from "next/navigation";
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
  PanelLeftOpen,
  MessageSquare,
  Lightbulb,
  Flame,
  Gift,
  TrendingUp,
  PenLine,
  Sparkles,
  X,
  FileText,
  type LucideIcon,
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

// Identity for the LinkedIn-style draft preview. Sourced from Clerk + the voice
// profile on the server and passed in (the workspace is a client component).
export type Author = {
  name: string;
  avatarUrl: string | null;
  headline: string | null;
};

// A post the user clicked "Model this post" on, carried in via ?model=<id> and
// shown as a dismissible chip above the composer. On send, its full text is
// woven into the message so the agent models off the complete source.
type ModelSource = {
  id: string;
  authorName: string | null;
  authorAvatar: string | null;
  postText: string;
  partial: boolean;
};

export function ChatWorkspace({
  initialChats,
  initialChatId,
  initialMessages,
  author,
}: {
  initialChats: ChatSummary[];
  initialChatId: string | null;
  initialMessages: RawDbMessage[];
  author: Author;
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
  const [modelSource, setModelSource] = useState<ModelSource | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // "Model this post" handoff: ?model=<id> means the user clicked Model this
  // post on the swipe file / a bookmark. Fetch the stashed source, start a fresh
  // chat for it, attach it as a chip, prefill the modeling instruction, and
  // clear the param so a refresh/back-nav doesn't re-trigger it. Runs once per
  // distinct id.
  const modelParam = searchParams.get("model");
  useEffect(() => {
    if (!modelParam) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/model-source/${modelParam}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Couldn't load that post");
        if (cancelled) return;
        const s = data.source;
        // Fresh chat so the modeled post doesn't get mixed into an existing
        // conversation.
        const chatRes = await fetch("/api/chats", { method: "POST" });
        const chatData = await chatRes.json();
        if (chatData.ok && !cancelled) {
          setChats((c) => [chatData.chat, ...c]);
          setActiveId(chatData.chat.id);
          setMessages([]);
          setArtifacts([]);
        }
        if (cancelled) return;
        setModelSource({
          id: s.id,
          authorName: s.author_name ?? null,
          authorAvatar: s.author_avatar ?? null,
          postText: s.post_text,
          partial: !!s.partial,
        });
        setInput(
          "Model an original post in my voice after the attached post. Keep its structure and hook style, but make the content mine — about [your topic].",
        );
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          const ph = el.value.match(/\[[^\]]+\]/);
          if (ph && ph.index !== undefined) {
            el.setSelectionRange(ph.index, ph.index + ph[0].length);
          }
        });
      } catch (e) {
        if (!cancelled) toast.error((e as Error).message);
      } finally {
        // Clear ?model from the URL regardless of outcome.
        if (!cancelled) router.replace("/dashboard");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only re-run when the id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelParam]);

  // Prefill the composer from a starter chip. If the prompt has a [placeholder]
  // (e.g. a topic the user must fill), focus the input and select that span so
  // they can type straight over it; otherwise drop the cursor at the end.
  const prefillPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const ph = prompt.match(/\[[^\]]+\]/);
      if (ph && ph.index !== undefined) {
        el.setSelectionRange(ph.index, ph.index + ph[0].length);
      } else {
        el.setSelectionRange(prompt.length, prompt.length);
      }
    });
  }, []);

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

    // If a "Model this post" source is attached, weave its full text into the
    // message the agent receives (delimited so it's unmistakably the reference,
    // not an instruction), while the visible bubble keeps the clean typed text.
    // Consume the chip on send.
    const attached = modelSource;
    const payloadText = attached
      ? `${text}\n\n--- POST TO MODEL AFTER ---\n${attached.postText}\n--- END POST ---`
      : text;
    if (attached) setModelSource(null);

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

    // Optimistically title an untitled chat from this first message, matching
    // the server's auto-title (first 60 chars). Keeps the sidebar label in sync
    // immediately instead of waiting for a reload.
    const derivedTitle = text.replace(/\s+/g, " ").slice(0, 60).trim();
    setChats((c) =>
      c.map((x) =>
        x.id === chatId && x.title === "New chat" && derivedTitle
          ? { ...x, title: derivedTitle }
          : x,
      ),
    );

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
        body: JSON.stringify({ message: payloadText }),
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
      // server-side. Remove the optimistic bubbles, give the text back, and
      // re-attach the modeled post so the user doesn't lose it.
      if (!streamStarted) {
        setMessages((m) => m.filter((x) => x.id !== userMsg.id && x.id !== assistantId));
        setInput(text);
        if (attached) setModelSource(attached);
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
  }, [input, sending, activeId, modelSource]);

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
      <section className="flex-1 min-w-0 flex flex-col relative">
        {/* Re-open the drafts panel after it's been collapsed. Only shown when
            there are drafts to reopen and the panel is currently closed — this
            is the "get the draft back" affordance (Claude-style). */}
        {!panelOpen && artifacts.length > 0 && (
          <button
            onClick={() => setPanelOpen(true)}
            className="hidden lg:inline-flex absolute top-3 right-3 z-10 items-center gap-1.5 rounded-full border border-border/60 bg-background px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-accent/60 transition-colors"
            aria-label="Show drafts"
          >
            <PanelLeftOpen className="h-3.5 w-3.5" />
            Drafts ({artifacts.length})
          </button>
        )}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-8 py-6">
          {messages.length === 0 ? (
            <EmptyState onPick={prefillPrompt} />
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
          <div className="max-w-3xl mx-auto flex flex-col gap-2">
            {modelSource && (
              <SourcePostChip
                source={modelSource}
                onRemove={() => setModelSource(null)}
              />
            )}
            <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
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
          <div className="flex-1 min-h-0 overflow-y-scroll [scrollbar-gutter:stable] p-3 flex flex-col gap-3">
            {[...artifacts].reverse().map((a) => (
              <ArtifactCard key={a.id} artifact={a} chatId={activeId} author={author} />
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

// The "Model this post" source, pinned above the composer until sent or
// dismissed. Shows the author + a one-line preview so the user knows what
// they're modeling after; the full text rides into the message on send.
function SourcePostChip({
  source,
  onRemove,
}: {
  source: ModelSource;
  onRemove: () => void;
}) {
  const preview = source.postText.replace(/\s+/g, " ").slice(0, 90).trim();
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-accent/40 px-3 py-2">
      {source.authorAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={source.authorAvatar}
          alt=""
          className="h-8 w-8 rounded-full object-cover shrink-0 mt-0.5"
        />
      ) : (
        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
          <FileText className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium flex items-center gap-1.5">
          Modeling after
          {source.authorName ? `: ${source.authorName}` : " this post"}
          {source.partial && (
            <span className="text-[10px] font-normal text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
              partial
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground truncate">{preview}…</p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground shrink-0"
        aria-label="Remove source post"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

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
        {renderInline(message.text)}
        {message.streaming && !message.text && (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
          </span>
        )}
      </div>
    </div>
  );
}

function ArtifactCard({
  artifact,
  chatId,
  author,
}: {
  artifact: Artifact;
  chatId: string | null;
  author: Author;
}) {
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

  const initials = author.name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="rounded-xl border border-border/60 bg-white text-zinc-900 shadow-sm overflow-hidden">
      {/* LinkedIn-style post header */}
      <div className="flex items-center gap-2.5 px-3 pt-3">
        {author.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={author.avatarUrl}
            alt=""
            className="h-10 w-10 rounded-full object-cover shrink-0"
          />
        ) : (
          <div className="h-10 w-10 rounded-full bg-zinc-200 text-zinc-600 flex items-center justify-center text-sm font-semibold shrink-0">
            {initials || "in"}
          </div>
        )}
        <div className="min-w-0 leading-tight">
          <p className="text-[13px] font-semibold truncate">{author.name}</p>
          {author.headline && (
            <p className="text-[11px] text-zinc-500 truncate">{author.headline}</p>
          )}
          <p className="text-[11px] text-zinc-500">now · 🌐</p>
        </div>
      </div>

      {/* Post body — LinkedIn renders plain text with line breaks; bold markers
          become <strong>. No height cap: the panel scrolls, not the card. */}
      <div className="px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap">
        {renderInline(artifact.body)}
      </div>

      {/* Faux engagement bar for the LinkedIn look (non-interactive) */}
      <div className="px-3 pb-1 text-[11px] text-zinc-500">👍❤️👏 · Comment · Repost</div>
      <div className="border-t border-zinc-100" />

      {/* Actions */}
      <div className="flex gap-2 px-3 py-2.5 bg-zinc-50/60">
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

// Starter prompts shown on an empty chat. Each maps to a real tool path the
// agent can actually execute, so a click leads somewhere useful rather than a
// dead end. Prompts with a [placeholder] expect the user to fill a detail —
// prefillPrompt selects that span on click.
type Starter = { icon: LucideIcon; label: string; prompt: string };

const STARTERS: Starter[] = [
  {
    icon: Lightbulb,
    label: "Give me post ideas",
    prompt:
      "Give me 5 post ideas based on what's going viral in my niche right now. For each, give a one-line angle and the hook style it would use.",
  },
  {
    icon: Flame,
    label: "Replicate the top viral post",
    prompt:
      "Find the single most viral regular post in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original.",
  },
  {
    icon: Gift,
    label: "Replicate a recent lead magnet",
    prompt:
      "Find the most recent high-performing lead-magnet post in my swipe file and adapt it into a lead-magnet post in my voice, using my lead-magnet style.",
  },
  {
    icon: TrendingUp,
    label: "What's working this week",
    prompt:
      "Show me the top posts from the most recent scrape and tell me what hook patterns and formats are working right now.",
  },
  {
    icon: PenLine,
    label: "Write an original post",
    prompt:
      "Write an original post in my voice about [topic]. Ground it in what's resonating in my niche right now.",
  },
  {
    icon: Sparkles,
    label: "Steal a viral hook",
    prompt:
      "Pull 5 viral hooks from my swipe file that I could adapt, and rewrite each one in my voice so I can pick a favorite.",
  },
];

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center gap-5 px-6">
      <div className="flex flex-col items-center gap-3">
        <div className="h-12 w-12 rounded-xl bg-accent flex items-center justify-center">
          <MessageSquare className="h-6 w-6 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-medium">What should we write today?</h2>
        <p className="text-sm text-muted-foreground max-w-md">
          Search your viral swipe file, mimic a proven hook, or draft an original
          post in your voice. Pick a starter or just ask.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-xl">
        {STARTERS.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.label}
              type="button"
              onClick={() => onPick(s.prompt)}
              title={s.prompt}
              className="group flex items-start gap-2.5 rounded-lg border border-border/60 bg-background px-3 py-2.5 text-left text-sm hover:bg-accent/60 hover:border-border transition-colors"
            >
              <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
              <span className="font-medium leading-snug">{s.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prettyToolName(name: string): string {
  return name.replace(/_/g, " ");
}

// Minimal inline markdown: render **bold** / __bold__ as <strong>. The agent
// emits this in its prose (e.g. "**What I kept:**") and we render plain text,
// so without this the user sees literal asterisks. Deliberately tiny — no
// markdown dep, no HTML injection (returns React nodes, never innerHTML). Other
// markdown (headings, links) isn't used in these responses; add here if it is.
// Exported so the saved-drafts page renders bodies identically.
export function renderInline(text: string): ReactNode {
  if (!text) return text;
  const parts: ReactNode[] = [];
  // Match **...** or __...__ (non-greedy, no line breaks inside the markers).
  const re = /(\*\*|__)(.+?)\1/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<strong key={key++}>{m[2]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : text;
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

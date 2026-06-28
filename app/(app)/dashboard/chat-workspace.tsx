"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus,
  Send,
  Square,
  Loader2,
  Trash2,
  Copy,
  Check,
  CheckCircle2,
  Circle,
  PanelRightClose,
  PanelLeftOpen,
  MessageSquare,
  Search,
  Lightbulb,
  Flame,
  Gift,
  TrendingUp,
  PenLine,
  Sparkles,
  X,
  FileText,
  Paperclip,
  Info,
  ChevronDown,
  ArrowDown,
  ArrowRight,
  ExternalLink,
  Pencil,
  AtSign,
  Building2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { resolveIntent } from "@/lib/post-intents";
import { AvatarImg } from "@/components/avatar-img";
import type { CitedPost } from "@/lib/cite-resolve";
import { Button } from "@/components/ui/button";
import { DraftEditor } from "./draft-editor";

// ---------------------------------------------------------------------------
// Claude-Cowork-style chat workspace.
//
// Three regions: chat-history sidebar (left), streaming conversation (center),
// artifact panel (right). The conversation streams from
// POST /api/chats/[id]/stream via SSE; generated posts surface as artifacts in
// the right panel where they can be copied or saved.
// ---------------------------------------------------------------------------

// Per-chat unsent-composer-draft persistence. Typing a message, switching chats,
// then coming back used to lose the text; these persist it per chat (keyed by
// chat id, "__new__" for the not-yet-created chat) in localStorage so it survives
// a chat switch AND a page reload. All localStorage access is wrapped — it throws
// in private mode / when disabled, and that must never break the composer.
export const draftKey = (id: string | null) => `swipein:chat-draft:${id ?? "__new__"}`;
export function readDraft(id: string | null): string {
  try {
    return localStorage.getItem(draftKey(id)) ?? "";
  } catch {
    return "";
  }
}
export function writeDraft(id: string | null, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(draftKey(id), text);
    else localStorage.removeItem(draftKey(id));
  } catch {
    /* non-fatal */
  }
}

type ChatSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Chat-history organization: search filter + date grouping. Pure + exported so
// the navigation logic is unit-tested independent of the React tree.
// ---------------------------------------------------------------------------

export type ChatGroupKey = "today" | "yesterday" | "previous7" | "older";

export const CHAT_GROUP_LABEL: Record<ChatGroupKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  previous7: "Previous 7 days",
  older: "Older",
};

// Filter chats by a search query against the title (case-insensitive, trimmed).
// Empty query returns everything.
export function filterChats<T extends { title: string }>(
  chats: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return chats;
  return chats.filter((c) => c.title.toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// Starter-prompt placeholders. A starter like "Write a post about [topic]" ships
// a [bracketed] span the user is meant to fill. If they send it unfilled, the
// agent would guess (or, worse, draft about the literal "[topic]"). These helpers
// detect + strip the placeholders so the composer can nudge the user, and so a
// deliberate second send can be turned into a clean "you pick" instruction.
//
// The pattern is deliberately CONSERVATIVE — a placeholder is a short token of
// letters/spaces/hyphens/slashes inside single brackets (e.g. [topic], [person],
// [company name], [your niche]). It does NOT match natural bracketed prose with
// sentence punctuation ("[see the docs].") so we don't false-positive on a user
// who legitimately typed brackets.
// ---------------------------------------------------------------------------
const PLACEHOLDER_RE = /\[[A-Za-z][A-Za-z /-]*\]/g;

// All placeholder tokens still present in the text (e.g. ["[topic]"]). Empty when
// none — the common case, so callers can early-out cheaply.
export function findPlaceholders(text: string): string[] {
  return text.match(PLACEHOLDER_RE) ?? [];
}

// Remove every placeholder token and tidy the surrounding whitespace/punctuation
// the removal leaves behind ("about [topic]." → "about."- then "about ." → fixed),
// so the stripped sentence still reads cleanly. Used on a deliberate second send
// (the user chose to proceed without filling) before appending the "you pick" note.
export function stripPlaceholders(text: string): string {
  return text
    .replace(PLACEHOLDER_RE, "")
    // Collapse a now-doubled space, and a dangling space before punctuation.
    .replace(/ {2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

// The send-gate decision: should send() proceed, or drop this attempt? Pure +
// exported so the layered guards (each behind a real shipped bug) are unit-
// tested without driving the React tree. The order matters and is preserved
// from send():
//   • in-flight lock — a send for this chat is already mid-flight (sync guard
//     against a rapid double-submit before the run registers).
//   • streaming — the chat already has a live streaming run.
//   • dedupe — the IDENTICAL text was sent to this chat within DEDUPE_WINDOW_MS
//     (the cost incident where the same prompt POSTed 5-7x). A deliberate resend
//     after the window, or any edited text, passes.
// `accept:true` means send() should claim the lock + record lastSend and run.
export const SEND_DEDUPE_WINDOW_MS = 10_000;
export type SendGateReason = "in-flight" | "streaming" | "duplicate" | "ok";
export function shouldAcceptSend(opts: {
  lockKey: string;
  text: string;
  now: number;
  inFlight: Set<string>;
  lastSend: { text: string; at: number } | undefined;
  runStreaming: boolean;
}): { accept: boolean; reason: SendGateReason } {
  if (opts.inFlight.has(opts.lockKey)) return { accept: false, reason: "in-flight" };
  if (opts.runStreaming) return { accept: false, reason: "streaming" };
  if (
    opts.lastSend &&
    opts.lastSend.text === opts.text &&
    opts.now - opts.lastSend.at < SEND_DEDUPE_WINDOW_MS
  ) {
    return { accept: false, reason: "duplicate" };
  }
  return { accept: true, reason: "ok" };
}

// Which date bucket a chat falls into, by its updated_at relative to `now`.
// Buckets are calendar-day based (local time): a chat from 11pm yesterday is
// "Yesterday", not "23 hours ago".
export function chatGroupFor(updatedAt: string, now: Date): ChatGroupKey {
  const d = new Date(updatedAt);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msPerDay = 86_400_000;
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfToday.getTime() - dayStart.getTime()) / msPerDay);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays <= 7) return "previous7";
  return "older";
}

// Group chats into ordered date sections, preserving the input order within
// each section (callers pass already-recency-sorted chats). Empty sections are
// omitted. `now` is injected so the grouping is deterministic + testable.
export function groupChatsByDate<T extends { updated_at: string }>(
  chats: T[],
  now: Date,
): { key: ChatGroupKey; chats: T[] }[] {
  const order: ChatGroupKey[] = ["today", "yesterday", "previous7", "older"];
  const buckets: Record<ChatGroupKey, T[]> = {
    today: [],
    yesterday: [],
    previous7: [],
    older: [],
  };
  for (const c of chats) buckets[chatGroupFor(c.updated_at, now)].push(c);
  return order
    .map((key) => ({ key, chats: buckets[key] }))
    .filter((g) => g.chats.length > 0);
}

export type Artifact = {
  id: string;
  // "post"/"hook" are generated drafts (drafts panel). "cite" is a read-only
  // reference to a real swipe-file post the agent pointed at — it renders
  // inline in the conversation; its card data lives in meta.card.
  kind: "post" | "hook" | "cite";
  title: string;
  body: string;
  meta?: Record<string, unknown>;
};

// One tool invocation in the agent's activity stream. `args` is the raw JSON
// string from tool_start (parsed lazily by toolDetail for a human label); `ok`
// is undefined while the tool runs, then set true/false on tool_end.
type ToolChip = { id: string; name: string; args?: string; ok?: boolean };

// One step in the agent's live task checklist (from the server's plan /
// plan_update SSE events). `status` advances pending → active → done as the
// agent works. The whole list is REPLACED on each event (the server sends the
// full ordered list every time), so a re-plan can't leave a stale step.
type PlanStep = {
  id: string;
  label: string;
  status: "pending" | "active" | "done";
};

// A clarifying question the agent asked (ask_user) when the request was
// ambiguous. Rendered as an interactive card; the turn waits for the answer.
type AskQuestion = {
  question: string;
  options: string[];
  allowOther: boolean;
};

// A single in-flight (or just-finished) agent run for one chat. Lives in a
// per-chat ref registry so it keeps accumulating even when that chat isn't the
// one on screen — that's what makes work continue in the background.
// A recoverable error the agent surfaced — its `recovery` action becomes a
// one-click button on the assistant message (e.g. "Continue" when the model
// got cut off). Non-recoverable errors stay as toasts.
type RecoverableError = {
  code: string;
  message: string;
  recovery: "continue";
};

export type ChatRun = {
  userMsg: Message; // the optimistic user bubble for this turn
  assistantId: string;
  rawText: string; // assistant text incl. ```post fences (stripped for display)
  tools: ToolChip[];
  // The agent's live task checklist for this turn (plan / plan_update events).
  // Empty for a simple one-shot turn that never called write_plan.
  plan: PlanStep[];
  artifacts: Artifact[];
  // Set when the agent asked a clarifying question (ask event). The turn ends;
  // the bubble renders an interactive AskCard. Cleared once answered (a new turn).
  ask?: AskQuestion;
  // Set when the server emits an error event with `recovery: "continue"`. The
  // bubble renders a Continue button using this; cleared on next user turn.
  recoverable?: RecoverableError;
  streaming: boolean;
  ctrl: AbortController;
};

// A file the user attached to the next message. GLM-5.1 is text-only, so we
// only accept text-extractable types: text files (read to text, inlined) and
// PDFs/docs (sent as a data URL for OpenRouter to parse). Images/video are
// rejected at pick time.
type Attachment = {
  localId: string;
  filename: string;
  size: number;
  kind: "text" | "file";
  text?: string; // kind: 'text'
  dataUrl?: string; // kind: 'file'
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  // assistant text with ```post fences stripped (those become artifacts)
  text: string;
  // filenames attached to a user message (shown as pills on the bubble)
  files?: string[];
  tools?: ToolChip[];
  // The agent's task checklist for this turn. Live-only: shown while streaming
  // (and briefly after), never persisted — a reloaded turn just shows its
  // result, not the now-complete plan.
  plan?: PlanStep[];
  artifacts?: Artifact[];
  // A clarifying question the agent asked this turn — renders an interactive
  // card. Live-only (the question text persists in the turn's prose for reload
  // context, but the card is not persisted).
  ask?: AskQuestion;
  // Recoverable error the server surfaced for THIS turn — rendered as a
  // banner with a one-click recovery button under the bubble. Live-only:
  // not persisted (the next turn either succeeds or surfaces its own error).
  recoverable?: RecoverableError;
  streaming?: boolean;
};

export type RawDbMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  artifacts: Artifact[] | null;
};

// Strip ```post and ```hook fenced blocks out of assistant text for display
// (the bodies already surface as artifact cards). Leaves all other text intact.
function stripPostFences(text: string): string {
  return text
    // Strip post/hook (→ draft cards) AND cite (→ inline source cards) fences,
    // so none leak into the displayed prose. Cite matters during streaming too:
    // the raw text streams in before the server's final stripped content lands.
    .replace(/```(?:post|hook|cite)\s*\n[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Human label for an artifact kind.
export function kindNoun(kind: Artifact["kind"]): string {
  return kind === "hook" ? "Hook" : "Draft";
}

// Assign each artifact a display label numbered WITHIN its kind ("Hook 1",
// "Hook 2", "Draft 1"…), in creation order. The number is omitted when there's
// only one of that kind (a lone draft is just "Draft", matching the old single-
// draft behavior). Returns artifacts in creation order; caller reverses for
// newest-first display.
export function labelArtifacts(
  artifacts: Artifact[],
): { a: Artifact; label: string | undefined }[] {
  const totals = artifacts.reduce<Record<string, number>>((acc, a) => {
    acc[a.kind] = (acc[a.kind] ?? 0) + 1;
    return acc;
  }, {});
  const seq: Record<string, number> = {};
  return artifacts.map((a) => {
    seq[a.kind] = (seq[a.kind] ?? 0) + 1;
    const noun = kindNoun(a.kind);
    const label = totals[a.kind] > 1 ? `${noun} ${seq[a.kind]}` : noun;
    return { a, label };
  });
}

// Panel header noun: "Drafts", "Hooks", or "Drafts & Hooks" depending on the mix.
export function panelTitle(artifacts: Artifact[]): string {
  const hasPost = artifacts.some((a) => a.kind === "post");
  const hasHook = artifacts.some((a) => a.kind === "hook");
  if (hasPost && hasHook) return "Drafts & Hooks";
  if (hasHook) return "Hooks";
  return "Drafts";
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
  // Provenance — drives the chip label: 'draft' (the user's own post being
  // refined) reads "Refining your post"; swipe/bookmark read "Modeling after".
  kind: "swipe" | "bookmark" | "draft";
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
  // Lazy initializer restores any saved unsent draft for the initial chat on
  // first mount (survives reload). Chat-switch restore is handled below.
  const [input, setInput] = useState(() => readDraft(initialChatId));
  // Generated drafts/hooks live in the right-hand panel (not inline in the
  // conversation), so the panel opens by default and re-opens whenever a new
  // artifact streams in. It can still be collapsed; the floating "Drafts (N)"
  // button brings it back.
  const [panelOpen, setPanelOpen] = useState(true);
  // Mobile only: the drafts panel is a bottom sheet (the desktop inline column is
  // hidden below lg). Opened via the floating "Drafts (N)" pill above the composer.
  const [mobileDraftsOpen, setMobileDraftsOpen] = useState(false);
  // Mobile only: the chat-history sidebar is an off-canvas drawer (it's a fixed
  // inline column on md+). Closed by default so the conversation has full width.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Chat-history search query (filters the list by title, client-side).
  const [chatSearch, setChatSearch] = useState("");
  const [modelSource, setModelSource] = useState<ModelSource | null>(null);
  // When a chat was opened via Posts → "Model in Chat", this maps that chat's id
  // to the original chat_artifacts row it's refining. Saving a refined post in
  // that chat UPDATES the original row instead of creating a duplicate. Per-chat
  // (reactive) so switching conversations shows the right "Update post" vs "Save
  // draft" affordance. Set in the ?model= handoff; a chat stays linked to its
  // source post for its lifetime.
  const [refiningByChat, setRefiningByChat] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Persistent notice shown when a chat rate/usage limit is hit (429). Stays
  // visible (unlike a toast) so the user understands chat is paused but the
  // rest of the app still works; cleared when they dismiss it or send again.
  const [limitNotice, setLimitNotice] = useState<string | null>(null);
  // Strict accordion for the drafts panel: exactly one draft expanded at a
  // time. Auto-follows the newest draft (see effect below); a manual click
  // overrides until the next new draft arrives.
  const [expandedArtifactId, setExpandedArtifactId] = useState<string | null>(
    null,
  );
  // Tracks the last "newest draft" we auto-expanded, so we only re-expand when a
  // genuinely new draft arrives (not on every render). See the accordion logic.
  const [lastNewestArtifactId, setLastNewestArtifactId] = useState<
    string | null
  >(null);

  // --- per-chat state so streams keep running in the background when you ---
  // --- switch chats. The rendered view (messages/artifacts) is DERIVED   ---
  // --- per active chat from these maps; `tick` forces a re-render when a  ---
  // --- background stream updates. The maps are held in state (stable      ---
  // --- identity, seeded once) so reading them during render is valid; we  ---
  // --- mutate their CONTENTS in place + bump() to re-render, which avoids  ---
  // --- cloning the whole map on every streamed token.                      ---

  // DB-loaded transcript per chat (cached so switching doesn't refetch/lose it).
  const [baseByChat] = useState<Map<string, Message[]>>(() => {
    const m = new Map<string, Message[]>();
    if (initialChatId) m.set(initialChatId, hydrate(initialMessages));
    return m;
  });
  // Persisted artifacts per chat.
  const [artifactsByChat] = useState<Map<string, Artifact[]>>(() => {
    const m = new Map<string, Artifact[]>();
    if (initialChatId) {
      m.set(
        initialChatId,
        initialMessages.flatMap((x) => x.artifacts ?? []),
      );
    }
    return m;
  });
  // The chat whose transcript is currently being fetched (sidebar click →
  // setActiveId fires immediately, but the messages load over the network).
  // During that window `messages` is empty; without this signal the empty-state
  // "starter prompt ideas" flash as if it were a new chat. We suppress that flash
  // by showing a quiet loading state instead while this matches the active chat.
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);
  // Live in-flight stream per chat (independent of which chat is on screen).
  const [runsByChat] = useState<Map<string, ChatRun>>(() => new Map());
  // Bumped on every run update to trigger a render.
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  // Derived view for the active chat: base transcript + live run overlay.
  const activeRun = activeId ? runsByChat.get(activeId) : undefined;
  const activeBase = activeId ? (baseByChat.get(activeId) ?? []) : [];
  const messages: Message[] = activeId
    ? [...activeBase, ...(activeRun ? runOverlay(activeRun, activeBase) : [])]
    : [];
  // The drafts panel shows generated post/hook drafts ONLY: "cite" artifacts
  // (read-only source references) render inline in the conversation, and a
  // body-less artifact would render as a blank "Draft" card — so both are
  // excluded here, on every path that feeds the panel (live run + reloaded).
  const artifacts: Artifact[] = activeId
    ? [
        ...(artifactsByChat.get(activeId) ?? []),
        ...(activeRun?.artifacts ?? []),
      ].filter(
        (a) => (a.kind === "post" || a.kind === "hook") && !!a.body.trim(),
      )
    : [];
  const sending = !!activeRun && activeRun.streaming;
  // Chats with a live background run, for the sidebar spinner.
  const streamingChatIds = new Set<string>();
  for (const [cid, r] of runsByChat) {
    if (r.streaming) streamingChatIds.add(cid);
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Mirror of activeId readable inside long-lived stream closures (which would
  // otherwise capture a stale activeId) — used to gate UI-only side effects
  // (like auto-opening the drafts panel) to the chat that's actually on screen.
  const activeIdRef = useRef<string | null>(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Per-chat unsent-draft persistence. Typing a message, switching chats, then
  // coming back used to lose the text. We stash the composer's unsent text per
  // chat in localStorage (keyed by chat id, "__new__" for the not-yet-created
  // chat), so it survives both a chat switch AND a page reload. Cleared on send.
  // Swap drafts on chat change using the "adjust state during render" pattern
  // the rest of this file uses (see userScrolledAway) — NOT an effect, which
  // would trigger a cascading-render lint and an extra paint. When activeId
  // changes: save the leaving chat's current input, then load the arriving
  // chat's saved draft. React batches the setState during render safely.
  const [draftActiveId, setDraftActiveId] = useState<string | null>(activeId);
  if (draftActiveId !== activeId) {
    writeDraft(draftActiveId, input); // input still holds the leaving chat's text
    setInput(readDraft(activeId));
    setDraftActiveId(activeId);
  }
  // Persist the current chat's input as it changes. localStorage-only (no
  // setState), so it's a plain effect with no cascading-render concern.
  useEffect(() => {
    writeDraft(activeIdRef.current, input);
  }, [input]);

  // Auto-grow the composer: start at 1 row, grow with the content up to 10 rows,
  // then scroll. (The Claude Code composer behavior.) Reset to auto first so it
  // can both grow AND shrink as the user edits/deletes. Keyed on `input` so it
  // recomputes on every change, including programmatic prefills.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 22;
    const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const maxHeight = lineHeight * 10 + padding; // 10 rows, then scroll
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input]);

  // Synchronous in-flight guard for send(). State/run-map checks alone can't
  // block a second send fired during an await (before the run is registered or
  // before setInput clears) — two rapid Enters would create duplicate chats or
  // overwrite a run. We track chatIds with an active send, plus a sentinel
  // ("__new__") for the brief pre-chat-creation window of a first message.
  const inFlightRef = useRef<Set<string>>(new Set());
  // chatIds that have been deleted, so async send() flows that captured a
  // chatId before deletion don't resurrect its caches after their awaits.
  const deletedRef = useRef<Set<string>>(new Set());
  // Last prompt submitted per chat (text + timestamp), to drop a rapid repeat
  // of the IDENTICAL prompt. The inFlightRef lock only blocks while a send is
  // mid-flight; a fast-finishing turn can release it and let a queued duplicate
  // submit slip through (observed: the same prompt POSTed 5-7x within ~140ms-3s,
  // each a full billed turn). This is the client-side half of the dedupe; the
  // stream route also rejects duplicates server-side as the authoritative guard.
  // Keyed by chatId (and "__new__" before the first chat exists).
  const lastSendRef = useRef<Map<string, { text: string; at: number }>>(new Map());
  // chatIds we've already fired an auto-title request for, so the (cheap) title
  // call runs at most once per chat even if the user sends several quick turns.
  const autoTitledRef = useRef<Set<string>>(new Set());
  // The exact composer text we last nudged for an unfilled [placeholder]. The
  // first send with a placeholder is blocked (we nudge + re-select the span);
  // if the user hits send AGAIN with the IDENTICAL text, that's a deliberate
  // "you pick" — we let it through (stripping the placeholder + appending a
  // note). Cleared whenever they edit, so editing then re-adding a placeholder
  // re-nudges. Null = nothing pending.
  const placeholderNudgedRef = useRef<string | null>(null);

  const searchParams = useSearchParams();
  const router = useRouter();

  // ----- file attachments -----

  const onPickFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const picked: Attachment[] = [];
      let oversize = false;
      let aggregateExceeded = false;
      for (const file of Array.from(files)) {
        const verdict = classifyFile(file);
        if (verdict === "reject-image") {
          toast.error(`Can't read images here`, {
            description: `${file.name}: the chat model is text-only. Attach a PDF or text doc instead.`,
          });
          continue;
        }
        if (verdict === "reject-other") {
          toast.error(`Unsupported file type`, {
            description: `${file.name}: attach a PDF, Word doc, or a text file (.txt, .md, .csv).`,
          });
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          toast.error(`File too large`, {
            description: `${file.name} is over ${MAX_FILE_MB}MB.`,
          });
          continue;
        }
        try {
          // Unique id (don't key on name+size — two distinct files can collide,
          // breaking React keys and the remove-by-id filter).
          const localId = newLocalId();
          if (verdict === "text") {
            picked.push({
              localId,
              filename: file.name,
              size: file.size,
              kind: "text",
              text: await file.text(),
            });
          } else {
            picked.push({
              localId,
              filename: file.name,
              size: file.size,
              kind: "file",
              dataUrl: await readAsDataUrl(file),
            });
          }
        } catch {
          toast.error(`Couldn't read ${file.name}`);
        }
      }
      if (picked.length) {
        // Enforce the count + aggregate-size caps INSIDE the updater so they're
        // never computed from a stale closure (two quick picks could otherwise
        // both see the old count and overshoot).
        setAttachments((prev) => {
          const next = [...prev];
          let bytes = prev.reduce((n, a) => n + a.size, 0);
          for (const a of picked) {
            if (next.length >= MAX_ATTACHMENTS) {
              oversize = true;
              break;
            }
            if (bytes + a.size > MAX_TOTAL_BYTES) {
              aggregateExceeded = true;
              break;
            }
            next.push(a);
            bytes += a.size;
          }
          return next;
        });
      }
      if (oversize) toast.error(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      if (aggregateExceeded)
        toast.error(`Attachments are too large in total (max ${MAX_TOTAL_MB}MB).`);
      // Allow re-picking the same file later.
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [],
  );

  const removeAttachment = useCallback((localId: string) => {
    setAttachments((a) => a.filter((x) => x.localId !== localId));
  }, []);

  // Auto-scroll to the bottom as the assistant streams — but ONLY while the
  // user hasn't intentionally scrolled up to read something earlier. The
  // previous version only checked "near the bottom" (within 120px), which
  // breaks if the user scrolls up by less than that and then the next token
  // yanks them back. We now track an explicit "scrolled away" flag set on a
  // wheel/touch-up gesture, and clear it only when the user manually scrolls
  // back to the bottom OR when a new assistant turn starts.
  const [userScrolledAway, setUserScrolledAway] = useState(false);
  // Whether there's actually content below the viewport (overflowing AND not at
  // the bottom). The "Latest" pill is gated on THIS, not just on the scroll-away
  // intent flag — otherwise a short conversation that fits the viewport, or one
  // already at the bottom, would still show "Latest" pointing at nothing.
  const [hasContentBelow, setHasContentBelow] = useState(false);
  // Mark as scrolled-away when the user does an UPWARD wheel/touch — even one
  // pixel of intent matters. Clear when they're back at the bottom. Bound to
  // the scroll element via the effect below.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const recomputeBelow = () => {
      const overflowing = el.scrollHeight > el.clientHeight + 1;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      setHasContentBelow(overflowing && !atBottom);
    };
    const onWheel = (e: WheelEvent) => {
      // Only treat upward scroll-intent as "leave auto-scroll" AND only when
      // there's actually somewhere to scroll up to. A wheel on a non-overflowing
      // conversation must not arm the "Latest" pill.
      if (e.deltaY < 0 && el.scrollHeight > el.clientHeight + 1) {
        setUserScrolledAway(true);
      }
    };
    const onTouchMove = () => {
      if (el.scrollHeight > el.clientHeight + 1) setUserScrolledAway(true);
    };
    const onScroll = () => {
      // Clear the flag once they're effectively back at the bottom (within a
      // small fudge factor for sub-pixel rounding). Cheap; runs on every
      // scroll event but only flips state when needed.
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      if (atBottom && userScrolledAway) setUserScrolledAway(false);
      recomputeBelow();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    recomputeBelow();
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("scroll", onScroll);
    };
  }, [userScrolledAway]);
  // Reset the flag when the user starts a new turn — sending creates a fresh
  // assistant message and they're back in "follow the stream" mode. Uses the
  // "adjust state during render" pattern: track the last-seen count in state
  // and call setState during render when it changes (React batches this
  // safely; the second render uses the cleared flag).
  const userMessageCount = messages.filter((m) => m.role === "user").length;
  const [trackedUserMsgs, setTrackedUserMsgs] = useState(userMessageCount);
  if (trackedUserMsgs !== userMessageCount) {
    setTrackedUserMsgs(userMessageCount);
    if (userMessageCount > trackedUserMsgs && userScrolledAway) {
      setUserScrolledAway(false);
    }
  }
  // Pin to the bottom as content grows, gated on the scroll-away flag. Keyed on
  // a cheap scalar that advances with streaming.
  const scrollKey = messages.length + (activeRun?.rawText.length ?? 0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!userScrolledAway) {
      el.scrollTo({ top: el.scrollHeight });
    }
    // Recompute whether there's content below after the layout settles, so the
    // "Latest" pill appears when a streamed reply grows past the fold and clears
    // once we're pinned back at the bottom. rAF lets the new content lay out
    // before we measure.
    requestAnimationFrame(() => {
      const overflowing = el.scrollHeight > el.clientHeight + 1;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      setHasContentBelow(overflowing && !atBottom);
    });
  }, [scrollKey, userScrolledAway]);

  // Drafts accordion: auto-expand the NEWEST draft whenever it changes (a new
  // draft arrives) OR when the active chat changes (so a switch never leaves
  // the previous chat's expanded id, which would render all of the new chat's
  // drafts collapsed). A manual click overrides until the next new draft lands.
  // React "adjust state during render" pattern, keyed on (activeId, newest id).
  const newestArtifactId = artifacts.length
    ? artifacts[artifacts.length - 1].id
    : null;
  const accordionKey = `${activeId ?? ""}:${newestArtifactId ?? ""}`;
  if (accordionKey !== lastNewestArtifactId) {
    setLastNewestArtifactId(accordionKey);
    setExpandedArtifactId(newestArtifactId);
  }

  // Contextual-action handoff: ?model=<id> means the user launched an AI action
  // on a post (swipe file / bookmark). &intent=<key> selects WHICH action —
  // model after it, break down its hook, draft variations, or analyze why it
  // worked (see lib/post-intents). Fetch the stashed source, start a fresh chat,
  // attach it as a chip, prefill the matching instruction, and clear the params
  // so a refresh/back-nav doesn't re-trigger it. Runs once per distinct id.
  const modelParam = searchParams.get("model");
  const intentParam = searchParams.get("intent");
  useEffect(() => {
    if (!modelParam) return;
    const intent = resolveIntent(intentParam);
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
          baseByChat.set(chatData.chat.id, []);
          artifactsByChat.set(chatData.chat.id, []);
          // If this is a Posts → "Model in Chat" refine, link the new chat to the
          // original post so saving updates it instead of duplicating.
          if (s.source === "draft" && s.source_post_id) {
            const linkId: string = chatData.chat.id;
            const draftId: string = s.source_post_id;
            setRefiningByChat((m) => ({ ...m, [linkId]: draftId }));
          }
          setActiveId(chatData.chat.id);
          bump();
        }
        if (cancelled) return;
        setModelSource({
          id: s.id,
          authorName: s.author_name ?? null,
          authorAvatar: s.author_avatar ?? null,
          postText: s.post_text,
          partial: !!s.partial,
          kind: s.source === "draft" || s.source === "bookmark" ? s.source : "swipe",
        });
        setInput(intent.prompt);
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
    // Only re-run when the source id (or its intent) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelParam, intentParam]);

  // (The Posts "Model in Chat" handoff now goes through the ?model= path above
  // with intent=refine — same source chip + clean composer as swipe/bookmark —
  // so there's no separate ?draft= effect anymore.)

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
      // Switch view immediately. Do NOT abort any in-flight run — streams keep
      // running in the background per chat.
      setActiveId(id);
      // Mark this chat as loading UNLESS we already have its transcript cached
      // (re-opening a chat we've seen this session) or it has a live run — in
      // those cases there's content to show immediately and no empty flash.
      // This is what stops the starter-prompt empty state from flashing while
      // an existing chat's messages are still fetching.
      const hasContent =
        (baseByChat.get(id)?.length ?? 0) > 0 || !!runsByChat.get(id);
      if (!hasContent) setLoadingChatId(id);
      // If this chat has a live run, its transcript is already current; only
      // (re)load the base transcript from the DB when we don't have a fresh one.
      // Always refresh on switch so a chat that finished in the background shows
      // its persisted result.
      try {
        const res = await fetch(`/api/chats/${id}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to load chat");
        baseByChat.set(id, hydrate(data.messages));
        artifactsByChat.set(
          id,
          (data.messages as RawDbMessage[]).flatMap((m) => m.artifacts ?? []),
        );
        // If the background run for this chat has finished, its result is now in
        // the DB base — drop the run so we don't double-render it.
        const run = runsByChat.get(id);
        if (run && !run.streaming) runsByChat.delete(id);
        // Cap the in-memory cache so a long session opening many chats doesn't
        // grow it unbounded. Evict oldest entries (Map preserves insertion
        // order) that aren't the active chat and have no live run; re-opening
        // them just refetches from the DB.
        const MAX_CACHED = 30;
        if (baseByChat.size > MAX_CACHED) {
          for (const key of baseByChat.keys()) {
            if (baseByChat.size <= MAX_CACHED) break;
            if (key === id || runsByChat.has(key)) continue;
            baseByChat.delete(key);
            artifactsByChat.delete(key);
          }
        }
        bump();
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        // Clear the loading flag only if it's still pointing at this chat (a
        // rapid switch to another chat may have moved it on already).
        setLoadingChatId((cur) => (cur === id ? null : cur));
      }
    },
    [activeId, bump, baseByChat, artifactsByChat, runsByChat],
  );

  // Start a new chat LAZILY: we no longer POST an empty chat row on click.
  // Clearing activeId drops us into the empty composer state; send() creates the
  // real chat row on the first message. This stops the history filling with
  // never-used "New chat" rows. (A running chat keeps streaming in the
  // background — switching away doesn't abort it.)
  const newChat = useCallback(() => {
    setActiveId(null);
    setInput("");
    setModelSource(null);
    setAttachments([]);
    bump();
  }, [bump]);

  // Fire-and-forget AI titling for a chat whose title is still the default.
  // One cheap GLM-5.2 call (server-side, cost-logged); updates the local title
  // in place. Guarded to run at most once per chat via autoTitledRef.
  const maybeAutoTitle = useCallback(
    async (chatId: string) => {
      // Once per chat on the client; the endpoint is also idempotent (it only
      // titles a chat still named "New chat", so a manual rename is never
      // overwritten and a re-fire is a cheap no-op).
      if (autoTitledRef.current.has(chatId)) return;
      autoTitledRef.current.add(chatId);
      try {
        const res = await fetch(`/api/chats/${chatId}/title`, { method: "POST" });
        const data = await res.json();
        if (data.ok && data.title && !data.skipped) {
          setChats((c) =>
            c.map((x) => (x.id === chatId ? { ...x, title: data.title } : x)),
          );
        }
      } catch {
        // Non-fatal — the chat keeps its placeholder title.
        autoTitledRef.current.delete(chatId); // allow a retry on the next turn
      }
    },
    [],
  );

  const deleteChat = useCallback(
    async (id: string) => {
      // Tombstone synchronously so an in-flight send() for this chat sees it the
      // moment it returns from an await and won't resurrect the chat's caches.
      deletedRef.current.add(id);
      // Abort + drop any live run up front (don't wait on the network).
      runsByChat.get(id)?.ctrl.abort();
      runsByChat.delete(id);
      try {
        const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to delete chat");
        baseByChat.delete(id);
        artifactsByChat.delete(id);
        setChats((c) => c.filter((x) => x.id !== id));
        if (id === activeId) setActiveId(null);
        bump();
        // Invalidate the App Router's RSC cache so navigating away and back
        // (Posts → Chat) re-renders the page Server Component with fresh data.
        // Without this, the cached initialChats payload predates the delete and
        // the chat reappears on return until a hard refresh.
        router.refresh();
        toast.success("Chat deleted");
      } catch (e) {
        // Delete failed server-side — un-tombstone so the chat works again.
        deletedRef.current.delete(id);
        toast.error((e as Error).message);
      }
    },
    [activeId, bump, baseByChat, artifactsByChat, runsByChat, router],
  );

  // ----- sending a message (SSE stream) -----

  const send = useCallback(async (overrideText?: string) => {
    // Caller passes overrideText to send a specific message without going
    // through the composer input — used by the "Continue" recovery button on
    // a cut-off/truncated assistant turn. Default path reads `input`.
    let text = (overrideText ?? input).trim();
    if (!text) return;

    // Unfilled-placeholder nudge. A starter like "…about [topic]" ships a
    // [bracketed] span to fill. Only applies to a real composer send (not a
    // programmatic overrideText like the Continue button).
    //   1st send with a placeholder → block, hint, and re-select the span so
    //     they can type over it (no model turn spent).
    //   2nd send of the SAME unfilled text → a deliberate "you pick": strip the
    //     placeholder(s) and append a short note so the agent chooses a fitting
    //     topic instead of asking. (The agent also asks on any literal [bracket]
    //     that still reaches it — see the system prompt — covering pasted text.)
    if (!overrideText) {
      const placeholders = findPlaceholders(text);
      if (placeholders.length > 0) {
        if (placeholderNudgedRef.current !== text) {
          // First time: nudge and stop.
          placeholderNudgedRef.current = text;
          toast.info(
            `Fill in ${placeholders.join(", ")} first — or hit send again and I'll pick for you.`,
          );
          requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) return;
            el.focus();
            const idx = el.value.search(PLACEHOLDER_RE);
            const m = el.value.match(PLACEHOLDER_RE);
            if (idx >= 0 && m) el.setSelectionRange(idx, idx + m[0].length);
          });
          return;
        }
        // Second time (deliberate): proceed without the placeholder, telling the
        // agent to choose. Clear the nudge state for the next message.
        placeholderNudgedRef.current = null;
        text =
          stripPlaceholders(text) +
          "\n\n(I didn't fill in the details in brackets — pick something that fits my voice and niche, and mention what you chose.)";
      }
    }

    // Hard length guard. The Send button's `disabled` already reflects overLimit,
    // but Enter / Cmd+Enter call send() directly and a programmatic send (e.g. the
    // ?draft= refine prefill, which embeds the full draft body) can also exceed
    // the cap — so enforce it HERE against the resolved text, not just on the
    // button. The server would 400 a >8000-char message; catch it client-side
    // with a clear message instead of an opaque "Stream failed (400)".
    if (text.length > MAX_MESSAGE_LEN) {
      toast.error(
        `Message is too long — ${text.length.toLocaleString()} / ${MAX_MESSAGE_LEN.toLocaleString()} characters. Trim it and try again.`,
      );
      return;
    }
    // Synchronous in-flight guard. Claim a lock keyed by the target chat (or the
    // "__new__" sentinel for a first message that hasn't created a chat yet)
    // BEFORE any await, so a second rapid send can't slip through and create a
    // duplicate chat or overwrite the run. Released once at the end of send().
    const lockKey = activeId ?? "__new__";
    // Layered send guards (in-flight lock, live stream, 10s identical-text
    // dedupe) — see shouldAcceptSend. Drops a rapid double-submit before the run
    // registers and a same-prompt resend within the window.
    const gate = shouldAcceptSend({
      lockKey,
      text,
      now: Date.now(),
      inFlight: inFlightRef.current,
      lastSend: lastSendRef.current.get(lockKey),
      runStreaming: !!(activeId && runsByChat.get(activeId)?.streaming),
    });
    if (!gate.accept) return;
    inFlightRef.current.add(lockKey);
    lastSendRef.current.set(lockKey, { text, at: Date.now() });

    try {
      // If a "Model this post" source is attached, send only its id — the server
      // fetches the (already-neutralized) post text and weaves it into the agent
      // envelope. This keeps the visible/persisted user message clean (no giant
      // delimiter blob on reload) and avoids hitting the 8000-char message cap
      // with a long modeled post. Consume the chip on send.
      const attached = modelSource;
      if (attached) setModelSource(null);

      // Capture + consume file attachments for this turn.
      const files = attachments;
      if (files.length) setAttachments([]);
      const filePayload = files.map((f) => ({
        kind: f.kind,
        filename: f.filename,
        ...(f.kind === "text" ? { text: f.text } : { dataUrl: f.dataUrl }),
      }));

      let resolvedId = activeId;
      // Lazily create a chat on the first message if none is active.
      if (!resolvedId) {
        try {
          const res = await fetch("/api/chats", { method: "POST" });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || "Failed to create chat");
          resolvedId = data.chat.id as string;
          setChats((c) => [data.chat, ...c]);
          baseByChat.set(resolvedId, []);
          artifactsByChat.set(resolvedId, []);
          setActiveId(resolvedId);
        } catch (e) {
          toast.error((e as Error).message);
          return;
        }
      }
      // Non-null from here on (either the active chat or the one we just created).
      const chatId: string = resolvedId;

      // Re-key the dedupe record under the resolved chatId. On a first message
      // the guard above recorded under "__new__"; once the chat exists, a queued
      // duplicate submit keys on the real id, so mirror the record there too.
      if (chatId !== lockKey) {
        lastSendRef.current.set(chatId, { text, at: Date.now() });
      }

      // Only clear the composer when sending what the user actually typed —
      // a programmatic send (recovery button, etc.) shouldn't wipe their
      // in-progress draft.
      if (!overrideText) setInput("");
      const userMsg: Message = {
        id: `u_${Date.now()}`,
        role: "user",
        text,
        ...(files.length ? { files: files.map((f) => f.filename) } : {}),
      };
      const assistantId = `a_${Date.now()}`;
      const ctrl = new AbortController();

      // Register this turn as the chat's live run, keyed by chatId. All stream
      // updates below mutate THIS run (chatId is captured), so they keep landing
      // on the right chat even after the user switches away.
      const run: ChatRun = {
        userMsg,
        assistantId,
        rawText: "",
        tools: [],
        plan: [],
        artifacts: [],
        streaming: true,
        ctrl,
      };
      runsByChat.set(chatId, run);
      bump();

      // Optimistically title an untitled chat from this first message, matching
      // the server's auto-title (first 60 chars).
      const derivedTitle = text.replace(/\s+/g, " ").slice(0, 60).trim();
      setChats((c) =>
        c.map((x) =>
          x.id === chatId && x.title === "New chat" && derivedTitle
            ? { ...x, title: derivedTitle }
            : x,
        ),
      );

      // True once the SSE stream opens. A failure BEFORE this (e.g. a 429 rate
      // limit) means the server persisted nothing, so we roll back the run and
      // restore the input; a failure AFTER means we keep the partial content.
      let streamStarted = false;

      try {
        const res = await fetch(`/api/chats/${chatId}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            ...(attached ? { modelSourceId: attached.id } : {}),
            ...(filePayload.length ? { attachments: filePayload } : {}),
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({}));
          const e = new Error(err.error || `Stream failed (${res.status})`);
          (e as Error & { status?: number }).status = res.status;
          throw e;
        }
        streamStarted = true;
        // A send got through — clear any stale limit banner.
        setLimitNotice(null);

        await consumeSSE(res.body, (event, data) => {
          // Stop fired between frames — drop this one; the finally settles the UI.
          if (ctrl.signal.aborted) return;
          if (event === "text") {
            run.rawText += data.delta as string;
            bump();
          } else if (event === "tool_start") {
            run.tools = [
              ...run.tools,
              {
                id: data.id as string,
                name: data.name as string,
                args: data.args as string | undefined,
              },
            ];
            bump();
          } else if (event === "tool_end") {
            run.tools = run.tools.map((t) =>
              t.id === data.id ? { ...t, ok: data.ok as boolean } : t,
            );
            bump();
          } else if (event === "plan" || event === "plan_update") {
            // The agent's live checklist. Both events carry the FULL ordered
            // step list — REPLACE, don't merge — so a re-plan can't leave a
            // stale step on screen and a finalize closes every step at once.
            run.plan = (data.steps as PlanStep[]) ?? [];
            bump();
          } else if (event === "ask") {
            // The agent asked a clarifying question and is ending the turn. Store
            // it so the bubble renders the interactive AskCard.
            run.ask = data as unknown as AskQuestion;
            bump();
          } else if (event === "artifact") {
            run.artifacts = [...run.artifacts, data as unknown as Artifact];
            // Drafts live in the right-hand panel — open it (only for the chat
            // on screen) so a freshly generated post is immediately visible.
            if (chatId === activeIdRef.current) setPanelOpen(true);
            bump();
          } else if (event === "error") {
            const code = String(data.code ?? "");
            const message = (data.message as string) || "";
            const recovery = data.recovery as "continue" | undefined;
            // RECOVERABLE errors (cut-off / tool-budget exhausted) attach to
            // the assistant bubble so the user gets a one-click recovery
            // button — not a toast. Non-recoverable errors stay as toasts
            // with friendlier copy for known provider categories.
            if (recovery === "continue") {
              run.recoverable = { code, message, recovery: "continue" };
              bump();
            } else if (code === "429" || /rate.?limit/i.test(message)) {
              toast.error("The AI provider is rate-limiting us — try again in a moment.");
            } else if (code === "content_filter" || /content.?filter/i.test(message)) {
              toast.error("The model's safety filter blocked that. Try rephrasing.");
            } else if (/timeout/i.test(message)) {
              toast.error("The model timed out. Try a shorter request.");
            } else {
              toast.error(message || "The assistant hit an error");
            }
          }
        }, ctrl.signal);
      } catch (e) {
        const status = (e as Error & { status?: number }).status;
        if ((e as Error).name === "AbortError") {
          // user navigated/cancelled — no message
        } else if (status === 429) {
          // Rate / usage limit: show a persistent banner (not a fleeting toast)
          // so it's clear chat is paused but the rest of the app still works.
          setLimitNotice((e as Error).message);
        } else {
          toast.error((e as Error).message);
        }
        // Pre-stream failure: nothing was saved server-side. Drop the run, give
        // the text back, and re-attach the modeled post + files.
        if (!streamStarted) {
          runsByChat.delete(chatId);
          setInput(text);
          if (attached) setModelSource(attached);
          if (files.length) setAttachments(files);
          bump();
          return;
        }
      } finally {
        run.streaming = false;
        bump();
        // Bump this chat to the top of the list (it just got activity).
        setChats((c) => {
          const idx = c.findIndex((x) => x.id === chatId);
          if (idx <= 0) return c;
          const next = [...c];
          const [moved] = next.splice(idx, 1);
          return [moved, ...next];
        });
      }

      // Streaming is done (or was stopped). Drop the live run and RELEASE THE
      // SEND LOCK NOW — before the post-stream reload below. The lock's only job
      // is to stop a rapid duplicate POST of THIS send; once the stream has
      // ended, the next Send is a new message and must not be blocked. Keeping
      // the lock held across the reload GET caused the "hit Stop, can't hit Send
      // right away" bug (the button flips back to Send when run.streaming=false,
      // but a click no-ops until the reload finishes and the lock frees).
      // Releasing here — AFTER runsByChat.delete, so a new Send creates a fresh
      // run rather than overwriting this one — is safe: the server already
      // persisted the assistant row in its own finally before this client code
      // runs, so the server-side 409 dedupe still covers a duplicate send.
      runsByChat.delete(chatId);
      inFlightRef.current.delete(lockKey);
      bump();
      // The turn consumed a monthly message credit (the user row was persisted
      // at turn start by claimChatTurn). Nudge the sidebar pill to refetch so
      // the 🪙 count stays live without polling.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("swipein:usage-changed"));
      }
      // Auto-name a still-untitled chat from its first exchange (one cheap
      // GLM-5.2 call, server-side). Fire-and-forget, once per chat.
      void maybeAutoTitle(chatId);

      // Now fold the canonical server-persisted turn into this chat's base cache
      // (fences→artifacts, the real assistant row). This is best-effort hydration
      // for the active view — it no longer gates the send lock, so a slow reload
      // can't lock the composer. If the chat was deleted mid-stream, skip it.
      if (deletedRef.current.has(chatId)) return;
      try {
        const res = await fetch(`/api/chats/${chatId}`);
        const data = await res.json();
        if (data.ok && !deletedRef.current.has(chatId)) {
          baseByChat.set(chatId, hydrate(data.messages));
          artifactsByChat.set(
            chatId,
            (data.messages as RawDbMessage[]).flatMap((m) => m.artifacts ?? []),
          );
          bump();
        }
      } catch {
        // Reload failed — the run is already dropped; the user can switch away
        // and back to reload the persisted result.
      }
    } finally {
      // Belt-and-braces: the lock is normally released above (right after the
      // stream ends), but a throw on the pre-stream path could skip that — so
      // ensure it's always cleared. Idempotent (delete of an absent key no-ops).
      inFlightRef.current.delete(lockKey);
    }
  }, [
    input,
    activeId,
    modelSource,
    attachments,
    bump,
    baseByChat,
    artifactsByChat,
    runsByChat,
    maybeAutoTitle,
  ]);

  // Stop the active chat's in-flight run — really stop it, not just cancel
  // the client's response read. We do TWO things:
  //   1. Abort the local fetch (unwinds the SSE read; send()'s catch swallows
  //      the AbortError and persists whatever was streamed).
  //   2. POST /api/chats/[id]/stop so the SERVER halts the agent loop (model
  //      keeps streaming on OpenRouter otherwise; tokens keep being spent).
  // Both safe to call when nothing's running.
  const stopActiveRun = useCallback(() => {
    if (!activeId) return;
    runsByChat.get(activeId)?.ctrl.abort();
    // Clear the identical-text dedupe for this chat so the user can immediately
    // RE-SEND the same prompt after stopping it. Without this, the 10s dedupe
    // (lastSendRef) would silently drop a same-text resend right after Stop —
    // part of the "can't hit play after pause" complaint. Stopping is an
    // explicit intent to redo, so dropping the dedupe record here is correct.
    lastSendRef.current.delete(activeId);
    // Fire-and-forget — the server flag is enough; we don't need the response.
    void fetch(`/api/chats/${activeId}/stop`, { method: "POST" }).catch(() => {
      // Stop endpoint failed (network, auth) — the local abort is still in
      // effect, so the UI ends cleanly. Server-side will eventually time out
      // on its own. No toast: clicking Stop and seeing a toast is jarring.
    });
  }, [activeId, runsByChat]);

  // Jump back to the live bottom of the stream. Clears the scrolled-away flag so
  // auto-scroll re-engages and the button hides.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setUserScrolledAway(false);
  }, []);

  // "Refine with AI" on a draft card: feed the draft back into THIS chat as a
  // real agent turn with the user's instruction, so the agent re-uses the full
  // pipeline (voice, swipe-file grounding, render_post) and produces a NEW draft
  // card — the original stays in the panel, so the user is iterating versions,
  // not overwriting. Closes the generate→refine loop without leaving the chat.
  const refineDraft = useCallback(
    (draftBody: string, kind: "post" | "hook", instruction: string) => {
      // Block a refine while this chat's turn is still streaming. send() would
      // silently no-op it (its in-flight guard), leaving the user with no
      // feedback — so reject early with a toast. The UI also disables the
      // refine controls (refineDisabled), this is the belt-and-braces guard.
      const aid = activeIdRef.current;
      if (aid && runsByChat.get(aid)?.streaming) {
        toast.info("Hang on — let the current draft finish before refining again.");
        return;
      }
      const noun = kind === "hook" ? "hook" : "post";
      const message =
        `Refine this ${noun}: ${instruction}\n\n` +
        `Keep it in my voice. Here's the current ${noun}:\n` +
        `"""\n${draftBody}\n"""`;
      void send(message);
    },
    [send, runsByChat],
  );

  // Delete one draft/hook card from the chat panel. The card lives in the owning
  // assistant message's artifacts (persisted jsonb), so an in-memory-only
  // removal would reappear on reload — we hit the server, then prune both the
  // persisted cache (artifactsByChat) and the live run's artifacts so it
  // disappears immediately. Optimistic with rollback on failure.
  const deleteArtifact = useCallback(
    async (artifactId: string) => {
      const aid = activeIdRef.current;
      if (!aid) return;
      // Snapshot for rollback.
      const prevPersisted = artifactsByChat.get(aid);
      const run = runsByChat.get(aid);
      const prevRunArtifacts = run?.artifacts;
      // Optimistic prune.
      if (prevPersisted) {
        artifactsByChat.set(
          aid,
          prevPersisted.filter((a) => a.id !== artifactId),
        );
      }
      if (run && prevRunArtifacts) {
        run.artifacts = prevRunArtifacts.filter((a) => a.id !== artifactId);
      }
      bump();
      try {
        const res = await fetch(`/api/chats/${aid}/artifacts`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ artifactId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Failed to delete draft");
        }
      } catch (e) {
        // Roll back the optimistic removal.
        if (prevPersisted) artifactsByChat.set(aid, prevPersisted);
        if (run && prevRunArtifacts) run.artifacts = prevRunArtifacts;
        bump();
        toast.error((e as Error).message || "Couldn't delete that draft");
      }
    },
    [artifactsByChat, runsByChat, bump],
  );

  // Composer length feedback. The counter only shows as you approach the cap;
  // over the cap, send is blocked client-side (the server would 400 a >8000 msg).
  const inputLen = input.length;
  const overLimit = inputLen > MAX_MESSAGE_LEN;
  const showCounter = inputLen >= MESSAGE_LEN_WARN_AT;

  // Slash-command menu: when the composer is JUST a "/<query>" (no spaces yet),
  // surface the starter prompts as a keyboard-driven menu. Typing past the "/"
  // filters by label; picking one prefills it (selecting any [placeholder]).
  const slashQuery =
    input.startsWith("/") && !input.includes(" ") && !sending
      ? input.slice(1).toLowerCase()
      : null;
  const slashMatches =
    slashQuery !== null
      ? STARTERS.filter((s) => s.label.toLowerCase().includes(slashQuery))
      : [];
  const slashOpen = slashQuery !== null && slashMatches.length > 0;
  const [slashActiveRaw, setSlashActive] = useState(0);
  // Clamp the active index in range as the filter narrows — derived during
  // render (not an effect) so it never points past the list.
  const slashActive = Math.min(slashActiveRaw, Math.max(0, slashMatches.length - 1));
  const pickSlash = (s: Starter) => {
    prefillPrompt(s.prompt);
    setSlashActive(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash-menu navigation takes precedence while it's open.
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActive((a) => Math.min(a + 1, slashMatches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActive((a) => Math.max(a - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        pickSlash(slashMatches[slashActive]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setInput("");
        return;
      }
    }
    // Cmd/Ctrl+Enter also sends — a habit from other chat apps, and the only way
    // to send from a hardware keyboard that maps Enter to newline.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (sending) return;
      void send();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // While a turn is streaming, the composer stays open so you can write
      // your next message — but Enter doesn't fire it (send() would no-op
      // mid-stream anyway). Suppress the keystroke so it neither sends nor
      // drops a newline; the user sends once the turn finishes.
      e.preventDefault();
      if (sending) return;
      void send();
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    void send();
  };

  // Chat history: filter by search, then group by date. `chats` is already
  // recency-sorted (newest first), so each date section preserves that order.
  // `now` is recomputed each render but only re-buckets when chats/search change.
  const chatGroups = useMemo(
    () => groupChatsByDate(filterChats(chats, chatSearch), new Date()),
    [chats, chatSearch],
  );

  // The rendered drafts list (expanded card for the active draft, collapsed rows
  // for the rest). Shared by the desktop side panel and the mobile bottom sheet
  // so the two never drift.
  const draftsList = labelArtifacts(artifacts)
    .reverse() // newest first
    .map(({ a, label }) =>
      a.id === expandedArtifactId ? (
        <ArtifactCard
          key={a.id}
          artifact={a}
          chatId={activeId}
          author={author}
          label={label}
          refiningDraftId={
            a.kind === "post" && activeId
              ? refiningByChat[activeId] ?? null
              : null
          }
          onRefine={(instruction) =>
            refineDraft(a.body, a.kind === "hook" ? "hook" : "post", instruction)
          }
          // While a turn is streaming in THIS chat, block refining — a second
          // refine mid-turn is silently dropped by send()'s in-flight guard, so
          // disable the controls + show why instead of a dead click.
          refineDisabled={sending}
          onDelete={() => deleteArtifact(a.id)}
        />
      ) : (
        <CollapsedDraftRow
          key={a.id}
          label={label ?? (a.kind === "hook" ? "Hook" : "Draft")}
          artifact={a}
          onExpand={() => setExpandedArtifactId(a.id)}
          onDelete={() => deleteArtifact(a.id)}
        />
      ),
    );

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[520px] gap-0 rounded-xl border border-border/60 overflow-hidden bg-background">
      {/* Mobile backdrop for the history drawer. */}
      {sidebarOpen && (
        <div
          className="md:hidden absolute inset-0 z-30 bg-black/30"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      {/* Left: chat history. Inline column on md+, off-canvas drawer on mobile. */}
      <aside
        className={cn(
          "flex w-60 shrink-0 flex-col border-r border-border/60",
          // Mobile drawer must be OPAQUE so the conversation behind it doesn't
          // bleed through the list; the translucent sidebar tint is desktop-only.
          "bg-background md:bg-sidebar/40",
          // Desktop: normal inline column.
          "md:relative md:translate-x-0",
          // Mobile: fixed drawer that slides in/out from the left.
          "absolute inset-y-0 left-0 z-40 shadow-xl md:shadow-none transition-transform duration-200 md:transition-none",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        <div className="flex items-center gap-2 p-3 pb-2">
          <Button
            onClick={() => {
              newChat();
              setSidebarOpen(false);
            }}
            className="flex-1 justify-start gap-2"
            size="sm"
          >
            <Plus className="h-4 w-4" /> New chat
          </Button>
          {/* Close the drawer (mobile only). */}
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="md:hidden shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close chat history"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* Search the history by title. */}
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
              placeholder="Search chats…"
              className="w-full rounded-lg border border-input bg-background/60 pl-8 pr-7 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring/30"
              aria-label="Search chats"
            />
            {chatSearch && (
              <button
                type="button"
                onClick={() => setChatSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-2">
          {chats.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              No chats yet. Start one below.
            </p>
          ) : chatGroups.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              No chats match &ldquo;{chatSearch}&rdquo;.
            </p>
          ) : (
            chatGroups.map((group) => (
              <div key={group.key} className="flex flex-col gap-px">
                <div className="px-3 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                  {CHAT_GROUP_LABEL[group.key]}
                </div>
                {group.chats.map((c) => (
                  <ChatRow
                    key={c.id}
                    chat={c}
                    active={c.id === activeId}
                    working={streamingChatIds.has(c.id)}
                    onOpen={() => {
                      loadChat(c.id);
                      setSidebarOpen(false);
                    }}
                    onDelete={() => void deleteChat(c.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Center: conversation */}
      <section className="flex-1 min-w-0 flex flex-col relative">
        {/* Mobile header: open chat history + new chat (the sidebar is a drawer
            on mobile, so these are the only way in). Hidden on md+ where the
            sidebar is always visible. */}
        <div className="md:hidden flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Open chat history"
          >
            <MessageSquare className="h-4 w-4" />
            History
          </button>
          <button
            type="button"
            onClick={newChat}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-primary hover:bg-accent"
          >
            <Plus className="h-4 w-4" />
            New
          </button>
        </div>
        {/* Re-open the drafts panel after it's been collapsed. Only shown when
            there are drafts to reopen and the panel is currently closed — this
            is the "get the draft back" affordance (Claude-style). */}
        {!panelOpen && artifacts.length > 0 && (
          <button
            onClick={() => setPanelOpen(true)}
            className="hidden lg:inline-flex absolute top-3 right-3 z-10 items-center gap-1.5 rounded-full border border-border/60 bg-background px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-accent/60 transition-colors"
            aria-label={`Show ${panelTitle(artifacts).toLowerCase()}`}
          >
            <PanelLeftOpen className="h-3.5 w-3.5" />
            {panelTitle(artifacts)} ({artifacts.length})
          </button>
        )}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-3 sm:px-6 py-6"
        >
          {messages.length === 0 ? (
            // While an existing chat's transcript is still fetching, show a
            // quiet loading state — NOT the starter-prompt empty state, which
            // would misleadingly flash as if this were a new/empty chat.
            loadingChatId && loadingChatId === activeId ? (
              <ChatLoading />
            ) : (
              <EmptyState onPick={prefillPrompt} author={author} />
            )
          ) : (
            <div className="max-w-4xl mx-auto flex flex-col gap-6">
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  onContinue={() =>
                    void send("Please continue from where you left off.")
                  }
                  onAnswer={(text) => void send(text)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Jump-to-latest: shown only when there's ACTUALLY content below the
            viewport (overflowing + not at the bottom) and the user has scrolled
            up. Gating on hasContentBelow (real scroll position) rather than just
            the scroll-away intent prevents the pill from lingering on a short
            conversation or when already at the bottom. */}
        {userScrolledAway && hasContentBelow && messages.length > 0 && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background px-3 py-1.5 text-xs font-medium shadow-md hover:bg-accent/60 transition-colors"
            aria-label="Scroll to latest"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Latest
          </button>
        )}

        {/* Composer */}
        <form
          onSubmit={onSubmit}
          className="border-t border-border/60 px-3 sm:px-6 py-3 sm:py-4 bg-background"
        >
          <div className="max-w-4xl mx-auto flex flex-col gap-2 relative">
            {/* Slash-command menu — anchored above the composer. Open while the
                input is a bare "/<query>". Click or ↑/↓+Enter to prefill a starter. */}
            {slashOpen && (
              <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-border/60 bg-popover shadow-xl z-20">
                <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground border-b border-border/60">
                  Starters
                </div>
                <div className="max-h-72 overflow-y-auto py-1">
                  {slashMatches.map((s, i) => {
                    const Icon = s.icon;
                    return (
                      <button
                        key={s.label}
                        type="button"
                        onMouseMove={() => setSlashActive(i)}
                        onClick={() => pickSlash(s)}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm",
                          i === slashActive ? "bg-accent" : "",
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="text-foreground">{s.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {limitNotice && (
              <div className="flex items-start gap-2.5 rounded-lg border border-amber-300/70 bg-amber-50 text-amber-900 px-3 py-2.5 text-sm">
                <Info className="h-4 w-4 mt-0.5 shrink-0" />
                <p className="flex-1 leading-snug">{limitNotice}</p>
                <button
                  type="button"
                  onClick={() => setLimitNotice(null)}
                  className="text-amber-700 hover:text-amber-900 shrink-0"
                  aria-label="Dismiss"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
            {modelSource && (
              <SourcePostChip
                source={modelSource}
                onRemove={() => setModelSource(null)}
              />
            )}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {attachments.map((a) => (
                  <span
                    key={a.localId}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-accent/40 pl-2 pr-1 py-1 text-xs"
                  >
                    <Paperclip className="h-3 w-3 text-muted-foreground" />
                    <span className="max-w-[140px] truncate">{a.filename}</span>
                    <span className="text-muted-foreground">
                      {prettyBytes(a.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.localId)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${a.filename}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT_ATTR}
                className="hidden"
                onChange={(e) => onPickFiles(e.target.files)}
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                // Attaching while a turn streams is fine — the files ride on the
                // NEXT send (attachments are consumed per-send), matching the
                // compose-ahead composer.
                disabled={attachments.length >= MAX_ATTACHMENTS}
                className="h-11 w-11 shrink-0"
                aria-label="Attach a file"
                title="Attach a PDF, Word doc, or text file"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              {/* Composer stays editable while a turn streams, so you can write
                  your next message instead of waiting. onKeyDown suppresses
                  Enter mid-stream (you send once the turn finishes). */}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  // A manual edit resets the placeholder-nudge state, so editing
                  // (then re-adding a placeholder) re-nudges rather than slipping
                  // through as a "second send". Selecting-over the span on a
                  // starter click fires this too, which is correct.
                  placeholderNudgedRef.current = null;
                }}
                onKeyDown={onKeyDown}
                rows={1}
                placeholder={
                  sending ? "Type your next message…" : "Ask for a post or hook…"
                }
                // Height is managed by the auto-grow effect (1 → 10 rows). text-base
                // + leading-relaxed so what you type is comfortably readable.
                className="flex-1 resize-none rounded-lg border border-input bg-background px-3.5 py-3 text-base leading-relaxed outline-none focus:ring-2 focus:ring-ring/40"
              />
              {sending ? (
                // Mid-stream: the primary button stops the run (aborts the SSE
                // fetch; the partial response is kept).
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={stopActiveRun}
                  className="h-11 w-11 shrink-0"
                  aria-label="Stop generating"
                  title="Stop generating"
                >
                  <Square className="h-4 w-4 fill-current" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  disabled={!input.trim() || overLimit}
                  className="h-11 w-11 shrink-0"
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
            {/* Char counter — only as you near the cap, so it's not noise the
                rest of the time. Turns destructive once over the limit (send is
                already blocked above). */}
            {showCounter && (
              <div
                className={cn(
                  "mt-1 text-right text-[11px] tabular-nums",
                  overLimit ? "text-destructive font-medium" : "text-muted-foreground",
                )}
              >
                {inputLen.toLocaleString()} / {MAX_MESSAGE_LEN.toLocaleString()}
                {overLimit ? " — too long to send" : ""}
              </div>
            )}
          </div>
        </form>
      </section>

      {/* Right: artifact panel — desktop inline column. */}
      {panelOpen && artifacts.length > 0 && (
        <aside className="hidden lg:flex w-80 xl:w-96 shrink-0 flex-col border-l border-border/60 bg-sidebar/30">
          <div className="flex items-center justify-between px-4 h-12 border-b border-border/60">
            <span className="text-sm font-medium">
              {panelTitle(artifacts)} ({artifacts.length})
            </span>
            <button
              onClick={() => setPanelOpen(false)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close panel"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-scroll [scrollbar-gutter:stable] p-3 flex flex-col gap-2">
            {draftsList}
          </div>
        </aside>
      )}

      {/* Mobile: a floating "Drafts (N)" pill above the composer that opens the
          drafts as a bottom sheet. The desktop panel is hidden below lg, so this
          is the ONLY way to reach generated drafts on a phone. */}
      {artifacts.length > 0 && !mobileDraftsOpen && (
        <button
          type="button"
          onClick={() => setMobileDraftsOpen(true)}
          className="lg:hidden absolute bottom-28 left-1/2 -translate-x-1/2 z-20 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background px-3.5 py-2 text-xs font-medium shadow-md hover:bg-accent/60 transition-colors"
          aria-label={`Show ${panelTitle(artifacts).toLowerCase()}`}
        >
          <FileText className="h-3.5 w-3.5" />
          {panelTitle(artifacts)} ({artifacts.length})
        </button>
      )}
      {mobileDraftsOpen && artifacts.length > 0 && (
        <div className="lg:hidden absolute inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileDraftsOpen(false)}
            aria-hidden="true"
          />
          <div className="relative max-h-[80%] flex flex-col rounded-t-2xl border-t border-border/60 bg-background shadow-xl animate-in slide-in-from-bottom duration-200">
            <div className="flex items-center justify-between px-4 h-12 border-b border-border/60 shrink-0">
              <span className="text-sm font-medium">
                {panelTitle(artifacts)} ({artifacts.length})
              </span>
              <button
                type="button"
                onClick={() => setMobileDraftsOpen(false)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Close drafts"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2 pb-[env(safe-area-inset-bottom)]">
              {draftsList}
            </div>
          </div>
        </div>
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
          {source.kind === "draft"
            ? "Refining your post"
            : source.authorName
              ? `Modeling after: ${source.authorName}`
              : "Modeling after this post"}
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

// A collapsed artifact in the strict-accordion panel: a one-line row showing
// "<label> · <first line>" (label is "Hook 1", "Draft 2", etc.). Clicking it
// expands this artifact (and collapses the one that was open).
function CollapsedDraftRow({
  label,
  artifact,
  onExpand,
  onDelete,
}: {
  label: string;
  artifact: Artifact;
  onExpand: () => void;
  // Remove this draft from the chat (hover-reveal ×). Confirmed in the parent.
  onDelete?: () => void;
}) {
  const firstLine =
    artifact.body
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? kindNoun(artifact.kind);
  // A row (not a <button>) so the delete control isn't a button-in-button. The
  // expand area is the button; delete sits beside it.
  return (
    <div className="group flex items-center gap-2 w-full rounded-xl border border-border/60 bg-background px-3 py-2.5 hover:bg-accent/50 transition-colors">
      <button
        type="button"
        onClick={onExpand}
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
      >
        <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground group-hover:text-foreground" />
        <span className="text-xs font-semibold shrink-0 text-muted-foreground">
          {label}
        </span>
        <span className="text-xs text-muted-foreground truncate">
          · {firstLine}
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={() => {
            if (
              window.confirm("Delete this draft from the chat? This can't be undone.")
            ) {
              onDelete();
            }
          }}
          className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
          aria-label="Delete draft"
          title="Delete draft"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// Scrollable post body with a "more below" affordance — a bottom fade plus a
// "Scroll for more" pill that show until the content is fully visible or
// scrolled to the bottom. Shared by the chat artifact card and the saved-
// drafts card so both signal scrollability the same way.
export function ScrollableBody({
  children,
  contentKey,
  className,
  // Height strategy for the scroll region. Default fills a flex parent (the
  // chat panel's fixed-height card); pass e.g. "max-h-80" for a card that sizes
  // to content up to a cap (the drafts grid).
  wrapperClassName = "flex-1 min-h-0",
}: {
  children: ReactNode;
  // Changes when the rendered content changes (e.g. a streaming draft growing),
  // so the hint recomputes.
  contentKey: string;
  className?: string;
  wrapperClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflowing = el.scrollHeight > el.clientHeight + 1;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    setHasMoreBelow(overflowing && !atBottom);
  }, []);
  useEffect(() => {
    update();
  }, [contentKey, update]);

  return (
    <div className={cn("relative", wrapperClassName)}>
      <div
        ref={ref}
        onScroll={update}
        className={cn(
          "h-full overflow-y-auto px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap",
          className,
        )}
      >
        {children}
      </div>
      {hasMoreBelow && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white to-transparent" />
          <div className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-zinc-900/80 px-2 py-0.5 text-[10px] font-medium text-white">
            <ChevronDown className="h-3 w-3" />
            Scroll for more
          </div>
        </>
      )}
    </div>
  );
}

// Sidebar "this chat is working" indicator. A compact coral "Working" label
// with three dots that pulse in sequence — reads clearly at a glance, unlike
// the old tiny spinner. shrink-0 so it never gets truncated with the title.
function WorkingLabel() {
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-primary"
      aria-label="Working…"
    >
      Working
      <span className="inline-flex gap-0.5" aria-hidden>
        <span className="working-dot h-1 w-1 rounded-full bg-primary" />
        <span className="working-dot h-1 w-1 rounded-full bg-primary [animation-delay:0.2s]" />
        <span className="working-dot h-1 w-1 rounded-full bg-primary [animation-delay:0.4s]" />
      </span>
    </span>
  );
}

// One chat-history row: icon + title, with a hover delete (or a "Working…"
// label when the chat is streaming in the background).
function ChatRow({
  chat,
  active,
  working,
  onOpen,
  onDelete,
}: {
  chat: ChatSummary;
  active: boolean;
  working: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      onClick={onOpen}
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="truncate flex-1">{chat.title}</span>
      {working ? (
        <WorkingLabel />
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive"
          aria-label="Delete chat"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// Small hover-reveal copy button for a message's text. Cards already have their
// own copy; this covers the conversational prose + the user's own messages,
// which had no copy affordance at all. Reuses the shared copyToClipboard (handles
// the insecure-context / permission-denied cases + toast).
function MessageCopyButton({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyToClipboard(text, "Copied to clipboard")) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors",
        className,
      )}
      aria-label="Copy message"
      title="Copy message"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function MessageBubble({
  message,
  onContinue,
  onAnswer,
}: {
  message: Message;
  // Click handler for the "Continue" recovery button surfaced when the agent
  // sent a recoverable error (e.g. response was cut off). Sends a "Please
  // continue from where you left off" message to the agent.
  onContinue: () => void;
  // Submit handler for the clarifying-question card (ask_user): sends the
  // composed answer as the next user message.
  onAnswer: (text: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end gap-1">
        {message.files && message.files.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 max-w-[85%]">
            {message.files.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground"
              >
                <Paperclip className="h-3 w-3" />
                <span className="max-w-[160px] truncate">{name}</span>
              </span>
            ))}
          </div>
        )}
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.text}
        </div>
        {/* Hover-reveal copy (always tappable on touch, where there's no hover). */}
        {message.text && (
          <MessageCopyButton
            text={message.text}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          />
        )}
      </div>
    );
  }

  const status = agentStatus(message);
  const tools = message.tools ?? [];
  const plan = message.plan ?? [];
  // Cited source posts attached to this message, with their resolved card.
  // Defensive: only render a cite whose meta.card actually resolved.
  const citeCards = (message.artifacts ?? [])
    .filter((a) => a.kind === "cite")
    .map((a) => ({ id: a.id, card: (a.meta?.card as CitedPost | undefined) }))
    .filter((c): c is { id: string; card: CitedPost } => !!c.card);

  return (
    <div className="group flex flex-col gap-2.5">
      {/* Status line — the agent narrating what it's doing right now ("Planning
          next moves", "Searching the swipe file"). Coral, with the SwipeIn
          sparkle; the label shimmers while it works so it reads as actively
          thinking rather than stalled. */}
      {status && (
        <div className="flex items-center gap-2 text-sm text-primary">
          <Sparkles className="h-4 w-4 shrink-0" />
          <span className="agent-shimmer font-medium">{status}</span>
        </div>
      )}

      {/* Task checklist — the agent's plan for a multi-step turn, ticking off
          as it works. When present it's the SOLE progress surface (the per-tool
          rail below is hidden) so the two don't narrate the same work twice.
          Absent for simple one-shot turns (the agent skips write_plan there). */}
      {plan.length > 0 && <PlanChecklist steps={plan} />}

      {/* Activity stream — one narrated line per tool call, on a thin left rail.
          Hidden when a plan is showing (the checklist replaces it), EXCEPT keep
          it whenever a tool FAILED (the plan card has no failure state, so the
          ✕ would otherwise be invisible on a planned turn). See
          shouldShowActivityRail. */}
      {shouldShowActivityRail(plan, tools) && <ActivityStream tools={tools} />}

      {/* Assistant prose. Generated drafts/hooks are NOT rendered here — they
          live in the right-hand Drafts panel so they're not duplicated. "chat"
          mode renders the model's "- "/"1." lists as proper bullets/numbers;
          the draft-body surfaces below stay default "draft" so a real post is
          never restyled. */}
      {message.text && (
        <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
          {renderRichText(message.text, "chat")}
        </div>
      )}

      {/* Copy the assistant's text reply — appears once the turn finishes
          streaming. Cards have their own copy; this covers the prose (e.g. a
          list of angles the user wants to grab). Hover-reveal on desktop, always
          visible on touch. */}
      {message.text && !message.streaming && (
        <MessageCopyButton
          text={message.text}
          className="-ml-1.5 self-start opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
        />
      )}

      {/* Cited source posts — compact one-line LINKS, not full preview cards, so
          the chat stays clean. Each links out to the original post (or, lacking a
          URL, is omitted). The agent references them in its prose; this is just a
          "see the source" affordance. */}
      {citeCards.length > 0 && (
        <div className="flex flex-col gap-1">
          {citeCards.map((c) => (
            <SourceLink key={c.id} post={c.card} />
          ))}
        </div>
      )}

      {/* Clarifying question (ask_user): an interactive card with the agent's
          options + a free-text box. Shown once the turn settles; submitting
          sends the composed answer as the next message. */}
      {message.ask && !message.streaming && (
        <AskCard ask={message.ask} onSubmit={onAnswer} />
      )}

      {/* Recovery affordance for cut-off / tool-budget-exhausted turns: a small
          amber banner with a one-click Continue button. Cleaner than asking
          the user to retype "please continue" themselves. */}
      {message.recoverable && !message.streaming && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="flex-1 leading-snug">{message.recoverable.message}</span>
          <button
            type="button"
            onClick={onContinue}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-amber-900 text-amber-50 px-2.5 py-1 text-xs font-medium hover:bg-amber-800 transition-colors"
          >
            Continue
          </button>
        </div>
      )}
    </div>
  );
}

// Compose the answer message from the AskCard selections + free text. Pure +
// exported so the "what gets sent" logic is unit-tested. Joins the picked
// options and any free-text into one clean line; returns "" when nothing is
// chosen (the caller disables submit in that case).
export function composeAskAnswer(
  selected: string[],
  otherText: string,
): string {
  const parts = [...selected];
  const other = otherText.trim();
  if (other) parts.push(other);
  return parts.join("; ");
}

// The clarifying-question card. Multi-select options (checkboxes) + an optional
// free-text box, with a Submit that auto-sends the composed answer. Once
// submitted it locks (shows the chosen answer) so the question can't be
// re-answered.
function AskCard({
  ask,
  onSubmit,
}: {
  ask: AskQuestion;
  onSubmit: (text: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);

  const answer = composeAskAnswer(selected, other);
  const toggle = (opt: string) =>
    setSelected((s) => (s.includes(opt) ? s.filter((o) => o !== opt) : [...s, opt]));

  if (submitted !== null) {
    return (
      <div className="rounded-xl border border-border/70 bg-muted/30 px-3.5 py-3 text-sm">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          You answered
        </p>
        <p className="mt-1 text-foreground">{submitted}</p>
      </div>
    );
  }

  return (
    <div className="agent-card-in rounded-xl border border-border/70 bg-muted/30 px-3.5 py-3">
      <p className="text-sm font-medium text-foreground">{ask.question}</p>
      <div className="mt-2.5 flex flex-col gap-1.5">
        {ask.options.map((opt) => {
          const on = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                on
                  ? "border-primary/60 bg-primary/10 text-foreground"
                  : "border-border/60 bg-background hover:bg-accent/50 text-foreground",
              )}
              aria-pressed={on}
            >
              <span
                className={cn(
                  "grid h-4 w-4 shrink-0 place-items-center rounded border",
                  on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                )}
                aria-hidden
              >
                {on && <Check className="h-3 w-3" />}
              </span>
              <span className="min-w-0">{opt}</span>
            </button>
          );
        })}
      </div>
      {ask.allowOther && (
        <input
          value={other}
          onChange={(e) => setOther(e.target.value)}
          placeholder="Or type your own answer…"
          className="mt-2 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          onKeyDown={(e) => {
            if (e.key === "Enter" && answer.trim()) {
              e.preventDefault();
              setSubmitted(answer);
              onSubmit(answer);
            }
          }}
        />
      )}
      <div className="mt-2.5 flex justify-end">
        <Button
          size="sm"
          className="h-8"
          disabled={!answer.trim()}
          onClick={() => {
            setSubmitted(answer);
            onSubmit(answer);
          }}
        >
          Send answer
        </Button>
      </div>
    </div>
  );
}

// A cited swipe-file post, rendered as a COMPACT one-line link rather than a full
// preview card — so the agent can reference several sources without cluttering
// the chat. Shows the author + a short snippet and links out to the original
// post. If there's no URL to open, falls back to non-clickable text (the agent's
// prose already named the post, so this is just a "go see it" affordance).
function SourceLink({ post }: { post: CitedPost }) {
  const name = post.authorName || "a source post";
  const snippet = (post.text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
  const label = (
    <>
      <FileText className="h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="font-medium shrink-0">{name}</span>
      {snippet && (
        <span className="truncate text-muted-foreground">· {snippet}</span>
      )}
    </>
  );
  const cls =
    "group inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs text-foreground";
  if (!post.postUrl) {
    return <div className={cls}>{label}</div>;
  }
  return (
    <a
      href={post.postUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(cls, "hover:bg-accent/60 transition-colors")}
      title={`Open ${name}'s post in a new tab`}
    >
      {label}
      <ExternalLink className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100 transition-opacity" />
    </a>
  );
}

// Whether to render the per-tool activity rail under the message. When a plan
// checklist is present it's the SOLE progress surface, so the rail is hidden to
// avoid narrating the same work twice (the screenshot bug: plan card + rail,
// desynced). The ONE exception: a failed tool. The plan card has no failure
// state (steps only go pending → active → done), so on a planned turn a tool ✕
// would vanish — keep the rail whenever any tool failed so the user still sees
// it. With no plan, the rail shows as before.
export function shouldShowActivityRail(
  plan: PlanStep[],
  tools: ToolChip[],
): boolean {
  if (tools.length === 0) return false;
  if (plan.length === 0) return true;
  return tools.some((t) => t.ok === false);
}

// The agent's task checklist: the plan it laid out for a multi-step turn
// (write_plan / update_plan on the server), rendered as a compact card that
// ticks off as work completes. Done = filled check, the in-progress step = a
// spinner + emphasized label, pending = a hollow circle. A small "n/total"
// counter in the header gives at-a-glance progress. This is the "delegated a
// task, watching it get done" surface; the activity stream below is the detail.
function PlanChecklist({ steps }: { steps: PlanStep[] }) {
  const done = steps.filter((s) => s.status === "done").length;
  const allDone = done === steps.length;
  return (
    <div className="agent-card-in rounded-xl border border-border/70 bg-muted/30 px-3.5 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {allDone ? "Plan complete" : "Plan"}
        </span>
        <span className="text-[11px] font-medium tabular-nums text-muted-foreground/80">
          {done}/{steps.length}
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {steps.map((s) => (
          <li
            // Keyed by step id so a status flip re-renders in place (no remount
            // flicker); a re-plan changes ids, animating the new rows in.
            key={s.id}
            className="agent-step-in flex items-center gap-2 text-[13px]"
          >
            {s.status === "done" ? (
              <CheckCircle2 className="check-pop h-4 w-4 shrink-0 text-emerald-600" />
            ) : s.status === "active" ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            ) : (
              <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
            )}
            <span
              className={cn(
                s.status === "done" && "text-muted-foreground line-through decoration-muted-foreground/40",
                s.status === "active" && "font-medium text-foreground",
                s.status === "pending" && "text-muted-foreground",
              )}
            >
              {s.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The agent's activity stream: a narrated, vertical list of the tool calls it
// made this turn, on a thin left rail. Each line reads as a step the agent
// took ("Searched the swipe file · AI") with a state icon — a spinner while
// running, a check when it succeeded, a ✕ when it failed.
function ActivityStream({ tools }: { tools: ToolChip[] }) {
  return (
    <div className="flex flex-col gap-1.5 border-l-2 border-border/70 pl-3">
      {tools.map((t) => {
        const phrase =
          t.ok === undefined
            ? (TOOL_PHRASES[t.name]?.running ?? prettyToolName(t.name))
            : (TOOL_PHRASES[t.name]?.done ?? prettyToolName(t.name));
        const detail = toolDetail(t.name, t.args ?? "");
        return (
          <div
            key={t.id}
            // agent-step-in fires once when this row mounts (each step is keyed
            // by tool id, so appending a new step animates only that row).
            className="agent-step-in flex items-center gap-2 text-[13px] text-muted-foreground"
          >
            {t.ok === undefined ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : t.ok ? (
              <Check className="check-pop h-3.5 w-3.5 shrink-0 text-emerald-600" />
            ) : (
              <X className="check-pop h-3.5 w-3.5 shrink-0 text-destructive" />
            )}
            <span>
              {phrase}
              {detail && (
                <span className="text-foreground/70"> · {detail}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ArtifactCard({
  artifact,
  chatId,
  author,
  label,
  refiningDraftId,
  onRefine,
  refineDisabled,
  onDelete,
}: {
  artifact: Artifact;
  chatId: string | null;
  author: Author;
  // "Draft N" badge shown when the chat has more than one draft (accordion).
  label?: string;
  // When set, this chat is refining an existing Posts-board post (this id). The
  // primary save action UPDATES that row instead of creating a new draft.
  refiningDraftId?: string | null;
  // Send this draft back to the agent with an instruction; produces a NEW draft.
  onRefine: (instruction: string) => void;
  // True while a turn is streaming in this chat — refine controls are disabled
  // (a refine mid-turn would be silently dropped by the send() in-flight guard).
  refineDisabled?: boolean;
  // Remove this draft from the chat. Confirmed before firing. Absent → no
  // delete affordance (e.g. a context where deletion doesn't apply).
  onDelete?: () => void;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  // The refine quick-action row toggles open below the action bar.
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineText, setRefineText] = useState("");
  // Local working copy of the post body. Seeded from the artifact and kept in
  // sync when a *new* artifact streams in (its id changes), but never clobbered
  // by re-renders of the same artifact — otherwise an edit would be lost the
  // moment the parent re-rendered.
  const [body, setBody] = useState(artifact.body);
  // Track the last artifact id we seeded from in state (not a ref) so the
  // "adjust state when a prop changes" happens cleanly during render without
  // reading/writing a ref mid-render. When a *new* artifact streams in (its id
  // changes), re-seed the working copy and reset the per-draft UI flags.
  const [seededId, setSeededId] = useState(artifact.id);
  if (seededId !== artifact.id) {
    setSeededId(artifact.id);
    setBody(artifact.body);
    setEditing(false);
    setSaved(false);
  }
  const dirty = body !== artifact.body;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  };

  // Whether the primary save should UPDATE an existing Posts-board row. Only for
  // post artifacts in a chat that was opened to refine that specific post.
  const canUpdateOriginal = !!refiningDraftId && artifact.kind === "post";

  // Save as a NEW chat_artifacts row (the original behavior).
  const saveAsNew = async () => {
    if (!chatId || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/chats/${chatId}/artifacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: artifact.title,
          // edited local body (from the inline editor), not artifact.body
          body,
          kind: artifact.kind,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save");
      setSaved(true);
      toast.success(`${kindNoun(artifact.kind)} saved`);
      // Bust the client Router Cache so the Drafts tab shows this draft on the
      // next visit without a manual refresh (the route handler also
      // revalidatePath's the server cache).
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // UPDATE the original Posts-board post this chat is refining (PATCH the body),
  // so iterating on a post doesn't spawn a duplicate draft.
  const updateOriginal = async () => {
    if (!refiningDraftId || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/drafts/${refiningDraftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update post");
      setSaved(true);
      toast.success("Post updated");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // The primary save action: update the original when this chat is refining one,
  // otherwise save a new draft.
  const save = canUpdateOriginal ? updateOriginal : saveAsNew;

  const initials = author.name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    // Bounded card: header pinned at top, action bar pinned at bottom, and the
    // POST BODY is the only scrolling region. Without this, a long post pushed
    // the Copy/Save bar off-screen and there was no way to scroll to it. Cap the
    // card at most of the panel height so it never grows unbounded.
    <div className="rounded-xl border border-border/60 bg-white text-zinc-900 shadow-sm overflow-hidden flex flex-col max-h-[calc(100vh-16rem)]">
      {/* "Draft N" badge (only when the chat has multiple drafts) */}
      {label && (
        <div className="px-3 pt-2.5 pb-0.5 shrink-0">
          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600">
            {label}
          </span>
        </div>
      )}
      {/* LinkedIn-style post header (fixed) */}
      <div className="flex items-center gap-2.5 px-3 pt-3 shrink-0">
        <AvatarImg
          src={author.avatarUrl}
          className="h-10 w-10 rounded-full object-cover shrink-0"
          fallback={
            // Initials placeholder when the avatar is absent OR the LinkedIn CDN
            // URL has expired (handled inside AvatarImg's onError).
            <div className="h-10 w-10 rounded-full bg-zinc-200 text-zinc-600 flex items-center justify-center text-sm font-semibold shrink-0">
              {initials || "in"}
            </div>
          }
        />
        <div className="min-w-0 leading-tight flex-1">
          <p className="text-[13px] font-semibold truncate">{author.name}</p>
          {author.headline && (
            <p className="text-[11px] text-zinc-500 truncate">
              {author.headline}
            </p>
          )}
          <p className="text-[11px] text-zinc-500">now · 🌐</p>
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {/* Delete this draft from the chat. Confirmed; hidden when no handler. */}
          {onDelete && !editing && (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm("Delete this draft from the chat? This can't be undone.")
                ) {
                  onDelete();
                }
              }}
              className="inline-flex items-center rounded-md px-1.5 py-1 text-[11px] font-medium text-zinc-500 hover:bg-red-50 hover:text-red-600 transition-colors"
              aria-label="Delete draft"
              title="Delete draft"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          {/* Edit toggle — flips the body between the LinkedIn-style preview and
              the inline editor. */}
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
              editing
                ? "bg-zinc-900 text-white hover:bg-zinc-800"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
            )}
          >
            {editing ? (
              <>
                <Check className="h-3.5 w-3.5" /> Done
              </>
            ) : (
              <>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </>
            )}
          </button>
        </div>
      </div>

      {/* Post body — preview (read-only) or the inline editor. In preview mode
          this is the only scrolling region, so the header and action bar stay
          put; the fade + "Scroll for more" hint signal content below. The
          preview renders rich text (bold/italic/blockquotes) off the edited
          local body so formatting shows and edits are reflected live. */}
      {editing ? (
        <div className="px-3 py-2.5 overflow-y-auto min-h-0">
          <DraftEditor value={body} onChange={setBody} />
        </div>
      ) : (
        <ScrollableBody contentKey={body}>
          {renderRichText(body)}
        </ScrollableBody>
      )}

      <div className="border-t border-zinc-100 shrink-0" />

      {/* Actions (fixed at the bottom — always reachable). flex-wrap so the bar
          never overflows the card: when Copy / Save / Save-as-new / Refine don't
          fit the panel width (e.g. when "Save as new" is present), they wrap to a
          second line instead of clipping off the right edge. */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 bg-zinc-50/60 shrink-0">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8"
          onClick={copy}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8"
          onClick={save}
          // Re-enable once the draft has been edited since the last save, so an
          // edited-then-saved draft can be saved again after further edits.
          disabled={saving || (saved && !dirty) || !chatId}
          title={
            canUpdateOriginal
              ? "Overwrite the post on your board with this version"
              : undefined
          }
        >
          {saved && !dirty ? <Check className="h-3.5 w-3.5" /> : null}
          {saving
            ? "Saving…"
            : saved && !dirty
              ? canUpdateOriginal
                ? "Updated"
                : "Saved"
              : saved
                ? canUpdateOriginal
                  ? "Update post"
                  : "Save changes"
                : canUpdateOriginal
                  ? "Update post"
                  : `Save ${kindNoun(artifact.kind).toLowerCase()}`}
        </Button>
        {/* When updating the original post is the primary action, offer a
            secondary "Save as new" so the user can still branch off a copy. */}
        {canUpdateOriginal && (
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5 h-8 text-muted-foreground"
            onClick={saveAsNew}
            disabled={saving || !chatId}
            title="Keep the original and save this as a separate new draft"
          >
            Save as new
          </Button>
        )}
        {/* Refine with AI — sends this draft back to the agent. Toggles the
            quick-action row below; the original card stays, the refined version
            arrives as a new card. Disabled while a turn is streaming in this
            chat (a refine mid-turn would be silently dropped). */}
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8"
          onClick={() => setRefineOpen((v) => !v)}
          disabled={refineDisabled}
          title={
            refineDisabled
              ? "Wait for the current draft to finish before refining again"
              : undefined
          }
        >
          <Sparkles className="h-3.5 w-3.5" />
          {refineDisabled ? "Refining…" : "Refine"}
        </Button>
      </div>

      {/* Refine quick actions — one-tap chips + a free-text instruction. Hidden
          while a stream is in flight so the panel can't be used mid-turn. */}
      {refineOpen && !refineDisabled && (
        <div className="flex flex-col gap-2 px-3 pb-2.5 bg-zinc-50/60 shrink-0">
          <div className="flex flex-wrap gap-1.5">
            {refineSuggestions(artifact.kind).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  onRefine(s);
                  setRefineOpen(false);
                }}
                className="rounded-full border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = refineText.trim();
              if (!t) return;
              onRefine(t);
              setRefineText("");
              setRefineOpen(false);
            }}
            className="flex items-center gap-1.5"
          >
            <input
              value={refineText}
              onChange={(e) => setRefineText(e.target.value)}
              placeholder="Or describe a change…"
              className="flex-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 outline-none focus:ring-2 focus:ring-ring/40"
            />
            <Button type="submit" size="sm" className="h-8" disabled={!refineText.trim()}>
              Refine
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

// One-tap refine instructions, tuned to the artifact kind. The agent gets these
// verbatim as the refine instruction.
export function refineSuggestions(kind: Artifact["kind"]): string[] {
  if (kind === "hook") {
    return ["Punchier", "More contrarian", "Add a number", "Shorter"];
  }
  return ["Punchier hook", "Make it shorter", "Stronger CTA", "More story-driven"];
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
  {
    icon: AtSign,
    label: "Namejack a person",
    prompt:
      "Namejack [person] — write a LinkedIn post in my voice that borrows their attention. Anchor on them, then pivot to my own insight. Pick the best lane (agree & extend, respectful contrarian, decode, or apply) and don't fabricate anything they said.",
  },
  {
    icon: Building2,
    label: "Brandjack a company",
    prompt:
      "Brandjack [company] — write a LinkedIn post in my voice that borrows their recognition. Do a teardown, a steal-this, or a versus, then deliver something the reader can apply. Keep it factual and reference-only (no impersonation).",
  },
];

// Quiet loading state shown while an existing chat's transcript is fetching,
// in place of the starter-prompt empty state (which would misleadingly imply a
// new/empty chat during the load gap after a sidebar click).
function ChatLoading() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center gap-3 px-6">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Loading chat…</p>
    </div>
  );
}

function EmptyState({
  onPick,
  author,
}: {
  onPick: (prompt: string) => void;
  author: Author;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center gap-5 px-6">
      <div className="flex flex-col items-center gap-3">
        {/* The user's profile pic, so the empty state feels personal — falling
            back to a chat icon in the brand gradient chip when there's no avatar. */}
        <AvatarImg
          src={author.avatarUrl}
          className="h-12 w-12 rounded-xl object-cover ring-1 ring-primary/10"
          fallback={
            <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/15 to-amber-500/10 ring-1 ring-primary/10 flex items-center justify-center">
              <MessageSquare className="h-6 w-6 text-primary" />
            </div>
          }
        />
        <h2 className="text-lg font-medium">What should we write today?</h2>
        <p className="text-sm text-muted-foreground max-w-md">
          Search your viral swipe file, mimic a proven hook, or draft an
          original post in your voice. Pick a starter or just ask.
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
              className="group flex items-center gap-2.5 rounded-lg border border-border/60 bg-background px-3 py-2.5 text-left text-sm hover:bg-accent/60 hover:border-border transition-colors"
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
              <span className="font-medium leading-snug flex-1">{s.label}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
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

export function prettyToolName(name: string): string {
  return name.replace(/_/g, " ");
}

// ----- agent activity narration -----
//
// The backend streams tool_start with the tool NAME and its ARGS (a JSON
// string). Rather than render a bare chip ("search_viral_posts"), we narrate
// each step the way the agent would describe it — a present-tense verb phrase
// while running ("Searching the swipe file · AI"), flipped to past tense once
// the tool finishes ("Searched the swipe file · AI"). The args are parsed
// defensively (a half-streamed tool_start can carry truncated JSON) and only a
// couple of human-meaningful params are surfaced as a trailing detail; the rest
// (limits, internal flags) stay hidden, matching the system prompt's "never
// narrate internal tool mechanics" rule.

type ToolPhrase = { running: string; done: string };

// Per-tool verb phrases. Keyed by the tool names defined in lib/agent/tools.ts.
const TOOL_PHRASES: Record<string, ToolPhrase> = {
  search_viral_posts: {
    running: "Searching the swipe file",
    done: "Searched the swipe file",
  },
  get_post: { running: "Reading a post", done: "Read a post" },
  list_niches: {
    running: "Checking your niches",
    done: "Checked your niches",
  },
  get_top_from_batch: {
    running: "Pulling the latest top posts",
    done: "Pulled the latest top posts",
  },
  get_voice: {
    running: "Reading your voice profile",
    done: "Read your voice profile",
  },
  list_accounts: {
    running: "Looking up tracked creators",
    done: "Looked up tracked creators",
  },
  list_brands: { running: "Checking your brands", done: "Checked your brands" },
  get_brand: { running: "Reading a brand", done: "Read a brand" },
};

// Parse tool args (best-effort) and return a short human detail to append after
// the verb phrase, or "" when there's nothing worth showing. We deliberately
// surface only audience-meaningful params (niche, the modeled post, a brand or
// account name) — never limits, sort keys, or internal flags.
export function toolDetail(name: string, argsJson: string): string {
  let args: Record<string, unknown>;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return ""; // truncated/streaming JSON — no detail yet
  }
  const pick = (k: string): string | null => {
    const v = args[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  if (name === "search_viral_posts") {
    const niche = pick("niche");
    const type = pick("post_type");
    return [niche, type === "lead_magnet" ? "lead magnets" : null]
      .filter(Boolean)
      .join(" · ");
  }
  if (name === "get_brand" || name === "list_brands") return pick("name") ?? "";
  if (name === "list_accounts") return pick("niche") ?? "";
  return "";
}

// The label of an in-flight agent run, shown above the activity stream while it
// works (the reference app's "Planning next moves"). GLM doesn't stream a
// separate reasoning channel, so we derive an honest cue from run state.
//
// The cue is shown for the ENTIRE streaming turn and only disappears when the
// turn is fully done (streaming flips false). A non-empty message.text does NOT
// mean "done" — the agent commonly streams an opening line, THEN calls tools,
// THEN streams the answer, with think-gaps in between. Going silent on the
// first token (the old behavior) left those gaps with no cue, so it looked
// frozen mid-turn (e.g. after "I'll pull your voice profile…" but before the
// tool chip appears).
export function agentStatus(message: Message): string | null {
  if (!message.streaming) return null;
  const tools = message.tools ?? [];
  const running = tools.find((t) => t.ok === undefined);
  if (running) {
    return TOOL_PHRASES[running.name]?.running ?? "Working";
  }
  // No tool currently running: "Planning next moves" before anything has
  // happened, then a steady "Working" through every later gap (between tool
  // rounds, while composing the final answer) so the cue never drops.
  const hasActivity = !!message.text || tools.length > 0;
  return hasActivity ? "Working" : "Planning next moves";
}

// Render a live run as the two bubbles it contributes to the active chat: the
// user's message and the streaming assistant message.
export function runOverlay(run: ChatRun, base: Message[] = []): Message[] {
  // The stream route persists the user message immediately when the turn
  // starts. If we switch away and back to a still-streaming chat, loadChat
  // refetches the base transcript — which now includes that user message — but
  // the run is kept (it's still streaming), so its optimistic run.userMsg would
  // render a SECOND copy. The ids differ (optimistic `u_<ts>` vs. the DB UUID),
  // so we dedupe by content: skip run.userMsg when the base already ends with
  // the same user turn.
  const last = base[base.length - 1];
  const alreadyInBase =
    last?.role === "user" &&
    last.text === run.userMsg.text &&
    sameFiles(last.files, run.userMsg.files);

  return [
    ...(alreadyInBase ? [] : [run.userMsg]),
    {
      id: run.assistantId,
      role: "assistant",
      text: stripPostFences(run.rawText),
      tools: run.tools,
      plan: run.plan,
      ask: run.ask,
      // Generated post/hook artifacts render in the right-hand panel, NOT on
      // the message (so the conversation isn't a second copy of every draft).
      // "cite" artifacts are the exception: they're read-only references to
      // source posts and render inline right under the message that cited them.
      artifacts: run.artifacts.filter((a) => a.kind === "cite"),
      // A recoverable error attaches to the bubble so the user gets a
      // one-click recovery button (e.g. "Continue" for cut-off responses).
      recoverable: run.recoverable,
      streaming: run.streaming,
    },
  ];
}

// Compare the optional filename lists on two user messages (order-sensitive,
// which is fine — they come from the same picked-file order).
export function sameFiles(a?: string[], b?: string[]): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((f, i) => f === b[i]);
}

// Max chars for a single message, mirroring the server schema
// (app/api/chats/[id]/stream/route.ts: message.max(8000)). The composer shows a
// counter as it approaches this and blocks send past it, so the user never gets
// a silent 400 from the server.
const MAX_MESSAGE_LEN = 8000;
// Below this remaining-char count the counter appears (it's noise the rest of
// the time). ~12.5% of the cap.
const MESSAGE_LEN_WARN_AT = MAX_MESSAGE_LEN - 1000;

// ----- file attachment helpers -----

const MAX_ATTACHMENTS = 5;
const MAX_FILE_MB = 10;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
// Aggregate cap across all attachments (the server also enforces this) so a
// user can't queue 5×10MB ≈ 50MB into one request.
const MAX_TOTAL_MB = 20;
const MAX_TOTAL_BYTES = MAX_TOTAL_MB * 1024 * 1024;

// Collision-proof attachment id (name+size collides for distinct files).
let localIdSeq = 0;
function newLocalId(): string {
  return `f_${Date.now()}_${localIdSeq++}`;
}

// File picker accept list — text-extractable types only (GLM-5.1 is text-only).
const ACCEPT_ATTR =
  ".pdf,.txt,.md,.markdown,.csv,.doc,.docx,application/pdf,text/plain,text/markdown,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Decide how to handle a picked file: read as text, send as a parseable file,
// or reject (images/video aren't supported by the text-only chat model).
export function classifyFile(
  file: File,
): "text" | "file" | "reject-image" | "reject-other" {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type.startsWith("image/")) return "reject-image";
  if (type.startsWith("video/") || type.startsWith("audio/"))
    return "reject-other";
  // Plain-text-ish: read directly to text and inline it.
  if (
    type.startsWith("text/") ||
    /\.(txt|md|markdown|csv|tsv|json|log)$/.test(name)
  ) {
    return "text";
  }
  // PDF / Word: send as a file block for OpenRouter to parse.
  if (type === "application/pdf" || /\.(pdf|docx?|rtf)$/.test(name)) {
    return "file";
  }
  // Some text files arrive with an empty MIME type; treat unknown extensions as
  // unsupported rather than guessing.
  return "reject-other";
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ⚠️ SECURITY — DO NOT enable markdown links, images, or HTML rendering in this
// component WITHOUT first revisiting:
//   1. The CSP in next.config.ts (img-src / connect-src).
//   2. An output-side safety screen for agent text.
//   3. SECURITY.md ("Lethal trifecta" section).
// The agent ingests untrusted scraped LinkedIn content, has access to other
// users' drafts, and renders into a logged-in browser session. Adding
// auto-loaded images or auto-resolving links opens a documented exfiltration
// channel (Bing Chat, Copilot Chat, Claude.ai, NotebookLM all shipped this bug).
//
// INVARIANT for any future block primitive (lists, etc.): untrusted text may
// only ever become a React TEXT CHILD (passed through renderInline, which React
// escapes) — NEVER part of a className, key, style, href, or any attribute. The
// list renderer below obeys this: the "-"/"1." markers are consumed as
// structural tokens and produce only <ul>/<ol>/<li>/<span> layout; the post
// content is the escaped text child. Do not add a chip/pill whose styling
// derives from untrusted label text, and do not add a [text](url) case.
//
// Minimal inline markdown: render **bold** / __bold__ as <strong>. The agent
// emits this in its prose (e.g. "**What I kept:**") and we render plain text,
// so without this the user sees literal asterisks. Deliberately tiny — no
// markdown dep, no HTML injection (returns React nodes, never innerHTML). Other
// markdown (headings, links) isn't used in these responses; add here if it is —
// see warning above.
// Exported so the saved-drafts page renders bodies identically.
// Inline markdown: bold (**x** / __x__) and italic (*x* / _x_). Bold is matched
// before italic so a `**` opener is never mis-read as two single `*` italics.
// The italic `_` form requires a word boundary so identifiers like snake_case
// and file_name.ts are left untouched; the `*` form has no such issue.
//
// One combined regex with alternation walks the string left-to-right, so
// markers don't overlap and the first match at each position wins.
const INLINE_RE =
  /(\*\*|__)(?=\S)(.+?)(?<=\S)\1|(?<![A-Za-z0-9])_(?=\S)(.+?)(?<=\S)_(?![A-Za-z0-9])|\*(?=\S)([^*\n]+?)(?<=\S)\*/g;

export function renderInline(text: string): ReactNode {
  if (!text) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      // **bold** / __bold__
      parts.push(<strong key={key++}>{m[2]}</strong>);
    } else {
      // _italic_ (m[3]) or *italic* (m[4])
      parts.push(<em key={key++}>{m[3] ?? m[4]}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : text;
}

// Render mode. "draft" is the byte-for-byte legacy behavior (blockquotes +
// inline only) and is the DEFAULT — so the draft-body surfaces (the saved-posts
// list, the in-chat post preview) keep rendering a real LinkedIn post literally:
// a post that starts a line with "- " or "1." must NOT be restyled as a list.
// "chat" mode additionally turns contiguous "- "/"• "/"* " and "1. " runs into
// proper <ul>/<ol>, and is used ONLY for the assistant's conversational prose.
export type RichTextMode = "draft" | "chat";

// A chat-prose line is a list item: "- ", "• ", "* " (unordered) or "1. "
// (ordered). The marker must be followed by a space + content. Capture group 1 =
// the ordered number (undefined for unordered).
const LIST_ITEM_RE = /^(?:[-•*]|(\d{1,3})\.)\s+(?=\S)/;
const ORDERED_RE = /^\d{1,3}\.\s+/;

export function renderRichText(text: string, mode: RichTextMode = "draft"): ReactNode {
  if (!text) return text;
  const chat = mode === "chat";
  // Fast path: nothing block-level → just inline formatting. In chat mode we
  // also early-out only when there's no list marker at a line start.
  const hasQuote = text.includes("\n> ") || text.startsWith("> ");
  const hasList = chat && /(?:^|\n)(?:[-•*]|\d{1,3}\.)\s/.test(text);
  if (!hasQuote && !hasList) {
    return renderInline(text);
  }

  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let key = 0;
  let i = 0;
  // Streaming guard: a list item is only "complete" once a newline proves the
  // line is fully streamed. The LAST line of the buffer may still be arriving,
  // so we don't promote it to a list item mid-stream (avoids a per-token
  // text→<li> reclassification flicker). It renders as plain text until the
  // newline commits, then snaps into the list on the next frame.
  const lastIdx = lines.length - 1;
  const isCompleteListLine = (idx: number) =>
    idx < lastIdx && LIST_ITEM_RE.test(lines[idx]);

  while (i < lines.length) {
    const line = lines[i];
    if (/^>\s?/.test(line)) {
      // Contiguous run of blockquote lines.
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote
          key={`bq${key++}`}
          className="border-l-2 border-border pl-3 my-1 text-foreground/80 italic"
        >
          {renderInline(quoted.join("\n"))}
        </blockquote>,
      );
    } else if (chat && isCompleteListLine(i)) {
      // Contiguous run of (complete) list items → one <ul> or <ol>. The list's
      // ordered-ness is decided by its first item. We render the model's LITERAL
      // number for ordered lists (not a CSS counter) so a half-streamed list
      // never renumbers items already painted.
      const ordered = ORDERED_RE.test(line);
      const items: { num: string | null; body: string }[] = [];
      while (i < lines.length && isCompleteListLine(i)) {
        const m = lines[i].match(LIST_ITEM_RE)!;
        items.push({ num: m[1] ?? null, body: lines[i].slice(m[0].length) });
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={`ls${key++}`} className="my-1 flex flex-col gap-0.5">
          {items.map((it, n) => (
            <li key={n} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {ordered ? `${it.num ?? n + 1}.` : "•"}
              </span>
              {/* min-w-0 + break-words: a long unbroken token (a pasted
                  URL-as-text, a kebab-handle) wraps instead of forcing
                  horizontal scroll on mobile. */}
              <span className="min-w-0 break-words">{renderInline(it.body)}</span>
            </li>
          ))}
        </Tag>,
      );
    } else {
      // Contiguous run of normal lines → one text node (whitespace-pre-wrap
      // keeps the line breaks between them). Stops at the next blockquote or
      // (in chat mode) the next complete list item.
      const normal: string[] = [];
      while (
        i < lines.length &&
        !/^>\s?/.test(lines[i]) &&
        !(chat && isCompleteListLine(i))
      ) {
        normal.push(lines[i]);
        i++;
      }
      // Trim a single trailing blank line before a following block, so the
      // pre-wrap newline + the block's own margin don't double the gap.
      if (
        normal.length > 1 &&
        normal[normal.length - 1] === "" &&
        i < lines.length
      ) {
        normal.pop();
      }
      blocks.push(<span key={`tx${key++}`}>{renderInline(normal.join("\n"))}</span>);
    }
  }
  return blocks;
}

// Convert persisted DB rows into display messages. Tool rows are dropped from
// the visible transcript (they're internal); assistant artifacts attach to the
// assistant message. Post fences are stripped from assistant text for display.
export function hydrate(rows: RawDbMessage[]): Message[] {
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
//
// `signal` is the run's AbortController signal. Aborting a fetch does NOT
// reliably interrupt an in-progress reader.read() on a buffered SSE response
// (Vercel proxies the stream, so frames keep arriving from the buffer and the
// read loop keeps resolving). That's the Stop-button "nothing happens" bug:
// the server halts, but the client keeps consuming and never flips out of the
// streaming state. So we listen on the signal directly and cancel the reader —
// which makes the next read() resolve done (or reject), breaks the loop, and
// lets the caller's finally settle the UI immediately.
export async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  cb: (event: string, data: Record<string, unknown>) => void,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // If already aborted, don't even start. Otherwise cancel the reader the
  // moment Stop fires — reader.cancel() unblocks the pending read() so the
  // while-loop exits on the next tick instead of draining the buffer.
  if (signal?.aborted) {
    await reader.cancel().catch(() => {});
    return;
  }
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      // If Stop fired, bail before another read so we don't process buffered
      // frames the user already abandoned.
      if (signal?.aborted) break;
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
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

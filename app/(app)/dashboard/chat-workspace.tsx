"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus,
  Send,
  Square,
  Loader2,
  Trash2,
  Copy,
  Save,
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
  WandSparkles,
  ClipboardCheck,
  AlertCircle,
  X,
  FileText,
  Clock,
  CalendarClock,
  Paperclip,
  Info,
  Brain,
  ChevronDown,
  ArrowDown,
  ArrowRight,
  ExternalLink,
  Pencil,
  AtSign,
  Building2,
  Zap,
  Fingerprint,
  ThumbsDown,
  ThumbsUp,
  ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  filterSkillsByQuery,
  SKILLS_PER_TURN_MAX,
  type CustomSkill,
} from "@/lib/custom-skills";
import {
  NO_MODEL_FORMAT_CATALOG,
  isLeadMagnetNoModelFormat,
  isNoModelFormatId,
  noModelFormatLabel,
  type NoModelFormatId,
} from "@/lib/agent/no-model-format-catalog";
import type { CreatorStyleSummary } from "@/lib/creator-styles";
import {
  NEGATIVE_FEEDBACK_REASONS,
  POSITIVE_FEEDBACK_REASONS,
  type ContentFeedbackRating,
  type ContentFeedbackReason,
} from "@/lib/content-feedback-catalog";
import type { PostMediaAttachment } from "@/lib/post-media";
import {
  isHookFocusedRefine,
  splicePreservedBody,
  buildHookOnlyRefineMessage,
} from "@/lib/hook-splice";
import { copyToClipboard } from "@/lib/clipboard";
import { localDateFromDatetimeInput } from "@/lib/schedule-local-date";
import { useCopiedFlag } from "@/lib/use-copied-flag";
import { resolveIntent } from "@/lib/post-intents";
import { AvatarImg } from "@/components/avatar-img";
import type { CitedPost } from "@/lib/cite-resolve";
import { Button } from "@/components/ui/button";
import { normalizePostBody } from "@/lib/post-body-normalize";
import { looksCorruptedDraft } from "@/lib/agent/specialists/nets";

const DraftEditor = dynamic(
  () => import("./draft-editor").then((mod) => mod.DraftEditor),
  {
    loading: () => (
      <div className="min-h-[15rem] rounded-2xl border border-border bg-card/70 p-3">
        <div className="mb-3 h-8 w-56 animate-pulse rounded-full bg-muted" />
        <div className="space-y-2">
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
          <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
          <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
        </div>
      </div>
    ),
  },
);

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

const DRAFT_PANEL_WIDTH_KEY = "swipein:cowork-draft-panel-width";
const VOICE_WARNING_DISMISSED_KEY = "swipein:cowork-voice-warning-dismissed";
const DRAFT_PANEL_MIN_WIDTH = 320;
const DRAFT_PANEL_MAX_WIDTH = 640;
const DRAFT_PANEL_DEFAULT_WIDTH = 384;
// UI preview only. The server remains the source of truth for actual batch size.
const WEEKLY_BATCH_DRAFT_COUNT = 7;

function clampDraftPanelWidth(width: number): number {
  return Math.min(DRAFT_PANEL_MAX_WIDTH, Math.max(DRAFT_PANEL_MIN_WIDTH, width));
}

function readDraftPanelWidth(): number {
  try {
    const raw = window.localStorage.getItem(DRAFT_PANEL_WIDTH_KEY);
    const n = raw ? Number(raw) : DRAFT_PANEL_DEFAULT_WIDTH;
    return Number.isFinite(n) ? clampDraftPanelWidth(n) : DRAFT_PANEL_DEFAULT_WIDTH;
  } catch {
    return DRAFT_PANEL_DEFAULT_WIDTH;
  }
}

function writeDraftPanelWidth(width: number): void {
  try {
    window.localStorage.setItem(
      DRAFT_PANEL_WIDTH_KEY,
      String(clampDraftPanelWidth(width)),
    );
  } catch {
    /* non-fatal */
  }
}

function readVoiceWarningDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(VOICE_WARNING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeVoiceWarningDismissed(): void {
  try {
    window.sessionStorage.setItem(VOICE_WARNING_DISMISSED_KEY, "1");
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

// The subset of the /api/batch/weekly run row the client renders inline. Kept
// permissive (each field optional) because the poll's error branch might hand
// us a partial payload, and the strip degrades gracefully to just "Working…"
// when a field is missing.
type BatchRunSnapshot = {
  id?: string | null;
  status?: string;
  stage?: string | null;
  total?: number;
  attempted?: number;
  created?: number;
  error?: string | null;
};

// The exact string prefix createBatchChat writes for a weekly-batch chat's
// title ("Weekly batch — <weekOf>"). Kept here so a chat-title match is the
// batch-chat detector — no schema change on chat_messages, no new column on
// chats. If the batch route ever renames the title, update this too.
const BATCH_CHAT_TITLE_PREFIX = "Weekly batch —";

// The client's "is this a weekly-batch draft?" classifier. Batch drafts carry
// meta.source === 'weekly_batch' (stamped by the pipeline in lib/batch/weekly.ts);
// nothing else does. This is what gates the inline Approve / Reject buttons on
// draft cards inside the batch chat (PR: batch review moves to Cowork).
// Exported for unit tests.
export function isWeeklyBatchArtifact(a: Artifact): boolean {
  return (a.meta as { source?: unknown } | undefined)?.source === "weekly_batch";
}

function batchIdForWeeklyBatchArtifact(a: Artifact): string | null {
  if (!isWeeklyBatchArtifact(a)) return null;
  const raw = (a.meta as { batch_id?: unknown } | undefined)?.batch_id;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function isWeeklyBatchMessage(m: Message): boolean {
  return (
    m.artifacts?.some(isWeeklyBatchArtifact) ||
    /building your week|Found \d+ posts? to adapt|Review them on your Posts page/i.test(
      m.text,
    )
  );
}

export function shouldShowBatchStatusForChat({
  title,
  messages,
  artifacts,
  run,
}: {
  title: string | null | undefined;
  messages: Message[];
  artifacts: Artifact[];
  run: BatchRunSnapshot | null;
}): boolean {
  if (!run) return false;
  const status = run.status;
  const visibleStatus =
    status === "pending" ||
    status === "running" ||
    status === "done" ||
    status === "failed";
  if (!visibleStatus) return false;

  const titleLooksLikeBatch = !!title?.startsWith(BATCH_CHAT_TITLE_PREFIX);
  const hasWeeklyBatchContent =
    messages.some(isWeeklyBatchMessage) || artifacts.some(isWeeklyBatchArtifact);
  if (!titleLooksLikeBatch && !hasWeeklyBatchContent) return false;

  if (status === "pending" || status === "running") {
    return true;
  }

  const runId = typeof run.id === "string" && run.id.trim() ? run.id : null;
  if (!runId) return false;
  return artifacts.some((artifact) => batchIdForWeeklyBatchArtifact(artifact) === runId);
}

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
const CLIENT_POST_REQUEST_RE =
  /\b(write|draft|create|make|model|turn this into|post about|linkedin post)\b/i;
const CLIENT_NON_POST_INTENT_RE =
  /\b(hooks?|openers?|analyze|analyse|teardown|find posts?|search|save|schedule|move|mark)\b/i;
const CLIENT_LEAD_MAGNET_INTENT_RE =
  /\b(lead[-\s]?magnet|giveaway|free resource|freebie|playbook|checklist|worksheet|comment .*send|comment .*dm|dm .*link)\b/i;
const CLIENT_EXPLICIT_REGULAR_POST_RE = /\bregular\s+post\b/i;

function clientShouldApplyPostFormat(text: string, hasModelSource: boolean): boolean {
  if (hasModelSource) return false;
  if (!CLIENT_POST_REQUEST_RE.test(text)) return false;
  return !CLIENT_NON_POST_INTENT_RE.test(text);
}

export function clientShouldApplyLeadMagnet(
  text: string,
  hasModelSource: boolean,
  postFormatId: NoModelFormatId | null | undefined,
  hasSelectedLeadMagnet = false,
  modelSourcePostType: "regular" | "lead_magnet" | null = null,
): boolean {
  void hasSelectedLeadMagnet;
  // A selected lead magnet is a RESOURCE HINT — which giveaway to use IF the
  // turn is a lead-magnet post — NOT a switch that forces every "write a post
  // about X" into a giveaway post. So merely having one selected no longer
  // turns a plain post request into a lead-magnet post: the message must show
  // explicit lead-magnet intent (CLIENT_LEAD_MAGNET_INTENT_RE), OR the user
  // must have explicitly picked the "Lead magnet post" FORMAT. This kills the
  // misuse where a leftover / accidental picker selection hijacked a regular
  // post. (The picker still helps: when the turn IS a lead-magnet post, the
  // selected resource is the one used.)
  if (postFormatId) return isLeadMagnetNoModelFormat(postFormatId);
  if (CLIENT_EXPLICIT_REGULAR_POST_RE.test(text)) return false;
  if (hasModelSource) {
    // The modeled source being a lead magnet is a signal, but only when the
    // user's message also asks for a lead-magnet/giveaway post — modeling a
    // lead-magnet post's STRUCTURE into a regular post is a valid ask.
    if (modelSourcePostType === "lead_magnet" && CLIENT_LEAD_MAGNET_INTENT_RE.test(text)) {
      return true;
    }
    return CLIENT_LEAD_MAGNET_INTENT_RE.test(text);
  }
  return CLIENT_LEAD_MAGNET_INTENT_RE.test(text);
}

export function leadMagnetPickerDisabledForSource(
  modelSourcePostType: "regular" | "lead_magnet" | null | undefined,
): boolean {
  void modelSourcePostType;
  return false;
}

export function suggestedLeadMagnetPromptForPost(
  userText: string,
  source: { postText: string; postType: "regular" | "lead_magnet" | null } | null,
): string {
  const cleanUserText = userText.replace(/\s+/g, " ").trim();
  const sourceText = source?.postText.replace(/\s+/g, " ").trim() ?? "";
  const parts: string[] = [];
  if (cleanUserText) {
    parts.push(`Create a practical lead magnet that supports this post request: ${cleanUserText}`);
  } else {
    parts.push("Create a practical lead magnet for this LinkedIn giveaway post.");
  }
  if (sourceText) {
    parts.push(`Use this modeled source angle for context, but make the resource original: ${sourceText.slice(0, 650)}`);
  }
  if (source?.postType === "lead_magnet") {
    parts.push("The modeled source is a lead-magnet/giveaway post, so the resource should be concrete enough to give away when someone comments.");
  }
  return parts.join("\n\n").slice(0, 1200);
}

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
const STOPPED_EMPTY_MESSAGE = "Stopped before a response was produced.";
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
  media_attachments?: PostMediaAttachment[];
  meta?: Record<string, unknown>;
};

type ArtifactScheduleMeta = {
  boardDraftId: string | null;
  scheduledAt: string | null;
  scheduleStatus: string | null;
  firstComment: string | null;
  planToPostOn: string | null;
};

type LeadMagnetSummary = {
  id: string;
  title: string;
  publicSlug?: string | null;
  metadata?: {
    summary?: string | null;
    selection_summary?: string | null;
    deliverables?: string[];
  };
};

type PendingLeadMagnet =
  | LeadMagnetSummary
  | {
      id: "__create_after_draft__";
      title: string;
      createAfterDraft: true;
      prompt: string;
      ctaUrl?: string | null;
      ctaLabel?: string | null;
    };

type AppliedLeadMagnet = {
  id?: string;
  title: string;
  selection: "manual" | "auto";
  publicSlug?: string | null;
};

function isCreateAfterDraftLeadMagnet(
  leadMagnet: PendingLeadMagnet | null,
): leadMagnet is Extract<PendingLeadMagnet, { createAfterDraft: true }> {
  return !!leadMagnet && "createAfterDraft" in leadMagnet;
}

// One tool invocation in the agent's activity stream. `args` is the raw JSON
// string from tool_start (parsed lazily by toolDetail for a human label); `ok`
// is undefined while the tool runs, then set true/false on tool_end.
type ToolChip = { id: string; name: string; args?: string; ok?: boolean; summary?: string };

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
  // Whether the user may pick more than one option. Falsy → single-select
  // (radio buttons, exactly one answer — the default for nearly every ask).
  // Mirrors the server type in lib/agent/run.ts. See AskCard.
  multiSelect?: boolean;
  // Label of a terminal "I'm satisfied — done" option. Picking ONLY this closes
  // the card with no message sent (no model turn). Mirrors the server type in
  // lib/agent/run.ts. See resolveAskSubmission.
  doneOption?: string;
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
  stopped?: boolean;
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
  kind: "text" | "file" | "image";
  text?: string; // kind: 'text'
  dataUrl?: string; // kind: 'file' | 'image'
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  // assistant text with ```post fences stripped (those become artifacts)
  text: string;
  // filenames attached to a user message (shown as pills on the bubble)
  files?: string[];
  // custom skill slugs the user applied to this message (shown as amber chips
  // on the bubble) — set on the OPTIMISTIC user message at send time and
  // re-attached from the persisted user row's tool_calls on hydrate, so the
  // "this turn used /cta" indicator survives a reload.
  skills?: string[];
  // UI-selected no-model post format for this user message, rehydrated from a
  // synthetic tool_call persisted by the stream route. Only present when the
  // user manually forced a format and the server actually applied it.
  postFormat?: string;
  // UI-selected creator style for this user message ("Style: Creator Name"),
  // rehydrated from a _creator_style_selected tool_call. Only present when the
  // user picked a style and the server applied it (no model source attached).
  creatorStyle?: { name: string; creatorName: string | null };
  leadMagnet?: AppliedLeadMagnet;
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
  // OpenAI-shape tool_calls for this assistant turn (null on a text-only turn).
  // The hydrate uses this to reconstruct an AskCard from a persisted ask_user
  // tool call, so checkboxes survive a hard refresh.
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[] | null;
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

export type CoworkNextAction = {
  kind: "track_creators" | "voice" | "inspiration" | "review" | "schedule" | "batch";
  title: string;
  description: string;
  cta: string;
  href: string;
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
  postType: "regular" | "lead_magnet" | null;
  // Provenance — drives the chip label: 'draft' (the user's own post being
  // refined) reads "Refining your post"; 'template' (a fill-in skeleton) reads
  // "Filling template"; swipe/bookmark read "Modeling after".
  kind: "swipe" | "bookmark" | "draft" | "template";
};

export function ChatWorkspace({
  initialChats,
  initialChatId,
  initialMessages,
  initialCustomSkills = [],
  initialVoiceReady,
  initialNextAction,
  author,
}: {
  initialChats: ChatSummary[];
  initialChatId: string | null;
  initialMessages: RawDbMessage[];
  // Server-provided so the composer's ⚡ button renders on first paint instead of
  // popping in after a client mount fetch. Optional (defaults to []) so callers
  // that don't pass it still compile.
  initialCustomSkills?: CustomSkill[];
  initialVoiceReady: boolean;
  initialNextAction: CoworkNextAction;
  author: Author;
}) {
  const [chats, setChats] = useState<ChatSummary[]>(initialChats);
  const [activeId, setActiveId] = useState<string | null>(initialChatId);
  // Start empty on the server and the client's first render, then restore the
  // saved localStorage draft after hydration. Reading localStorage in the lazy
  // initializer makes the client render an enabled send button while the server
  // rendered it disabled, which React reports as a hydration mismatch.
  const [input, setInput] = useState("");
  // Generated drafts/hooks live in the right-hand panel (not inline in the
  // conversation), so the panel opens by default and re-opens whenever a new
  // artifact streams in. It can still be collapsed; the floating "Drafts (N)"
  // button brings it back.
  const [panelOpen, setPanelOpen] = useState(true);
  const [draftPanelWidth, setDraftPanelWidth] = useState(DRAFT_PANEL_DEFAULT_WIDTH);
  const [draftPanelWidthReady, setDraftPanelWidthReady] = useState(false);
  const [resizingDraftPanel, setResizingDraftPanel] = useState(false);
  const draftPanelWidthRef = useRef(DRAFT_PANEL_DEFAULT_WIDTH);
  const draftPanelResizeRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const [voiceWarningDismissed, setVoiceWarningDismissed] = useState(false);
  const voiceWarningShownRef = useRef(false);
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
  // Batch review outcomes keyed by artifact id. Set when the user clicks
  // Approve / Reject on a weekly-batch draft inside its Cowork chat. Drives
  // the per-card badge that replaces the buttons after the action lands so
  // the user sees confirmation without the card vanishing. Session-only —
  // a page reload re-reads the DB status to reconcile.
  const [batchReviewOutcomes, setBatchReviewOutcomes] = useState<
    Record<string, "approved" | "rejected">
  >({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // The workspace's custom skills (fetched once on mount) + the ones picked for
  // the NEXT turn (via the / menu or the ⚡ picker). pendingSkills shows as chips
  // above the composer; their ids ride on send() and clear after.
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>(initialCustomSkills);
  const [pendingSkills, setPendingSkills] = useState<CustomSkill[]>([]);
  const [pendingPostFormat, setPendingPostFormat] =
    useState<NoModelFormatId | null>(null);
  // The workspace's READY creator styles (fetched once on mount) + the one
  // picked for the NEXT turn. pendingCreatorStyle shows as a chip above the
  // composer; its id rides on send() and clears after (like pendingSkills).
  const [creatorStyles, setCreatorStyles] = useState<CreatorStyleSummary[]>([]);
  const [pendingCreatorStyle, setPendingCreatorStyle] =
    useState<CreatorStyleSummary | null>(null);
  const [leadMagnets, setLeadMagnets] = useState<LeadMagnetSummary[]>([]);
  const [pendingLeadMagnet, setPendingLeadMagnet] =
    useState<PendingLeadMagnet | null>(null);
  const [leadMagnetAiUsage, setLeadMagnetAiUsage] = useState<{
    used: number;
    limit: number;
  } | null>(null);
  const [leadMagnetCreateOpen, setLeadMagnetCreateOpen] = useState(false);
  const [leadMagnetCreatePrompt, setLeadMagnetCreatePrompt] = useState("");
  const [leadMagnetCreateCtaUrl, setLeadMagnetCreateCtaUrl] = useState("");
  const [leadMagnetCreateCtaLabel, setLeadMagnetCreateCtaLabel] = useState("");
  // The ⚡ picker panel toggle, plus refs for outside-click detection — clicking
  // anywhere outside the panel (and not on the ⚡ button itself, which would
  // toggle it back open) closes it.
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const skillPickerButtonRef = useRef<HTMLButtonElement>(null);
  const [postFormatPickerOpen, setPostFormatPickerOpen] = useState(false);
  const postFormatPickerRef = useRef<HTMLDivElement>(null);
  const postFormatPickerButtonRef = useRef<HTMLButtonElement>(null);
  const [creatorStylePickerOpen, setCreatorStylePickerOpen] = useState(false);
  const creatorStylePickerRef = useRef<HTMLDivElement>(null);
  const creatorStylePickerButtonRef = useRef<HTMLButtonElement>(null);
  const [leadMagnetPickerOpen, setLeadMagnetPickerOpen] = useState(false);
  const leadMagnetPickerRef = useRef<HTMLDivElement>(null);
  const leadMagnetPickerButtonRef = useRef<HTMLButtonElement>(null);
  // Close every composer picker when the active chat changes (switch OR the
  // active chat being deleted, which sets activeId to null). The pickers are
  // anchored to the always-mounted composer, so without this a picker opened in
  // chat A stayed floating over chat B's conversation. Keyed on activeId so it
  // covers every switch path (sidebar click, soft-nav, contextual handoff)
  // uniformly, not just loadChat.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setSkillPickerOpen(false);
      setPostFormatPickerOpen(false);
      setCreatorStylePickerOpen(false);
      setLeadMagnetPickerOpen(false);
      // Batch approve/reject badges are session-only UI keyed by artifact id, with
      // no per-chat scoping. On a chat switch they must clear: a stale "Approved"
      // badge from chat A could otherwise ride into chat B (and mask the real
      // pending_review status of a same-id draft after a reload). Cleared here so
      // each chat reflects only what the user acted on in THAT chat this session.
      setBatchReviewOutcomes({});
    });
    return () => cancelAnimationFrame(id);
  }, [activeId]);
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
  // A chat whose turn is running SERVER-SIDE but which has no live local run —
  // the case where a full-page navigation destroyed the in-memory stream + plan.
  // While set, we show a "Cowork is still working…" indicator and poll the chat
  // until the turn settles (its persisted reply then lands via loadChat). This
  // restores the "still working" feedback that was otherwise lost on return.
  const [reattachingChatId, setReattachingChatId] = useState<string | null>(null);
  // The live plan checklist for a reattaching chat, restored from
  // chats.live_plan (persisted server-side while the turn runs). Lets a returning
  // client re-render the LITERAL steps, not just a generic "still working…".
  const [reattachPlan, setReattachPlan] = useState<PlanStep[]>([]);
  // Live in-flight stream per chat (independent of which chat is on screen).
  const [runsByChat] = useState<Map<string, ChatRun>>(() => new Map());
  // Live snapshot of the workspace's current batch run — kept fresh by the
  // /api/batch/weekly poll below. Nulled when no run has ever been made or
  // between runs. Rendered as an inline activity strip on batch chats so the
  // user sees stage + counters ("Finding this week's top posts…" → "Drafting
  // 3 of 5") during the ~15-40s silence between the intro line and the first
  // draft card landing. See BatchActivityStrip.
  const [batchRun, setBatchRun] = useState<BatchRunSnapshot | null>(null);
  // Live per-writer lanes for the running batch (batch_draft_slots rows), kept
  // fresh by the same poll. Rendered as the worker board inside the batch chat
  // so the user watches each writer advance queued → drafting → filed, instead
  // of staring at a stage line while 7 workers run silently in parallel.
  const [batchSlots, setBatchSlots] = useState<BatchSlot[]>([]);
  // Bumped on every run update to trigger a render.
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  // Derived view for the active chat: base transcript + live run overlay.
  const activeRun = activeId ? runsByChat.get(activeId) : undefined;
  const activeBase = activeId ? (baseByChat.get(activeId) ?? []) : [];
  const messages: Message[] = activeId
    ? [...activeBase, ...(activeRun ? runOverlay(activeRun, activeBase) : [])]
    : [];
  // The active chat's sidebar row, used for the title-based batch-chat check
  // below. Prefer local state, but also consult fresh server props because a
  // soft navigation to a newly-created batch chat can update initialChats
  // without remounting this client component.
  const activeChat = activeId
    ? chats.find((c) => c.id === activeId) ??
      initialChats.find((c) => c.id === activeId)
    : undefined;
  // Show batch progress when the active chat is the weekly-batch session. The
  // title prefix is the primary signal, but after a soft navigation the active
  // chat can be visible before the sidebar list has merged the new server props;
  // persisted batch transcript/artifact content is the fallback so the progress
  // UI does not disappear during that handoff.
  // Dedupe by id: persisted wins over a live-run copy of the same artifact.
  // Without this, the post-stream tail can produce a brief window where BOTH
  // sources hold the same follow-up draft (after reload writes it into
  // `artifactsByChat`, before `runsByChat.delete` retires the run — those are
  // two sync setState calls that React can render between). Duplicate keys in
  // `.map(a => <Card key={a.id} />)` cause React to silently drop the
  // second element AND make click handlers fire against the WRONG closure —
  // observed symptom: user clicks Draft 9 and the panel behaves as if the
  // click never landed (the card never expands). One Set keeps the list flat.
  const activeArtifactsAll: Artifact[] = (() => {
    if (!activeId) return [];
    const seen = new Set<string>();
    const merged: Artifact[] = [];
    for (const a of artifactsByChat.get(activeId) ?? []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      merged.push(a);
    }
    for (const a of activeRun?.artifacts ?? []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      merged.push(a);
    }
    return merged;
  })();
  const hasQueuedLeadMagnetImage = activeArtifactsAll.some((artifact) => {
    const status = generatedLeadMagnetImageStatus(artifact)?.status;
    return status === "queued" || status === "running";
  });
  const isBatchChat = shouldShowBatchStatusForChat({
    title: activeChat?.title,
    messages,
    artifacts: activeArtifactsAll,
    run: batchRun,
  });
  // Only pin the LIVE batch strip while a run is actually pending/running.
  // Once the batch settles (done / failed), the strip must retire so the chat
  // flows normally — otherwise the transcript's inline `BatchWorkerBoard` and
  // the panel's `BatchPanelStatus` both stay glued to the bottom/top of their
  // scroll containers forever, and every follow-up turn renders ABOVE them.
  // The settle message (weekly.ts writes it as a real assistant chat_messages
  // row) already lives in the transcript, so nothing is lost when the strip
  // disappears.
  const batchRunActive =
    batchRun?.status === "pending" || batchRun?.status === "running";
  const showBatchStrip = isBatchChat && !!batchRun && batchRunActive;
  // Mirror isBatchChat into a ref so the long-lived poll closure (deps don't
  // include isBatchChat) can gate the extra slots fetch on it without re-firing.
  const isBatchChatRef = useRef(isBatchChat);
  useEffect(() => {
    isBatchChatRef.current = isBatchChat;
  }, [isBatchChat]);
  const fetchBatchSlotsForRun = useCallback(
    async (
      runId: string,
      options?: { shouldApply?: () => boolean },
    ): Promise<void> => {
      try {
        const sres = await fetch(
          `/api/batch/weekly/slots?batchId=${encodeURIComponent(runId)}`,
          { cache: "no-store" },
        );
        const sdata = (await sres.json().catch(() => ({}))) as {
          ok?: boolean;
          slots?: BatchSlot[];
        };
        if (
          sdata?.ok &&
          Array.isArray(sdata.slots) &&
          (options?.shouldApply?.() ?? true)
        ) {
          setBatchSlots(sdata.slots);
        }
      } catch {
        /* transient — the normal batch poll will retry */
      }
    },
    [],
  );
  useEffect(() => {
    const runId =
      typeof batchRun?.id === "string" && batchRun.id.trim() ? batchRun.id : null;
    if (!showBatchStrip || !runId) {
      return;
    }
    const timeout = window.setTimeout(() => {
      void fetchBatchSlotsForRun(runId);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [batchRun?.id, fetchBatchSlotsForRun, showBatchStrip]);
  // The drafts panel shows generated post/hook drafts ONLY: "cite" artifacts
  // (read-only source references) render inline in the conversation, and a
  // body-less artifact would render as a blank "Draft" card — so both are
  // excluded here, on every path that feeds the panel (live run + reloaded).
  //
  // Also drop drafts whose body is corrupted (leaked tool-call XML, JSON key
  // fragments, code-fence markers). The server-side gate rejects these at
  // render time (see looksCorruptedDraft), but this client filter is
  // defense-in-depth for drafts already persisted before the server fix
  // landed — otherwise the panel renders an unreadable card whose body is
  // pure `<tool_call>…` XML.
  // Minimum body length for a draft to reach the panel. A post (or hook) that
  // survives .body.trim() with just a handful of characters is never a real
  // deliverable — it's a broken model turn that emitted a stray fragment (a
  // stray `.`, one word, half a XML tag with only the letters left after the
  // corruption strip). We were showing those as blank white ArtifactCards
  // ("Draft N" chip visible, no readable body) because the LinkedIn-style
  // preview renders 1-2 chars as effectively empty space. 40 chars is well
  // below any real hook (typical LinkedIn hook: 60-120 chars) so a genuine
  // draft is never dropped. The batch drafts you already have all have 100+
  // char bodies — safe floor.
  const MIN_PANEL_DRAFT_LENGTH = 40;
  const artifacts: Artifact[] = activeArtifactsAll.filter(
    (a) =>
      (a.kind === "post" || a.kind === "hook") &&
      a.body.trim().length >= MIN_PANEL_DRAFT_LENGTH &&
      !looksCorruptedDraft(a.body),
  );
  const hasDraftPanel = artifacts.length > 0 || showBatchStrip;
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

  // React to a server-driven change of the ?chat= query. `useState(initialChatId)`
  // only fires ONCE at mount — so a soft nav that changes the query (e.g. the
  // HomeBatchCard firing `router.push('/dashboard?chat=<batchChatId>')`) re-runs
  // page.tsx and hands us a fresh initialChatId prop, but activeId stays parked
  // on whatever was open before. Result: the user saw the toast, then… nothing,
  // and had to hard-refresh to unstick the view.
  //
  // This effect swaps to the new chat whenever the prop changes and it isn't
  // already active. Inlined transcript reload (rather than calling loadChat,
  // which is declared later) so we don't hit TS's temporal-dead-zone rule OR
  // introduce a circular ordering constraint on the hooks below.
  useEffect(() => {
    if (!initialChatId) return;
    if (initialChatId === activeIdRef.current) return;
    const id = initialChatId;
    // Mark loading unless we already have this chat cached (rare on this
    // path — a soft nav to a brand-new batch chat). Skips the empty-state
    // flash while the fetch is in flight.
    const hasContent =
      (baseByChat.get(id)?.length ?? 0) > 0 || !!runsByChat.get(id);
    // Reacting to a server-driven prop change — the sanctioned setState-in-
    // effect use (parallel to loadChat's own setActiveId on click).
    setActiveId(id);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!hasContent) setLoadingChatId(id);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/chats/${id}`, { cache: "no-store" });
        if (cancelled) return;
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          messages?: RawDbMessage[];
        };
        if (!data.ok || !Array.isArray(data.messages)) return;
        baseByChat.set(id, hydrate(data.messages));
        artifactsByChat.set(
          id,
          data.messages.flatMap((m) => m.artifacts ?? []),
        );
        bump();
      } catch {
        /* the batch poll below will retry if this was a blip */
      } finally {
        if (!cancelled) {
          setLoadingChatId((cur) => (cur === id ? null : cur));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialChatId, baseByChat, artifactsByChat, runsByChat, bump]);

  // ⚡ picker: close on outside click + Escape. Capture-phase so we run before
  // any inner click handlers (e.g. clicking a skill row still toggles it first
  // — its own onClick runs, then this effect's listener decides whether to
  // close the panel based on whether the click was inside it). We DON'T close
  // on clicks on the ⚡ button itself; that button toggles, and closing here
  // would race the toggle and re-open it.
  useEffect(() => {
    if (!skillPickerOpen) return;
    const onDocPointerDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (skillPickerRef.current?.contains(t)) return;
      if (skillPickerButtonRef.current?.contains(t)) return;
      setSkillPickerOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setSkillPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [skillPickerOpen]);

  useEffect(() => {
    if (!postFormatPickerOpen) return;
    const onDocPointerDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (postFormatPickerRef.current?.contains(t)) return;
      if (postFormatPickerButtonRef.current?.contains(t)) return;
      setPostFormatPickerOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setPostFormatPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [postFormatPickerOpen]);

  useEffect(() => {
    if (!creatorStylePickerOpen) return;
    const onDocPointerDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (creatorStylePickerRef.current?.contains(t)) return;
      if (creatorStylePickerButtonRef.current?.contains(t)) return;
      setCreatorStylePickerOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setCreatorStylePickerOpen(false);
    };
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [creatorStylePickerOpen]);

  useEffect(() => {
    if (!leadMagnetPickerOpen) return;
    const onDocPointerDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (leadMagnetPickerRef.current?.contains(t)) return;
      if (leadMagnetPickerButtonRef.current?.contains(t)) return;
      setLeadMagnetPickerOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setLeadMagnetPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [leadMagnetPickerOpen]);

  // Reconcile the workspace's custom skills with the DB on mount (for the /
  // autocomplete + ⚡ picker). The list is SEEDED from the server prop above, so
  // the ⚡ button already paints on first render — this fetch just picks up any
  // skill added/removed since the page was rendered. Best-effort; a failure
  // leaves the server-seeded list in place.
  useEffect(() => {
    let alive = true;
    fetch("/api/skills")
      .then((r) => r.json())
      .then((d) => {
        if (alive && d?.ok && Array.isArray(d.skills)) setCustomSkills(d.skills);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Load the workspace's READY creator styles once (for the style picker). Only
  // 'ready' ones can be applied, so we keep just those. Best-effort.
  useEffect(() => {
    let alive = true;
    fetch("/api/creator-styles")
      .then((r) => r.json())
      .then((d) => {
        if (alive && d?.ok && Array.isArray(d.styles)) {
          setCreatorStyles(
            (d.styles as Array<Record<string, unknown>>)
              .filter((s) => s.status === "ready")
              .map((s) => ({
                id: s.id as string,
                name: s.name as string,
                creatorName: (s.creator_name as string | null) ?? null,
                creatorAvatarUrl: (s.creator_avatar_url as string | null) ?? null,
              })),
          );
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/lead-magnets")
      .then((r) => r.json())
      .then((d) => {
        if (alive && d?.ok && Array.isArray(d.leadMagnets)) {
          setLeadMagnets(
            (d.leadMagnets as Array<Record<string, unknown>>).map((lm) => ({
              id: lm.id as string,
              title: lm.title as string,
              publicSlug:
                typeof lm.public_slug === "string" ? lm.public_slug : null,
              metadata: lm.metadata as LeadMagnetSummary["metadata"],
            })),
          );
          const aiUsage = d.aiUsage as { used?: unknown; limit?: unknown } | undefined;
          if (
            typeof aiUsage?.used === "number" &&
            typeof aiUsage.limit === "number"
          ) {
            setLeadMagnetAiUsage({ used: aiUsage.used, limit: aiUsage.limit });
          }
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Add/remove a skill from the pending set for the next turn (capped). Picking
  // an already-pending skill removes it (toggle), so the ⚡ menu doubles as the
  // on/off control.
  const toggleSkill = useCallback((skill: CustomSkill) => {
    setPendingSkills((cur) => {
      if (cur.some((s) => s.id === skill.id)) {
        return cur.filter((s) => s.id !== skill.id);
      }
      if (cur.length >= SKILLS_PER_TURN_MAX) {
        toast.info(`You can apply up to ${SKILLS_PER_TURN_MAX} skills per message.`);
        return cur;
      }
      return [...cur, skill];
    });
  }, []);

  const aiLeadMagnetLimitReached = leadMagnetAiUsage
    ? leadMagnetAiUsage.used >= leadMagnetAiUsage.limit
    : false;

  const openCreateLeadMagnetForPost = useCallback(() => {
    if (aiLeadMagnetLimitReached) return;
    setLeadMagnetCreatePrompt((cur) =>
      cur.trim() ? cur : suggestedLeadMagnetPromptForPost(input, modelSource),
    );
    setLeadMagnetCreateOpen(true);
  }, [aiLeadMagnetLimitReached, input, modelSource]);

  const selectCreateLeadMagnetForPost = useCallback(
    () => {
      const prompt = leadMagnetCreatePrompt.trim();
      if (prompt.length < 8) {
        toast.error("Describe the lead magnet to create.");
        return;
      }
      if (aiLeadMagnetLimitReached) return;
      setPendingLeadMagnet({
        id: "__create_after_draft__",
        title: "New lead magnet after draft",
        createAfterDraft: true,
        prompt,
        ctaUrl: leadMagnetCreateCtaUrl.trim() || null,
        ctaLabel: leadMagnetCreateCtaLabel.trim() || null,
      });
      setLeadMagnetCreateOpen(false);
      setLeadMagnetPickerOpen(false);
      toast.success("Lead magnet will be created after the draft");
    },
    [
      aiLeadMagnetLimitReached,
      leadMagnetCreateCtaLabel,
      leadMagnetCreateCtaUrl,
      leadMagnetCreatePrompt,
    ],
  );

  // Refetch the sidebar chat list when the user returns to /dashboard/chat after
  // navigating away. The page's Server Component baked an `initialChats`
  // snapshot at first render; if the user creates a chat (e.g. via "model this
  // post"), leaves the route, and comes back, Next.js may serve a cached page
  // render → initialChats is stale → the new chat is missing until a hard
  // refresh. We refetch on the page becoming visible and merge by id so we
  // preserve in-memory chats added since mount.
  useEffect(() => {
    if (typeof document === "undefined") return;
    let alive = true;
    const refresh = async () => {
      try {
        const res = await fetch("/api/chats");
        if (!res.ok) return;
        const data = (await res.json()) as { chats?: ChatSummary[] };
        if (!alive || !Array.isArray(data.chats)) return;
        setChats((cur) => {
          // Merge: server's list is authoritative for shared fields, but a
          // chat that's in `cur` and not yet in the server response (just
          // created, replication lag) stays.
          const serverIds = new Set(data.chats!.map((c) => c.id));
          const extras = cur.filter((c) => !serverIds.has(c.id));
          return [...extras, ...data.chats!];
        });
      } catch {
        // Best-effort; the stale list is no worse than before.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Also refresh on mount — the page Server Component may have served a
    // cached prerender (no DB read this navigation), so initialChats can be
    // stale even though we just "arrived". One extra request per nav, returns
    // <1KB.
    void refresh();
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Pick a custom skill from the / menu: add it to the pending set and clear the
  // composer (the "/query" was the whole input, like a starter pick).
  const pickSkillFromSlash = useCallback(
    (skill: CustomSkill) => {
      toggleSkill(skill);
      setInput("");
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [toggleSkill],
  );

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
  const [draftStoreReady, setDraftStoreReady] = useState(false);
  const [forcedDraftByChat, setForcedDraftByChat] = useState<Record<string, string>>({});
  useEffect(() => {
    setInput(readDraft(activeIdRef.current));
    setDraftActiveId(activeIdRef.current);
    setDraftStoreReady(true);
  }, []);
  if (draftStoreReady && draftActiveId !== activeId) {
    writeDraft(draftActiveId, input); // input still holds the leaving chat's text
    const arrivingChatId = activeId;
    const forcedDraft =
      arrivingChatId === null
        ? undefined
        : forcedDraftByChat[arrivingChatId];
    if (arrivingChatId !== null && forcedDraft !== undefined) {
      setForcedDraftByChat((prev) => {
        const next = { ...prev };
        delete next[arrivingChatId];
        return next;
      });
      writeDraft(arrivingChatId, forcedDraft);
      setInput(forcedDraft);
    } else {
      setInput(readDraft(arrivingChatId));
    }
    setDraftActiveId(arrivingChatId);
  }
  // Persist the current chat's input as it changes. localStorage-only (no
  // setState), so it's a plain effect with no cascading-render concern.
  useEffect(() => {
    if (!draftStoreReady) return;
    writeDraft(activeIdRef.current, input);
  }, [draftStoreReady, input]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const width = readDraftPanelWidth();
      draftPanelWidthRef.current = width;
      setDraftPanelWidth(width);
      setDraftPanelWidthReady(true);
      setVoiceWarningDismissed(readVoiceWarningDismissed());
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    draftPanelWidthRef.current = draftPanelWidth;
  }, [draftPanelWidth]);

  const dismissVoiceWarning = useCallback(() => {
    setVoiceWarningDismissed(true);
    writeVoiceWarningDismissed();
  }, []);

  const shouldShowVoiceWarning =
    !initialVoiceReady && !voiceWarningDismissed && input.trim().length > 0;

  const startDraftPanelResize = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      setResizingDraftPanel(true);
      draftPanelResizeRef.current = {
        startX: e.clientX,
        startWidth: draftPanelWidthRef.current,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [],
  );

  const resizeDraftPanel = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const resize = draftPanelResizeRef.current;
    if (!resize) return;
    const next = clampDraftPanelWidth(resize.startWidth + resize.startX - e.clientX);
    setDraftPanelWidth(next);
  }, []);

  const stopDraftPanelResize = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (!draftPanelResizeRef.current) return;
    draftPanelResizeRef.current = null;
    setResizingDraftPanel(false);
    writeDraftPanelWidth(draftPanelWidthRef.current);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* non-fatal */
    }
  }, []);

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
  // An AI refine in flight per chat: the draft card the user asked to refine.
  // A refine produces a NEW draft card appended alongside the source draft (not
  // an in-place update — every iteration is its own card so the user can
  // compare and pick). This ref carries per-refine metadata the artifact
  // handler needs: `originalBody` for the collapse guard's before/after check
  // and for hook-only body preservation; `hookOnly` flips the handler into
  // splicePreservedBody mode. Set in refineDraft, consumed and cleared by the
  // artifact handler after the first draft arrives.
  const pendingRefineRef = useRef<
    Map<string, { hookOnly?: boolean; originalBody?: string }>
  >(new Map());
  // A refine whose incoming draft was rejected by the collapse guard (GLM
  // shrunk a real post into a fragment). The fragment WAS saved server-side —
  // the post-stream tail DELETEs it so a reload doesn't resurrect it. Keyed by
  // chatId → the artifact id to delete.
  const collapsedRefineRef = useRef<Map<string, string>>(new Map());
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
        if (verdict === "reject-other") {
          toast.error(`Unsupported file type`, {
            description: `${file.name}: attach an image, PDF, Word doc, or text file (.txt, .md, .skills, .csv).`,
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
          } else if (verdict === "file") {
            picked.push({
              localId,
              filename: file.name,
              size: file.size,
              kind: "file",
              dataUrl: await readAsDataUrl(file),
            });
          } else {
            picked.push({
              localId,
              filename: file.name,
              size: file.size,
              kind: "image",
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

  // ----- drag-and-drop file attach -----
  //
  // Dropping files onto the composer routes them through the SAME onPickFiles
  // path as the paperclip button (classify → validate type/size → enforce
  // count + aggregate caps), so drag-drop and click-to-attach are byte-for-byte
  // identical. We only react to drags that carry FILES (dataTransfer contains
  // an item of kind "file") — a text selection or a link drag is ignored so the
  // overlay never flashes on those.
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  // dragenter/dragleave fire for every child element the cursor crosses, so a
  // naive boolean flickers as the pointer moves over the textarea, chips, etc.
  // A depth counter (enter++ / leave--) keeps the overlay stable until the drag
  // actually leaves the composer.
  const dragDepthRef = useRef(0);

  // True when a drag event's payload contains at least one file. Guards against
  // showing the drop overlay for non-file drags (selected text, a dragged link).
  const dragHasFiles = useCallback(
    (e: React.DragEvent) => dataTransferHasFiles(e.dataTransfer),
    [],
  );

  const onComposerDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setIsDraggingFile(true);
    },
    [dragHasFiles],
  );

  const onComposerDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      // preventDefault on dragover is REQUIRED or the browser treats the drop
      // as a navigation (opens the file) instead of firing our onDrop.
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [dragHasFiles],
  );

  const onComposerDragLeave = useCallback((e: React.DragEvent) => {
    // Only count leaves that pair with a prior enter (a non-file drag never
    // incremented the depth, so it can't drive it negative here).
    if (dragDepthRef.current === 0) return;
    e.preventDefault();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current === 0) setIsDraggingFile(false);
  }, []);

  const onComposerDrop = useCallback(
    (e: React.DragEvent) => {
      dragDepthRef.current = 0;
      setIsDraggingFile(false);
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      // DataTransfer.files IS a FileList — the exact type onPickFiles takes, so
      // the drop reuses every validation + cap the picker already enforces.
      void onPickFiles(e.dataTransfer.files);
    },
    [onPickFiles],
  );

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

  // Reset scroll state when the ACTIVE CHAT changes. The scroll container is
  // reused across chats (not keyed on activeId), and the pin-to-bottom effect
  // above keys on scrollKey (message count + streamed length) — so switching to
  // a chat with the SAME message count left the previous chat's scrollTop, and
  // the userScrolledAway flag leaked across the switch (a chat opened
  // pre-scrolled and wouldn't auto-pin). On every switch: clear the scroll-away
  // flag and snap the new chat to the bottom (the expected fresh-open state),
  // after a rAF so the swapped-in transcript has laid out.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      setUserScrolledAway(false);
      el.scrollTo({ top: el.scrollHeight });
    });
    return () => cancelAnimationFrame(id);
  }, [activeId]);

  // Drafts accordion: auto-expand the NEWEST draft whenever it changes (a new
  // draft arrives) OR when the active chat changes (so a switch never leaves
  // the previous chat's expanded id, which would render all of the new chat's
  // drafts collapsed). A manual click overrides until the next new draft lands.
  //
  // Runs in an effect (not during render) so a manual click doesn't get stomped
  // by a same-render auto-expand. Under the old render-time pattern, clicking a
  // COLLAPSED row set expandedArtifactId to that draft's id, then the same
  // render pass ran the accordion check and — if a poll tick had just landed a
  // NEW artifact whose id also became the "newest" — overwrote the click with
  // that other id. Symptom: click Draft 9, panel keeps showing an OLDER card.
  // Moving this to an effect lets the click's setState commit BEFORE the
  // accordion sees whether it still needs to force a change.
  const newestArtifactId = artifacts.length
    ? artifacts[artifacts.length - 1].id
    : null;
  const accordionKey = `${activeId ?? ""}:${newestArtifactId ?? ""}`;
  useEffect(() => {
    if (accordionKey === lastNewestArtifactId) return;
    const id = requestAnimationFrame(() => {
      setLastNewestArtifactId(accordionKey);
      setExpandedArtifactId(newestArtifactId);
    });
    return () => cancelAnimationFrame(id);
  }, [accordionKey, lastNewestArtifactId, newestArtifactId]);

  // Contextual-action handoff: ?model=<id> means the user launched an AI action
  // on a post (swipe file / bookmark). &intent=<key> selects WHICH action —
  // model after it, break down its hook, draft variations, or analyze why it
  // worked (see lib/post-intents). Fetch the stashed source, start a fresh chat,
  // attach it as a chip, prefill the matching instruction, and clear the params
  // so a refresh/back-nav doesn't re-trigger it. Runs once per distinct id.
  const modelParam = searchParams.get("model");
  const intentParam = searchParams.get("intent");
  const handoffParam = searchParams.get("handoff");
  useEffect(() => {
    if (!modelParam) return;
    const intent = resolveIntent(intentParam);
    let cancelled = false;
    (async () => {
      try {
        const previousActiveId = activeId;
        // A model-source handoff should always land on a fresh Cowork chat. On
        // soft navigations the server may pass initialChatId=null, but this
        // mounted client component keeps its old activeId unless we clear it.
        setActiveId(null);
        setInput("");
        setModelSource(null);
        setAttachments([]);
        if (previousActiveId) {
          const previousRun = runsByChat.get(previousActiveId);
          // A stopped/settled run should not keep the next contextual handoff
          // visually or logically tied to the paused chat. Leave genuinely live
          // background streams alone; this only sweeps stale local guard state.
          if (previousRun && (previousRun.stopped || !previousRun.streaming)) {
            runsByChat.delete(previousActiveId);
          }
          inFlightRef.current.delete(previousActiveId);
          lastSendRef.current.delete(previousActiveId);
        }
        inFlightRef.current.delete("__new__");
        lastSendRef.current.delete("__new__");

        const res = await fetch(`/api/model-source/${modelParam}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Couldn't load that post");
        if (cancelled) return;
        const s = data.source;
        // Fresh chat so the modeled post doesn't get mixed into an existing
        // conversation.
        const chatRes = await fetch("/api/chats", { method: "POST" });
        const chatData = await chatRes.json();
        if (!chatData.ok || !chatData.chat?.id) {
          throw new Error(chatData.error || "Couldn't start a new chat");
        }
        if (cancelled) return;
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
        // Seed the new chat's saved draft with the intent prompt BEFORE we
        // switch to it. The draft-swap-on-chat-change block (see draftActiveId)
        // runs setInput(readDraft(activeId)) the moment activeId changes; for a
        // brand-new chat readDraft() is empty, so it was WIPING the prompt we
        // set below (that's why "Model this post" showed a blank composer).
        // Seeding first makes that swap read the prompt back instead of blank.
        const handoffChatId: string = chatData.chat.id;
        setForcedDraftByChat((prev) => ({ ...prev, [handoffChatId]: intent.prompt }));
        writeDraft(handoffChatId, intent.prompt);
        setActiveId(handoffChatId);
        bump();
        setPendingPostFormat(null);
        setPostFormatPickerOpen(false);
        setPendingLeadMagnet(null);
        setLeadMagnetPickerOpen(false);
        setPendingCreatorStyle(null);
        setCreatorStylePickerOpen(false);
        setModelSource({
          id: s.id,
          authorName: s.author_name ?? null,
          authorAvatar: s.author_avatar ?? null,
          postText: s.post_text,
          partial: !!s.partial,
          postType: s.post_type === "lead_magnet" ? "lead_magnet" : "regular",
          kind:
            s.source === "draft" || s.source === "bookmark" || s.source === "template"
              ? s.source
              : "swipe",
        });
        // Also set it directly — belt-and-suspenders with the seeded draft above,
        // so whichever resolves last (this setInput, or the draft-swap reading
        // the seed), the composer ends up holding the prompt.
        setInput(intent.prompt);
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (activeIdRef.current === handoffChatId) {
            writeDraft(handoffChatId, intent.prompt);
            setInput(intent.prompt);
          }
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
    // Re-run when the source id, intent, or explicit handoff attempt changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelParam, intentParam, handoffParam]);

  // (The Posts "Model in Chat" handoff now goes through the ?model= path above
  // with intent=refine — same source chip + clean composer as swipe/bookmark —
  // so there's no separate ?draft= effect anymore.)

  // Creator Styles "Model with Cowork" handoff: ?style=<id> opens a FRESH chat with
  // that style preselected in the composer picker (the chip appears, ready for
  // the next message) — so the style lands on a clean conversation, not whatever
  // chat happened to be open. Waits for creatorStyles to load, matches by id,
  // then clears the param so a refresh/back-nav doesn't re-trigger. Best-effort —
  // an unknown/not-yet-ready id just clears the param with no chip.
  const styleParam = searchParams.get("style");
  useEffect(() => {
    if (!styleParam || creatorStyles.length === 0) return;
    const match = creatorStyles.find((s) => s.id === styleParam);
    if (match) {
      // Reset to a fresh empty chat first (same as newChat: clear the open chat,
      // composer, model source, attachments + other pickers), then attach the
      // style chip. Inlined rather than calling newChat() because that callback
      // is declared below this effect. One-shot: we clear ?style= in the same
      // tick so the effect can't re-run and clobber a chat the user then starts.
      /* eslint-disable react-hooks/set-state-in-effect */
      setActiveId(null);
      setInput("");
      setModelSource(null);
      setAttachments([]);
      setPendingPostFormat(null);
      setPostFormatPickerOpen(false);
      setPendingLeadMagnet(null);
      setLeadMagnetPickerOpen(false);
      setCreatorStylePickerOpen(false);
      setPendingCreatorStyle(match);
      /* eslint-enable react-hooks/set-state-in-effect */
      bump();
    }
    router.replace("/dashboard");
    // Re-run when the param or the loaded styles change (the styles fetch may
    // land after this effect first runs with an empty list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleParam, creatorStyles]);

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
        // Server says a turn is running for this chat, but we have no live local
        // run (a full-page navigation destroyed it). Flag it so the reattach
        // indicator + poll kick in, restoring the "Cowork is still working…"
        // feedback until the turn settles and its reply persists. When there IS
        // a local run, the live overlay already shows progress, so skip.
        const serverRunning =
          (data.chat as { running?: boolean } | undefined)?.running === true;
        const willReattach = serverRunning && !runsByChat.get(id);
        setReattachingChatId((cur) => {
          if (willReattach) return id;
          // This chat is no longer reattaching (settled, or has a local run).
          return cur === id ? null : cur;
        });
        // Restore the literal plan checklist from the server's live_plan.
        if (willReattach) {
          setReattachPlan(normalizeLivePlan((data.chat as { live_plan?: unknown }).live_plan));
        }
        // DON'T delete the run here. `!run.streaming` looks like "finished →
        // already in base", but send()'s post-stream tail has a multi-await
        // window where the run is non-streaming yet NOT yet folded into base
        // (it's mid reload/swap). Deleting it here in that window raced send()'s
        // own swap: two reloads competed and, if this one captured the base
        // before the assistant row committed, the just-finished reply vanished.
        // The run's OWNER (send()'s tail) retires it exactly once; until then
        // runOverlay renders it without double-counting. So loadChat leaves it.
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

  // -----------------------------------------------------------------------------
  // Reattach poll — restore the "Cowork is still working…" feedback after a
  // full-page navigation destroyed the live in-memory run.
  //
  // When we return to a chat whose turn is running server-side (chats.running,
  // surfaced by the chat GET) but for which we hold no live local run, the plan
  // checklist + streamed text are gone (never persisted; the SSE reader died
  // with the old page). Without this, the user waited blindly and the reply only
  // appeared on a later manual refresh. This poll refetches the chat every ~2.5s
  // while it's still running; the moment the turn settles (server `running` flips
  // false), the fetch's base refresh shows the persisted reply and we clear the
  // reattach flag. Only the ACTIVE reattaching chat is polled.
  // -----------------------------------------------------------------------------
  useEffect(() => {
    if (!reattachingChatId || reattachingChatId !== activeId) return;
    // A local run supersedes the reattach path — the live overlay owns progress,
    // and the render guard already hides the indicator, so just don't poll. The
    // flag clears on the next loadChat/poll tick (avoids a set-state-in-effect).
    if (runsByChat.get(reattachingChatId)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      const id = reattachingChatId;
      try {
        const res = await fetch(`/api/chats/${id}`, { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          chat?: { running?: boolean; live_plan?: unknown };
          messages?: RawDbMessage[];
        };
        if (!stopped && data.ok && Array.isArray(data.messages)) {
          // Fold in any newly-persisted rows (the settled reply lands here).
          if (!runsByChat.has(id)) {
            const nextBase = hydrate(data.messages);
            const prevBase = baseByChat.get(id) ?? [];
            const prevLast = prevBase[prevBase.length - 1]?.id ?? null;
            const nextLast = nextBase[nextBase.length - 1]?.id ?? null;
            if (prevBase.length !== nextBase.length || prevLast !== nextLast) {
              baseByChat.set(id, nextBase);
              artifactsByChat.set(id, data.messages.flatMap((m) => m.artifacts ?? []));
              bump();
            }
          }
          // Turn settled (or a local run took over) → stop reattaching + drop
          // the checklist so the persisted reply is what shows.
          if (data.chat?.running !== true || runsByChat.has(id)) {
            setReattachingChatId((cur) => (cur === id ? null : cur));
            setReattachPlan([]);
            return;
          }
          // Keep the restored checklist current as steps tick from pending→done.
          setReattachPlan(normalizeLivePlan(data.chat?.live_plan));
        }
      } catch {
        /* transient — next tick retries */
      }
      if (!stopped) timer = setTimeout(tick, 2500);
    };
    tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [reattachingChatId, activeId, runsByChat, baseByChat, artifactsByChat, bump]);

  // Mount-time reattach probe. The component initializes the active chat from
  // SSR props (initialChatId/initialMessages) WITHOUT calling loadChat, so the
  // reattach detection there never runs for the chat we land on after a hard
  // navigation. Probe that one chat's running state once on mount so returning
  // mid-turn shows the "still working…" indicator + kicks the poll. Runs only
  // when we have an initial chat and no live local run for it.
  useEffect(() => {
    if (!initialChatId) return;
    if (runsByChat.get(initialChatId)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/chats/${initialChatId}`, { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          chat?: { running?: boolean; live_plan?: unknown };
        };
        if (cancelled || !data.ok) return;
        // Only apply if the user is STILL on this chat — a fast switch to another
        // chat during the probe's in-flight fetch shouldn't set reattach state
        // for the chat we already left (it'd be a stale value; harmless via the
        // render/poll guards, but cleaner not to set it at all).
        if (
          data.chat?.running === true &&
          initialChatId === activeIdRef.current &&
          !runsByChat.get(initialChatId)
        ) {
          setReattachingChatId(initialChatId);
          setReattachPlan(normalizeLivePlan(data.chat.live_plan));
        }
      } catch {
        /* best-effort — no reattach indicator if the probe fails */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: probe the initial chat exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------------------
  // Batch chat live-feedback poll.
  //
  // The weekly batch runs in the background worker and writes to chat_messages
  // as each draft finishes — no SSE, no push. Before this poll, the transcript
  // hydrated once and then sat frozen: the user saw the intro line (if that,
  // and only after a hard refresh — see the initialChatId sync effect above)
  // and had to keep refreshing to watch the drafts land. This poll makes the
  // batch chat feel LIVE: while the workspace's batch_runs row is
  // pending|running, we refetch the active chat every ~2.5s and merge new
  // rows into baseByChat.
  //
  // Design notes:
  //   • Trigger is a workspace-level status ping (/api/batch/weekly), not a
  //     per-chat one. Only ONE batch runs per workspace at a time, so this
  //     matches the invariant naturally and needs no new endpoint.
  //   • If the active chat isn't the batch chat, the extra reload is
  //     harmless (message ids haven't changed → no re-render).
  //   • Stops on done/failed and issues ONE final reload so the closing
  //     "Review them on your Posts page" line lands even if it hit the DB
  //     right as we stopped.
  //   • When no run is active (idle workspace), tick() short-circuits after
  //     one ping; no infinite polling of a quiet API.
  //   • Re-fires whenever activeId flips — so opening the fresh batch chat
  //     via the initialChatId sync effect kicks the poll immediately.
  // -----------------------------------------------------------------------------
  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const reloadActive = async (): Promise<void> => {
      const id = activeIdRef.current;
      if (!id) return;
      try {
        const res = await fetch(`/api/chats/${id}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          ok?: boolean;
          messages?: RawDbMessage[];
        };
        if (!data.ok || !Array.isArray(data.messages)) return;
        // Never clobber a live in-flight run's overlay by rewriting base
        // mid-turn. Ordinary batch turns don't set runsByChat, so this only
        // guards the (rare) case where the user sends a normal message
        // AGAINST the batch chat while workers are still filing drafts.
        if (runsByChat.has(id)) return;
        const nextBase = hydrate(data.messages);
        const prevBase = baseByChat.get(id) ?? [];
        // Cheap change detection: length or last-id delta. Avoids
        // reconstructing identical Message[] arrays each tick.
        const prevLast = prevBase[prevBase.length - 1]?.id ?? null;
        const nextLast = nextBase[nextBase.length - 1]?.id ?? null;
        if (prevBase.length === nextBase.length && prevLast === nextLast) return;
        baseByChat.set(id, nextBase);
        artifactsByChat.set(
          id,
          data.messages.flatMap((m) => m.artifacts ?? []),
        );
        bump();
      } catch {
        /* transient — next tick retries */
      }
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const res = await fetch("/api/batch/weekly", { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          run?: BatchRunSnapshot | null;
        };
        const run = data?.run ?? null;
        // Publish the snapshot every tick so the inline activity strip
        // reflects the live stage + counters. Guard: only overwrite state
        // if it actually changed (cheap shallow compare) — spare a re-render
        // on every idle 2.5s tick when nothing's moving.
        if (!stopped) {
          setBatchRun((prev) => {
            if (prev === run) return prev;
            if (!prev && !run) return prev;
            if (
              prev &&
              run &&
              prev.status === run.status &&
              prev.stage === run.stage &&
              prev.total === run.total &&
              prev.created === run.created &&
              prev.attempted === run.attempted
            ) {
              return prev;
            }
            return run;
          });
        }
        const status = run?.status;
        const running = status === "pending" || status === "running";
        // Fetch the per-writer lanes so the worker board can render live and
        // remain visible after settle. Only on the batch chat (no point paying
        // for slots on a normal chat). run.id IS the batchId.
        const runId = (run as { id?: string } | null)?.id ?? null;
        if (runId && isBatchChatRef.current) {
          await fetchBatchSlotsForRun(runId, { shouldApply: () => !stopped });
        }
        if (typeof document !== "undefined" && document.hidden && running) {
          if (!stopped) timer = setTimeout(() => void tick(), CHAT_BATCH_HIDDEN_POLL_MS);
        } else if (running) {
          await reloadActive();
          if (!stopped) {
            timer = setTimeout(
              () => void tick(),
              status === "pending" ? CHAT_BATCH_QUEUED_POLL_MS : CHAT_BATCH_RUNNING_POLL_MS,
            );
          }
        } else if (status === "done" || status === "failed") {
          // One final reload so the closing "Review them on your Posts page"
          // line and any last-worker card that raced with settle both land.
          await reloadActive();
        }
        // status === undefined (workspace has never run a batch) → don't tick
      } catch {
        // API blip → back off slightly, don't spin.
        if (!stopped) {
          timer = setTimeout(
            () => void tick(),
            typeof document !== "undefined" && document.hidden ? CHAT_BATCH_HIDDEN_POLL_MS : 5000,
          );
        }
      }
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeId, bump, baseByChat, artifactsByChat, fetchBatchSlotsForRun, runsByChat]);

  // Lead-magnet images are generated by the background worker after the text
  // draft is already saved. While the active chat has a queued/running image
  // artifact, refresh the transcript lightly until the worker patches it with
  // media or a terminal skip/failure reason.
  useEffect(() => {
    if (!activeId || !hasQueuedLeadMagnetImage) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      const id = activeIdRef.current;
      if (!id || stopped) return;
      try {
        const res = await fetch(`/api/chats/${id}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          ok?: boolean;
          messages?: RawDbMessage[];
        };
        if (!data.ok || !Array.isArray(data.messages)) return;
        if (runsByChat.has(id)) return;
        const nextBase = hydrate(data.messages);
        baseByChat.set(id, nextBase);
        artifactsByChat.set(
          id,
          data.messages.flatMap((m) => m.artifacts ?? []),
        );
        bump();
      } catch {
        /* transient — next tick retries */
      } finally {
        if (!stopped) {
          timer = setTimeout(
            () => void tick(),
            typeof document !== "undefined" && document.hidden ? CHAT_BATCH_HIDDEN_POLL_MS : IMAGE_ARTIFACT_POLL_MS,
          );
        }
      }
    };

    timer = setTimeout(() => void tick(), 2500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    activeId,
    hasQueuedLeadMagnetImage,
    baseByChat,
    artifactsByChat,
    runsByChat,
    bump,
  ]);

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
    setPendingPostFormat(null);
    setPostFormatPickerOpen(false);
    setPendingLeadMagnet(null);
    setLeadMagnetPickerOpen(false);
    setPendingCreatorStyle(null);
    setCreatorStylePickerOpen(false);
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

  const send = useCallback(async (
    overrideText?: string,
    sendOpts?: {
      skipDecision?: boolean;
      skillIds?: string[];
      forceRefine?: boolean;
      // Hook-only refine: the server will splice the model's new opener onto
      // this source body byte-for-byte before persisting, so the body cannot
      // drift. Set by the ask-card "Tighten the hook" click and by
      // refineDraft() when the instruction is hook-focused.
      hookOnly?: boolean;
      hookOnlyOriginalBody?: string;
    },
  ) => {
    // Caller passes overrideText to send a specific message without going
    // through the composer input — used by the "Continue" recovery button on
    // a cut-off/truncated assistant turn. Default path reads `input`.
    // sendOpts.skipDecision is set for an AI refine so the server skips the
    // clarify pre-pass (the refine already targets one draft).
    // sendOpts.skillIds lets a refine INHERIT the skill(s) the source draft was
    // produced under (pendingSkills is empty by then — it's consumed each
    // send), so the refine stays guided by the skill AND keeps the badge.
    let text = (overrideText ?? input).trim();
    if (!text) return;

    if (!overrideText && !initialVoiceReady && !voiceWarningShownRef.current) {
      voiceWarningShownRef.current = true;
      toast.info("Cowork works better after voice setup.", {
        description: "You can still send this, but drafts will sound more like you once Voice is complete.",
        action: {
          label: "Set up voice",
          onClick: () => router.push("/dashboard/voice"),
        },
      });
    }

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
      const turnPostFormatApplies = clientShouldApplyPostFormat(text, !!attached);

      // Capture the pending custom skills for this turn. We do NOT clear the
      // composer chip here — clearing it now but only registering the user
      // message (which carries the same skill as a bubble badge) LATER opens a
      // visible gap: for a brand-new chat there's an `await fetch("/api/chats")`
      // between, so the chip vanishes for a whole round-trip before the badge
      // appears. Instead we clear pendingSkills in the SAME synchronous batch
      // as runsByChat.set() + bump() below, so the chip→badge handoff is one
      // frame with no flicker. (turnSkills is already captured, so the send
      // uses it regardless of when the state clears.)
      const turnSkills = pendingSkills;
      const turnPostFormat = pendingPostFormat;
      const turnLeadMagnet = pendingLeadMagnet;
      const turnLeadMagnetApplies = clientShouldApplyLeadMagnet(
        text,
        !!attached,
        turnPostFormat,
        Boolean(turnLeadMagnet),
        attached?.postType ?? null,
      );
      const turnAutoLeadMagnetFromSource =
        !turnLeadMagnet &&
        attached?.postType === "lead_magnet" &&
        turnLeadMagnetApplies;
      // Creator Style rides the same per-turn capture. It applies only when NO
      // model source is attached (a source post controls the structure), same
      // rule as Post Format — the badge + stream field are gated on it.
      const turnCreatorStyle = pendingCreatorStyle;
      const turnCreatorStyleApplies = !attached;
      // The skill ids sent to the server: explicit (a refine inheriting the
      // source draft's skills) OR the composer chips. The bubble badge still
      // comes from turnSkills (composer chips only) — an inherited refine skill
      // shouldn't render as if the user re-applied it this turn; it rides
      // silently so the skill keeps guiding the rewrite + re-tags the artifact.
      // `let` so the composer-refine auto-detect below can inherit the target
      // draft's skills when the user typed a refine (no chips, no explicit ids).
      let turnSkillIds =
        sendOpts?.skillIds && sendOpts.skillIds.length > 0
          ? sendOpts.skillIds
          : turnSkills.map((s) => s.id);
      setSkillPickerOpen(false);
      setPostFormatPickerOpen(false);
      setCreatorStylePickerOpen(false);
      setLeadMagnetPickerOpen(false);

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
          // Reflect the new chat's id in the URL WITHOUT navigating. A lazily-
          // created chat had no ?chat= param, so a full-page navigation away and
          // back resolved the active chat via the server's chatList[0] fallback
          // (most-recent updated_at) — which is unreliable while THIS turn is
          // mid-flight and other chats may sort ahead, landing the user on the
          // wrong (e.g. 2nd-latest) chat. replaceState updates the URL so a return
          // deterministically re-opens this chat; it doesn't re-render or trigger
          // a server round-trip (unlike router.replace), so the live stream is
          // undisturbed.
          try {
            const url = new URL(window.location.href);
            url.searchParams.set("chat", resolvedId);
            window.history.replaceState(window.history.state, "", url);
          } catch {
            /* URL sync is best-effort — never block the send on it */
          }
        } catch (e) {
          // Chat creation failed BEFORE we sent anything — the turn never
          // happened. Restore what we optimistically consumed above (the
          // model-source chip + the file attachments) so the user can retry
          // without re-attaching. The composer text isn't cleared until later
          // (after this block), so it's already intact. The skill chip is also
          // still intact — we now clear it only AFTER run registration (below),
          // which this early-return never reaches. Drop the dedupe record so an
          // immediate retry of the same text isn't swallowed.
          if (attached) setModelSource(attached);
          if (files.length) setAttachments(files);
          if (turnPostFormat) setPendingPostFormat(turnPostFormat);
          if (turnLeadMagnet) setPendingLeadMagnet(turnLeadMagnet);
          if (turnCreatorStyle) setPendingCreatorStyle(turnCreatorStyle);
          lastSendRef.current.delete(lockKey);
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

      // Auto-detect "the user is refining the most recent draft via the
      // composer" (vs clicking the per-card Refine button). This is what tells
      // the server to skip the clarify pre-pass and cap draft renders at 1, so
      // a composer-typed refine behaves the same as the Refine button. Also
      // stashes the source draft's body so the artifact handler's hook-only
      // preservation + collapse guard work for composer-typed refines too.
      // Conservative: skips when an explicit Refine-button click already set
      // pendingRefineRef (don't clobber the user's explicit choice).
      // True when THIS turn is a refine — either an explicit Refine-button send
      // (sendOpts.skipDecision) or a composer-detected one (set just below).
      // Sent to the server as skipDecision, which it also uses as the isRefine
      // signal (caps drafts at 1 → a "make it shorter" can't explode into 6).
      let refineThisTurn = !!sendOpts?.skipDecision;
      if (
        !pendingRefineRef.current.get(chatId) &&
        (sendOpts?.forceRefine || looksLikeComposerRefine(text))
      ) {
        // Search BOTH the persisted set AND the live run's artifacts for the
        // source draft. A draft made earlier THIS turn-chain may still be only
        // in the live run (not yet folded into artifactsByChat by a post-stream
        // reload); include it so hook-only preservation still works for a
        // refine right after the first draft renders.
        const persisted = artifactsByChat.get(chatId) ?? [];
        const runArts = runsByChat.get(chatId)?.artifacts ?? [];
        const seenIds = new Set(persisted.map((a) => a.id));
        const combined = [...persisted, ...runArts.filter((a) => !seenIds.has(a.id))];
        const drafts = combined.filter(
          (a) => a.kind === "post" || a.kind === "hook",
        );
        const target = drafts[drafts.length - 1]; // latest draft
        if (target) {
          pendingRefineRef.current.set(chatId, {
            originalBody: target.body,
            ...(target.kind === "post" && isHookFocusedRefine(text)
              ? { hookOnly: true }
              : {}),
          });
          // A composer-typed refine IS a refine: skip the clarify pre-pass +
          // cap drafts at 1 server-side, same as the Refine button.
          refineThisTurn = true;
          // Inherit the target draft's skill(s) so a composer-typed refine
          // (no chips applied) stays guided by the same skill and keeps the
          // /skill badge — but only when the user didn't explicitly apply
          // skills this turn (those win).
          if (turnSkillIds.length === 0) {
            turnSkillIds = skillNamesToIds(artifactSkillNames(target), customSkills);
          }
        }
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
        ...(turnSkills.length
          ? { skills: turnSkills.map((s) => s.name) }
          : {}),
        ...(turnPostFormat && turnPostFormatApplies
          ? { postFormat: noModelFormatLabel(turnPostFormat) }
          : {}),
        ...(turnCreatorStyle && turnCreatorStyleApplies
          ? {
              creatorStyle: {
                name: turnCreatorStyle.name,
                creatorName: turnCreatorStyle.creatorName,
              },
            }
          : {}),
        ...(turnLeadMagnet && turnLeadMagnetApplies
          ? {
              leadMagnet: {
                title: turnLeadMagnet.title,
                selection: "manual" as const,
              },
            }
          : turnAutoLeadMagnetFromSource
            ? {
                leadMagnet: {
                  title: "Auto",
                  selection: "auto" as const,
                },
              }
          : {}),
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
      // Clear the composer's skill chip HERE — in the same batch as the run
      // registration + bump that renders the user message (which shows the
      // skill as a bubble badge). Same frame = the chip moves from composer to
      // bubble with no intermediate "skill gone" flash. (turnSkills was
      // captured above; clearing the state now doesn't affect this send.)
      if (turnSkills.length) setPendingSkills([]);
      if (turnPostFormat) setPendingPostFormat(null);
      if (turnLeadMagnet) setPendingLeadMagnet(null);
      if (turnCreatorStyle) setPendingCreatorStyle(null);
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
      let streamAborted = false;

      try {
        const res = await fetch(`/api/chats/${chatId}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            ...(attached ? { modelSourceId: attached.id } : {}),
            ...(filePayload.length ? { attachments: filePayload } : {}),
            ...(refineThisTurn ? { skipDecision: true } : {}),
            // Hook-only refine: the server splices the model's new opener onto
            // this original body byte-for-byte before persisting the artifact,
            // so a hook-only refine can never let the body drift.
            ...(sendOpts?.hookOnly && sendOpts.hookOnlyOriginalBody
              ? {
                  hookOnly: true,
                  hookOnlyOriginalBody: sendOpts.hookOnlyOriginalBody,
                }
              : {}),
            ...(turnSkillIds.length ? { skillIds: turnSkillIds } : {}),
            ...(turnPostFormat ? { forcedNoModelFormatId: turnPostFormat } : {}),
            ...(turnLeadMagnet &&
            turnLeadMagnetApplies &&
            !isCreateAfterDraftLeadMagnet(turnLeadMagnet)
              ? { leadMagnetId: turnLeadMagnet.id }
              : {}),
            ...(turnLeadMagnet &&
            turnLeadMagnetApplies &&
            isCreateAfterDraftLeadMagnet(turnLeadMagnet)
              ? {
                  createLeadMagnet: {
                    prompt: turnLeadMagnet.prompt,
                    ...(turnLeadMagnet.ctaUrl
                      ? { cta_url: turnLeadMagnet.ctaUrl }
                      : {}),
                    ...(turnLeadMagnet.ctaLabel
                      ? { cta_label: turnLeadMagnet.ctaLabel }
                      : {}),
                  },
                }
              : {}),
            ...(turnCreatorStyle && turnCreatorStyleApplies
              ? { creatorStyleId: turnCreatorStyle.id }
              : {}),
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
              t.id === data.id
                ? {
                    ...t,
                    ok: data.ok as boolean,
                    // Deterministic finding ("→ 12 posts"); absent for tools with
                    // nothing to add.
                    ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
                  }
                : t,
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
          } else if (event === "preference_saved") {
            // The agent saved a durable writing preference. Surface it as a
            // lightweight toast with a one-click Undo (delete the just-saved
            // rule) — the "the agent will now always X — undo?" affordance. The
            // rule is also editable anytime in Voice settings, so this is a
            // convenience, not the only escape hatch.
            const { id, rule } = data as unknown as { id: string; rule: string };
            toast.success(`I'll remember: "${rule}"`, {
              description: "Manage your preferences in Voice settings.",
              action: {
                label: "Undo",
                onClick: () => {
                  void fetch(`/api/preferences/${id}`, { method: "DELETE" });
                },
              },
            });
          } else if (event === "artifact") {
            const incoming = data as unknown as Artifact;
            // Re-sent artifact id (e.g. a cite backfilling its draft's
            // source_url after the draft already streamed) → REPLACE the card
            // already on screen, not a second copy of it.
            if (run.artifacts.some((a) => a.id === incoming.id)) {
              run.artifacts = replaceOrAppendArtifact(run.artifacts, incoming);
              if (chatId === activeIdRef.current) setPanelOpen(true);
              bump();
              return;
            }
            // AI refine: a refine produces a NEW draft card, appended alongside
            // the source draft. We don't merge into the target or keep version
            // history — every iteration is its own card, so the user can compare
            // side-by-side and pick the one they like. The pendingRefineRef is
            // still consulted for TWO guardrails on the incoming draft:
            //   (a) hook-only refines graft the new hook onto the ORIGINAL body,
            //       so paragraph formatting isn't lost when GLM over-rewrites.
            //   (b) collapse guard: if GLM shrunk a real post into a fragment,
            //       we drop the fragment entirely rather than shipping garbage.
            const pending = pendingRefineRef.current.get(chatId);
            const isDraft = incoming.kind === "post" || incoming.kind === "hook";
            if (pending && isDraft) {
              const targetBody = pending.originalBody;
              const collapsed =
                !pending.hookOnly &&
                incoming.kind === "post" &&
                !!targetBody &&
                guardRefineCollapse(targetBody, incoming.body).collapsed;
              if (collapsed) {
                toast.info(
                  "That rewrite cut the post down too far to make sense, so I kept your original. Tell me what to trim and I'll try again.",
                );
                // Remember the collapsed artifact so the post-stream step can
                // delete it server-side — otherwise a reload would resurrect it.
                collapsedRefineRef.current.set(chatId, incoming.id);
              } else {
                const effective =
                  pending.hookOnly && pending.originalBody
                    ? {
                        ...incoming,
                        body: splicePreservedBody(pending.originalBody, incoming.body),
                      }
                    : incoming;
                run.artifacts = [...run.artifacts, effective];
              }
              // A refine produces ONE draft — clear so the next incoming (if
              // any) is treated as a plain append.
              pendingRefineRef.current.delete(chatId);
            } else {
              run.artifacts = [...run.artifacts, incoming];
            }
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
            } else if (code === "stream_stalled" || /stall/i.test(message)) {
              // The model connection went quiet mid-stream (vs. a hard timeout).
              // Offer a one-click Continue — picking up usually works.
              run.recoverable = {
                code: "stream_stalled",
                message: "The model went quiet mid-response.",
                recovery: "continue",
              };
              bump();
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
          streamAborted = true;
          if (!run.rawText.trim() && run.artifacts.length === 0) {
            run.rawText = STOPPED_EMPTY_MESSAGE;
          }
          bump();
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
          if (turnSkills.length) setPendingSkills(turnSkills);
          if (turnPostFormat) setPendingPostFormat(turnPostFormat);
          if (turnLeadMagnet) setPendingLeadMagnet(turnLeadMagnet);
          if (turnCreatorStyle) setPendingCreatorStyle(turnCreatorStyle);
          bump();
          return;
        }
      } finally {
        if (ctrl.signal.aborted || run.stopped) {
          streamAborted = true;
          if (!run.rawText.trim() && run.artifacts.length === 0) {
            run.rawText = STOPPED_EMPTY_MESSAGE;
          }
        }
        run.streaming = false;
        // Clear any UNCONSUMED refine intent for this chat: if the turn ended
        // without producing a draft artifact (errored, aborted, or the agent
        // just replied in text), the pending target must not bleed into the next
        // refine. (A consumed refine already deleted its entry in the artifact
        // handler; refineSwapRef is handled in the post-stream block below.)
        pendingRefineRef.current.delete(chatId);
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

      inFlightRef.current.delete(lockKey);

      // The turn ended on a clarifying question (ask_user). The full turn IS
      // persisted server-side by the time the stream closes: the user message
      // (saved at turn start) + the assistant question row, which carries a
      // SYNTHETIC ask_user tool_call (see run.ts) that hydrate() rebuilds the
      // interactive AskCard from. So we fold the persisted turn into `base` (a
      // reload GET, same as the normal post-stream tail) and retire the run.
      //
      // We do NOT keep the ask-run alive as the source of truth. That older
      // strategy dropped history: because base was never refreshed, the ask
      // turn's user message + question card lived ONLY in this run's overlay —
      // so the instant the user answered (their send overwrites runsByChat for
      // this chat, line ~1416), those two rows blinked out until the ANSWER
      // turn's own post-stream reload eventually ran. Folding into base now
      // means the question + card render from `base` (via hydrate) and survive
      // the answer-run swap seamlessly.
      if (run.ask) {
        void maybeAutoTitle(chatId);
        // If the chat was deleted mid-turn, just drop the run.
        if (deletedRef.current.has(chatId)) {
          if (runsByChat.get(chatId) === run) runsByChat.delete(chatId);
          bump();
          return;
        }
        try {
          const res = await fetch(`/api/chats/${chatId}`);
          const data = await res.json();
          // Same run-ownership guard as the normal tail: the await above lets a
          // follow-up send register a NEW run for this chat; only write base /
          // retire the run if THIS send still owns it. Also require the reloaded
          // transcript to actually carry the ask (hydrate rebuilt it from the
          // persisted tool_call) — if for any reason it didn't land, fall
          // through and keep the live run so the card isn't lost.
          const currentRun = runsByChat.get(chatId);
          const stillMine = currentRun === run;
          const reloaded =
            data.ok && !deletedRef.current.has(chatId)
              ? hydrate(data.messages as RawDbMessage[])
              : null;
          const askInBase =
            !!reloaded && reloaded.some((m) => m.role === "assistant" && m.ask);
          const currentBase = baseByChat.get(chatId) ?? [];
          const currentBaseHasAsk = currentBase.some(
            (m) => m.role === "assistant" && !!m.ask,
          );
          const shouldApplyReload =
            !!reloaded && shouldApplyAskTurnReload(currentBase, reloaded);
          if (askInBase && shouldApplyReload) {
            baseByChat.set(chatId, reloaded);
            artifactsByChat.set(
              chatId,
              (data.messages as RawDbMessage[]).flatMap((m) => m.artifacts ?? []),
            );
          }
          // If the user answered before this reload finished, a NEW run now owns
          // the chat. In that case we still apply the ask turn into base above
          // (so the history doesn't blink out), but we must not delete the newer
          // answer run. Only retire this ask run once the ask is represented in
          // base, either from this reload or an already-newer base snapshot.
          if (
            stillMine &&
            (shouldApplyReload || (currentBaseHasAsk && askInBase))
          ) {
            if (runsByChat.get(chatId) === run) runsByChat.delete(chatId);
          }
        } catch {
          // Reload failed — keep the live ask-run as the fallback source of the
          // question + card (its overlay still renders them) rather than losing
          // the AskCard entirely.
        }
        bump();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("swipein:usage-changed"));
        }
        return;
      }

      // (The send lock was already released at line ~1290, before the ask
      // branch — the next Send is a new message and must not be blocked. We KEEP
      // the live run until the reload lands; see the atomic-swap note below.)
      // The turn consumed a monthly message credit (the user row was persisted
      // at turn start by claimChatTurn). Nudge the sidebar pill to refetch so
      // the 🪙 count stays live without polling.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("swipein:usage-changed"));
      }
      // Auto-name a still-untitled chat from its first exchange (one cheap
      // GLM-5.2 call, server-side). Fire-and-forget, once per chat.
      void maybeAutoTitle(chatId);

      // A refine whose incoming draft was rejected by the collapse guard: the
      // server DID persist that fragment (it arrived as a normal artifact
      // event, and only the client saw it was garbage). DELETE it before the
      // reload below or a reload would resurrect it as a real card. Best-
      // effort: on failure the fragment appears on next reload — annoying but
      // recoverable (the user can just delete it).
      const collapsedId = collapsedRefineRef.current.get(chatId);
      if (collapsedId) {
        collapsedRefineRef.current.delete(chatId);
        try {
          await fetch(`/api/chats/${chatId}/artifacts`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ artifactId: collapsedId }),
          });
        } catch {
          // Leave the fragment; user can delete it manually if it reappears.
        }
      }

      // Fold the canonical server-persisted turn into this chat's base cache
      // (fences→artifacts, the real assistant row), THEN drop the live run — in
      // ONE synchronous swap with a single bump(). This kills the post-stream
      // "reload flicker": previously we deleted the run + bumped BEFORE the
      // reload GET, so for the whole network round-trip the just-finished reply
      // lived in neither source (the run was gone; base didn't have it yet) and
      // the message vanished, then reappeared. Reloading first and swapping
      // atomically means the reply is always present exactly once — it moves
      // from the run overlay to the base in the same render, never absent
      // (delete-then-reload, the old bug) and never doubled (reload-then-delete
      // with two bumps, which would render the run overlay AND the new base row
      // since runOverlay only dedupes the USER message, not the assistant).
      // If the chat was deleted mid-stream, just drop the run.
      if (deletedRef.current.has(chatId)) {
        if (runsByChat.get(chatId) === run) runsByChat.delete(chatId);
        bump();
        return;
      }
      try {
        const res = await fetch(`/api/chats/${chatId}`);
        const data = await res.json();
        // RUN-OWNERSHIP GUARD: this tail holds several awaits (the reload GET,
        // maybeAutoTitle, a refine PATCH). During them the user could send
        // AGAIN — a fresh send() registers a NEW run for this chatId and starts
        // streaming. If we then blindly wrote base / deleted the run, we'd
        // clobber that live turn: overwrite base with a pre-turn-2 transcript
        // and delete turn-2's actively-streaming run (reply never renders,
        // composer unlocks mid-stream). So every write past here only applies
        // when THIS send still owns the chat's run.
        const stillMine = runsByChat.get(chatId) === run;
        const hydrated = data.ok
          ? hydrate(data.messages as RawDbMessage[])
          : null;
        const hasAssistantForThisTurn =
          !!hydrated && hasAssistantAfterUserMessage(hydrated, userMsg);
        if (
          data.ok &&
          hydrated &&
          stillMine &&
          !deletedRef.current.has(chatId) &&
          (!streamAborted || hasAssistantForThisTurn)
        ) {
          baseByChat.set(chatId, hydrated);
          artifactsByChat.set(
            chatId,
            (data.messages as RawDbMessage[]).flatMap((m) => m.artifacts ?? []),
          );
        }
      } catch {
        // Reload failed — keep the live run as the fallback source of the reply
        // (it still holds the streamed text + artifacts) rather than dropping it
        // and showing nothing. The user can switch away and back to reload the
        // canonical persisted result.
        bump();
        return;
      }
      // Swap: base now has the canonical turn → retire the live run. Single
      // bump() so the handoff is one frame (no flicker, no double-render). Only
      // if THIS send still owns the run (a follow-up send may have replaced it —
      // see the ownership guard above).
      if (
        runsByChat.get(chatId) === run &&
        (!streamAborted ||
          hasAssistantAfterUserMessage(baseByChat.get(chatId) ?? [], userMsg))
      ) {
        runsByChat.delete(chatId);
      }
      bump();
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
    pendingSkills,
    pendingPostFormat,
    pendingLeadMagnet,
    pendingCreatorStyle,
    customSkills,
    initialVoiceReady,
    router,
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
    const run = runsByChat.get(activeId);
    if (run && !run.rawText.trim() && run.artifacts.length === 0) {
      run.rawText = STOPPED_EMPTY_MESSAGE;
    }
    if (run) {
      run.stopped = true;
      run.streaming = false;
      run.plan = [];
      run.tools = [];
      const base = baseByChat.get(activeId) ?? [];
      if (!hasAssistantAfterUserMessage(base, run.userMsg)) {
        baseByChat.set(activeId, [...base, ...runOverlay(run, base)]);
      }
      runsByChat.delete(activeId);
    }
    bump();
    run?.ctrl.abort();
    // Clear the identical-text dedupe for this chat so the user can immediately
    // RE-SEND the same prompt after stopping it. Without this, the 10s dedupe
    // (lastSendRef) would silently drop a same-text resend right after Stop —
    // part of the "can't hit play after pause" complaint. Stopping is an
    // explicit intent to redo, so dropping the dedupe record here is correct.
    lastSendRef.current.delete(activeId);
    inFlightRef.current.delete(activeId);
    inFlightRef.current.delete("__new__");
    // Fire-and-forget — the server flag is enough; we don't need the response.
    void fetch(`/api/chats/${activeId}/stop`, { method: "POST" }).catch(() => {
      // Stop endpoint failed (network, auth) — the local abort is still in
      // effect, so the UI ends cleanly. Server-side will eventually time out
      // on its own. No toast: clicking Stop and seeing a toast is jarring.
    });
  }, [activeId, baseByChat, runsByChat, bump]);

  // Jump back to the live bottom of the stream. Clears the scrolled-away flag so
  // auto-scroll re-engages and the button hides.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setUserScrolledAway(false);
  }, []);

  // "Refine with AI" on a draft card: feed the draft back into THIS chat as a
  // real agent turn with the user's instruction, so the agent re-uses the full
  // pipeline (voice, swipe-file grounding, render_post). The re-rendered draft
  // APPENDS a NEW card alongside the source — so iterating produces a series of
  // sibling drafts the user can compare and pick from (no version history, no
  // in-place swap). The pendingRefineRef metadata carried here is only used by
  // the artifact handler for TWO guardrails: hook-only body preservation
  // (splicePreservedBody) and the collapse guard.
  const refineDraft = useCallback(
    (
      artifactId: string,
      draftBody: string,
      kind: "post" | "hook",
      instruction: string,
    ) => {
      // Block a refine while this chat's turn is still streaming. send() would
      // silently no-op it (its in-flight guard), leaving the user with no
      // feedback — so reject early with a toast. The UI also disables the
      // refine controls (refineDisabled), this is the belt-and-braces guard.
      const aid = activeIdRef.current;
      if (aid && runsByChat.get(aid)?.streaming) {
        toast.info("Hang on — let the current draft finish before refining again.");
        return;
      }
      // A hook-focused refine of a POST should change ONLY the opener and leave
      // the rest of the post untouched. We both (a) instruct the agent sharply
      // and (b) preserve the body verbatim client-side (splicePreservedBody in
      // the artifact handler), since GLM tends to rewrite the whole post and drop
      // the paragraph formatting. (Hook CARDS are openers already — no body to
      // preserve — so this only applies to post cards.)
      const hookOnly = kind === "post" && isHookFocusedRefine(instruction);
      // Stash the source body so the artifact handler can (a) graft the new
      // hook onto it for hook-only refines and (b) run the collapse guard's
      // before/after ratio check.
      if (aid) {
        pendingRefineRef.current.set(aid, {
          originalBody: draftBody,
          ...(hookOnly ? { hookOnly: true } : {}),
        });
      }
      const noun = kind === "hook" ? "hook" : "post";
      const instr = hookOnly
        ? `${instruction}. Rewrite ONLY the hook — the first 1-2 lines. You may lightly adjust the next 1-2 lines so they still flow from the new hook, but leave the rest of the post EXACTLY as given: every other word and line break unchanged, blank lines between paragraphs kept. Do NOT rewrite the body.`
        : instruction;
      const message =
        `Refine this ${noun}: ${instr}\n\n` +
        `Keep it in my voice. Here's the current ${noun}:\n` +
        `"""\n${draftBody}\n"""`;
      // Inherit the skill(s) the SOURCE draft was produced under, so the refine
      // stays guided by that skill AND the new card keeps its /skill badge.
      // The draft's meta.skills holds the slugs; map them to ids via the loaded
      // workspace skills. (pendingSkills is empty by now — it's consumed each
      // send — so without this the refine would silently drop the skill.)
      const target = (aid && artifactsByChat.get(aid)?.find((a) => a.id === artifactId)) || null;
      const inheritedIds = target
        ? skillNamesToIds(artifactSkillNames(target), customSkills)
        : [];
      // skipDecision: a refine has an unambiguous source draft, so the clarify
      // pre-pass must not intercept it with a "which draft?" question (that
      // would swallow the refine → no re-render).
      // hookOnly + hookOnlyOriginalBody: when this refine is hook-focused, the
      // server splices the model's new opener onto draftBody byte-for-byte
      // before persisting the artifact, so the body cannot drift.
      void send(message, {
        skipDecision: true,
        ...(inheritedIds.length ? { skillIds: inheritedIds } : {}),
        ...(hookOnly
          ? { hookOnly: true, hookOnlyOriginalBody: draftBody }
          : {}),
      });
    },
    [send, runsByChat, artifactsByChat, customSkills],
  );

  // Reflect a Done-edit's PATCH into the parent's caches so the saved body
  // sticks across re-renders (the stale prop would otherwise seed-reset the
  // ArtifactCard's local body on the next parent bump). Patches both
  // artifactsByChat and the live run.
  const updateArtifactBody = useCallback(
    (artifactId: string, newBody: string) => {
      const aid = activeIdRef.current;
      if (!aid) return;
      const apply = (list: Artifact[]): Artifact[] =>
        list.map((a) => (a.id === artifactId ? { ...a, body: newBody } : a));
      const persisted = artifactsByChat.get(aid);
      if (persisted?.some((a) => a.id === artifactId)) {
        artifactsByChat.set(aid, apply(persisted));
      }
      const run = runsByChat.get(aid);
      if (run?.artifacts.some((a) => a.id === artifactId)) {
        run.artifacts = apply(run.artifacts);
      }
      bump();
    },
    [bump, artifactsByChat, runsByChat],
  );

  const updateArtifactMeta = useCallback(
    (artifactId: string, metaPatch: Record<string, unknown>) => {
      const aid = activeIdRef.current;
      if (!aid) return;
      const apply = (list: Artifact[]): Artifact[] =>
        list.map((a) =>
          a.id === artifactId ? { ...a, meta: { ...(a.meta ?? {}), ...metaPatch } } : a,
        );
      const persisted = artifactsByChat.get(aid);
      if (persisted?.some((a) => a.id === artifactId)) {
        artifactsByChat.set(aid, apply(persisted));
      }
      const run = runsByChat.get(aid);
      if (run?.artifacts.some((a) => a.id === artifactId)) {
        run.artifacts = apply(run.artifacts);
      }
      bump();
      const updated = (artifactsByChat.get(aid) ?? run?.artifacts ?? []).find(
        (a) => a.id === artifactId,
      );
      if (updated) {
        void fetch(`/api/chats/${aid}/artifacts`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetId: artifactId,
            body: updated.body,
            title: updated.title,
            meta: updated.meta,
          }),
        }).catch(() => {
          // In-memory metadata stands; a later reload reconciles from the DB.
        });
      }
    },
    [artifactsByChat, runsByChat, bump],
  );

  // Batch review: approve or reject a weekly-batch draft directly from its
  // Cowork draft card. Approve moves it to Ready on the /posts board; reject
  // flips it to 'rejected' (off-board but preserves the source-post dedup
  // signal so next week's batch skips the same source). Optimistic: paint
  // the outcome badge first, PATCH under it. On failure roll back so the
  // user can retry. The artifact.id here IS the chat_artifacts row id
  // (batch worker inserts a chat_artifacts row per draft, then mirrors the
  // artifact into chat_messages.artifacts with the same id) so
  // /api/drafts/:id targets the review row directly.
  const submitBatchReviewOutcome = useCallback(
    async (artifactId: string, outcome: "approved" | "rejected") => {
      setBatchReviewOutcomes((prev) =>
        prev[artifactId] === outcome ? prev : { ...prev, [artifactId]: outcome },
      );
      try {
        const res = await fetch(`/api/drafts/${artifactId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: outcome === "approved" ? "ready" : "rejected",
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!data?.ok) throw new Error(data?.error || "Failed");
        if (outcome === "approved") {
          toast.success("Approved — it's in your Ready column.");
        } else {
          toast.success("Rejected — this won't be re-served next week.");
        }
      } catch (e) {
        setBatchReviewOutcomes((prev) => {
          const next = { ...prev };
          delete next[artifactId];
          return next;
        });
        toast.error(
          (e as Error).message || "Couldn't update the draft — try again.",
        );
      }
    },
    [],
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
      const run = runsByChat.get(aid);
      // Capture the deleted artifact + its position from EACH source, so a
      // rollback can RE-INSERT it into the (possibly-changed) current array
      // rather than restoring a stale snapshot. The delete button isn't gated on
      // streaming (unlike refine), so the live run can append a new draft during
      // the await below — blindly restoring the pre-delete snapshot would erase
      // that streamed-in draft. We reconcile against current state instead.
      const persistedBefore = artifactsByChat.get(aid);
      const persistedIdx = persistedBefore?.findIndex((a) => a.id === artifactId) ?? -1;
      const persistedDeleted = persistedIdx >= 0 ? persistedBefore![persistedIdx] : undefined;
      const runIdx = run?.artifacts.findIndex((a) => a.id === artifactId) ?? -1;
      const runDeleted = runIdx >= 0 ? run!.artifacts[runIdx] : undefined;
      // Optimistic prune.
      if (persistedBefore) {
        artifactsByChat.set(aid, persistedBefore.filter((a) => a.id !== artifactId));
      }
      if (run) {
        run.artifacts = run.artifacts.filter((a) => a.id !== artifactId);
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
        // Roll back by RE-INSERTING the deleted artifact into CURRENT state (not
        // restoring the snapshot), so any draft streamed in during the await
        // survives. reinsertArtifact re-inserts at the original index and no-ops
        // if it's somehow already back.
        if (persistedDeleted) {
          artifactsByChat.set(
            aid,
            reinsertArtifact(artifactsByChat.get(aid) ?? [], persistedIdx, persistedDeleted),
          );
        }
        const curRun = runsByChat.get(aid);
        if (curRun && runDeleted) {
          curRun.artifacts = reinsertArtifact(curRun.artifacts, runIdx, runDeleted);
        }
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
  // Custom skills matching the same "/" query — shown as a second section in the
  // menu (click/⚡ to apply; the starter rows keep keyboard nav). Skills already
  // pending are hidden so the menu only offers what you can still add.
  const slashSkillMatches =
    slashQuery !== null
      ? filterSkillsByQuery(customSkills, slashQuery).filter(
          (sk) => !pendingSkills.some((p) => p.id === sk.id),
        )
      : [];
  const slashOpen =
    slashQuery !== null && (slashMatches.length > 0 || slashSkillMatches.length > 0);
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
        // Enter picks a STARTER (keyboard nav is on starters). If only skills
        // match, pick the first skill instead so Enter still does something.
        if (slashMatches.length > 0) pickSlash(slashMatches[slashActive]);
        else if (slashSkillMatches.length > 0) pickSkillFromSlash(slashSkillMatches[0]);
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
  const leadMagnetHrefById = useMemo(() => {
    const map = new Map<string, string>();
    for (const leadMagnet of leadMagnets) {
      if (leadMagnet.publicSlug) {
        map.set(leadMagnet.id, `/lm/${leadMagnet.publicSlug}`);
      }
    }
    return map;
  }, [leadMagnets]);
  const leadMagnetHref = useCallback(
    (leadMagnet: AppliedLeadMagnet | null) =>
      leadMagnet?.publicSlug
        ? `/lm/${leadMagnet.publicSlug}`
        : leadMagnet?.id
          ? (leadMagnetHrefById.get(leadMagnet.id) ?? null)
          : null,
    [leadMagnetHrefById],
  );

  // The rendered drafts list (expanded card for the active draft, collapsed rows
  // for the rest). Shared by the desktop side panel and the mobile bottom sheet
  // so the two never drift.
  const draftsList = labelArtifacts(artifacts)
    .reverse() // newest first
    .map(({ a, label }) =>
      // Weekly-batch drafts are review-gated (pending_review) — render a
      // READ-ONLY preview with no Save/Refine, so the review panel stays the one
      // approval writer. Never the editable card, never the Save-able collapsed
      // row.
      (a.meta as { source?: unknown } | undefined)?.source === "weekly_batch" ? (
        <BatchPreviewCard
          key={a.id}
          artifact={a}
          onApprove={() => void submitBatchReviewOutcome(a.id, "approved")}
          onReject={() => void submitBatchReviewOutcome(a.id, "rejected")}
          outcome={batchReviewOutcomes[a.id]}
        />
      ) : a.id === expandedArtifactId ? (
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
            refineDraft(a.id, a.body, a.kind === "hook" ? "hook" : "post", instruction)
          }
          onBodyChange={(newBody) => updateArtifactBody(a.id, newBody)}
          onMetaChange={(metaPatch) => updateArtifactMeta(a.id, metaPatch)}
          leadMagnetHref={leadMagnetHref}
          // While a turn is streaming in THIS chat, block refining — a second
          // refine mid-turn is silently dropped by send()'s in-flight guard, so
          // disable the controls + show why instead of a dead click.
          refineDisabled={sending}
          onDelete={() => deleteArtifact(a.id)}
          // Batch review inline on the card: a weekly-batch draft
          // (meta.source === 'weekly_batch') gets Approve / Reject actions.
          // Once acted on, a badge replaces them (batchReviewOutcomes).
          {...(isWeeklyBatchArtifact(a)
            ? {
                onApproveBatchReview: () =>
                  void submitBatchReviewOutcome(a.id, "approved"),
                onRejectBatchReview: () =>
                  void submitBatchReviewOutcome(a.id, "rejected"),
                batchReviewOutcome: batchReviewOutcomes[a.id],
              }
            : {})}
        />
      ) : (
        <CollapsedDraftRow
          key={a.id}
          label={label ?? (a.kind === "hook" ? "Hook" : "Draft")}
          artifact={a}
          onExpand={() => setExpandedArtifactId(a.id)}
          // Delete is hidden on batch drafts awaiting review — see the
          // matching gate on the expanded card's header. Reject is the
          // correct discard flow for a batch draft; the transcript-only
          // delete would half-orphan the chat_artifacts row.
          {...(isWeeklyBatchArtifact(a)
            ? {}
            : { onDelete: () => deleteArtifact(a.id) })}
        />
      ),
    );

  return (
    <div className="relative flex h-[calc(100vh-7.5rem)] min-h-[520px] gap-0 overflow-hidden bg-card lg:h-screen">
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
          "flex w-64 shrink-0 flex-col border-r border-border",
          // Mobile drawer must be OPAQUE so the conversation behind it doesn't
          // bleed through the list; the translucent sidebar tint is desktop-only.
          "bg-card md:bg-muted/90",
          // Desktop: normal inline column.
          "md:relative md:translate-x-0",
          // Mobile: fixed drawer that slides in/out from the left.
          "absolute inset-y-0 left-0 z-40 shadow-xl md:shadow-none transition-transform duration-200 md:transition-none",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        <div className="flex items-center gap-2 p-3 pb-2.5">
          <Button
            onClick={() => {
              newChat();
              setSidebarOpen(false);
            }}
            className="flex-1 justify-start gap-2 rounded-xl shadow-sm"
            size="sm"
          >
            <Plus className="h-4 w-4" /> New session
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
        <div className="px-3 pb-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
              placeholder="Search sessions…"
              className="w-full rounded-xl border border-border bg-card/75 pl-8 pr-7 py-2 text-xs outline-none shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] transition focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
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
        <div className="flex-1 overflow-y-auto px-2.5 pb-3 flex flex-col gap-2">
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
                {/* WCAG AA fix: text-muted-foreground/55 measured ~1.77:1
                    against the sidebar background (needs 4.5:1 at this
                    size) — foreground/65 clears ~5.07:1. */}
                <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/65">
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
      <section className="flex-1 min-w-0 flex flex-col relative bg-card">
        {/* Mobile header: open chat history + new chat (the sidebar is a drawer
            on mobile, so these are the only way in). Hidden on md+ where the
            sidebar is always visible. */}
        <div className="md:hidden flex items-center gap-2 border-b border-border bg-card/90 px-2 py-1.5">
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
        {!panelOpen && hasDraftPanel && (
          <button
            onClick={() => setPanelOpen(true)}
            className="hidden lg:inline-flex absolute top-4 right-4 z-10 items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur hover:bg-card transition-colors"
            aria-label={`Show ${panelTitle(artifacts).toLowerCase()}`}
          >
            <PanelLeftOpen className="h-3.5 w-3.5" />
            {panelTitle(artifacts)} ({artifacts.length})
          </button>
        )}
        <div
          ref={scrollRef}
          className={cn(
            "cowork-chat-canvas flex-1 px-3 sm:px-6",
            messages.length === 0 && !loadingChatId
              ? "overflow-hidden py-3 sm:py-4"
              : "overflow-y-auto py-6",
            messages.length > 0 && "cowork-chat-canvas-active",
          )}
        >
          {messages.length === 0 ? (
            // While an existing chat's transcript is still fetching, show a
            // quiet loading state — NOT the starter-prompt empty state, which
            // would misleadingly flash as if this were a new/empty chat.
            loadingChatId && loadingChatId === activeId ? (
              <ChatLoading />
            ) : (
              <EmptyState
                onPick={prefillPrompt}
                author={author}
                nextAction={initialNextAction}
              />
            )
          ) : (
            <div className={cn("mx-auto flex max-w-4xl flex-col pb-2", isBatchChat ? "gap-3" : "gap-7")}>
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  onContinue={() =>
                    void send("Please continue from where you left off.")
                  }
                  onAnswer={(text, ask) => {
                    const shouldRefine = askAnswerShouldRefineLatestDraft(ask, text);
                    if (!shouldRefine) {
                      void send(text);
                      return;
                    }
                    // Hook-only refine: when the ask-card answer is hook-
                    // focused (e.g. "Tighten the hook"), enrich the message
                    // with the same "Rewrite ONLY the hook" prompt the
                    // per-card Refine button uses, AND pass hookOnly +
                    // originalBody so the SERVER splices the model's new
                    // opener onto the source body byte-for-byte before
                    // persisting. Without this the raw "Tighten the hook"
                    // string went to the server, the model rewrote the
                    // whole post, and the post-stream reload swapped the
                    // clobbered body into the DB.
                    const aid = activeIdRef.current;
                    const persisted = aid ? artifactsByChat.get(aid) ?? [] : [];
                    const runArts = aid
                      ? runsByChat.get(aid)?.artifacts ?? []
                      : [];
                    const seenIds = new Set(persisted.map((a) => a.id));
                    const combined = [
                      ...persisted,
                      ...runArts.filter((a) => !seenIds.has(a.id)),
                    ];
                    const drafts = combined.filter(
                      (a) => a.kind === "post" || a.kind === "hook",
                    );
                    const target = drafts[drafts.length - 1];
                    if (
                      target &&
                      target.kind === "post" &&
                      isHookFocusedRefine(text)
                    ) {
                      const enriched = buildHookOnlyRefineMessage(text, target.body);
                      void send(enriched, {
                        forceRefine: true,
                        hookOnly: true,
                        hookOnlyOriginalBody: target.body,
                      });
                      return;
                    }
                    void send(text, { forceRefine: true });
                  }}
                />
              ))}
              {/* Live worker board for the batch chat — bridges the silence
                  while N writers draft in parallel. A header (stage + counter +
                  progress bar) over one live lane per writer (queued → drafting
                  → filed/skipped), reusing the home card's WorkerLane. Reads the
                  polled batchRun snapshot + batchSlots. Rendered inside the
                  transcript flex so it sits like another message, and disappears
                  when the batch settles. */}
              {showBatchStrip && batchRun && (
                <BatchWorkerBoard run={batchRun} slots={batchSlots} />
              )}
              {/* Reattach indicator: this chat's turn is running server-side but
                  we hold no live local run (a full-page navigation destroyed the
                  stream + plan). Show "Cowork is still working…" so the user gets
                  the feedback back; the reattach poll swaps in the reply when it
                  settles. Suppressed once a local run exists (its overlay shows
                  real progress) or the turn finishes. */}
              {reattachingChatId === activeId &&
                !(activeId && runsByChat.get(activeId)) && (
                  <ReattachingIndicator steps={reattachPlan} />
                )}
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
            className="absolute bottom-28 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs font-medium shadow-md backdrop-blur hover:bg-card transition-colors"
            aria-label="Scroll to latest"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Latest
          </button>
        )}

        {/* Composer */}
        <form
          onSubmit={onSubmit}
          className="border-t border-border bg-card/92 px-3 py-3 shadow-[0_-18px_45px_rgba(28,28,26,0.04)] backdrop-blur sm:px-6 sm:py-4"
        >
          <div className="mx-auto flex max-w-4xl flex-col gap-2.5 relative">
            {/* Slash-command menu — anchored above the composer. Open while the
                input is a bare "/<query>". Click or ↑/↓+Enter to prefill a starter. */}
            {slashOpen && (
              <div className="absolute bottom-full left-0 right-0 z-20 mb-3 overflow-hidden rounded-2xl border border-border bg-card/95 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur">
                <div className="px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground border-b border-border">
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
                          "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors",
                          i === slashActive ? "bg-muted" : "",
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="text-foreground">{s.label}</span>
                      </button>
                    );
                  })}
                </div>
                {slashSkillMatches.length > 0 && (
                  <>
                    <div className="px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground border-y border-border">
                      Your skills
                    </div>
                    <div className="max-h-48 overflow-y-auto py-1">
                      {slashSkillMatches.map((sk) => (
                        <button
                          key={sk.id}
                          type="button"
                          onClick={() => pickSkillFromSlash(sk)}
                          className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted"
                        >
                          <Zap className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
                          <span className="text-foreground">/{sk.name}</span>
                          {sk.description && (
                            <span className="truncate text-xs text-muted-foreground">
                              {sk.description}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ⚡ Skill picker panel — browse + toggle the workspace's skills. */}
            {skillPickerOpen && customSkills.length > 0 && (
              <div
                ref={skillPickerRef}
                role="dialog"
                aria-label="Apply a custom skill"
                className="absolute bottom-full left-0 right-0 z-20 mb-3 overflow-hidden rounded-2xl border border-border bg-card/95 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur"
              >
                <div className="flex items-center justify-between px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground border-b border-border">
                  <span>Apply a skill ({pendingSkills.length}/{SKILLS_PER_TURN_MAX})</span>
                  <button
                    type="button"
                    onClick={() => setSkillPickerOpen(false)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Close"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="max-h-72 overflow-y-auto py-1">
                  {customSkills.map((sk) => {
                    const on = pendingSkills.some((p) => p.id === sk.id);
                    return (
                      <button
                        key={sk.id}
                        type="button"
                        onClick={() => toggleSkill(sk)}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                          on && "bg-amber-50",
                        )}
                      >
                        <Zap
                          className={cn(
                            "h-4 w-4 shrink-0",
                            on ? "text-amber-500" : "text-muted-foreground",
                          )}
                          aria-hidden
                        />
                        <span className="text-foreground">/{sk.name}</span>
                        {sk.description && (
                          <span className="truncate text-xs text-muted-foreground">
                            {sk.description}
                          </span>
                        )}
                        {on && <Check className="ml-auto h-3.5 w-3.5 text-amber-600" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {postFormatPickerOpen && (
              <div
                ref={postFormatPickerRef}
                role="dialog"
                aria-label="Choose post format"
                className="absolute bottom-full left-0 right-0 z-20 mb-3 overflow-hidden rounded-2xl border border-border bg-card/95 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur"
              >
                <div className="flex items-center justify-between px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground border-b border-border">
                  <span>Post format</span>
                  <button
                    type="button"
                    onClick={() => setPostFormatPickerOpen(false)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Close"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setPendingPostFormat(null);
                      setPostFormatPickerOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                      pendingPostFormat === null && "bg-muted",
                    )}
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="text-foreground">Auto</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Let SwipeIn choose the best structure
                    </span>
                    {pendingPostFormat === null && (
                      <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                    )}
                  </button>
                  {NO_MODEL_FORMAT_CATALOG.map((format) => {
                    const on = pendingPostFormat === format.id;
                    return (
                      <button
                        key={format.id}
                        type="button"
                        onClick={() => {
                          setPendingPostFormat(on ? null : format.id);
                          setPostFormatPickerOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                          on && "bg-rose-50",
                        )}
                      >
                        <FileText
                          className={cn(
                            "h-4 w-4 shrink-0",
                            on ? "text-primary" : "text-muted-foreground",
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-foreground">
                            {format.label}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {format.description}
                          </span>
                        </span>
                        {on && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {leadMagnetPickerOpen && (
              <div
                ref={leadMagnetPickerRef}
                role="dialog"
                aria-label="Choose lead magnet"
                className="absolute bottom-full left-0 right-0 z-20 mb-3 overflow-hidden rounded-2xl border border-border bg-card/95 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur"
              >
                <div className="flex items-center justify-between border-b border-border px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <span>Lead magnet</span>
                  <button
                    type="button"
                    onClick={() => setLeadMagnetPickerOpen(false)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Close"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="border-b border-border bg-amber-50/60 px-3.5 py-2 text-xs leading-5 text-muted-foreground">
                  Only choose a lead magnet when you want to write a lead magnet post.
                </div>
                <div className="max-h-80 overflow-y-auto py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setPendingLeadMagnet(null);
                      setLeadMagnetPickerOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                      pendingLeadMagnet === null && "bg-muted",
                    )}
                  >
                    <Gift className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="text-foreground">Auto</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Pick the best resource only for a lead magnet post
                    </span>
                    {pendingLeadMagnet === null && (
                      <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                    )}
                  </button>
                  <div className="border-y border-border bg-white px-3.5 py-2.5">
                      {!leadMagnetCreateOpen ? (
                        <button
                          type="button"
                          onClick={openCreateLeadMagnetForPost}
                          disabled={aiLeadMagnetLimitReached}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-xl border border-dashed px-3 py-2.5 text-left text-sm transition-colors",
                            aiLeadMagnetLimitReached
                              ? "cursor-not-allowed border-border bg-muted text-muted-foreground"
                              : "border-primary/30 bg-rose-50/50 text-primary hover:bg-rose-50",
                          )}
                        >
                          <Plus className="h-4 w-4 shrink-0" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium">
                              Create a new lead magnet after drafting
                            </span>
                            <span
                              className={cn(
                                "block truncate text-xs",
                                aiLeadMagnetLimitReached
                                  ? "text-muted-foreground"
                                  : "text-primary/70",
                              )}
                            >
                              {aiLeadMagnetLimitReached
                                ? `You've used all ${leadMagnetAiUsage?.limit ?? "monthly"} AI lead magnets this month`
                                : leadMagnetAiUsage
                                  ? `${leadMagnetAiUsage.limit - leadMagnetAiUsage.used} AI creations left this month`
                                  : "Uses one AI creation after you send"}
                            </span>
                          </span>
                        </button>
                      ) : (
                        <div className="space-y-2.5 rounded-xl border border-border bg-card p-3">
                          <div>
                            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                              Resource brief
                            </label>
                            <textarea
                              value={leadMagnetCreatePrompt}
                              onChange={(e) => setLeadMagnetCreatePrompt(e.target.value)}
                              rows={3}
                              maxLength={1200}
                              className="w-full resize-none rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none transition focus:border-primary/50"
                              placeholder="Create a checklist, prompt pack, or template that fits this post..."
                            />
                          </div>
                          <div className="grid gap-2 sm:grid-cols-[1fr_160px]">
                            <input
                              value={leadMagnetCreateCtaUrl}
                              onChange={(e) => setLeadMagnetCreateCtaUrl(e.target.value)}
                              className="min-w-0 rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none transition focus:border-primary/50"
                              placeholder="Optional CTA URL"
                            />
                            <input
                              value={leadMagnetCreateCtaLabel}
                              onChange={(e) => setLeadMagnetCreateCtaLabel(e.target.value)}
                              className="min-w-0 rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none transition focus:border-primary/50"
                              placeholder="CTA label"
                            />
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setLeadMagnetCreateOpen(false)}
                              className="rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={selectCreateLeadMagnetForPost}
                              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                            >
                              Select
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  {leadMagnets.length === 0 ? (
                    <div className="px-3.5 py-3 text-xs text-muted-foreground">
                      No lead magnets yet. Create one above or from the Lead Magnets page.
                    </div>
                  ) : (
                    leadMagnets.map((leadMagnet) => {
                      const on = pendingLeadMagnet?.id === leadMagnet.id;
                      const deliverable =
                        leadMagnet.metadata?.selection_summary ??
                        leadMagnet.metadata?.deliverables?.[0] ??
                        leadMagnet.metadata?.summary ??
                        "Use this resource as the giveaway";
                      return (
                        <button
                          key={leadMagnet.id}
                          type="button"
                          onClick={() => {
                            setPendingLeadMagnet(on ? null : leadMagnet);
                            setLeadMagnetPickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                            on && "bg-rose-50",
                          )}
                        >
                          <Gift
                            className={cn(
                              "h-4 w-4 shrink-0",
                              on ? "text-primary" : "text-muted-foreground",
                            )}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-foreground">
                              {leadMagnet.title}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {deliverable}
                            </span>
                          </span>
                          {on && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
            {creatorStylePickerOpen && (
              <div
                ref={creatorStylePickerRef}
                role="dialog"
                aria-label="Choose creator style"
                className="absolute bottom-full left-0 right-0 z-20 mb-3 overflow-hidden rounded-2xl border border-border bg-card/95 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur"
              >
                <div className="flex items-center justify-between px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground border-b border-border">
                  <span>Creator style</span>
                  <button
                    type="button"
                    onClick={() => setCreatorStylePickerOpen(false)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Close"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setPendingCreatorStyle(null);
                      setCreatorStylePickerOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                      pendingCreatorStyle === null && "bg-muted",
                    )}
                  >
                    <Fingerprint className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="text-foreground">None</span>
                    {pendingCreatorStyle === null && (
                      <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                    )}
                  </button>
                  {creatorStyles.length === 0 ? (
                    <div className="px-3.5 py-3 text-xs text-muted-foreground">
                      No creator styles yet. Generate one on the Creator Styles page.
                    </div>
                  ) : (
                    creatorStyles.map((style) => {
                      const on = pendingCreatorStyle?.id === style.id;
                      return (
                        <button
                          key={style.id}
                          type="button"
                          onClick={() => {
                            setPendingCreatorStyle(on ? null : style);
                            setCreatorStylePickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                            on && "bg-rose-50",
                          )}
                        >
                          <Fingerprint
                            className={cn(
                              "h-4 w-4 shrink-0",
                              on ? "text-primary" : "text-muted-foreground",
                            )}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-foreground">{style.name}</span>
                            {style.creatorName && (
                              <span className="block truncate text-xs text-muted-foreground">
                                {style.creatorName}
                              </span>
                            )}
                          </span>
                          {on && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
            <div
              className={cn(
                "relative overflow-hidden rounded-[1.35rem] border bg-card/92 shadow-[0_18px_60px_rgba(28,28,26,0.12)] ring-1 ring-white/70 backdrop-blur transition-colors",
                isDraggingFile
                  ? "border-primary/60 ring-primary/30"
                  : "border-border",
              )}
              onDragEnter={onComposerDragEnter}
              onDragOver={onComposerDragOver}
              onDragLeave={onComposerDragLeave}
              onDrop={onComposerDrop}
            >
            {/* Drop overlay — shown while a file drag is over the composer. Sits
                above the composer content and is pointer-events-none so it never
                intercepts the drop itself (the drop lands on the card below). */}
            {isDraggingFile && (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[1.35rem] border-2 border-dashed border-primary/50 bg-card/85 backdrop-blur-sm">
                <div className="flex flex-col items-center gap-1.5 text-primary">
                  <Paperclip className="h-6 w-6" aria-hidden />
                  <span className="text-sm font-medium">Drop to attach</span>
                  <span className="text-[11px] text-muted-foreground">
                    PDF, Word, text, or image · up to {MAX_ATTACHMENTS} files
                  </span>
                </div>
              </div>
            )}
            {limitNotice && (
              <div className="mx-3 mt-3 flex items-start gap-2.5 rounded-xl border border-amber-300/70 bg-amber-50 text-amber-900 px-3 py-2.5 text-sm">
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
            {shouldShowVoiceWarning && (
              <div className="mx-3 mt-3 flex items-start gap-2.5 rounded-xl border border-primary/20 bg-primary/[0.06] px-3 py-2.5 text-sm text-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Cowork works better with your voice set up.</p>
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                    You can keep writing, but drafts will be more accurate after Voice setup.
                  </p>
                  <button
                    type="button"
                    onClick={() => router.push("/dashboard/voice")}
                    className="mt-1.5 text-xs font-medium text-primary hover:underline"
                  >
                    Complete voice setup
                  </button>
                </div>
                <button
                  type="button"
                  onClick={dismissVoiceWarning}
                  className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-card/70 hover:text-foreground"
                  aria-label="Dismiss voice setup reminder"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
            <div className="flex flex-col gap-2 px-3 pt-3">
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
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card pl-2.5 pr-1.5 py-1 text-xs text-foreground"
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
            {/* Applied custom skills for the next message. */}
            {pendingSkills.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {pendingSkills.map((sk) => (
                  <span
                    key={sk.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/60 bg-amber-50 pl-2.5 pr-1.5 py-1 text-xs text-amber-900"
                  >
                    <Zap className="h-3 w-3" aria-hidden />
                    <span className="max-w-[140px] truncate">/{sk.name}</span>
                    <button
                      type="button"
                      onClick={() => toggleSkill(sk)}
                      className="text-amber-700 hover:text-amber-900"
                      aria-label={`Remove ${sk.name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {pendingPostFormat && (
              <div className="flex flex-wrap gap-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-300/60 bg-rose-50 pl-2.5 pr-1.5 py-1 text-xs text-primary">
                  <FileText className="h-3 w-3" aria-hidden />
                  <span className="max-w-[220px] truncate">
                    {noModelFormatLabel(pendingPostFormat)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPendingPostFormat(null)}
                    className="text-primary/70 hover:text-primary"
                    aria-label={`Remove ${noModelFormatLabel(pendingPostFormat)}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </div>
            )}
            {pendingLeadMagnet && (
              <div className="flex flex-wrap gap-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-300/60 bg-rose-50 pl-2.5 pr-1.5 py-1 text-xs text-primary">
                  <Gift className="h-3 w-3" aria-hidden />
                  <span className="max-w-[220px] truncate">
                    Giveaway: {pendingLeadMagnet.title}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPendingLeadMagnet(null)}
                    className="text-primary/70 hover:text-primary"
                    aria-label={`Remove ${pendingLeadMagnet.title}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </div>
            )}
            {pendingCreatorStyle && (
              <div className="flex flex-wrap gap-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-300/60 bg-rose-50 pl-2.5 pr-1.5 py-1 text-xs text-primary">
                  <Fingerprint className="h-3 w-3" aria-hidden />
                  <span className="max-w-[220px] truncate">
                    {pendingCreatorStyle.creatorName
                      ? `Style: ${pendingCreatorStyle.creatorName}`
                      : pendingCreatorStyle.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPendingCreatorStyle(null)}
                    className="text-primary/70 hover:text-primary"
                    aria-label={`Remove ${pendingCreatorStyle.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </div>
            )}
            </div>
            <div className="flex flex-col gap-2 px-3 pb-3 pt-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT_ATTR}
                className="hidden"
                onChange={(e) => onPickFiles(e.target.files)}
              />
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
                // Rests at ONE line (min-h-10 ≈ one line of text-base leading-relaxed
                // + py-1.5), then the auto-grow effect expands it up to 10 rows as you
                // type. text-base + leading-relaxed keeps what you type readable.
                className="min-h-10 w-full resize-none border-0 bg-transparent px-1 py-1.5 text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:ring-0"
              />
              <div className="flex items-center gap-1.5 border-t border-border pt-2.5">
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                // Attaching while a turn streams is fine — the files ride on the
                // NEXT send (attachments are consumed per-send), matching the
                // compose-ahead composer.
                disabled={attachments.length >= MAX_ATTACHMENTS}
                className="h-9 w-9 shrink-0 rounded-xl border-border bg-card hover:bg-muted"
                aria-label="Attach a file"
                title="Attach an image, PDF, Word doc, or text file"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              {/* ⚡ Custom-skills picker — only when the workspace has skills.
                  Opens a panel above the composer to browse + toggle skills. */}
              {customSkills.length > 0 && (
                <Button
                  ref={skillPickerButtonRef}
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={() => {
                    setPostFormatPickerOpen(false);
                    setCreatorStylePickerOpen(false);
                    setLeadMagnetPickerOpen(false);
                    setSkillPickerOpen((o) => !o);
                  }}
                  className={cn(
                    "h-9 w-9 shrink-0 rounded-xl border-border bg-card hover:bg-muted",
                    (skillPickerOpen || pendingSkills.length > 0) &&
                      "border-amber-400 text-amber-600",
                  )}
                  aria-label="Apply a custom skill"
                  aria-expanded={skillPickerOpen}
                  title="Apply a custom skill"
                >
                  <Zap className="h-4 w-4" />
                </Button>
              )}
              <Button
                ref={postFormatPickerButtonRef}
                type="button"
                size="icon"
                variant="outline"
                onClick={() => {
                  setSkillPickerOpen(false);
                  setCreatorStylePickerOpen(false);
                  setLeadMagnetPickerOpen(false);
                  setPostFormatPickerOpen((o) => !o);
                }}
                disabled={!!modelSource}
                className={cn(
                  "h-9 w-9 shrink-0 rounded-xl border-border bg-card hover:bg-muted",
                  (postFormatPickerOpen || pendingPostFormat) &&
                    "border-primary/60 text-primary",
                )}
                aria-label="Choose post format"
                aria-expanded={postFormatPickerOpen}
                title={
                  modelSource
                    ? "Source post controls the structure"
                    : "Choose post format"
                }
              >
                <FileText className="h-4 w-4" />
              </Button>
              <Button
                ref={leadMagnetPickerButtonRef}
                type="button"
                size="icon"
                variant="outline"
                onClick={() => {
                  setSkillPickerOpen(false);
                  setPostFormatPickerOpen(false);
                  setCreatorStylePickerOpen(false);
                  setLeadMagnetPickerOpen((o) => !o);
                }}
                className={cn(
                  "h-9 w-9 shrink-0 rounded-xl border-border bg-card hover:bg-muted",
                  (leadMagnetPickerOpen ||
                    pendingLeadMagnet ||
                    modelSource?.postType === "lead_magnet") &&
                    "border-primary/60 text-primary",
                )}
                aria-label="Choose lead magnet"
                aria-expanded={leadMagnetPickerOpen}
                title={
                  modelSource?.postType === "lead_magnet"
                      ? "Choose the giveaway for this modeled lead magnet post"
                      : modelSource?.postType === "regular"
                        ? "Choose a giveaway if you want this modeled source to become a lead magnet post"
                        : "Choose lead magnet"
                }
              >
                <Gift className="h-4 w-4" />
              </Button>
              <Button
                ref={creatorStylePickerButtonRef}
                type="button"
                size="icon"
                variant="outline"
                onClick={() => {
                  setSkillPickerOpen(false);
                  setPostFormatPickerOpen(false);
                  setLeadMagnetPickerOpen(false);
                  setCreatorStylePickerOpen((o) => !o);
                }}
                disabled={!!modelSource}
                className={cn(
                  "h-9 w-9 shrink-0 rounded-xl border-border bg-card hover:bg-muted",
                  (creatorStylePickerOpen || pendingCreatorStyle) &&
                    "border-primary/60 text-primary",
                )}
                aria-label="Choose creator style"
                aria-expanded={creatorStylePickerOpen}
                title={
                  modelSource
                    ? "Source post controls the style"
                    : "Choose creator style"
                }
              >
                <Fingerprint className="h-4 w-4" />
              </Button>
              <div className="min-w-0 flex-1" />
              {sending ? (
                // Mid-stream: the primary button stops the run (aborts the SSE
                // fetch; the partial response is kept).
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={stopActiveRun}
                  className="h-10 w-10 shrink-0 rounded-full border-border bg-card"
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
                  className="h-10 w-10 shrink-0 rounded-full shadow-sm"
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
              </div>
            </div>
            {/* Char counter — only as you near the cap, so it's not noise the
                rest of the time. Turns destructive once over the limit (send is
                already blocked above). */}
            {showCounter && (
              <div
                className={cn(
                  "px-4 pb-2 text-right text-[11px] tabular-nums",
                  overLimit ? "text-destructive font-medium" : "text-muted-foreground",
                )}
              >
                {inputLen.toLocaleString()} / {MAX_MESSAGE_LEN.toLocaleString()}
                {overLimit ? " — too long to send" : ""}
              </div>
            )}
            </div>
          </div>
        </form>
      </section>

      {/* Right: artifact panel — desktop inline column. */}
      {panelOpen && hasDraftPanel && (
        <aside
          className={cn(
            "relative hidden lg:flex shrink-0 flex-col border-l border-border bg-muted/80",
            resizingDraftPanel && "select-none",
          )}
          style={{
            width: draftPanelWidthReady ? draftPanelWidth : DRAFT_PANEL_DEFAULT_WIDTH,
          }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize drafts panel"
            title="Drag to resize drafts panel"
            tabIndex={0}
            onPointerDown={startDraftPanelResize}
            onPointerMove={resizeDraftPanel}
            onPointerUp={stopDraftPanelResize}
            onPointerCancel={stopDraftPanelResize}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const delta = e.key === "ArrowLeft" ? 24 : -24;
              const next = clampDraftPanelWidth(draftPanelWidth + delta);
              setDraftPanelWidth(next);
              writeDraftPanelWidth(next);
            }}
            className={cn(
              "absolute inset-y-0 -left-1.5 z-20 hidden w-3 cursor-col-resize items-center justify-center lg:flex",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            )}
          >
            <span
              className={cn(
                "h-12 w-1 rounded-full bg-border opacity-0 transition-opacity",
                "hover:opacity-100",
                resizingDraftPanel && "opacity-100 bg-primary/50",
              )}
              aria-hidden
            />
          </div>
          <div className="flex items-center justify-between px-4 h-14 border-b border-border bg-card/75">
            <span className="text-sm font-semibold tracking-[-0.01em]">
              {panelTitle(artifacts)} ({artifacts.length})
            </span>
            <button
              onClick={() => setPanelOpen(false)}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
              aria-label="Close panel"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-scroll [scrollbar-gutter:stable] p-3.5 flex flex-col gap-3">
            {showBatchStrip && batchRun && (
              <BatchPanelStatus run={batchRun} slots={batchSlots} />
            )}
            {draftsList}
          </div>
        </aside>
      )}

      {/* Mobile: a floating "Drafts (N)" pill above the composer that opens the
          drafts as a bottom sheet. The desktop panel is hidden below lg, so this
          is the ONLY way to reach generated drafts on a phone. */}
      {hasDraftPanel && !mobileDraftsOpen && (
        <button
          type="button"
          onClick={() => setMobileDraftsOpen(true)}
          className="lg:hidden absolute bottom-32 left-1/2 -translate-x-1/2 z-20 inline-flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-3.5 py-2 text-xs font-medium shadow-md backdrop-blur hover:bg-card transition-colors"
          aria-label={`Show ${panelTitle(artifacts).toLowerCase()}`}
        >
          <FileText className="h-3.5 w-3.5" />
          {panelTitle(artifacts)} ({artifacts.length})
        </button>
      )}
      {mobileDraftsOpen && hasDraftPanel && (
        <div className="lg:hidden absolute inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileDraftsOpen(false)}
            aria-hidden="true"
          />
          <div className="relative max-h-[80%] flex flex-col rounded-t-[1.35rem] border-t border-border bg-card shadow-xl animate-in slide-in-from-bottom duration-200">
            <div className="flex items-center justify-between px-4 h-14 border-b border-border shrink-0">
              <span className="text-sm font-semibold">
                {panelTitle(artifacts)} ({artifacts.length})
              </span>
              <button
                type="button"
                onClick={() => setMobileDraftsOpen(false)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-card hover:text-foreground"
                aria-label="Close drafts"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3.5 flex flex-col gap-3 pb-[env(safe-area-inset-bottom)]">
              {showBatchStrip && batchRun && (
                <BatchPanelStatus run={batchRun} slots={batchSlots} />
              )}
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
    <div className="flex items-start gap-2.5 rounded-2xl border border-border bg-card px-3 py-2.5">
      {source.authorAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={source.authorAvatar}
          alt=""
          className="h-8 w-8 rounded-xl object-cover shrink-0 mt-0.5"
        />
      ) : (
        <div className="h-8 w-8 rounded-xl bg-white flex items-center justify-center shrink-0 mt-0.5">
          <FileText className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold flex items-center gap-1.5">
          {source.kind === "draft"
            ? "Refining your post"
            : source.kind === "template"
              ? "Filling template"
              : source.authorName
                ? `Modeling after: ${source.authorName}`
                : "Modeling after this post"}
          {source.partial && (
            <span className="text-[10px] font-normal text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
              partial
            </span>
          )}
          {source.postType === "lead_magnet" && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-normal text-primary"
              title="Lead Magnet: Auto. Cowork will keep this as a lead-magnet post and pick a saved resource if one fits."
            >
              <Gift className="h-2.5 w-2.5" aria-hidden />
              Lead Magnet: Auto
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground truncate">{preview}…</p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-lg p-1 text-muted-foreground hover:bg-card hover:text-foreground shrink-0"
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
  const displayBody =
    artifact.kind === "post" ? normalizePostBody(artifact.body) : artifact.body;
  const firstLine =
    displayBody
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? kindNoun(artifact.kind);
  // A row (not a <button>) so the delete control isn't a button-in-button. The
  // expand area is the button; delete sits beside it.
  return (
    <div className="group flex items-center gap-2 w-full rounded-2xl border border-border bg-card/85 px-3 py-2.5 shadow-sm transition-colors hover:bg-card">
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
    // flex-col is load-bearing: with a max-h wrapper (the drafts card), a plain
    // block child using h-full resolves to AUTO height (percentage heights need
    // a DEFINITE parent; max-height alone isn't one) — so a long post grew to
    // full content height and visually spilled past the clamp, over the
    // feedback chips + action bar. As a flex container, max-h makes the box
    // definite for flex layout, and the min-h-0 child shrinks to fit and
    // scrolls internally instead of overflowing.
    <div className={cn("relative flex flex-col", wrapperClassName)}>
      <div
        ref={ref}
        onScroll={update}
        className={cn(
          "min-h-0 overflow-y-auto px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap",
          className,
        )}
      >
        {children}
      </div>
      {hasMoreBelow && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white to-transparent" />
          <div className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-foreground/80 px-2 py-0.5 text-[10px] font-medium text-white">
            <ChevronDown className="h-3 w-3" />
            Scroll for more
          </div>
        </>
      )}
    </div>
  );
}

// In-transcript indicator shown when we've returned to a chat whose turn is
// running server-side but whose live stream we lost to a full-page navigation.
// When the server's live_plan was restored, render the REAL plan checklist so
// the user sees the literal steps again; otherwise fall back to a "still
// working…" line. The reattach poll keeps `steps` fresh and swaps in the reply
// the moment the turn settles.
function ReattachingIndicator({ steps }: { steps: PlanStep[] }) {
  if (steps.length > 0) {
    return <PlanChecklist steps={steps} status="Working" />;
  }
  return (
    <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
      <span className="inline-flex gap-0.5" aria-hidden>
        <span className="working-dot h-1.5 w-1.5 rounded-full bg-primary" />
        <span className="working-dot h-1.5 w-1.5 rounded-full bg-primary [animation-delay:0.2s]" />
        <span className="working-dot h-1.5 w-1.5 rounded-full bg-primary [animation-delay:0.4s]" />
      </span>
      Cowork is still working on this…
    </div>
  );
}

// Sidebar "this chat is working" indicator. A compact coral "Working" label
// with three dots that pulse in sequence — reads clearly at a glance, unlike
// the old tiny spinner. shrink-0 so it never gets truncated with the title.
function WorkingLabel() {
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
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
        "group flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm cursor-pointer transition-all",
        active
          ? "bg-white text-foreground shadow-sm ring-1 ring-border"
          : "text-muted-foreground hover:bg-card/70 hover:text-foreground",
      )}
      onClick={onOpen}
    >
      <MessageSquare className={cn("h-3.5 w-3.5 shrink-0", active ? "text-primary" : "opacity-60")} />
      <span className={cn("truncate flex-1", active && "font-medium")}>{chat.title}</span>
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
  const [copied, markCopied] = useCopiedFlag();
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyToClipboard(text, "Copied to clipboard")) {
          markCopied();
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
  onAnswer: (text: string, ask: AskQuestion) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end gap-1.5">
        {message.files && message.files.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 max-w-[85%]">
            {message.files.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/80 px-2.5 py-1 text-xs text-muted-foreground"
              >
                <Paperclip className="h-3 w-3" />
                <span className="max-w-[160px] truncate">{name}</span>
              </span>
            ))}
          </div>
        )}
        {message.skills && message.skills.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 max-w-[85%]">
            {message.skills.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/60 bg-amber-50 px-2.5 py-0.5 text-[11px] text-amber-900"
                title={`Custom skill applied: /${name}`}
              >
                <Zap className="h-3 w-3" aria-hidden />
                <span className="max-w-[160px] truncate">/{name}</span>
              </span>
            ))}
          </div>
        )}
        {message.postFormat && (
          <div className="flex flex-wrap justify-end gap-1.5 max-w-[85%]">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-rose-300/60 bg-rose-50 px-2.5 py-0.5 text-[11px] text-primary"
              title={`Post format selected: ${message.postFormat}`}
            >
              <FileText className="h-3 w-3" aria-hidden />
              <span className="max-w-[200px] truncate">{message.postFormat}</span>
            </span>
          </div>
        )}
        {message.creatorStyle && (
          <div className="flex flex-wrap justify-end gap-1.5 max-w-[85%]">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-rose-300/60 bg-rose-50 px-2.5 py-0.5 text-[11px] text-primary"
              title={`Creator style: ${message.creatorStyle.creatorName ?? message.creatorStyle.name}`}
            >
              <Fingerprint className="h-3 w-3" aria-hidden />
              <span className="max-w-[200px] truncate">
                {message.creatorStyle.creatorName
                  ? `Style: ${message.creatorStyle.creatorName}`
                  : message.creatorStyle.name}
              </span>
            </span>
          </div>
        )}
        {message.leadMagnet && (
          <div className="flex flex-wrap justify-end gap-1.5 max-w-[85%]">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-rose-300/60 bg-rose-50 px-2.5 py-0.5 text-[11px] text-primary"
              title={`Lead magnet ${message.leadMagnet.selection === "auto" ? "auto-selected" : "selected"}: ${message.leadMagnet.title}`}
            >
              <Gift className="h-3 w-3" aria-hidden />
              <span className="max-w-[200px] truncate">
                Giveaway: {message.leadMagnet.title}
              </span>
            </span>
          </div>
        )}
        <div className="max-w-[82%] rounded-2xl rounded-br-md border border-primary/15 bg-primary/[0.09] px-4 py-2.5 text-sm leading-relaxed text-foreground shadow-[0_1px_0_rgba(255,255,255,0.8)] whitespace-pre-wrap">
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
    <div className="group flex flex-col gap-3">
      {/* Agent progress — status-only turns, planned turns, and tool-detail
          turns all use the same card language so Cowork does not jump between
          unrelated "working" UIs. */}
      {plan.length > 0 ? (
        <PlanChecklist steps={plan} status={status} />
      ) : shouldShowActivityRail(plan, tools) ? (
        <ActivityStream tools={tools} status={status ?? "Working"} />
      ) : status ? (
        <AgentProgressStatus status={status} />
      ) : null}

      {/* Activity stream — one narrated line per tool call, on a thin left rail.
          Hidden when a plan is showing (the checklist replaces it), EXCEPT keep
          it whenever a tool FAILED (the plan card has no failure state, so the
          ✕ would otherwise be invisible on a planned turn). See
          shouldShowActivityRail. */}
      {plan.length > 0 && shouldShowActivityRail(plan, tools) && (
        <ActivityStream tools={tools} status="Tool details" />
      )}

      {/* Assistant prose. Generated drafts/hooks are NOT rendered here — they
          live in the right-hand Drafts panel so they're not duplicated. "chat"
          mode renders the model's "- "/"1." lists as proper bullets/numbers;
          the draft-body surfaces below stay default "draft" so a real post is
          never restyled. */}
      {message.text && (
        <div className="text-[15px] leading-7 whitespace-pre-wrap text-foreground">
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

// A "we're satisfied — no-op" terminal option label ("It's good — done",
// "Looks great", "Nothing to change", "All set", "Perfect", "Ship it"). Mirrors
// the server's DONE_ISH_RE (lib/agent/run.ts) so an already-persisted ask whose
// doneOption the model dropped still closes deterministically on rehydrate.
const CLIENT_DONE_ISH_RE =
  /\b(we'?re\s+done|it'?s?\s+(all\s+)?good|they'?re\s+(all\s+)?good|looks?\s+(great|good|perfect)|nothing\s+(to\s+change|else)|all\s+(set|good|done)|i'?m\s+(good|happy|satisfied|done)|perfect|ship\s+it|good\s+to\s+go|no\s+changes?)\b|—\s*done\b|\bdone\b/i;
// A "you decide / proceed" escape ("Use your best judgment") — NOT terminal,
// it requires the model to act. Kept in sync with run.ts PROCEED_ESCAPE_RE.
const CLIENT_PROCEED_ESCAPE_RE =
  /\b(your?\s+(best\s+)?(judge?ment|call|choice|discretion)|you\s+(decide|choose|pick)|whatever\s+you\s+(think|prefer|want)|surprise\s+me|up\s+to\s+you|dealer'?s\s+choice)\b/i;

// Recover a dropped doneOption for a hydrated ask: if none was persisted but
// EXACTLY ONE option reads as a satisfied/no-op terminal, adopt it. Same
// exactly-one guard + proceed-escape exclusion as the server. Exported for tests.
export function recoverDoneOption(
  options: string[],
  persistedDone: string | undefined,
): string | undefined {
  if (persistedDone && options.includes(persistedDone)) return persistedDone;
  const doneish = options.filter(
    (o) => CLIENT_DONE_ISH_RE.test(o) && !CLIENT_PROCEED_ESCAPE_RE.test(o),
  );
  return doneish.length === 1 ? doneish[0] : undefined;
}

// Decide what an AskCard submission should DO. Pure + exported for unit tests.
//   - "done": the user picked ONLY the terminal/done option (no other option,
//     no free text). There's nothing for the agent to do, so the card just
//     closes — NO message is sent, NO model turn fires, the drafts stay put.
//   - "send": anything else → send the composed answer as the next message.
// The done short-circuit is deliberately strict: a "done" pick combined with
// another option or with typed text is a real instruction ("they're good, but
// shorten #2") and must reach the agent.
export function resolveAskSubmission(
  ask: AskQuestion,
  selected: string[],
  otherText: string,
): { kind: "done" } | { kind: "send"; text: string } {
  const text = composeAskAnswer(selected, otherText);
  const isDone =
    !!ask.doneOption &&
    selected.length === 1 &&
    selected[0] === ask.doneOption &&
    !otherText.trim();
  return isDone ? { kind: "done" } : { kind: "send", text };
}

// Toggle one AskCard option.
//
// SINGLE-SELECT (the default, ask.multiSelect falsy): exactly one option at a
// time. Picking an option replaces whatever was selected (radio-button
// semantics); clicking the already-selected one clears it. This is right for
// nearly every clarifying question ("which idea?", "casual or formal?") — the
// user can't send two contradictory answers.
//
// MULTI-SELECT (ask.multiSelect true — the post-draft "which edits?" case):
// several options compose ("Make it shorter" + "Add a CTA" is a real answer),
// EXCEPT the terminal "done"/escape option is mutually exclusive with the
// action options (reliability finding #24): "It's good — done" combined with an
// edit request is a contradiction, so picking done clears every other pick and
// picking any other option clears done.
//
// Pure + exported for unit tests.
export function toggleAskOption(
  ask: AskQuestion,
  selected: string[],
  opt: string,
): string[] {
  // Turning OFF an already-selected option is always just a removal.
  if (selected.includes(opt)) return selected.filter((o) => o !== opt);
  // Single-select: the newly-picked option becomes the ONLY selection.
  if (!ask.multiSelect) return [opt];
  const isExclusive = !!ask.doneOption && opt === ask.doneOption;
  // Turning ON the exclusive (done) option → it becomes the only selection.
  if (isExclusive) return [opt];
  // Turning ON a normal option → add it, but drop the exclusive option if set.
  return [...selected.filter((o) => o !== ask.doneOption), opt];
}

// The clarifying-question card. Single-select (radio buttons — the default) or
// multi-select (checkboxes, ask.multiSelect) options + an optional free-text
// box, with a Submit that auto-sends the composed answer. Once submitted it
// locks (shows the chosen answer) so the question can't be re-answered.
function AskCard({
  ask,
  onSubmit,
}: {
  ask: AskQuestion;
  onSubmit: (text: string, ask: AskQuestion) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState("");
  // null = unanswered. {done:true} = closed via the terminal option (no send).
  // {done:false,text} = answered with a message that was sent.
  const [submitted, setSubmitted] = useState<
    { done: boolean; text: string } | null
  >(null);

  // Single-select unless the model asked for multi. Drives BOTH the control
  // visuals (radios vs checkboxes) and the free-text/pick interaction below.
  const isMulti = !!ask.multiSelect;
  const answer = composeAskAnswer(selected, other);
  // True when the only thing chosen is the terminal "done" option — the button
  // then reads "Done" and clicking it closes the card without sending.
  const isDoneOnly =
    resolveAskSubmission(ask, selected, other).kind === "done";
  const toggle = (opt: string) => {
    setSelected((s) => toggleAskOption(ask, s, opt));
    // Single-select is exactly ONE answer: picking an option clears any typed
    // free-text so the card can't send a radio pick AND a contradictory typed
    // answer together. (Multi-select composes picks + text on purpose.)
    if (!isMulti) setOther("");
  };
  // Free-text handler: in single-select, typing an answer means "none of the
  // options" — clear the radio pick so the two can't both be sent. Multi-select
  // keeps both (compose).
  const onOtherChange = (v: string) => {
    setOther(v);
    if (!isMulti && v.trim() && selected.length) setSelected([]);
  };

  // Submit handler: a terminal "done" pick just closes the card (no model
  // turn); anything else sends the composed answer.
  const submit = () => {
    const action = resolveAskSubmission(ask, selected, other);
    if (action.kind === "done") {
      setSubmitted({ done: true, text: ask.doneOption ?? "" });
      return; // no onSubmit → no send → no AI turn, drafts stay visible
    }
    setSubmitted({ done: false, text: action.text });
    onSubmit(action.text, ask);
  };

  if (submitted !== null) {
    return (
      <div className="rounded-2xl border border-border bg-card/80 px-3.5 py-3 text-sm shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {submitted.done ? "Marked as done" : "You answered"}
        </p>
        <p className="mt-1 text-foreground">{submitted.text}</p>
      </div>
    );
  }

  return (
    <div className="agent-card-in rounded-2xl border border-border bg-card/80 px-3.5 py-3 shadow-sm">
      <p className="text-sm font-medium text-foreground">{ask.question}</p>
      <div
        className="mt-2.5 flex flex-col gap-1.5"
        role={isMulti ? "group" : "radiogroup"}
      >
        {ask.options.map((opt) => {
          const on = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className={cn(
                "flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                on
                  ? "border-primary/50 bg-primary/[0.08] text-foreground"
                  : "border-border bg-card hover:bg-card text-foreground",
              )}
              // Single-select options are radios (exactly one); multi are
              // checkboxes. Expose the matching ARIA role/state so it reads
              // correctly to assistive tech, not just visually.
              role={isMulti ? "checkbox" : "radio"}
              aria-checked={on}
            >
              <span
                className={cn(
                  "grid h-4 w-4 shrink-0 place-items-center border",
                  // Radio = circle, checkbox = rounded square. The shape is the
                  // affordance: a circle says "pick one", a box says "pick any".
                  isMulti ? "rounded" : "rounded-full",
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40",
                )}
                aria-hidden
              >
                {on &&
                  (isMulti ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    // Filled dot for a selected radio.
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  ))}
              </span>
              <span className="min-w-0">{opt}</span>
            </button>
          );
        })}
      </div>
      {ask.allowOther && (
        <input
          value={other}
          onChange={(e) => onOtherChange(e.target.value)}
          placeholder="Or type your own answer…"
          className="mt-2 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
          onKeyDown={(e) => {
            if (e.key === "Enter" && answer.trim()) {
              e.preventDefault();
              submit();
            }
          }}
        />
      )}
      <div className="mt-2.5 flex justify-end">
        <Button
          size="sm"
          className="h-8"
          disabled={!answer.trim()}
          onClick={submit}
        >
          {isDoneOnly ? "Done" : "Send answer"}
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
    "group inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card/80 px-2.5 py-1.5 text-xs text-foreground shadow-sm";
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
function AgentProgressShell({
  title,
  count,
  children,
}: {
  title: string;
  count?: string;
  children: ReactNode;
}) {
  return (
    <div className="agent-card-in w-full max-w-2xl rounded-2xl border border-primary/15 bg-card/85 px-3.5 py-3 shadow-sm shadow-primary/5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-primary/85">
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span className="agent-shimmer">{title}</span>
        </span>
        {count && (
          <span className="text-[11px] font-medium tabular-nums text-muted-foreground/80">
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function AgentProgressStatus({ status }: { status: string }) {
  return (
    <AgentProgressShell title="Working">
      <div className="agent-step-in flex items-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        <span>{status}</span>
      </div>
    </AgentProgressShell>
  );
}

function PlanChecklist({ steps, status }: { steps: PlanStep[]; status: string | null }) {
  const done = steps.filter((s) => s.status === "done").length;
  const allDone = done === steps.length;
  const explicitActiveIndex = steps.findIndex((s) => s.status === "active");
  const fallbackActiveIndex = allDone ? -1 : steps.findIndex((s) => s.status !== "done");
  const activeIndex = explicitActiveIndex >= 0 ? explicitActiveIndex : fallbackActiveIndex;
  return (
    <AgentProgressShell
      title={allDone ? "Plan complete" : status ?? "Working"}
      count={`${done}/${steps.length}`}
    >
      <ul className="flex flex-col gap-1.5">
        {steps.map((s, index) => {
          const visuallyActive = index === activeIndex;
          return (
          <li
            // Keyed by step id so a status flip re-renders in place (no remount
            // flicker); a re-plan changes ids, animating the new rows in.
            key={s.id}
            className="agent-step-in flex items-center gap-2 text-[13px]"
          >
            {s.status === "done" ? (
              <CheckCircle2 className="check-pop h-4 w-4 shrink-0 text-emerald-600" />
            ) : visuallyActive ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            ) : (
              <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
            )}
            <span
              className={cn(
                s.status === "done" && "text-muted-foreground line-through decoration-muted-foreground/40",
                visuallyActive && "font-medium text-foreground",
                !visuallyActive && s.status === "pending" && "text-muted-foreground",
              )}
            >
              {s.label}
            </span>
          </li>
          );
        })}
      </ul>
    </AgentProgressShell>
  );
}

// The agent's activity stream: a narrated, vertical list of the tool calls it
// made this turn, on a thin left rail. Each line reads as a step the agent
// took ("Searched the swipe file · AI") with a state icon — a spinner while
// running, a check when it succeeded, a ✕ when it failed.
function ActivityStream({ tools, status }: { tools: ToolChip[]; status: string }) {
  return (
    <AgentProgressShell title={status}>
      <div className="flex flex-col gap-1.5">
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
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
              ) : t.ok ? (
                <CheckCircle2 className="check-pop h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <X className="check-pop h-4 w-4 shrink-0 text-destructive" />
              )}
              <span>
                {phrase}
                {detail && (
                  <span className="text-foreground/70"> · {detail}</span>
                )}
                {/* The RESULT finding, once the tool completed ("→ 12 posts").
                    Deterministic + server-computed; makes the rail read as the
                    agent reacting to real data instead of a spinner. */}
                {t.ok !== undefined && t.summary && (
                  <span className="text-foreground/70"> → {t.summary}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </AgentProgressShell>
  );
}

// Live worker board for the weekly batch, rendered inline in the batch chat's
// transcript while the workspace-level poll reports a pending/running run. It's
// the fix for "the chat gives no feedback while the writers draft" — instead of
// one static stage line, the user watches a team: a header (live stage +
// counter + progress bar) over one lane per writer that advances queued →
// drafting (spinner) → filed (title) / skipped, reusing the SAME WorkerLane the
// home card renders so the two surfaces never drift.
//
// Degrades gracefully: before the slots arrive (or if that fetch blips) it's
// just the header — the same ambient strip as before, never a blank box. Fades
// out entirely when the run settles (done|failed), via showBatchStrip.
function BatchWorkerBoard({
  run,
  slots,
}: {
  run: BatchRunSnapshot;
  slots: BatchSlot[];
}) {
  // The pipeline publishes stage strings like "Finding this week's top posts",
  // "Setting up your writers", "Dispatched N writers". We render the raw stage
  // so a copy tweak in lib/batch/weekly.ts flows through without a client change.
  const stage = (run.stage ?? "").trim() || "Working on your week";
  // Prefer the live lane counts (filed slots) once lanes exist — they're the
  // ground truth the user is literally watching — and fall back to the run
  // rollup's counters before slots load. total: lane count if we have lanes,
  // else the run's committed source count.
  const filed = slots.filter((s) => s.status === "filed").length;
  const total = slots.length > 0 ? slots.length : (run.total ?? 0);
  const created = slots.length > 0 ? filed : (run.created ?? 0);
  const attempted = run.attempted ?? 0;
  // Progress denominator: `total` (source count committed at fan-out). Before
  // fan-out both are 0 → hide the bar/counter; the spinner + stage still move.
  const showCounter = total > 0;
  const progressPct = showCounter
    ? Math.min(100, Math.max(0, Math.round((created / total) * 100)))
    : 0;
  const counterLine = showCounter
    ? created > 0
      ? `${created} of ${total} drafted`
      : attempted > 0
        ? `${attempted} of ${total} in progress`
        : `${total} in the queue`
    : null;
  const terminal = run.status === "done" || run.status === "failed";
  const HeaderIcon = run.status === "done" ? CheckCircle2 : terminal ? Circle : Loader2;
  // Lanes render newest-progress-first-ish by their stable slot order (the
  // pipeline created them in source order). Keep insertion order so a lane
  // doesn't jump around as its status flips.
  const ordered = [...slots].sort((a, b) => a.slot_index - b.slot_index);
  const placeholderCount =
    ordered.length === 0 && total > 0 ? Math.min(total, WEEKLY_BATCH_DRAFT_COUNT) : 0;
  return (
    <div
      className="agent-card-in rounded-xl border border-primary/25 bg-primary/[0.04] px-4 py-3"
      aria-live="polite"
      role="status"
    >
      <div className="flex items-center gap-2.5">
        <HeaderIcon
          className={cn(
            "h-4 w-4 shrink-0 text-primary",
            !terminal && "animate-spin",
            run.status === "failed" && "text-muted-foreground",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {stage}
          {!terminal && (
            <span className="ml-1 inline-block animate-pulse text-primary">…</span>
          )}
        </span>
        {counterLine && (
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            {counterLine}
          </span>
        )}
      </div>
      {showCounter && (
        <div
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-primary/10"
          aria-hidden
        >
          <div
            className="h-full rounded-full bg-primary/70 transition-[width] duration-500 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
      {ordered.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {ordered.map((s) => (
            <WorkerLane key={s.slot_index} slot={s} />
          ))}
        </div>
      )}
      {placeholderCount > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {Array.from({ length: placeholderCount }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-background px-3 py-2.5"
            >
              <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
              <div className="min-w-0 flex-1">
                <div className="h-3 w-32 rounded bg-muted animate-pulse" />
                <div className="mt-1.5 h-2.5 w-20 rounded bg-muted/70 animate-pulse" />
              </div>
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                Queued
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BatchPanelStatus({
  run,
  slots,
}: {
  run: BatchRunSnapshot;
  slots: BatchSlot[];
}) {
  const stage = (run.stage ?? "").trim() || "Working on your week";
  const filed = slots.filter((s) => s.status === "filed").length;
  const writing = slots.filter((s) => s.status === "drafting").length;
  const total = slots.length > 0 ? slots.length : (run.total ?? 0);
  const created = slots.length > 0 ? filed : (run.created ?? 0);
  const progressPct =
    total > 0 ? Math.min(100, Math.max(0, Math.round((created / total) * 100))) : 0;
  const terminal = run.status === "done" || run.status === "failed";
  const StatusIcon = run.status === "done" ? CheckCircle2 : terminal ? Circle : Loader2;
  return (
    <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-3">
      <div className="flex items-start gap-2.5">
        <StatusIcon
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 text-primary",
            !terminal && "animate-spin",
            run.status === "failed" && "text-muted-foreground",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-snug">{stage}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {total > 0
              ? `${created}/${total} drafts ready${
                  writing > 0 ? ` · ${writing} writing now` : ""
                }`
              : "Finding the right posts and preparing writers"}
          </div>
        </div>
      </div>
      {total > 0 && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
          <div
            className="h-full rounded-full bg-primary/70 transition-[width] duration-500 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
      <div className="mt-3 text-xs leading-snug text-muted-foreground">
        Drafts appear here one by one as each writer finishes.
      </div>
    </div>
  );
}

// Navigate to the Posts page, dropping the client Router Cache first.
//
// The sidebar's <Link href="/dashboard/posts" prefetch> caches the Posts RSC
// payload early; during a batch, drafts are written server-side but that
// prefetched client payload is stale, so a plain router.push served the
// pre-batch snapshot and the review panel looked empty until a manual reload.
// router.refresh() clears the WHOLE client Router Cache (all routes), so the
// subsequent push re-fetches /dashboard/posts fresh and the just-filed drafts
// are there on arrival. Same class of fix as the bookmark button.
function compactBatchDraftPreview(title: string | null | undefined, body: string): string {
  const normalizedTitle = (title ?? "").trim().toLowerCase();
  return body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index) => index > 0 || line.toLowerCase() !== normalizedTitle)
    .slice(0, 2)
    .join("\n");
}

// A weekly-batch draft rendered in the chat transcript. READ-ONLY: batch drafts
// are status='pending_review' and the ONE approval surface is the review panel
// on /dashboard/posts — so this card has no Save/Refine (which would be a second
// writer). It shows the draft + a lead-magnet badge + "Adapted from" link, and a
// single "Review this batch" button that deep-links to the review panel.
function BatchPreviewCard({
  artifact,
  onApprove,
  onReject,
  outcome,
}: {
  artifact: Artifact;
  // Approve = PATCH /api/drafts/:id { status:'ready' } → Ready column.
  // Reject = PATCH { status:'rejected' } → off-board + dedup preserved.
  // Absent while a batch is still filing this draft (parent gates on the
  // artifact reaching pending_review before wiring these in).
  onApprove?: () => void;
  onReject?: () => void;
  outcome?: "approved" | "rejected";
}) {
  const [copied, markCopied] = useCopiedFlag();
  const [expanded, setExpanded] = useState(false);
  const meta = (artifact.meta ?? {}) as {
    is_lead_magnet?: boolean;
    source_url?: string | null;
  };
  const title = (artifact.title ?? "").trim() || "Draft";
  const displayBody =
    artifact.kind === "post" ? normalizePostBody(artifact.body) : artifact.body;
  const preview = compactBatchDraftPreview(title, displayBody);
  // The auto-selected lead-magnet resource for this batch draft. Shown as a
  // "Giveaway: X" pill so the user sees which resource got attached without
  // opening the full artifact card. Uses the same reader as ArtifactCard.
  const leadMagnet = artifactLeadMagnet(artifact);
  // Generated lead-magnet image state. Two data sources:
  //   • media_attachments — the image, once the job persisted an asset.
  //   • meta.generated_lead_magnet_image — job status (queued / running /
  //     done / failed / skipped) + failure reason. Set by the batch worker
  //     when it enqueues + updated by the image job on completion.
  // We surface all three states below the expanded body so the user can see
  // WHY credits were spent even if the image isn't ready yet or the job failed.
  const mediaAttachments = artifactMediaAttachments(artifact);
  const imageAttachments = mediaAttachments.filter(
    (a) => a.type === "image" && (a.previewUrl || a.url),
  );
  const generatedImageStatus = generatedLeadMagnetImageStatus(artifact);
  const imageJobPending =
    !imageAttachments.length &&
    (generatedImageStatus?.status === "queued" ||
      generatedImageStatus?.status === "running");
  const imageJobFailed =
    !imageAttachments.length &&
    (generatedImageStatus?.status === "failed" ||
      generatedImageStatus?.status === "skipped");
  const copy = async () => {
    if (await copyToClipboard(displayBody)) {
      markCopied();
    }
  };
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/[0.03]">
      {/* Header row — title is the focal point (bumped to sm/foreground), the
          lead-magnet chip is small and matches the posts-board kindBadge for
          cross-surface consistency. When the draft has been reviewed
          (approved/rejected in this session), the status swaps from
          "Pending review" to a confirmation. */}
      <button
        type="button"
        className="block w-full px-4 py-3 text-left transition-colors hover:bg-primary/[0.035]"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {title}
          </span>
          {meta.is_lead_magnet && (
            <span
              className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
              title={postTypeHelp(true)}
            >
              lead magnet
            </span>
          )}
          {outcome === "approved" ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-[11px] text-emerald-700"
              title="Approved — this draft is on the Ready column of your Posts board."
            >
              <span
                className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                aria-hidden
              />
              Approved
            </span>
          ) : outcome === "rejected" ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
              title="Rejected — kept off the board; the source post won't be re-served next week."
            >
              <span
                className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50"
                aria-hidden
              />
              Rejected
            </span>
          ) : (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-[11px] text-amber-700"
              title="Pending review — approve or reject below to move this draft to Ready or rejected."
            >
              <span
                className="h-1.5 w-1.5 rounded-full bg-amber-500"
                aria-hidden
              />
              Pending review
            </span>
          )}
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </div>
        {!expanded && preview && (
          <div className="mt-2 whitespace-pre-line text-sm leading-snug text-muted-foreground line-clamp-2">
            {preview}
          </div>
        )}
      </button>
      {expanded && (
        <div className="whitespace-pre-wrap px-4 pb-3 text-sm leading-relaxed">
          {displayBody}
        </div>
      )}
      {/* Generated lead-magnet image — the credit-spend feedback surface. Three
          states, in priority order:
          1) image ready → render the asset (LinkedIn-style aspect, 1 tile).
          2) job in-flight → skeleton placeholder so the user can see credits
             are being spent for a reason (the batch worker enqueued a job).
          3) job failed/skipped → muted one-liner explaining the null result.
          Nothing renders when no lead-magnet image was ever intended. */}
      {expanded && imageAttachments.length > 0 && (
        <div className="px-4 pb-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageAttachments[0].previewUrl || imageAttachments[0].url || ""}
            alt=""
            className="aspect-[4/3] w-full rounded-lg border border-border/60 bg-muted/30 object-cover"
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Image ready in your media library. It travels with the draft when
            you approve it, so it will attach on the Posts board.
          </p>
        </div>
      )}
      {expanded && imageJobPending && (
        <div className="px-4 pb-3">
          <div
            className="aspect-[4/3] w-full animate-pulse rounded-lg border border-border/60 bg-muted/40"
            aria-label="Generating image"
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Generating image…
          </p>
        </div>
      )}
      {expanded && imageJobFailed && (
        <div className="px-4 pb-3">
          <p className="text-[11px] text-muted-foreground">
            Image couldn’t be generated for this draft
            {generatedImageStatus?.reason
              ? ` (${generatedImageStatus.reason})`
              : ""}
            .
          </p>
        </div>
      )}
      {expanded && (
        <div className="border-t border-border/50 px-4 py-2.5">
        {/* Lead-magnet resource pill — surfaces the auto-selected giveaway
            when meta.lead_magnet was set by the batch resolver. Same
            component the ArtifactCard uses (artifactLeadMagnet reader). */}
        {leadMagnet && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span
              className="inline-flex items-center gap-1 rounded-full border border-rose-300/60 bg-rose-50 px-2.5 py-0.5 text-[10px] font-semibold text-primary"
              title={`Lead magnet ${leadMagnet.selection === "auto" ? "auto-selected" : "selected"}: ${leadMagnet.title}`}
            >
              <Gift className="h-2.5 w-2.5" aria-hidden />
              <span className="max-w-[220px] truncate">
                Giveaway: {leadMagnet.title}
              </span>
            </span>
          </div>
        )}
        {!outcome && (
          <div className="mb-2 text-[11px] leading-snug text-muted-foreground">
            Generated in Cowork. Approve to move it to Ready on your Posts
            board, or reject to keep it off the board.
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        {onApprove && onReject && !outcome && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
              onClick={onApprove}
              title="Approve this batch draft and send it to Ready on the Posts board"
            >
              <Check className="h-3.5 w-3.5" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground"
              onClick={onReject}
              title="Reject this batch draft (kept off the board; the source won't be re-served next week)"
            >
              <X className="h-3.5 w-3.5" />
              Reject
            </Button>
          </>
        )}
        {outcome === "approved" && (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-700">
            <Check className="h-3.5 w-3.5" />
            Approved · on the Ready column
          </span>
        )}
        {outcome === "rejected" && (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-muted px-3 text-xs font-medium text-muted-foreground">
            <X className="h-3.5 w-3.5" />
            Rejected
          </span>
        )}
        {meta.source_url && (
          <a
            href={meta.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
          >
            Adapted from <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
        </div>
      </div>
      )}
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
  onBodyChange,
  onMetaChange,
  leadMagnetHref,
  refineDisabled,
  onDelete,
  onApproveBatchReview,
  onRejectBatchReview,
  batchReviewOutcome,
}: {
  artifact: Artifact;
  chatId: string | null;
  author: Author;
  // "Draft N" badge shown when the chat has more than one draft (accordion).
  label?: string;
  // When set, this chat is refining an existing Posts-board post (this id). The
  // primary save action UPDATES that row instead of creating a new draft.
  refiningDraftId?: string | null;
  // Send this draft back to the agent with an instruction. The result UPDATES
  // this card in place (with version history), not a separate new draft.
  onRefine: (instruction: string) => void;
  // The Done-edit PATCH succeeded — the parent updates its artifactsByChat
  // cache so the next render reflects the saved body (otherwise the parent's
  // stale prop would seed-reset the local body on a re-render).
  onBodyChange?: (newBody: string) => void;
  onMetaChange?: (metaPatch: Record<string, unknown>) => void;
  leadMagnetHref?: (leadMagnet: AppliedLeadMagnet | null) => string | null;
  // True while a turn is streaming in this chat — refine controls are disabled
  // (a refine mid-turn would be silently dropped by the send() in-flight guard).
  refineDisabled?: boolean;
  // Remove this draft from the chat. Confirmed before firing. Absent → no
  // delete affordance (e.g. a context where deletion doesn't apply).
  onDelete?: () => void;
  // Batch review — set on a weekly-batch draft awaiting user validation
  // (status='pending_review' in chat_artifacts). Approve moves the draft to
  // 'ready' on the /posts board; reject flips it to 'rejected' (off-board,
  // preserves the dedup signal). Absent for regular chat drafts.
  onApproveBatchReview?: () => void;
  onRejectBatchReview?: () => void;
  // "Approved" / "Rejected" transient state after the user acts, so the card
  // stays visible with a small badge instead of vanishing. Absent for cards
  // that haven't been acted on.
  batchReviewOutcome?: "approved" | "rejected";
}) {
  const router = useRouter();
  const [copied, markCopied] = useCopiedFlag();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  // Whether the primary save/schedule should UPDATE an existing Posts-board row.
  // Only for post artifacts in a chat that was opened to refine that specific post.
  const canUpdateOriginal = !!refiningDraftId && artifact.kind === "post";
  // The refine quick-action row toggles open below the action bar.
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineText, setRefineText] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const scheduleMeta = scheduleMetaFromArtifact(artifact);
  const artifactBody =
    artifact.kind === "post" ? normalizePostBody(artifact.body) : artifact.body;
  const [boardDraftId, setBoardDraftId] = useState<string | null>(
    canUpdateOriginal ? refiningDraftId : scheduleMeta.boardDraftId,
  );
  const [scheduledAt, setScheduledAt] = useState<string | null>(scheduleMeta.scheduledAt);
  const [scheduleStatus, setScheduleStatus] = useState<string | null>(
    scheduleMeta.scheduleStatus,
  );
  const [firstComment, setFirstComment] = useState(scheduleMeta.firstComment ?? "");
  const [scheduleWhen, setScheduleWhen] = useState(isoToLocalInput(scheduleMeta.scheduledAt));
  const [scheduling, setScheduling] = useState(false);
  // Local working copy of the post body. Seeded from the artifact and kept in
  // sync when a *new* artifact streams in (its id changes), but never clobbered
  // by re-renders of the same artifact — otherwise an edit would be lost the
  // moment the parent re-rendered.
  const [body, setBody] = useState(artifactBody);
  // Track the last (id, body) we seeded from in state (not a ref) so the
  // "adjust state when a prop changes" happens cleanly during render. We re-seed
  // when a NEW artifact streams in (id changes) AND when an AI refine updates
  // THIS card in place (same id, new body — the in-place "update the current
  // draft" flow), so the card shows the refined text instead of the stale one.
  const [seededId, setSeededId] = useState(artifact.id);
  const [seededBody, setSeededBody] = useState(artifactBody);
  if (seededId !== artifact.id || (!editing && seededBody !== artifactBody)) {
    setSeededId(artifact.id);
    setSeededBody(artifactBody);
    setBody(artifactBody);
    setEditing(false);
    const seededBoardDraftId = canUpdateOriginal ? refiningDraftId : scheduleMeta.boardDraftId;
    // A board row already exists for THIS exact content (persisted on the
    // artifact via meta.board_draft_id) → it's already saved, not merely
    // "not yet saved this session". Without this, reopening a chat you'd
    // already saved reset `saved` to false unconditionally, so the Save
    // button re-enabled on unchanged content and clicking it inserted a
    // genuine duplicate chat_artifacts row (saveAsNew is an unconditional
    // INSERT with no dedup check). `dirty` (body !== artifactBody) still
    // correctly re-enables Save the moment the user actually edits it.
    setSaved(!!seededBoardDraftId);
    setBoardDraftId(seededBoardDraftId);
    setScheduledAt(scheduleMeta.scheduledAt);
    setScheduleStatus(scheduleMeta.scheduleStatus);
    setFirstComment(scheduleMeta.firstComment ?? "");
    setScheduleWhen(isoToLocalInput(scheduleMeta.scheduledAt));
  }
  const dirty = body !== artifactBody;

  // Custom-skill slugs the server stamped onto meta.skills when this draft was
  // produced under an active /skill — rendered as amber chips next to the
  // "Draft" badge ("this draft came from /cta"). Defensive read: meta is
  // unknown-shape; only accept a string array.
  const draftSkills = ((): string[] => {
    const v = (artifact.meta as { skills?: unknown } | undefined)?.skills;
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  })();
  const draftSourceUrl = (() => {
    const v = (artifact.meta as { source_url?: unknown } | undefined)?.source_url;
    return typeof v === "string" && /^https?:\/\//i.test(v) ? v : null;
  })();
  const draftLeadMagnet = artifactLeadMagnet(artifact);
  const draftLeadMagnetHref = leadMagnetHref?.(draftLeadMagnet) ?? null;
  const mediaAttachments = artifactMediaAttachments(artifact);
  const generatedImageStatus = generatedLeadMagnetImageStatus(artifact);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      markCopied();
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  };

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
          // Send kind ONLY for a hook (an explicit non-post type). For a rendered
          // 'post', omit it so the server auto-classifies regular vs lead-magnet
          // from the body — a lead magnet written in Cowork gets tagged for free.
          ...(artifact.kind === "hook" ? { kind: "hook" as const } : {}),
          ...(artifact.meta ? { meta: artifact.meta } : {}),
          ...(mediaAttachments.length ? { media_attachments: mediaAttachments } : {}),
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save");
      if (data.artifact?.id) {
        setBoardDraftId(data.artifact.id);
        onMetaChange?.({ board_draft_id: data.artifact.id });
      }
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

  const ensureSchedulableDraft = async (): Promise<string> => {
    if (canUpdateOriginal) {
      if (!refiningDraftId) throw new Error("Couldn't find the original post.");
      if (dirty) {
        const res = await fetch(`/api/drafts/${refiningDraftId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to update post");
        setSaved(true);
        onBodyChange?.(body);
        router.refresh();
      }
      return refiningDraftId;
    }

    if (boardDraftId) {
      if (dirty) {
        const res = await fetch(`/api/drafts/${boardDraftId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to update draft");
        onBodyChange?.(body);
        setSaved(true);
      }
      return boardDraftId;
    }

    if (!chatId) throw new Error("Save the chat before scheduling this draft.");
    const res = await fetch(`/api/chats/${chatId}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: artifact.title,
        body,
        ...(artifact.kind === "hook" ? { kind: "hook" as const } : {}),
        ...(artifact.meta ? { meta: artifact.meta } : {}),
        ...(mediaAttachments.length ? { media_attachments: mediaAttachments } : {}),
      }),
    });
    const data = await res.json();
    if (!data.ok || !data.artifact?.id) {
      throw new Error(data.error || "Failed to save draft before scheduling");
    }
    setBoardDraftId(data.artifact.id);
    setSaved(true);
    onMetaChange?.({ board_draft_id: data.artifact.id });
    router.refresh();
    return data.artifact.id;
  };

  const scheduleDraft = async () => {
    const iso = localInputToIso(scheduleWhen);
    const planToPostOn = localDateFromDatetimeInput(scheduleWhen);
    if (!iso || !planToPostOn) {
      toast.error("Pick a date and time.");
      return;
    }
    setScheduling(true);
    try {
      const draftId = await ensureSchedulableDraft();
      const res = await fetch(`/api/drafts/${draftId}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduledAt: iso,
          planToPostOn,
          firstComment: firstComment.trim() || null,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Couldn't schedule.");
      const next = {
        board_draft_id: draftId,
        scheduled_at: data.scheduledAt ?? iso,
        schedule_status: "scheduled",
        first_comment: data.firstComment ?? null,
        plan_to_post_on: data.planToPostOn ?? planToPostOn,
      };
      setBoardDraftId(draftId);
      setScheduledAt(next.scheduled_at);
      setScheduleStatus("scheduled");
      setFirstComment(next.first_comment ?? "");
      setScheduleWhen(isoToLocalInput(next.scheduled_at));
      onMetaChange?.(next);
      router.refresh();
      toast.success("Scheduled to publish on LinkedIn.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScheduling(false);
    }
  };

  const unscheduleDraft = async () => {
    const draftId = boardDraftId;
    if (!draftId) return;
    setScheduling(true);
    try {
      const res = await fetch(`/api/drafts/${draftId}/schedule`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Couldn't unschedule.");
      setScheduledAt(null);
      setScheduleStatus(null);
      setFirstComment("");
      setScheduleWhen("");
      onMetaChange?.({
        scheduled_at: null,
        schedule_status: null,
        first_comment: null,
      });
      router.refresh();
      toast.success("Unscheduled.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScheduling(false);
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
    // Bounded card: header pinned at top, action bar pinned at bottom, and the
    // POST BODY is the only scrolling region. Without this, a long post pushed
    // the Copy/Save bar off-screen and there was no way to scroll to it. Cap the
    // card at most of the panel height so it never grows unbounded.
    // NOTE: no `flex flex-col` + `max-h-...` here — that combo collapses the
    // ScrollableBody's `flex-1 min-h-0` to zero when the parent scroll panel is
    // content-sized (which the drafts panel IS). Symptom: only the "Draft N"
    // chip and the LinkedIn-style header would render; the body + action bar
    // sat at zero height below and the card looked mysteriously empty. Just
    // let the card size to its content — the outer drafts panel is already
    // `overflow-y-scroll` so a tall card scrolls with the panel, not itself.
    <div className="rounded-[1.15rem] border border-border bg-white text-foreground shadow-[0_16px_45px_rgba(28,28,26,0.10)]">
      {/* "Draft N" badge + applied-skill chip(s). Skills come from the server
          stamping meta.skills onto the artifact when one was active for the
          turn that produced it (see route's artifact case). Renders even when
          there's no draft label, so a single-draft turn still shows /name. */}
      {(label || draftSkills.length > 0 || draftLeadMagnet || draftSourceUrl) && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 pb-0.5 shrink-0">
          {label && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {label}
            </span>
          )}
          {/* Source-post chip sits directly to the RIGHT of the "Draft" chip so
              the inspiration is always adjacent to the draft label, instead of
              trailing after the skill/lead-magnet chips (where flex-wrap could
              push it to a new line, away from Draft). */}
          {draftSourceUrl && (
            <a
              href={draftSourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border bg-white px-2.5 py-0.5 text-[10px] font-semibold text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
              title="Open the original swipe-file post this draft modeled."
            >
              <FileText className="h-2.5 w-2.5" aria-hidden />
              Source post
              <ExternalLink className="h-2.5 w-2.5" aria-hidden />
            </a>
          )}
          {draftSkills.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-full border border-amber-300/60 bg-amber-50 px-2.5 py-0.5 text-[10px] font-semibold text-amber-900"
              title={`Produced with custom skill /${name}`}
            >
              <Zap className="h-2.5 w-2.5" aria-hidden />
              /{name}
            </span>
          ))}
          {draftLeadMagnet &&
            (draftLeadMagnetHref ? (
              <a
                href={draftLeadMagnetHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-rose-300/60 bg-rose-50 px-2.5 py-0.5 text-[10px] font-semibold text-primary transition-colors hover:border-primary/40 hover:bg-rose-100"
                title={`Open lead magnet resource: ${draftLeadMagnet.title}`}
              >
                <Gift className="h-2.5 w-2.5" aria-hidden />
                <span className="max-w-[180px] truncate">
                  Giveaway: {draftLeadMagnet.title}
                </span>
                <ExternalLink className="h-2.5 w-2.5" aria-hidden />
              </a>
            ) : (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-rose-300/60 bg-rose-50 px-2.5 py-0.5 text-[10px] font-semibold text-primary"
                title={`Giveaway deliverable: ${draftLeadMagnet.title}`}
              >
                <Gift className="h-2.5 w-2.5" aria-hidden />
                <span className="max-w-[180px] truncate">
                  Giveaway: {draftLeadMagnet.title}
                </span>
              </span>
            ))}
        </div>
      )}
      {/* LinkedIn-style post header (fixed) */}
      <div className="flex items-center gap-2.5 px-3.5 pt-3.5 shrink-0">
        <AvatarImg
          src={author.avatarUrl}
          className="h-10 w-10 rounded-xl object-cover shrink-0"
          fallback={
            // Initials placeholder when the avatar is absent OR the LinkedIn CDN
            // URL has expired (handled inside AvatarImg's onError).
            <div className="h-10 w-10 rounded-xl bg-muted text-muted-foreground flex items-center justify-center text-sm font-semibold shrink-0">
              {initials || "in"}
            </div>
          }
        />
        <div className="min-w-0 leading-tight flex-1">
          <p className="text-[13px] font-semibold truncate">{author.name}</p>
          {author.headline && (
            <p
              className="text-[11px] text-muted-foreground truncate"
              title={author.headline}
            >
              {truncateHeadline(author.headline)}
            </p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {/* Delete this draft from the chat. Confirmed; hidden when no handler.
              Also hidden on batch drafts awaiting review — the header delete
              only removes from chat_messages.artifacts jsonb, NOT from
              chat_artifacts, so a batch draft would end up half-deleted
              (invisible in Cowork but still pending_review in the DB). Reject
              is the correct discard flow for a batch draft: it moves the
              chat_artifacts row to 'rejected' AND preserves the source-post
              dedup signal so next week's batch skips the same source. */}
          {onDelete && !editing && !onApproveBatchReview && (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm("Delete this draft from the chat? This can't be undone.")
                ) {
                  onDelete();
                }
              }}
              className="inline-flex items-center rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors"
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
            onClick={async () => {
              // Clicking "Done" while editing: if the body changed, PATCH the
              // artifact so the edit survives a reload. Two failure modes the
              // PR #418 fix didn't cover and this round addresses:
              //  (a) Streaming race — user clicks Done before the agent's
              //      assistant row has been inserted. The PATCH then iterates
              //      0 matching rows and used to silently return ok:true,
              //      so the client thought it saved when it hadn't. Server
              //      now returns 404; we retry with backoff up to ~3s, which
              //      covers a normal turn finishing.
              //  (b) Even on success, the parent's artifactsByChat still has
              //      the pre-edit body — a later parent re-render would seed
              //      the body back. onBodyChange tells the parent to reflect
              //      the saved body in its cache.
              if (editing && dirty && chatId) {
                const payload = JSON.stringify({
                  targetId: artifact.id,
                  body,
                  title: artifact.title,
                  ...(artifact.meta ? { meta: artifact.meta } : {}),
                });
                const trySave = async (): Promise<boolean> => {
                  const res = await fetch(`/api/chats/${chatId}/artifacts`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: payload,
                  });
                  if (res.ok) {
                    const data = await res.json();
                    if (data?.ok && data?.updated) return true;
                  }
                  return false;
                };
                try {
                  // Up to ~3.5s of retries with backoff (300ms / 700ms / 1500ms
                  // / 1000ms). Covers a typical turn that's still mid-stream
                  // when the user clicks Done.
                  let ok = await trySave();
                  for (const delay of [300, 700, 1500, 1000]) {
                    if (ok) break;
                    await new Promise((r) => setTimeout(r, delay));
                    ok = await trySave();
                  }
                  if (!ok) {
                    throw new Error(
                      "Couldn't save the edit — try Done again in a moment.",
                    );
                  }
                  // Tell the parent so artifactsByChat reflects the saved body.
                  onBodyChange?.(body);
                } catch (e) {
                  toast.error((e as Error).message);
                  // Leave editing mode OPEN on failure so the user doesn't
                  // think the save succeeded — they can click Done to retry.
                  return;
                }
              }
              setEditing((e) => !e);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
              editing
                ? "bg-foreground text-white hover:bg-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
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
        <div className="px-3 py-2.5">
          <DraftEditor value={body} onChange={setBody} />
        </div>
      ) : (
        // wrapperClassName override: the card is content-sized (no fixed
        // parent height), so the default `flex-1 min-h-0` would collapse the
        // body to zero. `max-h-[60vh]` grows with content up to a sane cap —
        // a truly long post still gets an internal scroll region, everything
        // else just renders in full.
        <ScrollableBody
          contentKey={`${body}:${mediaAttachments.map((m) => m.id).join(",")}`}
          wrapperClassName="max-h-[60vh]"
        >
          <DraftMediaPreview
            attachments={mediaAttachments}
            generatedImageStatus={generatedImageStatus}
          />
          {renderRichText(body)}
        </ScrollableBody>
      )}

      <CoworkDraftFeedback
        key={artifact.id}
        artifact={artifact}
        chatId={chatId}
        body={body}
        draftId={boardDraftId}
      />

      <div className="border-t border-border shrink-0" />

      {/* Actions (fixed at the bottom — always reachable). flex-wrap so the bar
          never overflows the card: when Copy / Save / Save-as-new / Refine don't
          fit the panel width (e.g. when "Save as new" is present), they wrap to a
          second line instead of clipping off the right edge. */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 bg-card shrink-0">
        {/* Batch review: a weekly-batch draft awaiting user validation gets
            Approve / Reject buttons AT THE FRONT of the action bar. Approve
            moves it to Ready on the /posts board; reject flips it to
            'rejected' (off-board but keeps the dedup signal so next week's
            batch skips the same source). Once acted on, a small pill replaces
            the buttons so the user sees what they did without the card
            vanishing. */}
        {onApproveBatchReview && onRejectBatchReview && !batchReviewOutcome && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8 rounded-full border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
              onClick={onApproveBatchReview}
              title="Approve this batch draft and send it to Ready on the Posts board"
            >
              <Check className="h-3.5 w-3.5" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8 rounded-full border-border text-muted-foreground hover:text-foreground"
              onClick={onRejectBatchReview}
              title="Reject this batch draft (kept off the board; the source won't be re-served next week)"
            >
              <X className="h-3.5 w-3.5" />
              Reject
            </Button>
          </>
        )}
        {batchReviewOutcome === "approved" && (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-700">
            <Check className="h-3.5 w-3.5" />
            Approved · on the Ready column
          </span>
        )}
        {batchReviewOutcome === "rejected" && (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-muted px-3 text-xs font-medium text-muted-foreground">
            <X className="h-3.5 w-3.5" />
            Rejected
          </span>
        )}
        {!canUpdateOriginal && !onApproveBatchReview && (
          <p className="basis-full px-1 text-[11px] font-medium text-muted-foreground">
            Save adds this draft to your Posts board, ready to schedule.
          </p>
        )}
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 rounded-full border-border"
          onClick={copy}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
        {/* Save is HIDDEN on a batch draft awaiting review: the draft is
            already in chat_artifacts as pending_review, so Approve IS save
            (moves to Ready). Clicking Save would POST /api/chats/[id]/
            artifacts and create a DUPLICATE row. Delete stays available
            below so the user can still discard mid-review; Approve/Reject
            at the front of the bar are the primary path. */}
        {!onApproveBatchReview && (
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 rounded-full border-border"
          onClick={save}
          // Re-enable once the draft has been edited since the last save, so an
          // edited-then-saved draft can be saved again after further edits.
          disabled={saving || (saved && !dirty) || !chatId}
          title={
            canUpdateOriginal
              ? "Overwrite the post on your board with this version"
              : "Save this draft to your Posts board"
          }
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : saved && !dirty ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
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
        )}
        {/* When updating the original post is the primary action, offer a
            secondary "Save as new" so the user can still branch off a copy. */}
        {canUpdateOriginal && (
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5 h-8 rounded-full text-muted-foreground"
            onClick={saveAsNew}
            disabled={saving || !chatId}
            title="Keep the original and save this as a separate new draft"
          >
            <FileText className="h-3.5 w-3.5" />
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
          className="gap-1.5 h-8 rounded-full border-border"
          onClick={() => {
            setRefineOpen((v) => !v);
            setScheduleOpen(false);
          }}
          disabled={refineDisabled}
          title={
            refineDisabled
              ? "Wait for the current draft to finish before refining again"
              : undefined
          }
        >
          <PenLine className="h-3.5 w-3.5" />
          {refineDisabled ? "Refining…" : "Refine"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 rounded-full border-border"
          onClick={() => {
            setScheduleOpen((v) => !v);
            setRefineOpen(false);
          }}
          disabled={scheduling || artifact.kind === "hook"}
          title={
            artifact.kind === "hook"
              ? "Hooks need to become full posts before scheduling"
              : "Schedule this draft to publish on LinkedIn"
          }
        >
          {scheduling ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CalendarClock className="h-3.5 w-3.5" />
          )}
          {scheduleStatus === "scheduled" && scheduledAt ? "Scheduled" : "Schedule"}
        </Button>
      </div>

      {scheduleOpen && artifact.kind !== "hook" && (
        <div className="flex flex-col gap-2 border-t border-border bg-card px-3 pb-2.5 pt-2.5 shrink-0">
          {scheduleStatus === "scheduled" && scheduledAt ? (
            <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/[0.04] px-3 py-2 text-xs">
              <CalendarClock className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 text-foreground">
                Scheduled for{" "}
                <span className="font-medium text-foreground">
                  {new Date(scheduledAt).toLocaleString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-full px-2 text-xs"
                onClick={unscheduleDraft}
                disabled={scheduling}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <>
              <p className="text-xs leading-snug text-muted-foreground">
                Saves this draft to Posts if needed, then creates the real LinkedIn
                publishing schedule.
              </p>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  type="datetime-local"
                  value={scheduleWhen}
                  onChange={(e) => setScheduleWhen(e.target.value)}
                  className="h-9 min-w-0 rounded-full border border-border bg-white px-3 text-xs text-foreground outline-none focus:border-primary"
                  aria-label="Publish date and time"
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-9 rounded-full gap-1.5"
                  onClick={scheduleDraft}
                  disabled={scheduling || !scheduleWhen || body.length > 3000}
                >
                  {scheduling ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CalendarClock className="h-3.5 w-3.5" />
                  )}
                  Schedule
                </Button>
              </div>
              <input
                type="text"
                value={firstComment}
                onChange={(e) => setFirstComment(e.target.value)}
                placeholder="First comment (optional)"
                className="h-9 rounded-full border border-border bg-white px-3 text-xs text-foreground outline-none focus:border-primary"
                aria-label="First comment"
              />
              <div
                className={cn(
                  "text-[11px]",
                  body.length > 3000 ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {body.length}/3000
                {body.length > 3000 && ` — trim ${body.length - 3000} characters first`}
              </div>
            </>
          )}
        </div>
      )}

      {/* Refine quick actions — one-tap chips + a free-text instruction. Hidden
          while a stream is in flight so the panel can't be used mid-turn. */}
      {refineOpen && !refineDisabled && (
        <div className="flex flex-col gap-2 px-3 pb-2.5 bg-card shrink-0">
          <div className="flex flex-wrap gap-1.5">
            {refineSuggestions(artifact.kind).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  onRefine(s);
                  setRefineOpen(false);
                }}
                className="rounded-full border border-border bg-white px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted"
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
              className="flex-1 rounded-full border border-border bg-white px-3 py-1.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-primary/15"
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

function mediaPreviewUrl(attachment: PostMediaAttachment): string | null {
  if (attachment.previewUrl) return attachment.previewUrl;
  if (attachment.source === "library" && attachment.assetId) {
    return `/api/media-assets/${attachment.assetId}/preview`;
  }
  return attachment.url ?? null;
}

function DraftMediaPreview({
  attachments,
  generatedImageStatus,
}: {
  attachments: PostMediaAttachment[];
  generatedImageStatus: { status: string; reason?: string } | null;
}) {
  const images = attachments.filter((a) => a.type === "image");
  if (images.length === 0) {
    if (generatedImageStatus?.status === "queued" || generatedImageStatus?.status === "running") {
      return (
        <div className="mb-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] leading-snug text-primary">
          Adapting the source image. The draft text is ready.
        </div>
      );
    }
    if (generatedImageStatus?.status === "failed") {
      const reason = userFacingImageFailureReason(generatedImageStatus.reason);
      return (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-900">
          Image could not be generated{reason ? `: ${reason}` : ""}. The draft text is still ready.
        </div>
      );
    }
    if (generatedImageStatus?.status === "save_failed") {
      const reason = userFacingImageFailureReason(generatedImageStatus.reason);
      return (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-900">
          Image was generated but could not be saved{reason ? `: ${reason}` : ""}. The draft text is still ready.
        </div>
      );
    }
    if (generatedImageStatus?.status === "skipped") {
      const reason = userFacingImageFailureReason(generatedImageStatus.reason);
      return (
        <div className="mb-3 rounded-xl border border-border bg-muted px-3 py-2 text-[11px] leading-snug text-foreground">
          No adapted image{reason ? `: ${reason}` : ""}. The draft text is still ready.
        </div>
      );
    }
    return null;
  }

  return (
    <div className="mb-3 space-y-2">
      <div className="overflow-hidden rounded-xl border border-border bg-muted">
        {images.map((attachment) => {
          const src = mediaPreviewUrl(attachment);
          return src ? (
            // eslint-disable-next-line @next/next/no-img-element -- Signed media preview URLs are dynamic API routes, so next/image cannot optimize them reliably here.
            <img
              key={attachment.id}
              src={src}
              alt={attachment.name}
              className="max-h-72 w-full object-contain bg-foreground"
              loading="lazy"
            />
          ) : null;
        })}
      </div>
      {generatedImageStatus?.status === "ready" && (
        <div className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[10px] font-medium text-primary">
          <ImageIcon className="h-3 w-3" aria-hidden />
          Image adapted from source post
        </div>
      )}
    </div>
  );
}

function userFacingImageFailureReason(reason: string | undefined): string | null {
  if (!reason) return null;
  if (/Source image could not be fetched/i.test(reason)) {
    const status = reason.match(/\((\d{3})\)/)?.[1];
    return status
      ? `the source image could not be fetched (${status})`
      : "the source image could not be fetched";
  }
  if (/not a supported image|unsupported image/i.test(reason)) {
    return "the source media was not a supported image";
  }
  if (/GIF sources/i.test(reason)) {
    return "GIF sources are not supported yet";
  }
  if (/too large/i.test(reason)) {
    return "the source image was too large";
  }
  if (/monthly credits|used up|budget/i.test(reason)) {
    return "monthly credits are used up";
  }
  if (/uses video/i.test(reason)) {
    return "the source post uses video, so image adaptation was skipped";
  }
  if (/document carousel/i.test(reason)) {
    return "the source post uses a document carousel, so image adaptation was skipped";
  }
  if (/uses a GIF/i.test(reason)) {
    return "the source post uses a GIF, so image adaptation was skipped";
  }
  if (/no eligible image|not fetchable|No source post image/i.test(reason)) {
    return "no eligible source image was available";
  }
  if (/OpenRouter/i.test(reason)) {
    return "the image model failed";
  }
  return reason.slice(0, 140);
}

const FEEDBACK_REASON_LIMIT = 4;

function CoworkDraftFeedback({
  artifact,
  chatId,
  body,
  draftId,
}: {
  artifact: Artifact;
  chatId: string | null;
  body: string;
  draftId: string | null;
}) {
  const [rating, setRating] = useState<ContentFeedbackRating | null>(null);
  const [selected, setSelected] = useState<ContentFeedbackReason[]>([]);
  const [phrase, setPhrase] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<ContentFeedbackRating | null>(null);

  const reasons =
    rating === "up"
      ? POSITIVE_FEEDBACK_REASONS
      : rating === "down"
        ? NEGATIVE_FEEDBACK_REASONS
        : [];
  const phraseSelected = selected.includes("Don't use this phrase");

  const chooseRating = (next: ContentFeedbackRating) => {
    setRating((current) => {
      const changed = current !== next;
      if (changed) {
        setSelected([]);
        setPhrase("");
        setSaved(null);
      }
      return changed ? next : null;
    });
  };

  const toggleReason = (reason: ContentFeedbackReason) => {
    setSelected((current) => {
      if (current.includes(reason)) return current.filter((r) => r !== reason);
      if (current.length >= FEEDBACK_REASON_LIMIT) {
        toast.error(`Pick up to ${FEEDBACK_REASON_LIMIT} feedback chips.`);
        return current;
      }
      return [...current, reason];
    });
  };

  const save = async () => {
    if (!rating || saving) return;
    const snapshot = body.trim();
    if (!snapshot) {
      toast.error("There is no draft text to save feedback for.");
      return;
    }
    if (selected.length === 0) {
      toast.error("Pick at least one feedback chip.");
      return;
    }
    if (phraseSelected && !phrase.trim()) {
      toast.error("Add the phrase Cowork should avoid.");
      return;
    }
    setSaving(true);
    try {
      if (phraseSelected) {
        const prefRes = await fetch("/api/preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rule: `Never say "${phrase.trim()}"` }),
        });
        const prefData = await prefRes.json().catch(() => ({}));
        if (!prefRes.ok && prefData?.error !== "You already have that preference.") {
          throw new Error(prefData?.error || "Couldn't save memory rule.");
        }
      }

      const res = await fetch("/api/content-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating,
          reasons: selected,
          bodySnapshot: snapshot,
          artifactId: artifact.id,
          ...(chatId ? { chatId } : {}),
          ...(draftId ? { draftId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Couldn't save feedback.");

      setSaved(rating);
      setRating(null);
      setSelected([]);
      setPhrase("");
      toast.success(phraseSelected ? "Saved to memory" : "Saved feedback");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-border bg-card px-3 py-2.5 shrink-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-8 rounded-full gap-1.5 border transition-colors",
              rating === "up"
                ? "border-emerald-500/55 bg-emerald-50 text-emerald-800 ring-2 ring-emerald-500/15 hover:bg-emerald-100"
                : "border-emerald-200 bg-emerald-50/75 text-emerald-800 hover:border-emerald-300 hover:bg-emerald-100/80",
            )}
            onClick={() => chooseRating("up")}
            aria-pressed={rating === "up"}
            disabled={saving}
            title="Save positive feedback for future drafts"
          >
            <ThumbsUp className="h-3.5 w-3.5" />
            Good
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-8 rounded-full gap-1.5 border transition-colors",
              rating === "down"
                ? "border-red-500/55 bg-red-50 text-red-800 ring-2 ring-red-500/15 hover:bg-red-100"
                : "border-red-200 bg-red-50/75 text-red-800 hover:border-red-300 hover:bg-red-100/80",
            )}
            onClick={() => chooseRating("down")}
            aria-pressed={rating === "down"}
            disabled={saving}
            title="Save negative feedback for future drafts"
          >
            <ThumbsDown className="h-3.5 w-3.5" />
            Needs work
          </Button>
          <span
            className="ml-1 inline-flex items-center gap-1 rounded-full border border-border bg-background/70 px-2 py-1 text-[11px] font-medium text-muted-foreground"
            title="Good/Needs work saves feedback to Cowork's memory for future drafts. It will not change this draft."
          >
            <Brain className="h-3 w-3" aria-hidden />
            Feedback trains memory
          </span>
        </div>
        {saved && !rating && (
          <span className="text-[11px] text-muted-foreground">
            Saved {saved === "up" ? "positive" : "negative"} feedback
          </span>
        )}
      </div>

      {rating && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {reasons.map((reason) => {
              const on = selected.includes(reason);
              return (
                <button
                  key={reason}
                  type="button"
                  onClick={() => toggleReason(reason)}
                  aria-pressed={on}
                  disabled={saving}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    on
                      ? "border-primary/40 bg-primary/[0.08] text-primary"
                      : "border-border bg-white text-foreground hover:bg-muted",
                  )}
                >
                  {reason}
                </button>
              );
            })}
          </div>

          {phraseSelected && (
            <input
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="Phrase Cowork should never say..."
              className="h-8 rounded-full border border-border bg-white px-3 text-xs text-foreground outline-none focus:ring-2 focus:ring-primary/15"
              disabled={saving}
            />
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {selected.length}/{FEEDBACK_REASON_LIMIT} selected
            </span>
            <Button
              type="button"
              size="sm"
              className="h-8 rounded-full"
              onClick={save}
              disabled={saving || selected.length === 0}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save feedback
            </Button>
          </div>
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

function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function scheduleMetaFromArtifact(artifact: Artifact): ArtifactScheduleMeta {
  const meta = artifact.meta ?? {};
  const stringOrNull = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  return {
    boardDraftId: stringOrNull(meta.board_draft_id),
    scheduledAt: stringOrNull(meta.scheduled_at),
    scheduleStatus: stringOrNull(meta.schedule_status),
    firstComment: stringOrNull(meta.first_comment),
    planToPostOn: stringOrNull(meta.plan_to_post_on),
  };
}

// Starter prompts shown on an empty chat. Each maps to a real tool path the
// agent can actually execute, so a click leads somewhere useful rather than a
// dead end. Prompts with a [placeholder] expect the user to fill a detail —
// prefillPrompt selects that span on click.
type Starter = { icon: LucideIcon; label: string; prompt: string };

const STARTERS: Starter[] = [
  {
    icon: Lightbulb,
    label: "Brainstorm new post ideas",
    prompt:
      "Give me 5 post ideas based on what's been going viral across my tracked accounts over the last 30 days. Pull from ALL niches — don't ask me which niche, and don't limit it to mine. Adapt every idea to my voice and my niche. For each, give a one-line angle and the hook style it would use.",
  },
  {
    icon: Flame,
    label: "Model a top viral post",
    prompt:
      "Find a top-performing regular post in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original.",
  },
  {
    icon: Gift,
    label: "Model a recent viral lead magnet",
    prompt:
      "Find the most recent high-performing lead-magnet post in my swipe file and adapt it into a lead-magnet post in my voice, using my lead-magnet style.",
  },
  {
    icon: TrendingUp,
    label: "What's working this week",
    prompt:
      "Show me the top posts from THIS WEEK (the last 7 days of the most recent scrape) and tell me what hook patterns and formats are working right now.",
  },
  {
    icon: PenLine,
    label: "Write an original post",
    prompt:
      "Write an original post in my voice about [topic]. Ground it in what's resonating in my niche right now.",
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

// Readiness snapshot from GET /api/batch/weekly/status (fetched once on mount).
type BatchReadiness = {
  available: number;
  cooldown: { onCooldown: false } | { onCooldown: true; retryAtIso: string };
};

// The live run row (subset) the card polls while a batch generates.
type HomeBatchRun = {
  status: "pending" | "running" | "done" | "failed";
  stage: string | null;
  total: number;
  created: number;
  error: string | null;
};

// One worker lane — a batch_draft_slots row. Each is an agent adapting one
// source post into the user's voice; the board renders these live.
type BatchSlot = {
  slot_index: number;
  source_first_line: string | null;
  source_url: string | null;
  is_lead_magnet: boolean;
  skill_label: string | null;
  status: "queued" | "drafting" | "filed" | "skipped" | "failed";
  draft_title: string | null;
  error: string | null;
};

// Whole days from now until an ISO instant (min 1, so "unlocks tomorrow" never
// reads as "in 0 days"). Used for the cooldown copy.
function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

const HOME_BATCH_POLL_MS = 2500;
const CHAT_BATCH_RUNNING_POLL_MS = 2000;
const CHAT_BATCH_QUEUED_POLL_MS = 6000;
const CHAT_BATCH_HIDDEN_POLL_MS = 8000;
const IMAGE_ARTIFACT_POLL_MS = 5000;

// Icon + tint for a worker lane's status.
function slotVisual(status: BatchSlot["status"]) {
  switch (status) {
    case "filed":
      return { icon: CheckCircle2, cls: "text-primary", ring: "border-primary/40 bg-primary/[0.06]" };
    case "drafting":
      return { icon: Loader2, cls: "text-primary animate-spin", ring: "border-primary/40 bg-primary/[0.04]" };
    case "skipped":
    case "failed":
      return { icon: Circle, cls: "text-muted-foreground/50", ring: "border-border/60 bg-muted/30" };
    default:
      return { icon: Circle, cls: "text-muted-foreground/40", ring: "border-border/60 bg-background" };
  }
}

const SLOT_STATUS_HELP: Record<BatchSlot["status"], string> = {
  queued: "Queued: this writer is waiting to start.",
  drafting: "Writing: this writer is adapting the source post now.",
  filed: "Written: the draft is ready for review.",
  skipped: "Couldn't adapt: the source was not usable this time.",
  failed: "Couldn't adapt: this writer hit an error.",
};

function slotStatusHelp(slot: BatchSlot): string {
  if ((slot.status === "skipped" || slot.status === "failed") && slot.error) {
    return `Couldn't adapt: ${slot.error}`;
  }
  return SLOT_STATUS_HELP[slot.status];
}

function postTypeHelp(isLeadMagnet: boolean): string {
  return isLeadMagnet
    ? "Lead Magnet Post: designed to drive replies, signups, or interest."
    : "Regular Post: a standard thought-leadership or engagement post.";
}

// One worker lane: the source it grabbed, the voice/skill chip, and its live
// status — advancing to the finished draft's title. A "team member" you watch.
function WorkerLane({ slot }: { slot: BatchSlot }) {
  const v = slotVisual(slot.status);
  const Icon = v.icon;
  const help = slotStatusHelp(slot);
  const title =
    slot.status === "filed" && slot.draft_title
      ? slot.draft_title
      : slot.status === "skipped" || slot.status === "failed"
        ? "Couldn't adapt this one"
        : slot.source_first_line || "A top post";
  const sub =
    slot.status === "filed"
      ? "Written · ready to review"
      : slot.status === "drafting"
        ? "Writing…"
        : slot.status === "queued"
          ? "Queued"
          : slot.error || "Skipped";
  return (
    <div
      className={cn("flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors", v.ring)}
      title={help}
    >
      <Icon className={cn("h-4 w-4 shrink-0", v.cls)} aria-label={help} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{title}</div>
        <div className="truncate text-[11px] text-muted-foreground" title={help}>
          {sub}
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
          slot.is_lead_magnet
            ? "bg-amber-500/15 text-amber-700"
            : "bg-primary/10 text-primary",
        )}
        title={postTypeHelp(slot.is_lead_magnet)}
      >
        {slot.skill_label || (slot.is_lead_magnet ? "Lead Magnet Post" : "Regular Post")}
      </span>
    </div>
  );
}

// The "Generate this week's batch" card on the chat home — and, once you fire it,
// a live AGENT WORKERS BOARD. Instead of a fake progress bar, you watch a team of
// writers: each lane grabs one of this week's top posts, shows which voice/skill
// it's applying, and advances queued → writing → filed as it produces a real
// draft (the finished title appears in-lane). Skipped sources show honestly.
//
// It fires the same real pipeline as the board button (POST /api/batch/weekly)
// and polls the per-worker slots — one behavior, no drift. Reacts to readiness +
// cooldown before a run, and resumes the live board if you land here mid-batch.
function HomeBatchCard({ featured = false }: { featured?: boolean }) {
  const router = useRouter();
  const [ready, setReady] = useState<BatchReadiness | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [run, setRun] = useState<HomeBatchRun | null>(null);
  const [slots, setSlots] = useState<BatchSlot[]>([]);
  // A PERSISTENT start error (cost cap / transient) shown inline on the card —
  // NOT a toast, because "why your primary action didn't run" is the one message
  // the user most needs to still be able to read a few seconds later. A cooldown
  // rejection is handled separately (it flips the card to the cooldown panel).
  const [startError, setStartError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const batchIdRef = useRef<string | null>(null);
  const refreshedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Poll BOTH the run rollup (for status/stage) and the worker lanes (slots).
  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const runRes = await fetch("/api/batch/weekly", { cache: "no-store" });
      const runData = (await runRes.json().catch(() => ({}))) as {
        ok?: boolean;
        run?: (HomeBatchRun & { id?: string }) | null;
      };
      if (runData?.ok) {
        const r = runData.run ?? null;
        setRun(r);
        const id = r?.id ?? batchIdRef.current;
        if (id) {
          batchIdRef.current = id;
          const slotRes = await fetch(
            `/api/batch/weekly/slots?batchId=${encodeURIComponent(id)}`,
            { cache: "no-store" },
          );
          const slotData = (await slotRes.json().catch(() => ({}))) as {
            ok?: boolean;
            slots?: BatchSlot[];
          };
          if (slotData?.ok && slotData.slots) setSlots(slotData.slots);
        }
        if (r && (r.status === "done" || r.status === "failed")) {
          stopPolling();
          if (!refreshedRef.current) {
            refreshedRef.current = true;
            if (r.status === "done" && r.created > 0) router.refresh();
          }
        }
      }
    } catch {
      /* transient — next tick retries */
    }
  }, [router, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(poll, HOME_BATCH_POLL_MS);
  }, [poll, stopPolling]);

  // On mount: readiness snapshot AND resume any in-flight run (rebuild the live
  // board if the user landed here mid-batch). One call returns both.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/batch/weekly/status", { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          readiness?: BatchReadiness;
          run?: (HomeBatchRun & { id?: string }) | null;
        };
        if (cancelled || !data?.ok) return;
        if (data.readiness) setReady(data.readiness);
        if (data.run && (data.run.status === "pending" || data.run.status === "running")) {
          setRun(data.run);
          if (data.run.id) {
            batchIdRef.current = data.run.id;
          }
          startPolling();
          void poll();
        }
      } catch {
        /* leave ready null → default copy */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [startPolling, stopPolling, poll]);

  const onCooldown = ready?.cooldown.onCooldown === true ? ready.cooldown : null;
  const active = run?.status === "pending" || run?.status === "running";
  const done = run?.status === "done";
  const filedCount = slots.filter((s) => s.status === "filed").length;
  const previewCount = ready
    ? Math.max(Math.min(ready.available, WEEKLY_BATCH_DRAFT_COUNT), 0)
    : WEEKLY_BATCH_DRAFT_COUNT;

  const fire = async () => {
    if (starting || active || onCooldown) return;
    setStarting(true);
    setStartError(null);
    refreshedRef.current = false;
    const { startWeeklyBatch } = await import("@/lib/batch/client");
    const result = await startWeeklyBatch();
    if (!result.ok) {
      // Cooldown → flip the card to the persistent cooldown panel (with the
      // unlock time) instead of a toast that vanishes. This is the fix for the
      // "I click Generate and nothing happens" bug: the readiness snapshot was
      // fetched at mount and went stale after a run, so a second click 429'd
      // silently. Now the rejection itself updates the card.
      if (result.reason === "cooldown" && result.retryAt) {
        setReady((r) =>
          r
            ? { ...r, cooldown: { onCooldown: true, retryAtIso: result.retryAt! } }
            : { available: 0, cooldown: { onCooldown: true, retryAtIso: result.retryAt! } },
        );
      } else {
        // Cost cap / transient → a PERSISTENT inline banner, not a flash.
        setStartError(result.message);
      }
      setStarting(false);
      return;
    }
    // The batch runs AS a Cowork chat — open it so the drafts stream into the
    // transcript. (We're already in the chat workspace; navigating with ?chat
    // switches the active chat to the fresh batch session.)
    if (result.chatId) {
      setStarting(false);
      toast.success("Queued your weekly batch", {
        description: "We'll start as soon as capacity opens.",
      });
      router.push(`/dashboard?chat=${result.chatId}`);
      return;
    }
    // No chat (rare) → keep the inline live view as a fallback.
    if (result.runId) {
      batchIdRef.current = result.runId;
    }
    setRun({
      status: "pending",
      stage: "Queued. We'll start as soon as capacity opens.",
      total: 0,
      created: 0,
      error: null,
    });
    setStarting(false);
    startPolling();
    void poll();
  };

  // ---- Cooldown: calm muted panel, no active button. ----
  if (onCooldown && !run) {
    const days = daysUntil(onCooldown.retryAtIso);
    return (
      <div className="col-span-full w-full rounded-2xl border border-border/60 bg-muted/40 p-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Clock className="h-4 w-4" />
          </div>
          <div className="flex-1 text-left">
            <div className="text-sm font-medium">This week&apos;s batch is done</div>
            <div className="text-xs text-muted-foreground">
              Your next batch unlocks in {days} day{days === 1 ? "" : "s"}. Your
              drafts are waiting on your board.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              router.push("/dashboard/posts");
            }}
            title="Open the Posts board."
            className="shrink-0 rounded-lg border border-border/70 bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent/60 transition-colors"
          >
            View board
          </button>
        </div>
      </div>
    );
  }

  const noSources = loaded && ready !== null && ready.available === 0 && !run;
  // A run only earns the full-height worker board once it's actually going.
  const showBoard = !!run && slots.length > 0;

  // --- RUNNING / DONE: the run earns the full card (live worker board). ---
  if (run) {
    return (
      <div className="col-span-full w-full overflow-hidden rounded-2xl border border-primary/40 bg-primary/[0.035]">
        <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            {active ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : done ? (
              <ClipboardCheck className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )}
          </div>
          <div className="flex-1 text-left">
            <div className="text-sm font-medium">
              {active ? "Your writers are on it" : done ? `${filedCount} draft${filedCount === 1 ? "" : "s"} ready to review` : "That didn't finish"}
            </div>
            <div className="text-xs text-muted-foreground">
              {active
                ? `${filedCount} of ${slots.length || previewCount} written · working in parallel`
                : done
                  ? "Open your batch chat to approve or edit each draft."
                  : run.error || "Please try again."}
            </div>
          </div>
          {active && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {filedCount}/{slots.length}
            </span>
          )}
        </div>

        {showBoard && (
          <div className="flex flex-col gap-1.5 px-3.5">
            {slots.map((s) => (
              <WorkerLane key={s.slot_index} slot={s} />
            ))}
          </div>
        )}

        <div className="px-3.5 pt-2.5 pb-3">
          {active ? (
            <span className="text-xs font-medium text-muted-foreground">
              Your batch chat is streaming — see the sidebar.
            </span>
          ) : done ? (
            <button
              type="button"
              onClick={() => {
                // The batch chat lives in the sidebar (title "Weekly batch —
                // Mon D"); a refresh + navigate to /dashboard makes sure it
                // appears in the list on a fresh load. Approve/Reject
                // happens inside the batch chat now (per-card).
                router.refresh();
                router.push("/dashboard");
              }}
              title="Open your batch chat below to approve or edit each draft."
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Open your batch <ArrowRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={fire}
              title="Run the weekly batch again."
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <WandSparkles className="h-4 w-4" /> Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  // --- NO SOURCES: a calm muted row, no button (nothing to run). ---
  if (noSources) {
    return (
      <div className="col-span-full w-full flex items-center gap-2.5 rounded-2xl border border-border/60 bg-muted/30 px-3.5 py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Search className="h-4 w-4" />
        </div>
        <div className="flex-1 text-left">
          <div className="text-sm font-medium">Your weekly batch</div>
          <div className="text-xs text-muted-foreground">
            No fresh posts to adapt yet — check back after your next scrape.
          </div>
        </div>
      </div>
    );
  }

  // --- READY: primary command-center CTA or normal starter tile. ---
  return (
    <>
      <button
        type="button"
        onClick={fire}
        disabled={starting}
        title="Find this week's top posts, adapt them into drafts, and open the batch chat so you can watch progress."
        className={cn(
          "group flex items-center text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:translate-y-0 disabled:opacity-60",
          featured
            ? "min-h-[5.75rem] gap-3 rounded-2xl border border-primary/30 bg-primary px-4 py-4 text-primary-foreground hover:bg-primary/95 sm:px-5"
            : "min-h-14 gap-2.5 rounded-xl border border-primary/25 bg-primary/[0.06] px-3.5 py-3 text-sm hover:bg-primary/[0.08]",
        )}
      >
        <span
          className={cn(
            "grid shrink-0 place-items-center rounded-lg transition-colors",
            featured
              ? "h-11 w-11 bg-card/15 text-primary-foreground ring-1 ring-white/20"
              : "h-9 w-9 bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground",
          )}
        >
          {starting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CalendarClock className="h-4 w-4" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block font-medium leading-tight",
              featured && "text-base sm:text-lg",
            )}
          >
            {starting
              ? "Dispatching your writers…"
              : "Draft weekly batch"}
          </span>
          <span
            className={cn(
              "mt-1 block leading-tight",
              featured
                ? "text-sm text-primary-foreground/82"
                : "text-xs leading-4 text-muted-foreground",
            )}
          >
            5 regular + 2 lead magnet posts
          </span>
        </span>
        <ArrowRight
          className={cn(
            "h-4 w-4 shrink-0 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100",
            featured ? "text-primary-foreground" : "text-primary",
          )}
        />
      </button>
      {startError && (
        <div className="col-span-full flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="flex-1">{startError}</span>
          <button
            type="button"
            onClick={() => setStartError(null)}
            aria-label="Dismiss"
            className="shrink-0 hover:opacity-70"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </>
  );
}

function EmptyState({
  onPick,
  author,
  nextAction,
}: {
  onPick: (prompt: string) => void;
  author: Author;
  nextAction: CoworkNextAction;
}) {
  const groups = [
    {
      title: "Explore",
      description: "Find angles from what is working now.",
      starters: [STARTERS[0], STARTERS[3]],
    },
    {
      title: "Create",
      description: "Turn an idea or proven source into a post.",
      starters: [STARTERS[4], STARTERS[1], STARTERS[2]],
    },
    {
      title: "Borrow attention",
      description: "Build a post around a person, brand, or timely story.",
      starters: [STARTERS[5], STARTERS[6]],
    },
    {
      title: "Campaigns",
      description: "Generate a coordinated week of content.",
      starters: [],
    },
  ];

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center px-2 py-7 sm:px-5 sm:py-9">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3.5 text-left">
        <AvatarImg
          src={author.avatarUrl}
          className="h-14 w-14 shrink-0 rounded-2xl object-cover ring-1 ring-border"
          fallback={
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-muted ring-1 ring-border">
              <MessageSquare className="h-7 w-7 text-muted-foreground" />
            </div>
          }
        />
          <div>
          <h2 className="text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
            What should we write today?
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Choose a starting point or describe what you need below.
          </p>
          </div>
        </div>
        <NextActionChip action={nextAction} />
      </div>

      <div className="mt-7 grid grid-cols-1 divide-y divide-border border-y border-border lg:grid-cols-4 lg:divide-x lg:divide-y-0">
        {groups.map((group) => (
          <section key={group.title} className="py-5 md:px-5 first:md:pl-0 last:md:pr-0">
            <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
            <p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">
              {group.description}
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              {group.starters.map((starter) => (
                <StarterCommand key={starter.label} starter={starter} onPick={onPick} />
              ))}
              {group.title === "Campaigns" && <HomeBatchCard />}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function StarterCommand({
  starter,
  onPick,
}: {
  starter: Starter;
  onPick: (prompt: string) => void;
}) {
  const Icon = starter.icon;
  return (
    <button
      type="button"
      onClick={() => onPick(starter.prompt)}
      title={starter.prompt}
      className="group flex min-h-12 w-full items-center gap-2.5 rounded-[10px] border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 active:translate-y-px"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 text-sm font-medium leading-tight">{starter.label}</span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/55 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function NextActionChip({ action }: { action: CoworkNextAction }) {
  const iconByKind: Record<CoworkNextAction["kind"], LucideIcon> = {
    track_creators: AtSign,
    voice: Fingerprint,
    inspiration: Search,
    review: ClipboardCheck,
    schedule: CalendarClock,
    batch: WandSparkles,
  };
  const Icon = iconByKind[action.kind];
  return (
    <a
      href={action.href}
      className="group inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1.5 text-left text-xs shadow-sm transition-colors hover:border-primary/25 hover:bg-card"
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/[0.08] text-primary">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 truncate text-muted-foreground">
        <span className="font-medium text-foreground">Next:</span>{" "}
        <span>{action.title}</span>
      </span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
    </a>
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
  // Board tools — the agent operating the user's drafts pipeline.
  list_drafts: { running: "Checking your drafts", done: "Checked your drafts" },
  move_on_board: { running: "Updating your board", done: "Updated your board" },
  schedule_post: { running: "Scheduling on your board", done: "Scheduled on your board" },
  generate_lead_magnet_image: {
    running: "Adapting the source image",
    done: "Adapted the source image",
  },
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
  if (name === "generate_lead_magnet_image") return pick("leadMagnet") ?? "";
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

// Hook-only refine helpers moved to lib/hook-splice.ts so client + server
// splice byte-identically (see the "Tighten the hook" fix). isHookFocusedRefine,
// splicePreservedBody, and buildHookOnlyRefineMessage are IMPORTED at the top
// of the file (used at runtime) and re-exported below by re-exporting the whole
// module. splitHookLines + HOOK_LINE_COUNT are re-exported for backward compat
// with the test suite that imports them from this file.
export { isHookFocusedRefine, splicePreservedBody, buildHookOnlyRefineMessage };
export { splitHookLines, HOOK_LINE_COUNT } from "@/lib/hook-splice";

// Detect when the user's composer message is a REFINE of the existing draft
// (vs a request for a new one), so the artifact handler can swap in place
// instead of stacking a duplicate card. Conservative — only matches clear
// refine signals AND rules out explicit "give me another" requests. Without
// this, typing "make it punchier" in the composer (rather than using the
// per-card Refine button) produced a second card.
export function looksLikeComposerRefine(message: string): boolean {
  const t = message.toLowerCase().trim();
  if (!t) return false;
  // Explicit "make a new / another / different" requests are NOT refines.
  // These take priority over the refine signal — if both fire, treat as new.
  if (
    /\b(another|new draft|fresh draft|different draft|other draft|alternative|variation|version 2|v2|a second|one more|give me \d+|draft \d+ more)\b/.test(
      t,
    )
  ) {
    return false;
  }
  // Refine signals — verbs + adjectives users naturally type when iterating
  // on the same draft. Anchored on word boundaries so substrings inside
  // unrelated words don't trip.
  return /\b(refine|tighten|shorten|lengthen|punchier|simpler|stronger|sharper|crisper|tweak|polish|improve|edit (this|the|it)|rewrite (this|the|it)|change (the|this)|update (this|the|it)|fix (this|the|it)|make it|make this|make the)\b/.test(
    t,
  );
}

// Ask-card answers need a slightly different heuristic from raw composer sends.
// In the composer, "make a variation" usually means "create another card", so
// looksLikeComposerRefine deliberately rejects it. But after the assistant asks
// "Anything else on this one?", the same wording is an edit to the current card:
// keep one draft and push the result into version history.
export function askAnswerShouldRefineLatestDraft(
  ask: Pick<AskQuestion, "question" | "options">,
  answer: string,
): boolean {
  const context = `${ask.question} ${ask.options.join(" ")}`.toLowerCase();
  const text = answer.toLowerCase().trim();
  if (!text) return false;
  const isPostDraftFollowUp =
    /\b(anything else|on this one|this one|this draft|the draft|change|edit|refine|tighten|shorter|hook|cta|list|listicle|variation)\b/.test(
      context,
    );
  if (!isPostDraftFollowUp) return false;
  if (CLIENT_DONE_ISH_RE.test(text) && !CLIENT_PROCEED_ESCAPE_RE.test(text)) {
    return false;
  }
  return /\b(refine|tighten|shorten|shorter|lengthen|punchier|simpler|stronger|sharper|crisper|tweak|polish|improve|edit|rewrite|change|update|fix|make it|make this|make the|turn it into|turn this into|add|remove|cut|listicle|list-format|list format|numbered|variation|format|structure|hook|opener|cta|call to action)\b/.test(
    text,
  );
}

// Read the custom-skill slugs an artifact was produced under (meta.skills,
// stamped server-side — see route's tagArtifactWithSkills). Defensive: meta is
// unknown-shape; only string entries survive. Pure + exported for tests.
export function artifactSkillNames(artifact: { meta?: Record<string, unknown> }): string[] {
  const v = (artifact.meta as { skills?: unknown } | undefined)?.skills;
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

export function artifactLeadMagnet(
  artifact: { meta?: Record<string, unknown> },
): AppliedLeadMagnet | null {
  const v = (artifact.meta as { lead_magnet?: unknown } | undefined)?.lead_magnet;
  if (!v || typeof v !== "object") return null;
  const raw = v as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  return {
    ...(id ? { id } : {}),
    title,
    selection: raw.selection === "manual" ? "manual" : "auto",
    publicSlug: typeof raw.public_slug === "string" ? raw.public_slug.trim() : null,
  };
}

export function artifactMediaAttachments(artifact: {
  media_attachments?: PostMediaAttachment[];
  meta?: Record<string, unknown>;
}): PostMediaAttachment[] {
  const raw =
    artifact.media_attachments ??
    (artifact.meta as { media_attachments?: unknown } | undefined)?.media_attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is PostMediaAttachment => {
    if (!item || typeof item !== "object") return false;
    const a = item as Partial<PostMediaAttachment>;
    return (
      typeof a.id === "string" &&
      typeof a.name === "string" &&
      typeof a.mimeType === "string" &&
      typeof a.type === "string" &&
      typeof a.uploadedAt === "string"
    );
  });
}

function generatedLeadMagnetImageStatus(artifact: {
  meta?: Record<string, unknown>;
}): { status: string; reason?: string } | null {
  const raw = (artifact.meta as { generated_lead_magnet_image?: unknown } | undefined)
    ?.generated_lead_magnet_image;
  if (!raw || typeof raw !== "object") return null;
  const status = (raw as { status?: unknown }).status;
  if (typeof status !== "string") return null;
  const reason = (raw as { reason?: unknown }).reason;
  return {
    status,
    ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}),
  };
}

// Map skill slugs → their ids using the workspace's loaded skills. A slug that
// no longer resolves (skill deleted/renamed since the draft was made) is
// dropped, so a refine never sends a stale id. Pure + exported for tests.
export function skillNamesToIds(
  names: string[],
  skills: { id: string; name: string }[],
): string[] {
  const byName = new Map(skills.map((s) => [s.name, s.id]));
  return names.map((n) => byName.get(n)).filter((id): id is string => !!id);
}

// The consistent character budget for the author headline shown in a draft
// card's LinkedIn-style header. The header used a CSS `truncate` (ellipsis at
// the pixel edge), so the SAME headline cut at a different word on every card
// and screen width — it "cut off weirdly". Truncating at a fixed CHARACTER
// count first makes the cut identical everywhere; the CSS truncate stays as a
// belt-and-suspenders guard for very narrow viewports.
export const HEADLINE_PREVIEW_CHARS = 48;

// Truncate a headline to a stable length: cut at HEADLINE_PREVIEW_CHARS, but
// back up to the last word boundary so we never slice a word in half, then
// append an ellipsis. Returns the headline unchanged when it already fits.
// Pure + exported for unit tests.
export function truncateHeadline(
  headline: string,
  max: number = HEADLINE_PREVIEW_CHARS,
): string {
  const trimmed = headline.trim();
  if (trimmed.length <= max) return trimmed;
  // Cut to the budget, then drop back to the last space so the last word isn't
  // sliced. If there's no space in the window (one very long token), hard-cut.
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const base = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${base.trimEnd()}…`;
}

// Split a post body into [hook, rest] at the first BLANK-LINE paragraph break.
// The hook is the first paragraph (LinkedIn's "…see more" cut); the rest is
// everything after it, including the blank-line separator's trailing content.
// Returns rest = "" when the post is a single paragraph (no break).
export function splitHook(body: string): { hook: string; rest: string } {
  const m = body.match(/\n[ \t]*\n/); // first blank line
  if (!m || m.index === undefined) return { hook: body, rest: "" };
  return {
    hook: body.slice(0, m.index),
    rest: body.slice(m.index + m[0].length),
  };
}

// splitHookLines / splicePreservedBody / HOOK_LINE_COUNT / isHookFocusedRefine
// live in lib/hook-splice.ts now (shared with the server stream route so
// splicing is byte-identical on both sides). Re-exported at the top of this
// file — see the `export { … } from "@/lib/hook-splice"` block above.

// A refine must not DESTROY a post. GLM, told to "shorten"/"tighten", sometimes
// returns a fragment that no longer makes sense — either a lone hook (dropped
// the body) or a drastically gutted post (e.g. a coherent 1,111-char post
// reduced to a nonsensical 164 chars). Either way the user's post is replaced
// by something worse, recoverable only via the version stepper. This is a
// deterministic backstop — no model judgment — that rejects such a refine.
//
// Two independent collapse signals; EITHER trips it (only for a POST that was a
// real, substantial post to begin with — we never touch a short original):
//   A. LONE HOOK: the original was multi-paragraph but the refined is a single
//      paragraph that's ~just the opener (<=45% of the original AND <=1.4x its
//      own hook). Catches "returned only the hook", even if it's a few lines.
//   B. GUTTED: the refined dropped below BOTH ~35% of the original length AND an
//      absolute floor (~400 chars). A 1,111→164 (15%) post is caught here even
//      if it kept a blank line; a genuine heavy trim (1,111→500, 45%) passes.
// The "was a real post" gate (original >= MIN chars) means a deliberately tiny
// post, or shortening an already-short one, is never blocked.
//
// On a detected collapse, KEEP THE ORIGINAL body and report it so the caller can
// tell the user the refine was rejected. Otherwise return the refined unchanged.
// Pure + exported for unit tests.
// A cite arriving AFTER its draft (the normal order — the model is told to
// call render_cite AFTER mentioning the post in chat text) backfills the
// draft's source_url server-side and RE-SENDS that same artifact id so the
// live client picks up the "Source post" chip. Without a replace-by-id check,
// the plain-append path in the SSE artifact handler would have shipped a
// SECOND copy of the same draft (as a "new" artifact with the same id landing
// twice in the array) instead of updating the one already on screen.
// Pure + exported for unit tests.
export function replaceOrAppendArtifact(
  existing: Artifact[],
  incoming: Artifact,
): Artifact[] {
  const idx = existing.findIndex((a) => a.id === incoming.id);
  if (idx === -1) return [...existing, incoming];
  return existing.map((a, i) => (i === idx ? incoming : a));
}

export const REFINE_MIN_ORIGINAL_CHARS = 500; // only guard a substantial post
export const REFINE_GUT_RATIO = 0.35; // below this fraction of the original …
export const REFINE_GUT_ABS_CHARS = 400; // … AND below this absolute length → gutted
export function guardRefineCollapse(
  originalBody: string,
  refinedBody: string,
): { body: string; collapsed: boolean } {
  const orig = splitHook(originalBody);
  const origLen = originalBody.trim().length;
  const refinedTrim = refinedBody.trim();
  const refinedLen = refinedTrim.length;
  const refinedHasBody = /\n[ \t]*\n/.test(refinedTrim); // a blank-line break

  // A. Lone-hook collapse (original was multi-paragraph → refined is ~just the
  // opener). Independent of the size gate below so a shorter multi-paragraph
  // original that collapses to its hook is still caught.
  const loneHook =
    orig.rest.trim().length > 0 &&
    !refinedHasBody &&
    refinedLen <= origLen * 0.45 &&
    refinedLen <= orig.hook.trim().length * 1.4;

  // B. Gutted: a substantial post shrunk past BOTH the ratio and the absolute
  // floor. This is the 1,111→164 case (structured or not).
  const gutted =
    origLen >= REFINE_MIN_ORIGINAL_CHARS &&
    refinedLen <= origLen * REFINE_GUT_RATIO &&
    refinedLen <= REFINE_GUT_ABS_CHARS;

  const collapsed = loneHook || gutted;
  return collapsed
    ? { body: originalBody, collapsed: true }
    : { body: refinedBody, collapsed: false };
}

// Re-insert a deleted artifact back into a (possibly-changed) current list at
// its original index — the rollback for an optimistic delete that FAILED. We
// reconcile against current state instead of restoring a pre-delete snapshot,
// so an artifact that streamed in during the delete's network round-trip isn't
// erased. No-ops if the artifact is somehow already present (avoid duplicates);
// clamps the index to the current bounds. Pure + exported for unit tests.
export function reinsertArtifact(
  list: Artifact[],
  at: number,
  art: Artifact,
): Artifact[] {
  if (list.some((a) => a.id === art.id)) return list;
  const next = [...list];
  next.splice(Math.min(Math.max(at, 0), next.length), 0, art);
  return next;
}

// Render a live run as the two bubbles it contributes to the active chat: the
// user's message and the streaming assistant message.
export function runOverlay(run: ChatRun, base: Message[] = []): Message[] {
  // The stream route persists the user message immediately when the turn
  // starts. If we switch away and back to a still-streaming chat, loadChat
  // refetches the base transcript — which now includes that user message — but
  // the run is kept (it's still streaming), so its optimistic run.userMsg would
  // render a SECOND copy. The ids differ (optimistic `u_<ts>` vs. the DB UUID),
  // so we dedupe by content.
  //
  // We can't only check base[last]: there's a window (a follow-up send, or a
  // reload that raced send()'s swap) where base already ends with the ASSISTANT
  // row of this turn, so the last element is the assistant, not the user. Scan
  // the LAST USER row near the tail instead — if it matches run.userMsg, the
  // turn is already in base and we drop the optimistic copy.
  const lastUser = [...base].reverse().find((m) => m.role === "user");
  const alreadyInBase =
    !!lastUser &&
    lastUser.text === run.userMsg.text &&
    sameFiles(lastUser.files, run.userMsg.files);

  // The AskCard owns the question text. If we also put ask.question in the
  // assistant prose, the UI renders the same question twice.
  const overlayText = stripPostFences(run.rawText);

  return [
    ...(alreadyInBase ? [] : [run.userMsg]),
    {
      id: run.assistantId,
      role: "assistant",
      text: overlayText,
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

// The ask-turn reload races the next answer send. If the user answers quickly,
// the ask run is no longer the current run by the time its reload returns, but
// the reloaded rows are still valuable: they contain the persisted ask_user
// card that keeps the prior prompt/question visible under the new answer run.
// Apply that reload when it fills in a missing ask turn, but don't let an older
// ask-only snapshot overwrite a newer base that already includes later rows.
export function shouldApplyAskTurnReload(
  currentBase: Message[],
  reloadedBase: Message[],
): boolean {
  const reloadedHasAsk = reloadedBase.some(
    (m) => m.role === "assistant" && !!m.ask,
  );
  if (!reloadedHasAsk) return false;

  // Never overwrite a STRICTLY NEWER current base (more rows, different tail) —
  // it already carries the answer + its reply, so a stale ask reload would
  // regress it. This check comes first because hydrate now marks an *answered*
  // ask inert (no `.ask`), so we can't rely on "current still has an ask" to
  // detect the answered state — the row count/tail is the durable signal.
  const currentLast = currentBase[currentBase.length - 1]?.id ?? null;
  const reloadedLast = reloadedBase[reloadedBase.length - 1]?.id ?? null;
  if (currentBase.length > reloadedBase.length && currentLast !== reloadedLast) {
    return false;
  }

  return true;
}

// Compare the optional filename lists on two user messages (order-sensitive,
// which is fine — they come from the same picked-file order).
export function sameFiles(a?: string[], b?: string[]): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((f, i) => f === b[i]);
}

export function hasAssistantAfterUserMessage(
  messages: Message[],
  userMsg: Message,
): boolean {
  const userIdx = messages.findLastIndex(
    (m) =>
      m.role === "user" &&
      m.text === userMsg.text &&
      sameFiles(m.files, userMsg.files),
  );
  if (userIdx < 0) return false;
  return messages.slice(userIdx + 1).some((m) => m.role === "assistant");
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

// File picker accept list. Text-like files are inlined, PDFs/docs are parsed by
// OpenRouter's file parser, and images are described by a vision pre-pass.
const ACCEPT_ATTR =
  ".pdf,.txt,.md,.markdown,.skills,.csv,.tsv,.json,.log,.doc,.docx,.rtf,.png,.jpg,.jpeg,.webp,application/pdf,text/plain,text/markdown,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/rtf,text/rtf,image/png,image/jpeg,image/webp";

// Does a drag's DataTransfer carry files (vs. selected text / a dragged link)?
// During dragenter/dragover the `files` list is empty (files are only readable
// on drop), so we key on `types` containing the "Files" sentinel — the reliable
// cross-browser signal. Pure + exported so the guard is unit-testable without a
// DOM DragEvent. Accepts the minimal shape we read so tests can pass a stub.
export function dataTransferHasFiles(
  dt: { types?: readonly string[] | DOMStringList } | null | undefined,
): boolean {
  if (!dt || !dt.types) return false;
  return Array.from(dt.types).includes("Files");
}

// Decide how to handle a picked file: read as text, send as a parseable file,
// describe as image context, or reject.
export function classifyFile(
  file: File,
): "text" | "file" | "image" | "reject-other" {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (
    type === "image/png" ||
    type === "image/jpeg" ||
    type === "image/webp" ||
    /\.(png|jpe?g|webp)$/.test(name)
  ) {
    return "image";
  }
  if (type.startsWith("video/") || type.startsWith("audio/"))
    return "reject-other";
  // Plain-text-ish: read directly to text and inline it.
  if (
    type.startsWith("text/") ||
    /\.(txt|md|markdown|skills|csv|tsv|json|log)$/.test(name)
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
  const visible = rows.filter(
    (r) => r.role === "user" || r.role === "assistant",
  );
  return visible.map((r, i) => {
    const parsedAsk =
      r.role === "assistant" ? extractPersistedAsk(r.tool_calls) : undefined;
    // An ask_user card is only LIVE (interactive) when it's the last message in
    // the transcript — i.e. the turn ended on the question and is still waiting.
    // Once ANY later message exists (the user's answer, or the assistant's next
    // turn), the question was already resolved, so the card must render inert on
    // reload. Without this, a rehydrated answered/dismissed card came back fully
    // clickable and re-fired a billed model turn. We still keep `parsedAsk` for
    // the text-stripping below so the question line isn't duplicated as prose.
    const isLast = i === visible.length - 1;
    const ask = parsedAsk && isLast ? parsedAsk : undefined;
    // Rebuild the recoverable Continue banner from the assistant row's persisted
    // marker so it survives the post-stream reload (see extractPersistedRecoverable).
    const recoverable =
      r.role === "assistant"
        ? extractPersistedRecoverable(r.tool_calls)
        : undefined;
    const skills =
      r.role === "user" ? extractPersistedSkills(r.tool_calls) : undefined;
    const postFormat =
      r.role === "user" ? extractPersistedPostFormat(r.tool_calls) : undefined;
    const creatorStyle =
      r.role === "user" ? extractPersistedCreatorStyle(r.tool_calls) : undefined;
    const leadMagnet =
      r.role === "user" ? extractPersistedLeadMagnet(r.tool_calls) : undefined;
    const text = r.role === "assistant" ? stripPostFences(r.content) : r.content;
    // Strip the question line from display text whenever the row carried an ask
    // (resolved or not), so an answered ask's question doesn't reappear as prose.
    const displayText = parsedAsk
      ? stripAskQuestionFromText(text, parsedAsk.question)
      : text;
    return {
      id: r.id,
      role: r.role as "user" | "assistant",
      text: displayText,
      artifacts: r.artifacts ?? undefined,
      ...(ask ? { ask } : {}),
      ...(recoverable ? { recoverable } : {}),
      ...(skills && skills.length ? { skills } : {}),
      ...(postFormat ? { postFormat } : {}),
      ...(creatorStyle ? { creatorStyle } : {}),
      ...(leadMagnet ? { leadMagnet } : {}),
    };
  });
}

export function stripAskQuestionFromText(text: string, question: string): string {
  const trimmedText = text.trim();
  const trimmedQuestion = question.trim();
  if (!trimmedText || !trimmedQuestion) return text;
  if (trimmedText === trimmedQuestion) return "";
  if (!trimmedText.endsWith(trimmedQuestion)) return text;
  return trimmedText.slice(0, -trimmedQuestion.length).trimEnd();
}

// Validate the JSONB `chats.live_plan` (restored from the server for a chat we
// reattached to) into a clean PlanStep[]. Untrusted-shaped input from the DB, so
// we filter to well-formed steps (string id + label, known status) and drop the
// rest — a malformed plan just renders no checklist rather than crashing. Pure +
// exported for unit tests.
export function normalizeLivePlan(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const step = s as Record<string, unknown>;
    const id = typeof step.id === "string" ? step.id : null;
    const label = typeof step.label === "string" ? step.label : null;
    const status =
      step.status === "pending" || step.status === "active" || step.status === "done"
        ? step.status
        : null;
    if (id && label && status) out.push({ id, label, status });
  }
  return out;
}

// Reconstruct an AskQuestion from a persisted ask_user tool_call (BOTH the
// decide-layer ask and the GLM-emitted ask go through ask_user, so a single
// matcher rehydrates both). Returns undefined when there's nothing to
// reconstruct or the args are unparseable — the UI then falls back to the
// prose-only render (still readable, just no interactive checkboxes).
function extractPersistedAsk(
  toolCalls: RawDbMessage["tool_calls"],
): AskQuestion | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const tc = toolCalls.find((c) => c.function?.name === "ask_user");
  if (!tc) return undefined;
  try {
    const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    const question = typeof args.question === "string" ? args.question : "";
    const options = Array.isArray(args.options)
      ? args.options.filter((o): o is string => typeof o === "string")
      : [];
    if (!question || options.length < 2) return undefined;
    const allowOther = args.allowOther !== false;
    const multiSelect = args.multiSelect === true;
    // Recover a dropped doneOption on rehydrate (the model sometimes forgot to
    // tag it; without this the persisted card's "done" pick would send a turn).
    const doneOption = recoverDoneOption(
      options,
      typeof args.doneOption === "string" ? args.doneOption : undefined,
    );
    return {
      question,
      options,
      allowOther,
      ...(multiSelect ? { multiSelect: true } : {}),
      ...(doneOption ? { doneOption } : {}),
    };
  } catch {
    return undefined;
  }
}

// Reconstruct the list of applied custom-skill slugs from a USER row's
// persisted tool_calls (we stash them as a synthetic _custom_skills_applied
// entry on send, since the user row's tool_calls column was nullable + unused).
// Returns undefined when the row has no skill marker — the bubble renders
// without the chip row, which is correct.
function extractPersistedSkills(
  toolCalls: RawDbMessage["tool_calls"],
): string[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const tc = toolCalls.find(
    (c) => c.function?.name === "_custom_skills_applied",
  );
  if (!tc) return undefined;
  try {
    const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    const names = Array.isArray(args.names)
      ? args.names.filter((n): n is string => typeof n === "string")
      : [];
    return names.length > 0 ? names : undefined;
  } catch {
    return undefined;
  }
}

// Rebuild the recoverable-error banner from the synthetic marker the stream
// route stashes on the assistant row when a cut-off/stalled turn still persisted
// a `done`. Without this, `recoverable` is live-only and the one-click Continue
// button vanishes the instant the post-stream reload swaps run→base.
function extractPersistedRecoverable(
  toolCalls: RawDbMessage["tool_calls"],
): RecoverableError | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const tc = toolCalls.find((c) => c.function?.name === "_recoverable");
  if (!tc) return undefined;
  try {
    const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    const message = typeof args.message === "string" ? args.message : "";
    if (!message) return undefined;
    return {
      code: typeof args.code === "string" ? args.code : "",
      message,
      recovery: "continue",
    };
  } catch {
    return undefined;
  }
}

function extractPersistedPostFormat(
  toolCalls: RawDbMessage["tool_calls"],
): string | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const tc = toolCalls.find(
    (c) => c.function?.name === "_post_format_selected",
  );
  if (!tc) return undefined;
  try {
    const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    if (typeof args.label === "string" && args.label.trim()) {
      return args.label.trim();
    }
    return isNoModelFormatId(args.id) ? noModelFormatLabel(args.id) : undefined;
  } catch {
    return undefined;
  }
}

// Reconstruct the "Style: Creator Name" badge from a persisted
// _creator_style_selected tool_call (the stream route stamps { id, name,
// creatorName } when a style was applied). Exported for tests.
export function extractPersistedCreatorStyle(
  toolCalls: RawDbMessage["tool_calls"],
): { name: string; creatorName: string | null } | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const tc = toolCalls.find(
    (c) => c.function?.name === "_creator_style_selected",
  );
  if (!tc) return undefined;
  try {
    const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return undefined;
    return {
      name,
      creatorName:
        typeof args.creatorName === "string" && args.creatorName.trim()
          ? args.creatorName.trim()
          : null,
    };
  } catch {
    return undefined;
  }
}

export function extractPersistedLeadMagnet(
  toolCalls: RawDbMessage["tool_calls"],
): AppliedLeadMagnet | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const tc = toolCalls.find(
    (c) => c.function?.name === "_lead_magnet_selected",
  );
  if (!tc) return undefined;
  try {
    const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return undefined;
    const selection = args.selection === "manual" ? "manual" : "auto";
    return { ...(id ? { id } : {}), title, selection };
  } catch {
    return undefined;
  }
}

// Re-attach a live-only clarifying question (ask_user) to the LAST assistant
// message after a DB reload. The ask isn't persisted, so a reloaded transcript
// loses it — without this graft the AskCard would vanish the instant the turn
// settles (it renders only when !streaming, i.e. after the run is dropped).
// No-op when there's no pending ask. Returns a new array (doesn't mutate input).
export function attachAskToLastAssistant(
  messages: Message[],
  ask: AskQuestion | undefined,
): Message[] {
  if (!ask) return messages;
  // Find the last assistant message (the one that just asked the question).
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      const next = [...messages];
      next[i] = { ...next[i], ask };
      return next;
    }
  }
  return messages;
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

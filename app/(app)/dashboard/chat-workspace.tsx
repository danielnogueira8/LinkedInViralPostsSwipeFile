"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { leadMagnetPickerDisabledForSource } from "@/lib/chat-composer-policy";
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
  Layers,
  MessageSquare,
  MessageCircleQuestionMark,
  Search,
  Lightbulb,
  Flame,
  Magnet,
  TrendingUp,
  PenLine,
  SquarePen,
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
  AtSign,
  Building2,
  Zap,
  Fingerprint,
  ThumbsDown,
  ThumbsUp,
  ImageIcon,
  Newspaper,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { renderRichText } from "@/components/chat-rich-text";
import { GroundedSourceLinks } from "@/components/grounded-source-links";
import { cn } from "@/lib/utils";
import { ChatContextPanel } from "./chat-context-panel";
import {
  summarizeChatContext,
  isContextSummaryEmpty,
} from "@/lib/cowork-context-summary";
import {
  filterSkillsByQuery,
  SKILLS_PER_TURN_MAX,
  type CustomSkill,
} from "@/lib/custom-skills";
import {
  NO_MODEL_FORMAT_CATALOG,
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
import {
  validatePostMediaFile,
  validatePostMediaSet,
  type PostMediaAttachment,
} from "@/lib/post-media";
import {
  isHookFocusedRefine,
  splicePreservedBody,
  buildHookOnlyRefineMessage,
} from "@/lib/hook-splice";
import { copyToClipboard } from "@/lib/clipboard";
import {
  contentBodyForFormat,
  draftEgressBody,
  draftMarkdownEnabled,
  type ContentFormat,
} from "@/lib/markdown/mode";
import { localDateFromDatetimeInput } from "@/lib/schedule-local-date";
import { suggestedScheduleLocalInput } from "@/lib/next-open-schedule-day";
import { useCopiedFlag } from "@/lib/use-copied-flag";
import { resolveIntent } from "@/lib/post-intents";
import { AvatarImg } from "@/components/avatar-img";
import { Button } from "@/components/ui/button";
import { normalizePostBody } from "@/lib/post-body-normalize";
import { looksCorruptedDraft } from "@/lib/agent/specialists/nets";
import type {
  Artifact,
  AskQuestion,
  PlanStep,
} from "@/lib/agent/contracts";
import {
  commandForComposer,
  initialCoworkComposerState,
  preservesCoworkCommandOnSessionChange,
  resumesPersistedCoworkOperation,
  type CoworkCommand,
  type CoworkComposerCommandKind,
  type CoworkComposerState,
} from "@/lib/cowork-command";
import {
  isAskSelectionComplete,
  resolveAskSubmission,
  toggleAskOption,
} from "@/lib/chat-ask";
import {
  persistedDraftPanelArtifacts,
  replaceOrAppendArtifact,
  runOverlay,
  shouldApplyAskTurnReload,
} from "@/lib/chat-session-view";
import { AGENT_CHAT_TITLE } from "@/lib/agent-loop/constants";
import {
  clearComposerStarter,
  moveComposerDraft,
  readComposerDraft,
  readDraft,
  writeComposerDraft,
  writeDraft,
} from "@/lib/chat-draft-storage";
import {
  chatIdAfterPendingNewSession,
  modelHandoffDestination,
  modelSourceBelongsToChat,
  prependChatIfMissing,
  readChatScopedList,
  shouldSyncSelectedChat,
  updateChatScopedList,
} from "@/lib/chat-navigation";
import {
  ChatSession,
  fetchChatStream,
  normalizeLivePlan,
  type ChatSendLease,
} from "@/lib/chat-session";
import { chatSetupDeadlines } from "@/lib/chat-stream-policy";
import {
  DRAFT_COUNT_OPTIONS,
  POST_TYPE_OPTIONS,
  generationConfigForSelection,
  type DraftCountSelection,
  type PostTypeSelection,
} from "@/lib/generation-config";
import type { DraftKind } from "@/lib/post-type";
import type { ModelSourceAttachment } from "@/lib/model-source-attachments";
import type { ComposerStarterId } from "@/lib/composer-task-context";
import { requestServerTurnStop } from "@/lib/chat-stop";
import { safeJsonSchema } from "@/lib/api-fetch";
import {
  applyPersistedUserMessageId,
  hydrate,
  persistedRetryTaskForUserMessage,
  retryTask,
  type AppliedLeadMagnet,
  type ChatRun,
  type Message,
  type RawDbMessage,
  type ToolChip,
} from "@/lib/chat-hydration";
import {
  CHAT_GROUP_LABEL,
  activityTailLabel,
  agentStatus,
  artifactLeadMagnet,
  artifactMediaAttachments,
  classifyFile,
  clientShouldApplyLeadMagnet,
  clientShouldApplyPostFormat,
  dataTransferHasFiles,
  filterChats,
  findPlaceholders,
  firstPlaceholderRange,
  generatedLeadMagnetImageStatus,
  groupChatsByDate,
  guardRefineCollapse,
  assistantAfterPersistedUserMessage,
  hasAssistantAfterPersistedUserMessage,
  ARTIFACT_PANEL_TITLE,
  buildArtifactIndex,
  kindNoun,
  numberedArtifactLabel,
  planProgressTitle,
  prettyBytes,
  reinsertArtifact,
  resolveArtifactEditTarget,
  shouldShowActivityRail,
  stripPlaceholders,
  suggestedLeadMagnetPromptForPost,
  toolDetail,
  toolPhrase,
  truncateHeadline,
  visibleActivityTools,
} from "@/lib/chat-ui-policy";
import { partitionCoworkStarters } from "@/lib/cowork-starter-policy";
import {
  parseCoworkTurnUsage,
  researchSourcesFromArtifact,
} from "@/lib/cowork-turn-usage";
import { modeledSourceAttribution } from "@/lib/model-source-attribution";
import { ResearchSources, TaskUsageSummary } from "./cowork-trust-details";

export type { Artifact } from "@/lib/agent/contracts";

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

function CoworkCommandIcon({
  kind,
  className,
}: {
  kind: CoworkComposerCommandKind;
  className?: string;
}) {
  const Icon =
    kind === "ask"
      ? MessageCircleQuestionMark
      : kind === "create"
        ? SquarePen
        : PenLine;
  return <Icon className={className} aria-hidden />;
}

// ---------------------------------------------------------------------------
// Claude-Cowork-style chat workspace.
//
// Three regions: chat-history sidebar (left), streaming conversation (center),
// artifact panel (right). The conversation streams from
// POST /api/chats/[id]/stream via SSE; generated posts surface as artifacts in
// the right panel where they can be copied or saved.
// ---------------------------------------------------------------------------

 const DRAFT_PANEL_WIDTH_KEY = "swipein:cowork-draft-panel-width";
const VOICE_WARNING_DISMISSED_KEY = "swipein:cowork-voice-warning-dismissed";
const DRAFT_PANEL_MIN_WIDTH = 320;
const DRAFT_PANEL_MAX_WIDTH = 640;
const DRAFT_PANEL_DEFAULT_WIDTH = 384;

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

const STOPPED_EMPTY_MESSAGE = "Stopped before a response was produced.";

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

function isCreateAfterDraftLeadMagnet(
  leadMagnet: PendingLeadMagnet | null,
): leadMagnet is Extract<PendingLeadMagnet, { createAfterDraft: true }> {
  return !!leadMagnet && "createAfterDraft" in leadMagnet;
}

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

// Identity for the LinkedIn-style draft preview. Sourced from Clerk + the voice
// profile on the server and passed in (the workspace is a client component).
export type Author = {
  name: string;
  avatarUrl: string | null;
  // A durable backup avatar (the Clerk-hosted photo) tried when avatarUrl — a
  // LinkedIn CDN URL that expires — fails to load, before falling to initials.
  fallbackAvatarUrl: string | null;
  headline: string | null;
};

export type CoworkNextAction = {
  kind:
    | "track_creators"
    | "voice"
    | "inspiration"
    | "breakout"
    | "review"
    | "schedule"
    | "batch";
  title: string;
  description: string;
  cta: string;
  href: string;
  /** Breakout radar (Phase E4): the swipe post to model on click. */
  breakoutPostId?: string;
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
  writerContentFormat = "plain",
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
  writerContentFormat?: ContentFormat;
}) {
  const [chats, setChats] = useState<ChatSummary[]>(initialChats);
  const [chatSession] = useState(() =>
    new ChatSession<Message, Artifact, ChatRun>({
      activeId: initialChatId,
      initialMessages: hydrate(initialMessages),
      initialArtifacts: initialMessages.flatMap((message) => message.artifacts ?? []),
    }),
  );
  const sessionSnapshot = useSyncExternalStore(
    chatSession.subscribe,
    chatSession.snapshot,
    chatSession.snapshot,
  );
  const activeId = sessionSnapshot.activeId;
  const activeIdRef = useRef<string | null>(activeId);
  const setActiveId = useCallback(
    (id: string | null) => {
      // Chat selection is an ownership boundary for send(). Update the mirror
      // synchronously so a click followed by an immediate submit cannot use a
      // render closure that still points at the previous conversation.
      activeIdRef.current = id;
      chatSession.selectLocal(id);
    },
    [chatSession],
  );
  const pendingNewChatRef = useRef<Promise<string | null> | null>(null);
  const localChatNavigationRef = useRef<string | null>(null);
  // Start empty on the server and the client's first render, then restore the
  // saved localStorage draft after hydration. Reading localStorage in the lazy
  // initializer makes the client render an enabled send button while the server
  // rendered it disabled, which React reports as a hydration mismatch.
  const [input, setInput] = useState("");
  // Operation authority is visible and scoped to one turn. A new session starts
  // in Create; existing sessions and completed turns return to Ask. Edit owns
  // one visible Post target and scope, so wording never has to identify what
  // may change.
  const [coworkComposer, setCoworkComposer] = useState<CoworkComposerState>(() =>
    initialCoworkComposerState(initialChatId),
  );
  const askContextPostId =
    coworkComposer.kind === "ask" ? coworkComposer.contextPostId : undefined;
  // Generated drafts/hooks live in the right-hand panel (not inline in the
  // conversation), so the panel opens by default and re-opens whenever a new
  // artifact streams in. It can still be collapsed; the floating "Drafts (N)"
  // button brings it back.
  const [panelOpen, setPanelOpen] = useState(true);
  // The context rail (right side) — an aggregated, referenceable view of what's
  // shaping this chat (source post, skills, format, style, giveaway, files).
  // Opt-in: closed by default so it never competes with the drafts panel for
  // attention; opened from the header toggle. Mobile uses a bottom sheet.
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
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
  const [pendingModelSource, setModelSource] = useState<ModelSource | null>(null);
  const [modelSourceChatId, setModelSourceChatId] = useState<string | null>(null);
  const modelSource = modelSourceBelongsToChat(activeId, modelSourceChatId)
    ? pendingModelSource
    : null;
  const leadMagnetPickerDisabled = leadMagnetPickerDisabledForSource(modelSource?.postType);
  // When a chat was opened via Posts → "Model in Chat", this maps that chat's id
  // to the original chat_artifacts row it's refining. Saving a refined post in
  // that chat UPDATES the original row instead of creating a duplicate. Per-chat
  // (reactive) so switching conversations shows the right "Update post" vs "Save
  // draft" affordance. Set in the ?model= handoff; a chat stays linked to its
  // source post for its lifetime.
  const [refiningByChat, setRefiningByChat] = useState<Record<string, string>>({});
  const [attachmentsByChat, setAttachmentsByChat] = useState<Map<string, Attachment[]>>(
    () => new Map(),
  );
  const attachmentsByChatRef = useRef(attachmentsByChat);
  const attachments = useMemo(
    () => readChatScopedList(attachmentsByChat, activeId),
    [activeId, attachmentsByChat],
  );
  const setAttachments = useCallback(
    (update: Attachment[] | ((items: Attachment[]) => Attachment[])) => {
      const next = updateChatScopedList(
        attachmentsByChatRef.current,
        activeIdRef.current,
        update,
      );
      attachmentsByChatRef.current = next;
      setAttachmentsByChat(next);
    },
    [],
  );
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
  const [postFormatPickerOpen, setPostFormatPickerOpen] = useState(false);
  const postFormatPickerRef = useRef<HTMLDivElement>(null);
  const [creatorStylePickerOpen, setCreatorStylePickerOpen] = useState(false);
  const creatorStylePickerRef = useRef<HTMLDivElement>(null);
  const [leadMagnetPickerOpen, setLeadMagnetPickerOpen] = useState(false);
  const leadMagnetPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!leadMagnetPickerDisabled) return;
    // A modeled source is an external navigation state; clear incompatible
    // composer-only context when it changes to a regular post.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingLeadMagnet(null);
    setLeadMagnetPickerOpen(false);
  }, [leadMagnetPickerDisabled]);
  const [generationSettingsOpen, setGenerationSettingsOpen] = useState(false);
  const generationSettingsRef = useRef<HTMLDivElement>(null);
  const generationSettingsButtonRef = useRef<HTMLButtonElement>(null);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [draftCountSelection, setDraftCountSelection] =
    useState<DraftCountSelection>("auto");
  const enterCreateCommand = useCallback(
    (count?: Exclude<DraftCountSelection, "auto">) => {
      setCoworkComposer({ kind: "create" });
      setDraftCountSelection((current) =>
        count ?? (current === "auto" ? 1 : current),
      );
    },
    [],
  );
  const preserveCommandOnNextChatChangeRef = useRef<
    string | null | undefined
  >(initialChatId ? undefined : null);
  // Explicit post-type pick for a plain composer send with no starter (a
  // starter like "model a lead magnet" already carries its own post type via
  // composerTaskContext — this only matters for free-text requests, which
  // otherwise fall to the read-only orchestrator's instruction-derived
  // fallback). Same Auto/explicit shape and lifecycle as draftCountSelection.
  const [postTypeSelection, setPostTypeSelection] =
    useState<PostTypeSelection>("auto");
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
      setGenerationSettingsOpen(false);
      setContextMenuOpen(false);
      const preserveCommand = preservesCoworkCommandOnSessionChange(
        preserveCommandOnNextChatChangeRef.current,
        activeId,
      );
      preserveCommandOnNextChatChangeRef.current = undefined;
      if (!preserveCommand) {
        setCoworkComposer({ kind: "ask" });
      }
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
  // --- the session runtime owns cache/run publication, so streamed updates ---
  // --- remain isolated even while another chat is active.                  ---

  // The chat whose transcript is currently being fetched (sidebar click →
  // setActiveId fires immediately, but the messages load over the network).
  // During that window `messages` is empty; without this signal the empty-state
  // "starter prompt ideas" flash as if it were a new chat. We suppress that flash
  // by showing a quiet loading state instead while this matches the active chat.
  const loadingChatId = sessionSnapshot.loadingChatId;
  const setLoadingChatId = useCallback(
    (value: string | null | ((current: string | null) => string | null)) => {
      const current = chatSession.snapshot().loadingChatId;
      chatSession.setLoadingChatId(typeof value === "function" ? value(current) : value);
    },
    [chatSession],
  );
  // A chat whose turn is running SERVER-SIDE but which has no live local run —
  // the case where a full-page navigation destroyed the in-memory stream + plan.
  // While set, we show a "Cowork is still working…" indicator and poll the chat
  // until the turn settles (its persisted reply then lands via loadChat). This
  // restores the "still working" feedback that was otherwise lost on return.
  const reattachingChatId = sessionSnapshot.reattachingChatId;
  // The live plan checklist for a reattaching chat, restored from
  // chats.live_plan (persisted server-side while the turn runs). Lets a returning
  // client re-render the LITERAL steps, not just a generic "still working…".
  const reattachPlan = sessionSnapshot.reattachPlan as PlanStep[];
  const setReattachingChatId = useCallback(
    (value: string | null | ((current: string | null) => string | null)) => {
      const current = chatSession.snapshot().reattachingChatId;
      chatSession.setReattaching(
        typeof value === "function" ? value(current) : value,
        chatSession.snapshot().reattachPlan,
      );
    },
    [chatSession],
  );
  const setReattachPlan = useCallback(
    (plan: PlanStep[]) => chatSession.setReattaching(
      chatSession.snapshot().reattachingChatId,
      plan,
    ),
    [chatSession],
  );
  // Derived view for the active chat: base transcript + live run overlay.
  const activeRun = chatSession.runFor(activeId);
  const activeBase = chatSession.baseMessages(activeId);
  const messages: Message[] = activeId
    ? [...activeBase, ...(activeRun ? runOverlay(activeRun, activeBase) : [])]
    : [];
  // Aggregate everything shaping this chat into one referenceable summary for the
  // context rail: the per-message context the transcript already carries + the
  // live source post being modeled. Pure fold — no new data. Empty until a chat
  // actually has context, which gates whether the rail/toggle appear at all.
  const contextSummary = summarizeChatContext({
    messages,
    sourcePost: modelSource
      ? {
          authorName: modelSource.authorName,
          authorAvatar: modelSource.authorAvatar,
          postText: modelSource.postText,
          partial: modelSource.partial,
          postType: modelSource.postType,
          kind: modelSource.kind,
        }
      : null,
  });
  const hasContext = !isContextSummaryEmpty(contextSummary);
  // The active chat's sidebar row. Prefer local state, but also consult fresh
  // server props because a soft navigation can update initialChats without
  // remounting this client component.
  const activeChat = activeId
    ? chats.find((c) => c.id === activeId) ??
      initialChats.find((c) => c.id === activeId)
    : undefined;
  const activeArtifactsAll: Artifact[] = activeId
    ? persistedDraftPanelArtifacts(chatSession.artifactsFor(activeId))
    : [];
  const hasQueuedLeadMagnetImage = activeArtifactsAll.some((artifact) => {
    const status = generatedLeadMagnetImageStatus(artifact)?.status;
    return status === "queued" || status === "running";
  });
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
  // draft is never dropped. Real drafts have 100+ char bodies — safe floor.
  const MIN_PANEL_DRAFT_LENGTH = 40;
  // Only POST drafts reach the panel. Hooks are never rendered as cards
  // (render_hook removed); a stray/legacy kind:"hook" artifact is dropped here
  // so it can never surface as a draft card — the deterministic client backstop.
  const artifacts: Artifact[] = activeArtifactsAll.filter(
    (a) =>
      a.kind === "post" &&
      a.body.trim().length >= MIN_PANEL_DRAFT_LENGTH &&
      !looksCorruptedDraft(a.body),
  );
  const artifactIndex = buildArtifactIndex(artifacts);
  const hasEditablePosts = artifactIndex.entries.length > 0;
  // Edit is a capability, not a permanent navigation option. Keep the
  // effective command safe during the render where the final Post disappears;
  // the effect below then removes the now-invalid stored selection as well.
  const effectiveCoworkComposer = useMemo<CoworkComposerState>(
    () =>
      coworkComposer.kind === "edit" && !hasEditablePosts
        ? { kind: "ask" }
        : coworkComposer,
    [coworkComposer, hasEditablePosts],
  );
  const composerCommandKind = effectiveCoworkComposer.kind;
  useEffect(() => {
    if (coworkComposer.kind !== "edit" || hasEditablePosts) return;
    // The editable collection can change outside the command bar (delete,
    // reload, or stream reconciliation), so enforce the invariant at its
    // canonical source rather than only in click handlers.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCoworkComposer({ kind: "ask" });
  }, [coworkComposer.kind, hasEditablePosts]);
  const askContextPost = artifactIndex.entries.find(
    (entry) => entry.artifactId === askContextPostId,
  );
  const editTargetPostId =
    effectiveCoworkComposer.kind === "edit"
      ? effectiveCoworkComposer.targetPostId
      : undefined;
  const editTargetPost =
    effectiveCoworkComposer.kind === "edit"
      ? resolveArtifactEditTarget(artifactIndex.entries, {
          targetArtifactId: editTargetPostId,
          expandedArtifactId,
        })
      : undefined;
  const editTargetLabel = editTargetPost
    ? numberedArtifactLabel(editTargetPost)
    : null;
  const enterEditCommand = (requestedTargetPostId?: string) => {
    const requestedTarget = artifactIndex.entries.find(
      (entry) => entry.artifactId === requestedTargetPostId,
    );
    const expandedTarget = artifactIndex.entries.find(
      (entry) => entry.artifactId === expandedArtifactId,
    );
    const fallbackTarget = artifactIndex.entries.at(-1);
    setCoworkComposer({
      kind: "edit",
      targetPostId:
        requestedTarget?.artifactId ??
        expandedTarget?.artifactId ??
        fallbackTarget?.artifactId,
      scope:
        coworkComposer.kind === "edit" ? coworkComposer.scope : "full_post",
    });
  };
  const hasDraftPanel = artifacts.length > 0;
  const sending = !!activeRun && activeRun.streaming;
  // Chats with a live background run, for the sidebar spinner.
  const streamingChatIds = chatSession.streamingRunIds();

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Mirror of activeId readable inside long-lived stream closures (which would
  // otherwise capture a stale activeId) — used to gate UI-only side effects
  // (like auto-opening the drafts panel) to the chat that's actually on screen.
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // React to a server-driven change of the ?chat= query. `useState(initialChatId)`
  // only fires ONCE at mount — so a soft nav that changes the query re-runs
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
    // Mark loading unless we already have this chat cached. Skips the empty-state
    // flash while the fetch is in flight.
    const hasContent = chatSession.hasVisibleContent(id);
    // Reacting to a server-driven prop change — the sanctioned setState-in-
    // effect use (parallel to loadChat's own setActiveId on click).
    setActiveId(id);
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
        chatSession.reconcile(
          id,
          hydrate(data.messages),
          data.messages.flatMap((m) => m.artifacts ?? []),
        );
      } catch {
        /* transient — next tick retries */
      } finally {
        if (!cancelled) {
          setLoadingChatId((cur) => (cur === id ? null : cur));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    initialChatId,
    setActiveId,
    setLoadingChatId,
    chatSession,
  ]);

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

  useEffect(() => {
    if (!generationSettingsOpen) return;
    const onDocPointerDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node;
      if (generationSettingsRef.current?.contains(target)) return;
      if (generationSettingsButtonRef.current?.contains(target)) return;
      setGenerationSettingsOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setGenerationSettingsOpen(false);
    };
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [generationSettingsOpen]);

  // Add context menu: close on outside click + Escape.
  useEffect(() => {
    if (!contextMenuOpen) return;
    const onDocPointerDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node;
      if (contextMenuRef.current?.contains(target)) return;
      if (contextMenuButtonRef.current?.contains(target)) return;
      setContextMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setContextMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenuOpen]);

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
    if (pendingSkills.some((pending) => pending.id === skill.id)) {
      setPendingSkills(pendingSkills.filter((pending) => pending.id !== skill.id));
      return;
    }
    if (pendingSkills.length >= SKILLS_PER_TURN_MAX) {
      toast.info(`You can apply up to ${SKILLS_PER_TURN_MAX} skills per message.`);
      return;
    }
    setPendingSkills([...pendingSkills, skill]);
  }, [pendingSkills]);

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
      enterCreateCommand();
      setLeadMagnetCreateOpen(false);
      setLeadMagnetPickerOpen(false);
      toast.success("Lead magnet will be created after the draft");
    },
    [
      aiLeadMagnetLimitReached,
      enterCreateCommand,
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
  // An AI refine in flight per chat: the draft card the user asked to refine.
  // The direct lane reuses `artifactId` and replaces that card after canonical
  // persistence. The kill-switch baseline can still emit a sibling card, so
  // this ref also keeps the legacy collapse and hook-preservation metadata.
  const pendingRefineRef = useRef<
    Map<string, { artifactId?: string; hookOnly?: boolean; originalBody?: string }>
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
        // The ref mirrors every scoped attachment update synchronously, so two
        // quick async picks cannot both calculate from the same stale render.
        const current = readChatScopedList(
          attachmentsByChatRef.current,
          activeIdRef.current,
        );
        const next = [...current];
        let bytes = current.reduce((n, attachment) => n + attachment.size, 0);
        for (const attachment of picked) {
          if (next.length >= MAX_ATTACHMENTS) {
            oversize = true;
            break;
          }
          if (bytes + attachment.size > MAX_TOTAL_BYTES) {
            aggregateExceeded = true;
            break;
          }
          next.push(attachment);
          bytes += attachment.size;
        }
        setAttachments(next);
      }
      if (oversize) toast.error(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      if (aggregateExceeded)
        toast.error(`Attachments are too large in total (max ${MAX_TOTAL_MB}MB).`);
      // Allow re-picking the same file later.
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [setAttachments],
  );

  const removeAttachment = useCallback(
    (localId: string) => {
      setAttachments((a) => a.filter((x) => x.localId !== localId));
    },
    [setAttachments],
  );

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
    let handoffChatId: string | null = null;
    (async () => {
      try {
        const previousActiveId = activeId;
        // A model-source handoff should always land on a fresh Cowork chat. On
        // soft navigations the server may pass initialChatId=null, but this
        // mounted client component keeps its old activeId unless we clear it.
        setActiveId(null);
        setInput("");
        setModelSource(null);
        if (previousActiveId) {
          const previousRun = chatSession.runFor(previousActiveId);
          // A stopped/settled run should not keep the next contextual handoff
          // visually or logically tied to the paused chat. Leave genuinely live
          // background streams alone; this only sweeps stale local guard state.
          if (previousRun && (previousRun.stopped || !previousRun.streaming)) {
            chatSession.retireRun(previousActiveId, previousRun);
          }
          chatSession.releaseSend(previousActiveId);
          chatSession.clearLastSend(previousActiveId);
        }
        chatSession.releaseSend("__new__");
        chatSession.clearLastSend("__new__");

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
        setChats((chats) => prependChatIfMissing(chats, chatData.chat));
        chatSession.ensureConversation(chatData.chat.id);
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
        const newChatId: string = chatData.chat.id;
        handoffChatId = newChatId;
        setModelSourceChatId(newChatId);
        setForcedDraftByChat((prev) => ({ ...prev, [newChatId]: intent.prompt }));
        writeDraft(newChatId, intent.prompt);
        preserveCommandOnNextChatChangeRef.current = newChatId;
        setActiveId(newChatId);
        setPendingPostFormat(null);
        setPostFormatPickerOpen(false);
        setPendingLeadMagnet(null);
        setLeadMagnetPickerOpen(false);
        setPendingCreatorStyle(null);
        setCreatorStylePickerOpen(false);
        setContextMenuOpen(false);
        if (intent.command === "create") {
          enterCreateCommand(intent.count ?? 1);
        } else {
          setCoworkComposer({ kind: "ask" });
        }
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
          if (activeIdRef.current === newChatId) {
            writeDraft(newChatId, intent.prompt);
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
        if (!cancelled) {
          router.replace(
            handoffChatId
              ? modelHandoffDestination(handoffChatId)
              : "/dashboard",
          );
        }
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
      preserveCommandOnNextChatChangeRef.current =
        activeId === null ? undefined : null;
      setActiveId(null);
      setInput("");
      setModelSource(null);
      setPendingPostFormat(null);
      setPostFormatPickerOpen(false);
      setPendingLeadMagnet(null);
      setLeadMagnetPickerOpen(false);
      setCreatorStylePickerOpen(false);
      setContextMenuOpen(false);
      setPendingCreatorStyle(match);
      enterCreateCommand();
      /* eslint-enable react-hooks/set-state-in-effect */
    }
    router.replace("/dashboard");
    // Re-run when the param or the loaded styles change (the styles fetch may
    // land after this effect first runs with an empty list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleParam, creatorStyles]);

  // Prefill the composer from a starter chip. If the prompt has a [placeholder]
  // (e.g. a topic the user must fill), focus the input and select that span so
  // they can type straight over it; otherwise drop the cursor at the end.
  const prefillPrompt = useCallback((starter: Starter) => {
    const { id, prompt } = starter;
    setCoworkComposer({ kind: starter.command });
    if (starter.command === "create" && draftCountSelection === "auto") {
      setDraftCountSelection(1);
    }
    writeComposerDraft(activeIdRef.current, { text: prompt, starterId: id });
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
  }, [draftCountSelection]);

  // ----- chat list management -----

  const loadChat = useCallback(
    async (id: string, options: { pushHistory?: boolean } = {}) => {
      if (id === activeId) return;
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("chat", id);
        url.searchParams.delete("model");
        url.searchParams.delete("intent");
        url.searchParams.delete("handoff");
        url.searchParams.delete("new");
        if (options.pushHistory !== false) {
          localChatNavigationRef.current = id;
          window.history.pushState(window.history.state, "", url);
        }
      } catch {
        /* URL history is best-effort; loading the chat must still proceed. */
      }
      try {
        await chatSession.select(id, async () => {
          const res = await fetch(`/api/chats/${id}`);
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || "Failed to load chat");
          const rows = data.messages as RawDbMessage[];
          return {
            messages: hydrate(rows),
            artifacts: rows.flatMap((message) => message.artifacts ?? []),
            running: (data.chat as { running?: boolean } | undefined)?.running,
            livePlan: normalizeLivePlan(
              (data.chat as { live_plan?: unknown } | undefined)?.live_plan,
            ),
          };
        });
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [activeId, chatSession],
  );

  const selectedChatParam = searchParams.get("chat");
  useEffect(() => {
    if (localChatNavigationRef.current) {
      if (selectedChatParam === localChatNavigationRef.current) {
        localChatNavigationRef.current = null;
      }
      return;
    }
    if (!selectedChatParam) return;
    if (
      !shouldSyncSelectedChat(
        selectedChatParam,
        chatSession.snapshot().activeId,
        pendingNewChatRef.current !== null,
      )
    ) {
      return;
    }
    void loadChat(selectedChatParam, { pushHistory: false });
  }, [selectedChatParam, loadChat, chatSession]);

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
    if (chatSession.runFor(reattachingChatId)) return;
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
          if (!chatSession.hasRun(id)) {
            const nextBase = hydrate(data.messages);
            const prevBase = chatSession.baseMessages(id);
            const prevLast = prevBase[prevBase.length - 1]?.id ?? null;
            const nextLast = nextBase[nextBase.length - 1]?.id ?? null;
            if (prevBase.length !== nextBase.length || prevLast !== nextLast) {
              chatSession.reconcile(
                id,
                nextBase,
                data.messages.flatMap((m) => m.artifacts ?? []),
              );
            }
          }
          // Turn settled (or a local run took over) → stop reattaching + drop
          // the checklist so the persisted reply is what shows.
          if (data.chat?.running !== true || chatSession.hasRun(id)) {
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
  }, [
    reattachingChatId,
    activeId,
    setReattachPlan,
    setReattachingChatId,
    chatSession,
  ]);

  // Mount-time reattach probe. The component initializes the active chat from
  // SSR props (initialChatId/initialMessages) WITHOUT calling loadChat, so the
  // reattach detection there never runs for the chat we land on after a hard
  // navigation. Probe that one chat's running state once on mount so returning
  // mid-turn shows the "still working…" indicator + kicks the poll. Runs only
  // when we have an initial chat and no live local run for it.
  useEffect(() => {
    if (!initialChatId) return;
    if (chatSession.runFor(initialChatId)) return;
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
          !chatSession.runFor(initialChatId)
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
  // Lead-magnet image live-feedback poll.
  //
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
        if (chatSession.hasRun(id)) return;
        const nextBase = hydrate(data.messages);
        chatSession.reconcile(
          id,
          nextBase,
          data.messages.flatMap((m) => m.artifacts ?? []),
        );
      } catch {
        /* transient — next tick retries */
      } finally {
        if (!stopped) {
          timer = setTimeout(
            () => void tick(),
            typeof document !== "undefined" && document.hidden ? HIDDEN_POLL_MS : IMAGE_ARTIFACT_POLL_MS,
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
    chatSession,
  ]);

  // Start a new chat: PERSIST the session on click (it shows in the history and
  // survives navigation immediately), but never stack empties — the server's
  // reuseEmpty guard returns the existing empty "New chat" instead of inserting
  // another, so mashing "New session" lands on the same persisted session every
  // time. An empty active chat still renders the starter home (that UI is gated
  // on messages.length, not activeId). On any failure, fall back to the old
  // lazy behavior (clear activeId; send() creates the row on first message).
  // (A running chat keeps streaming in the background — switching away doesn't
  // abort it.)
  const newChat = useCallback(async () => {
    setInput("");
    enterCreateCommand();
    // Starting a session transitions through the temporary null owner and then
    // the persisted chat id. Preserve Create across both transitions; ordinary
    // sidebar switches still reset to Ask in the activeId effect above.
    preserveCommandOnNextChatChangeRef.current = null;
    // Sever send ownership from the previous chat before the eager create's
    // first await. Users can start typing immediately; send() waits for the
    // pending destination below instead of leaking that turn into the old chat.
    writeDraft(null, "");
    setActiveId(null);
    setAttachments([]);
    setModelSource(null);
    setPendingPostFormat(null);
    setPostFormatPickerOpen(false);
    setPendingLeadMagnet(null);
    setLeadMagnetPickerOpen(false);
    setPendingCreatorStyle(null);
    setCreatorStylePickerOpen(false);
    setContextMenuOpen(false);
    const request = (async (): Promise<string | null> => {
      try {
        const res = await fetch("/api/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reuseEmpty: true }),
        });
        const data = await res.json();
        if (!data.ok || !data.chat?.id) {
          throw new Error(data.error || "create failed");
        }
        const chat = data.chat as ChatSummary;
        // A reused chat is usually already in the list — dedupe by id so the
        // history never shows the same session twice.
        setChats((chats) => prependChatIfMissing(chats, chat));
        chatSession.ensureConversation(chat.id);
        // Purge context inherited from an earlier life of a REUSED empty chat,
        // but preserve anything the user typed after clicking New while this
        // request was in flight. Seed before activating so the draft-swap reads
        // the new text instead of clearing it.
        const typedDuringCreate = inputRef.current?.value ?? readDraft(null);
        moveComposerDraft(null, chat.id, typedDuringCreate);
        setForcedDraftByChat((prev) => {
          if (!(chat.id in prev)) return prev;
          const next = { ...prev };
          delete next[chat.id];
          return next;
        });
        setRefiningByChat((prev) => {
          if (!(chat.id in prev)) return prev;
          const next = { ...prev };
          delete next[chat.id];
          return next;
        });
        preserveCommandOnNextChatChangeRef.current = chat.id;
        setActiveId(chat.id);
        // Reflect the session in the URL (same replaceState pattern as send()'s
        // lazy create) so navigating away and back deterministically re-opens it.
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("chat", chat.id);
          url.searchParams.delete("new");
          window.history.replaceState(window.history.state, "", url);
          localChatNavigationRef.current = chat.id;
        } catch {
          /* URL sync is best-effort */
        }
        return chat.id;
      } catch {
        // Persisting failed — send() will use the normal lazy-create path.
        setActiveId(null);
        return null;
      } finally {
      }
    })();
    pendingNewChatRef.current = request;
    try {
      await request;
    } finally {
      if (pendingNewChatRef.current === request) {
        pendingNewChatRef.current = null;
      }
    }
  }, [enterCreateCommand, setActiveId, setAttachments, chatSession]);

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
      chatSession.retireRun(id);
      try {
        const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to delete chat");
        chatSession.deleteConversation(id);
        setChats((c) => c.filter((x) => x.id !== id));
        if (id === activeId) setActiveId(null);
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
    [activeId, router, setActiveId, chatSession],
  );

  // ----- sending a message (SSE stream) -----

  const send = useCallback(async (
    overrideText?: string,
    sendOpts?: {
      command?: CoworkCommand;
      retryOfUserMessageId?: string;
      actionSelectionIds?: string[];
      clarificationChoiceIndex?: number;
      clarificationAssistantMessageId?: string;
    },
  ) => {
    // Caller passes overrideText to send a specific message without going
    // through the composer input — used by the "Continue" recovery button on
    // a cut-off/truncated assistant turn. Default path reads `input`.
    // Every ordinary browser turn carries one explicit command. Retry and a
    // pending structured answer replay server-persisted authority instead.
    let text = (overrideText ?? input).trim();
    if (!text) return;

    if (
      overrideText === undefined &&
      composerCommandKind === "edit" &&
      !editTargetPost
    ) {
      toast.error("Select a Post before editing.");
      return;
    }

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
            const range = firstPlaceholderRange(el.value);
            if (range) el.setSelectionRange(range[0], range[1]);
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
    const targetChatId = await chatIdAfterPendingNewSession(
      pendingNewChatRef.current,
      // The session runtime is the ownership source of truth. A ref mirrored
      // from React effects can temporarily describe the previous render while
      // an eager New-session create and an immediate submit overlap.
      () => chatSession.snapshot().activeId,
    );
    const lockKey = targetChatId ?? "__new__";
    // The session runtime owns the layered in-flight, live-run, and identical-
    // prompt guards so rapid submits cannot bypass run ownership.
    const sendLease = await chatSession.send({
      lockKey,
      text,
      // Retry is an explicit user command tied to a persisted failed turn. It
      // must bypass only the recent-identical-text window; in-flight and live-
      // run ownership guards remain mandatory.
      bypassDedupeWindow: Boolean(sendOpts?.retryOfUserMessageId),
    }) as
      | ChatSendLease
      | undefined;
    if (!sendLease) return;

    try {
      // If a "Model this post" source is attached, send only its id — the server
      // fetches the (already-neutralized) post text and weaves it into the agent
      // envelope. This keeps the visible/persisted user message clean (no giant
      // delimiter blob on reload) and avoids hitting the 8000-char message cap
      // with a long modeled post. Keep the chip selected until the stream
      // starts: a pre-stream failure means no user message was created and the
      // user should be able to retry without reattaching it.
      const attached = modelSource;
      const turnPostFormatApplies = clientShouldApplyPostFormat(text, !!attached);

      // Capture the pending custom skills for this turn. We do NOT clear the
      // composer chip here — clearing it now but only registering the user
      // message (which carries the same skill as a bubble badge) LATER opens a
      // visible gap: for a brand-new chat there's an `await fetch("/api/chats")`
      // between, so the chip vanishes for a whole round-trip before the badge
      // appears. Instead we clear pendingSkills in the SAME synchronous batch
      // as run registration below, so the chip→badge handoff is one
      // frame with no flicker. (turnSkills is already captured, so the send
      // uses it regardless of when the state clears.)
      const turnSkills = pendingSkills;
      const turnPostFormat = pendingPostFormat;
      const turnLeadMagnet = leadMagnetPickerDisabled ? null : pendingLeadMagnet;
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
      // The Ask-card submission callback always supplies this field, including
      // an empty array for free-text/non-board answers. Presence means "resume
      // the persisted pending operation"; checking length would accidentally
      // compile an empty-selection answer as a brand-new Ask command.
      const resumesPersistedOperation = resumesPersistedCoworkOperation({
        ...(sendOpts?.retryOfUserMessageId
          ? { retryOfUserMessageId: sendOpts.retryOfUserMessageId }
          : {}),
        ...(sendOpts?.actionSelectionIds !== undefined
          ? { actionSelectionIds: sendOpts.actionSelectionIds }
          : {}),
        ...(sendOpts?.clarificationAssistantMessageId
          ? {
              clarificationAssistantMessageId:
                sendOpts.clarificationAssistantMessageId,
            }
          : {}),
      });
      const appliesComposerControls =
        overrideText === undefined &&
        !resumesPersistedOperation &&
        !sendOpts?.command;
      const turnCommand =
        resumesPersistedOperation
          ? undefined
          : sendOpts?.command ??
            commandForComposer({
              kind: composerCommandKind,
              count:
                draftCountSelection === "auto" ? 1 : draftCountSelection,
              ...(composerCommandKind === "ask" && askContextPost
                ? { contextPostId: askContextPost.artifactId }
                : {}),
              ...(effectiveCoworkComposer.kind === "edit" && editTargetPost
                ? {
                    targetPostId: editTargetPost.artifactId,
                    scope: effectiveCoworkComposer.scope,
                  }
                : {}),
            });
      const turnStarterOwnerId = targetChatId;
      const turnStarterId = appliesComposerControls
        ? readComposerDraft(turnStarterOwnerId).starterId ?? undefined
        : undefined;
      let turnGenerationConfig = appliesComposerControls
        ? generationConfigForSelection(draftCountSelection, postTypeSelection)
        : undefined;
      // These are only the skills explicitly selected for this turn. Target
      // skill inheritance is a server-owned operation rule.
      const turnSkillIds = turnSkills.map((skill) => skill.id);
      setSkillPickerOpen(false);
      setPostFormatPickerOpen(false);
      setCreatorStylePickerOpen(false);
      setLeadMagnetPickerOpen(false);
      setGenerationSettingsOpen(false);
      setContextMenuOpen(false);

      // Capture + consume file attachments for this turn.
      const files = attachments;
      if (files.length) setAttachments([]);
      const filePayload = files.map((f) => ({
        kind: f.kind,
        filename: f.filename,
        ...(f.kind === "text" ? { text: f.text } : { dataUrl: f.dataUrl }),
      }));

      let resolvedId = targetChatId;
      // Lazily create a chat on the first message if none is active.
      if (!resolvedId) {
        try {
          const res = await fetch("/api/chats", { method: "POST" });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || "Failed to create chat");
          resolvedId = data.chat.id as string;
          setChats((chats) => prependChatIfMissing(chats, data.chat));
          chatSession.ensureConversation(resolvedId);
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
            url.searchParams.delete("new");
            window.history.replaceState(window.history.state, "", url);
            localChatNavigationRef.current = resolvedId;
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
          chatSession.clearLastSend(lockKey);
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
        chatSession.recordLastSend(chatId, text);
      }

      // The browser creates operations only for explicit UI actions. Ordinary
      // composer text carries the selected card as non-authoritative context;
      // the server owns all language interpretation and target validation.
      const explicitEditCommand =
        turnCommand?.kind === "edit"
          ? turnCommand
          : null;
      const refineThisTurn = Boolean(explicitEditCommand);
      const refineTargetIdThisTurn = explicitEditCommand?.targetPostId;
      const persistedArtifacts = chatSession.artifactsFor(chatId);
      const liveArtifacts = chatSession.runFor(chatId)?.artifacts ?? [];
      const seenIds = new Set(persistedArtifacts.map((artifact) => artifact.id));
      const combined = [
        ...persistedArtifacts,
        ...liveArtifacts.filter((artifact) => !seenIds.has(artifact.id)),
      ];
      const writableArtifacts = combined.filter(
        (artifact) => artifact.kind === "post" || artifact.kind === "hook",
      );
      if (refineThisTurn && refineTargetIdThisTurn) {
        const target = writableArtifacts.find(
          (artifact) => artifact.id === refineTargetIdThisTurn,
        );
        if (target && !pendingRefineRef.current.get(chatId)) {
          pendingRefineRef.current.set(chatId, {
            artifactId: target.id,
            originalBody: target.body,
            ...(explicitEditCommand?.scope === "hook"
              ? { hookOnly: true }
              : {}),
          });
        }
      }
      if (refineThisTurn) turnGenerationConfig = undefined;

      // Only clear the composer when sending what the user actually typed —
      // a programmatic send (recovery button, etc.) shouldn't wipe their
      // in-progress draft.
      if (!overrideText) setInput("");
      const clientTurnId = crypto.randomUUID();
      const userMsg: Message = {
        id: `u_${Date.now()}`,
        role: "user",
        text,
        clientTurnId,
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
        ...(attached
          ? {
              modelSource: {
                ...attached,
                state: "available" as const,
              },
            }
          : {}),
      };
      const assistantId = `a_${Date.now()}`;
      const ctrl = new AbortController();

      // A recovery retry can race the server's final claim release after a
      // transport stall. Keep the settled recovery overlay so a transient 409
      // cannot replace it with a failed run and make the Retry action vanish.
      const previousRun = chatSession.runFor(chatId);
      const recoverableFallbackRun =
        previousRun && !previousRun.streaming && previousRun.recoverable
          ? previousRun
          : null;

      // Register this turn as the chat's live run, keyed by chatId. All stream
      // updates below mutate THIS run (chatId is captured), so they keep landing
      // on the right chat even after the user switches away.
      const run: ChatRun = {
        userMsg,
        assistantId,
        rawText: "",
        contentFormat: writerContentFormat,
        tools: [],
        plan: [],
        artifacts: [],
        streaming: true,
        ctrl,
        clientTurnId,
      };
      chatSession.registerRun(chatId, run);
      // Clear the composer's skill chip HERE — in the same batch as the run
      // registration that renders the user message (which shows the
      // skill as a bubble badge). Same frame = the chip moves from composer to
      // bubble with no intermediate "skill gone" flash. (turnSkills was
      // captured above; clearing the state now doesn't affect this send.)
      if (turnSkills.length) setPendingSkills([]);
      if (turnPostFormat) setPendingPostFormat(null);
      if (turnLeadMagnet) setPendingLeadMagnet(null);
      if (turnCreatorStyle) setPendingCreatorStyle(null);
      if (turnStarterId) clearComposerStarter(turnStarterOwnerId);
      if (turnCommand) {
        setCoworkComposer({ kind: "ask" });
      }

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
      let recoverableTransportFailure = false;

      try {
        const res = await fetchChatStream(`/api/chats/${chatId}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            clientTurnId,
            clientTimezone:
              Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            ...(sendOpts?.retryOfUserMessageId
              ? { retryOfUserMessageId: sendOpts.retryOfUserMessageId }
              : {}),
            ...(sendOpts?.actionSelectionIds?.length
              ? { actionSelectionIds: sendOpts.actionSelectionIds }
              : {}),
            ...(sendOpts?.clarificationChoiceIndex !== undefined
              ? { clarificationChoiceIndex: sendOpts.clarificationChoiceIndex }
              : {}),
            ...(sendOpts?.clarificationAssistantMessageId
              ? {
                  clarificationAssistantMessageId:
                    sendOpts.clarificationAssistantMessageId,
                }
              : {}),
            ...(attached ? { modelSourceId: attached.id } : {}),
            ...(filePayload.length ? { attachments: filePayload } : {}),
            ...(turnCommand ? { command: turnCommand } : {}),
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
            // Context is scoped to this turn. Stamp explicit clears for every
            // unselected binding so a later opt-in cannot revive a stale skill,
            // creator style, or format from behind this turn.
            ...(appliesComposerControls
              ? {
                  contextPolicy: {
                    clear: [
                      ...(turnSkillIds.length ? [] : ["skills"]),
                      ...(turnCreatorStyle && turnCreatorStyleApplies
                        ? []
                        : ["creator_style"]),
                      ...(turnPostFormat ? [] : ["post_format"]),
                    ],
                  },
                }
              : {}),
            ...(turnGenerationConfig
              ? { generationConfig: turnGenerationConfig }
              : {}),
            ...(turnStarterId ? { starterId: turnStarterId } : {}),
          }),
        }, ctrl.signal, {
          timeoutMs: chatSetupDeadlines({
            hasImageAttachment: filePayload.some((file) => file.kind === "image"),
            createsLeadMagnet: Boolean(
              turnLeadMagnet &&
                turnLeadMagnetApplies &&
                isCreateAfterDraftLeadMagnet(turnLeadMagnet),
            ),
          }).clientMs,
        });
        chatSession.updateRun(chatId, run, (ownedRun) => {
          ownedRun.turnStartedAt =
            res.headers.get("X-Turn-Started-At") ?? undefined;
          applyPersistedUserMessageId(
            ownedRun,
            res.headers.get("X-User-Message-Id"),
          );
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({}));
          const e = new Error(err.error || `Stream failed (${res.status})`);
          (e as Error & { status?: number }).status = res.status;
          if (res.status === 504) {
            (e as Error & { code?: string }).code = "stream_stalled";
          }
          throw e;
        }
        streamStarted = true;
        if (attached) {
          setModelSource((current) =>
            current?.id === attached.id ? null : current,
          );
        }
        // A send got through — clear any stale limit banner.
        setLimitNotice(null);

        await chatSession.consumeRun(chatId, run, res.body, (ownedRun, event, data) => {
          // Stop fired between frames — drop this one; the finally settles the UI.
          if (ctrl.signal.aborted) return;
          if (event === "text") {
            ownedRun.rawText += data.delta as string;
          } else if (event === "tool_start") {
            ownedRun.tools = [
              ...ownedRun.tools,
              {
                id: data.id as string,
                name: data.name as string,
                args: data.args as string | undefined,
              },
            ];
          } else if (event === "tool_end") {
            ownedRun.tools = ownedRun.tools.map((t) =>
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
          } else if (event === "plan" || event === "plan_update") {
            // The agent's live checklist. Both events carry the FULL ordered
            // step list — REPLACE, don't merge — so a re-plan can't leave a
            // stale step on screen and a finalize closes every step at once.
            ownedRun.plan = (data.steps as PlanStep[]) ?? [];
          } else if (event === "ask") {
            // The agent asked a clarifying question and is ending the turn. Store
            // it so the bubble renders the interactive AskCard.
            ownedRun.ask = data as unknown as AskQuestion;
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
            const isWritableArtifact =
              incoming.kind === "post" || incoming.kind === "hook";
            // Re-sent artifact id (e.g. a cite backfilling its draft's
            // source_url after the draft already streamed) → REPLACE the card
            // already on screen, not a second copy of it.
            if (ownedRun.artifacts.some((a) => a.id === incoming.id)) {
              ownedRun.artifacts = replaceOrAppendArtifact(ownedRun.artifacts, incoming);
              if (isWritableArtifact && chatId === activeIdRef.current) {
                setPanelOpen(true);
              }
              return;
            }
            // Direct AI refine: the server reuses the target id, so this run
            // carries one replacement until its assistant row is persisted.
            // The baseline path may still return a new id and uses the two
            // legacy client guardrails below:
            //   (a) hook-only refines graft the new hook onto the ORIGINAL body,
            //       so paragraph formatting isn't lost when GLM over-rewrites.
            //   (b) collapse guard: if GLM shrunk a real post into a fragment,
            //       we drop the fragment entirely rather than shipping garbage.
            const pending = pendingRefineRef.current.get(chatId);
            if (pending && isWritableArtifact) {
              // The direct refine lane reuses the target id. Keep the streamed
              // result as one replacement and wait for canonical persistence
              // before the draft panel swaps the saved card.
              if (pending.artifactId === incoming.id) {
                ownedRun.artifacts = replaceOrAppendArtifact(
                  ownedRun.artifacts,
                  incoming,
                );
                pendingRefineRef.current.delete(chatId);
                if (chatId === activeIdRef.current) setPanelOpen(true);
                return;
              }
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
                ownedRun.artifacts = [...ownedRun.artifacts, effective];
              }
              // A refine produces ONE draft — clear so the next incoming (if
              // any) is treated as a plain append.
              pendingRefineRef.current.delete(chatId);
            } else {
              ownedRun.artifacts = [...ownedRun.artifacts, incoming];
            }
            // Drafts live in the right-hand panel — open it (only for the chat
            // on screen) so a freshly generated post is immediately visible.
            if (isWritableArtifact && chatId === activeIdRef.current) {
              setPanelOpen(true);
            }
          } else if (event === "done") {
            // A failed turn that delivered nothing shouldn't show a credit
            // line — "~1 credit" next to a dead-end error reads as "you were
            // charged for nothing." The `error` frame for a recoverable
            // failure always precedes `done` in the same turn, so
            // run.recoverable is already set by the time this runs. Mirrors
            // the same suppression chat-turn.ts applies to the PERSISTED
            // usage marker, so live and post-reload rendering agree.
            ownedRun.usage =
              ownedRun.recoverable && ownedRun.artifacts.length === 0
                ? undefined
                : (parseCoworkTurnUsage(data.usage) ?? undefined);
          } else if (event === "error") {
            const code = String(data.code ?? "");
            const message = (data.message as string) || "";
            const recovery = data.recovery as "continue" | undefined;
            // RECOVERABLE errors (cut-off / tool-budget exhausted) attach to
            // the assistant bubble so the user gets a one-click recovery
            // button — not a toast. Non-recoverable errors stay as toasts
            // with friendlier copy for known provider categories.
            if (recovery === "continue") {
              ownedRun.recoverable = { code, message, recovery: "continue" };
            } else if (code === "429" || /rate.?limit/i.test(message)) {
              toast.error("The AI provider is rate-limiting us — try again in a moment.");
            } else if (code === "content_filter" || /content.?filter/i.test(message)) {
              toast.error("The model's safety filter blocked that. Try rephrasing.");
            } else if (code === "stream_stalled" || /stall/i.test(message)) {
              // The model connection went quiet mid-stream (vs. a hard timeout).
              // Offer a one-click Continue — picking up usually works.
              ownedRun.recoverable = {
                code: "stream_stalled",
                message: "The model went quiet mid-response.",
                recovery: "continue",
              };
            } else if (/timeout/i.test(message)) {
              toast.error("The model timed out. Try a shorter request.");
            } else {
              toast.error(message || "The assistant hit an error");
            }
          }
        }, ctrl.signal);
      } catch (e) {
        const status = (e as Error & { status?: number }).status;
        const code = (e as Error & { code?: string }).code;
        if ((e as Error).name === "AbortError") {
          streamAborted = true;
          chatSession.updateRun(chatId, run, (ownedRun) => {
            if (
              !ownedRun.stopPending &&
              !ownedRun.rawText.trim() &&
              ownedRun.artifacts.length === 0
            ) {
              ownedRun.rawText = STOPPED_EMPTY_MESSAGE;
            }
          });
        } else if (code === "stream_stalled" || code === "stream_ended_early") {
          // The browser has its own transport watchdog in addition to the
          // provider watchdog. This catches silence before response headers,
          // silence between route frames, and an EOF without a terminal event.
          // Keep the partial reply visible and offer Continue instead of
          // leaving an endless spinner or silently accepting truncated prose.
          recoverableTransportFailure = true;
          streamAborted = true;
          chatSession.updateRun(chatId, run, (ownedRun) => {
            ownedRun.plan = [];
            ownedRun.tools = ownedRun.tools.map((tool) =>
              tool.ok === undefined ? { ...tool, ok: false } : tool,
            );
            ownedRun.recoverable = {
              code,
              message:
                code === "stream_ended_early"
                  ? "The response ended before it finished."
                  : "Cowork stopped receiving updates.",
              recovery: "continue",
            };
          });
          void requestServerTurnStop({
            chatId,
            identity: {
              clientTurnId: run.clientTurnId,
              turnStartedAt: run.turnStartedAt,
            },
            recoverable: true,
          }).catch(() => {});
        } else if (status === 429) {
          // Rate / usage limit: show a persistent banner (not a fleeting toast)
          // so it's clear chat is paused but the rest of the app still works.
          setLimitNotice((e as Error).message);
        } else {
          toast.error((e as Error).message);
        }
        // Pre-stream failure: nothing was saved server-side. Drop the run and
        // give the text/files back; the modeled source remains selected until
        // a stream has actually opened.
        if (!streamStarted && !recoverableTransportFailure && !run.stopPending) {
          chatSession.retireRun(chatId, run);
          if (status === 409 && recoverableFallbackRun) {
            chatSession.registerRun(chatId, { ...recoverableFallbackRun });
            toast.info("Cowork is still finishing the previous attempt. Retry again in a moment.");
          }
          const failedChatIsActive = activeIdRef.current === chatId;
          const activeComposerIsEmpty = inputRef.current?.value.length === 0;
          // The request may settle after the user has switched sessions or typed
          // a compose-ahead message. Restore only the failed chat's empty draft
          // slot; never replace a newer draft in this or another session.
          if (failedChatIsActive && activeComposerIsEmpty) {
            writeDraft(chatId, text);
            setInput(text);
          } else if (!failedChatIsActive && !readDraft(chatId)) {
            writeDraft(chatId, text);
          }
          // Composer accessories are not keyed by chat, so restoring them while
          // another session is active would overwrite that session's choices.
          if (failedChatIsActive && activeComposerIsEmpty) {
            if (files.length) setAttachments(files);
            if (turnSkills.length) setPendingSkills(turnSkills);
            if (turnPostFormat) setPendingPostFormat(turnPostFormat);
            if (turnLeadMagnet) setPendingLeadMagnet(turnLeadMagnet);
            if (turnCreatorStyle) setPendingCreatorStyle(turnCreatorStyle);
            if (turnStarterId) {
              writeComposerDraft(chatId, { text, starterId: turnStarterId });
            }
            if (turnCommand?.kind === "ask") {
              setCoworkComposer({
                kind: "ask",
                ...(turnCommand.contextPostId
                  ? { contextPostId: turnCommand.contextPostId }
                  : {}),
              });
            } else if (turnCommand?.kind === "create") {
              enterCreateCommand(turnCommand.count);
            } else if (turnCommand?.kind === "edit") {
              setCoworkComposer({
                kind: "edit",
                targetPostId: turnCommand.targetPostId,
                scope: turnCommand.scope,
              });
            }
          }
          return;
        }
      } finally {
        chatSession.updateRun(chatId, run, (ownedRun) => {
          if (ctrl.signal.aborted || ownedRun.stopped) {
            streamAborted = true;
            if (
              !ownedRun.stopPending &&
              !ownedRun.rawText.trim() &&
              ownedRun.artifacts.length === 0
            ) {
              ownedRun.rawText = STOPPED_EMPTY_MESSAGE;
            }
          }
          if (!ownedRun.stopPending) ownedRun.streaming = false;
        });
        // Clear any UNCONSUMED refine intent for this chat: if the turn ended
        // without producing a draft artifact (errored, aborted, or the agent
        // just replied in text), the pending target must not bleed into the next
        // refine. (A consumed refine already deleted its entry in the artifact
        // handler; refineSwapRef is handled in the post-stream block below.)
        pendingRefineRef.current.delete(chatId);
        // Bump this chat to the top of the list (it just got activity).
        setChats((c) => {
          const idx = c.findIndex((x) => x.id === chatId);
          if (idx <= 0) return c;
          const next = [...c];
          const [moved] = next.splice(idx, 1);
          return [moved, ...next];
        });
      }

      sendLease.release();

      // Stop owns the canonical handoff while its durable server fence is being
      // confirmed. The Stop callback either folds/removes this run after a
      // confirmed tombstone or leaves it visible with an explicit retry-Stop
      // warning. A concurrent reload here could otherwise retire the run first
      // and falsely present an unconfirmed Stop as complete.
      if (run.stopPending) return;

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
      // so the instant the user answered (their send replaces run ownership for
      // this chat, line ~1416), those two rows blinked out until the ANSWER
      // turn's own post-stream reload eventually ran. Folding into base now
      // means the question + card render from `base` (via hydrate) and survive
      // the answer-run swap seamlessly.
      if (run.ask) {
        void maybeAutoTitle(chatId);
        // If the chat was deleted mid-turn, just drop the run.
        if (deletedRef.current.has(chatId)) {
          chatSession.retireRun(chatId, run);
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
          const currentRun = chatSession.runFor(chatId);
          const stillMine = currentRun === run;
          const reloaded =
            data.ok && !deletedRef.current.has(chatId)
              ? hydrate(data.messages as RawDbMessage[])
              : null;
          const askInBase =
            !!reloaded && reloaded.some((m) => m.role === "assistant" && m.ask);
          const currentBase = chatSession.baseMessages(chatId);
          const currentBaseHasAsk = currentBase.some(
            (m) => m.role === "assistant" && !!m.ask,
          );
          const shouldApplyReload =
            !!reloaded && shouldApplyAskTurnReload(currentBase, reloaded);
          if (askInBase && shouldApplyReload) {
            chatSession.reconcile(
              chatId,
              reloaded,
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
            chatSession.retireRun(chatId, run);
          }
        } catch {
          // Reload failed — keep the live ask-run as the fallback source of the
          // question + card (its overlay still renders them) rather than losing
          // the AskCard entirely.
        }
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
      // ONE synchronous session publication. This kills the post-stream
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
        chatSession.retireRun(chatId, run);
        return;
      }
      let completedCanonicalHandoff = false;
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
        const hydrated = data.ok
          ? hydrate(data.messages as RawDbMessage[])
          : null;
        const hasAssistantForThisTurn =
          !!hydrated &&
          hasAssistantAfterPersistedUserMessage(hydrated, userMsg);
        if (
          data.ok &&
          hydrated &&
          chatSession.ownsRun(chatId, run) &&
          !deletedRef.current.has(chatId) &&
          (!streamAborted || hasAssistantForThisTurn)
        ) {
          completedCanonicalHandoff = chatSession.completeRun(
            chatId,
            run,
            hydrated,
            (data.messages as RawDbMessage[]).flatMap((m) => m.artifacts ?? []),
          );
        }
      } catch {
        // Reload failed — keep the live run as the fallback source of the reply
        // (it still holds the streamed text + artifacts) rather than dropping it
        // and showing nothing. The user can switch away and back to reload the
        // canonical persisted result.
        return;
      }
      // If another poll already folded this assistant into base, only retirement
      // remains. The ordinary canonical handoff above is a single session
      // command/publication, so no duplicate base+overlay frame can render.
      if (
        !completedCanonicalHandoff &&
        chatSession.ownsRun(chatId, run) &&
        (!streamAborted ||
          hasAssistantAfterPersistedUserMessage(
            chatSession.baseMessages(chatId),
            userMsg,
          ))
      ) {
        chatSession.retireRun(chatId, run);
      }
    } finally {
      // Belt-and-braces: the lock is normally released above (right after the
      // stream ends), but a throw on the pre-stream path could skip that — so
      // ensure it's always cleared. Idempotent (delete of an absent key no-ops).
      sendLease.release();
    }
  }, [
    input,
    modelSource,
    attachments,
    pendingSkills,
    pendingPostFormat,
    pendingLeadMagnet,
    leadMagnetPickerDisabled,
    pendingCreatorStyle,
    composerCommandKind,
    askContextPost,
    editTargetPost,
    effectiveCoworkComposer,
    draftCountSelection,
    postTypeSelection,
    initialVoiceReady,
    router,
    maybeAutoTitle,
    setAttachments,
    chatSession,
    setActiveId,
    writerContentFormat,
    enterCreateCommand,
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
    const run = chatSession.runFor(activeId);
    if (!run || run.stopPending) return;
    void chatSession.stop(activeId, {
      foldRun: (ownedRun, base) =>
        hasAssistantAfterPersistedUserMessage([...base], ownedRun.userMsg)
          ? [...base]
          : [...base, ...runOverlay(ownedRun, [...base])],
      onStopConfirmed: (ownedRun) => {
        ownedRun.stopped = true;
        ownedRun.recoverable = undefined;
        ownedRun.plan = [];
        ownedRun.tools = [];
        if (!ownedRun.rawText.trim() && ownedRun.artifacts.length === 0) {
          ownedRun.rawText = STOPPED_EMPTY_MESSAGE;
        }
      },
      onStopFailure: async (ownedRun) => {
        try {
          const response = await fetch(`/api/chats/${activeId}`);
          const data = await response.json();
          if (data.ok) {
            const canonical = hydrate(data.messages as RawDbMessage[]);
            if (
              hasAssistantAfterPersistedUserMessage(
                canonical,
                ownedRun.userMsg,
              )
            ) {
              chatSession.completeRun(
                activeId,
                ownedRun,
                canonical,
                (data.messages as RawDbMessage[]).flatMap(
                  (message) => message.artifacts ?? [],
                ),
              );
              return;
            }
          }
        } catch {
          // The visible warning below keeps Stop retryable if reconciliation
          // is unavailable too.
        }
        ownedRun.stopped = false;
        ownedRun.rawText = [
          ownedRun.rawText.trim(),
          "Stop could not be confirmed. Cowork may still be running — press Stop again.",
        ]
          .filter(Boolean)
          .join("\n\n");
        toast.error("Stop was not confirmed. Press Stop again.");
      },
      serverStop: (identity) => requestServerTurnStop({
        chatId: activeId,
        identity,
      }),
    });
  }, [activeId, chatSession]);

  // Jump back to the live bottom of the stream. Clears the scrolled-away flag so
  // auto-scroll re-engages and the button hides.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setUserScrolledAway(false);
  }, []);

  // Reflect a Done-edit's PATCH into the parent's caches so the saved body
  // sticks across re-renders (the stale prop would otherwise seed-reset the
  // ArtifactCard's local body on the next parent render). Patches both
  // the session's persisted artifacts and the live run.
  const updateArtifactBody = useCallback(
    (artifactId: string, newBody: string) => {
      const aid = activeIdRef.current;
      if (!aid) return;
      const apply = (list: readonly Artifact[]): Artifact[] =>
        list.map((a) => (a.id === artifactId ? { ...a, body: newBody } : a));
      const persisted = chatSession.artifactsFor(aid);
      if (persisted?.some((a) => a.id === artifactId)) {
        chatSession.setArtifacts(aid, apply(persisted));
      }
      const run = chatSession.runFor(aid);
      if (run?.artifacts.some((a) => a.id === artifactId)) {
        chatSession.updateRun(aid, run, (ownedRun) => {
          ownedRun.artifacts = apply(ownedRun.artifacts);
        });
      }
    },
    [chatSession],
  );

  const updateArtifactMeta = useCallback(
    async (artifactId: string, metaPatch: Record<string, unknown>) => {
      const aid = activeIdRef.current;
      if (!aid) throw new Error("Couldn't find the chat for this draft.");
      const apply = (list: readonly Artifact[]): Artifact[] =>
        list.map((a) =>
          a.id === artifactId ? { ...a, meta: { ...(a.meta ?? {}), ...metaPatch } } : a,
        );
      const persisted = chatSession.artifactsFor(aid);
      const run = chatSession.runFor(aid);
      const current = [...(persisted ?? []), ...(run?.artifacts ?? [])].find(
        (a) => a.id === artifactId,
      );
      if (!current) throw new Error("Couldn't find this draft in the chat.");
      const updated = { ...current, meta: { ...(current.meta ?? {}), ...metaPatch } };
      const res = await fetch(`/api/chats/${aid}/artifacts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetId: artifactId,
          body: updated.body,
          title: updated.title,
          meta: updated.meta,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        // A conflict means our optimistic basis is stale. Reload the persisted
        // transcript before surfacing the error so the card reflects the winner.
        try {
          const reload = await fetch(`/api/chats/${aid}`, { cache: "no-store" });
          const fresh = await reload.json();
          if (fresh.ok && Array.isArray(fresh.messages)) {
            chatSession.reconcile(
              aid,
              hydrate(fresh.messages as RawDbMessage[]),
              (fresh.messages as RawDbMessage[]).flatMap((m) => m.artifacts ?? []),
            );
          }
        } catch {
          // The persistence error remains authoritative even if reconciliation fails.
        }
        throw new Error(data.error || "Failed to update draft metadata");
      }
      if (persisted?.some((a) => a.id === artifactId)) {
        chatSession.setArtifacts(aid, apply(persisted));
      }
      if (run?.artifacts.some((a) => a.id === artifactId)) {
        chatSession.updateRun(aid, run, (ownedRun) => {
          ownedRun.artifacts = apply(ownedRun.artifacts);
        });
      }
    },
    [chatSession],
  );

  // Delete one draft/hook card from the chat panel. The card lives in the owning
  // assistant message's artifacts (persisted jsonb), so an in-memory-only
  // removal would reappear on reload — we hit the server, then prune both the
  // persisted session cache and the live run's artifacts so it
  // disappears immediately. Optimistic with rollback on failure.
  const deleteArtifact = useCallback(
    async (artifactId: string) => {
      const aid = activeIdRef.current;
      if (!aid) return;
      const run = chatSession.runFor(aid);
      // Capture the deleted artifact + its position from EACH source, so a
      // rollback can RE-INSERT it into the (possibly-changed) current array
      // rather than restoring a stale snapshot. The delete button isn't gated on
      // streaming (unlike refine), so the live run can append a new draft during
      // the await below — blindly restoring the pre-delete snapshot would erase
      // that streamed-in draft. We reconcile against current state instead.
      const persistedBefore = chatSession.artifactsFor(aid);
      const persistedIdx = persistedBefore?.findIndex((a) => a.id === artifactId) ?? -1;
      const persistedDeleted = persistedIdx >= 0 ? persistedBefore![persistedIdx] : undefined;
      const runIdx = run?.artifacts.findIndex((a) => a.id === artifactId) ?? -1;
      const runDeleted = runIdx >= 0 ? run!.artifacts[runIdx] : undefined;
      // Optimistic prune.
      if (persistedBefore) {
        chatSession.setArtifacts(
          aid,
          persistedBefore.filter((a) => a.id !== artifactId),
        );
      }
      if (run) {
        chatSession.updateRun(aid, run, (ownedRun) => {
          ownedRun.artifacts = ownedRun.artifacts.filter(
            (a) => a.id !== artifactId,
          );
        });
      }
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
          chatSession.setArtifacts(
            aid,
            reinsertArtifact(chatSession.artifactsFor(aid), persistedIdx, persistedDeleted),
          );
        }
        if (run && runDeleted) {
          // Use the identity captured before the request. A newer turn may have
          // replaced this run while the delete was in flight; in that case the
          // rollback belongs to the stale run and must be rejected.
          chatSession.updateRun(aid, run, (ownedRun) => {
            ownedRun.artifacts = [
              ...reinsertArtifact(ownedRun.artifacts, runIdx, runDeleted),
            ];
          });
        }
        toast.error((e as Error).message || "Couldn't delete that draft");
      }
    },
    [chatSession],
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
    prefillPrompt(s);
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
  const artifactsList = buildArtifactIndex(artifacts).entries
    .reverse() // newest first
    .map(({ artifact: a, label }) =>
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
          onEdit={() => {
            setExpandedArtifactId(a.id);
            enterEditCommand(a.id);
            setMobileDraftsOpen(false);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          onAsk={() => {
            setCoworkComposer({ kind: "ask", contextPostId: a.id });
            setMobileDraftsOpen(false);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          onBodyChange={(newBody) => updateArtifactBody(a.id, newBody)}
          onMetaChange={(metaPatch) => updateArtifactMeta(a.id, metaPatch)}
          leadMagnetHref={leadMagnetHref}
          // While a turn is streaming in THIS chat, block Edit — a second turn
          // would be rejected by the in-flight guard, so explain it up front.
          editDisabled={sending}
          onDelete={() => deleteArtifact(a.id)}
        />
      ) : (
        <CollapsedDraftRow
          key={a.id}
          label={label ?? kindNoun(a.kind)}
          artifact={a}
          onExpand={() => setExpandedArtifactId(a.id)}
          onDelete={() => deleteArtifact(a.id)}
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
              className="w-full rounded-xl border border-border bg-card/70 pl-8 pr-7 py-2 text-xs outline-none shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] transition focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
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
            aria-label={`Show ${ARTIFACT_PANEL_TITLE.toLowerCase()}`}
          >
            <PanelLeftOpen className="h-3.5 w-3.5" />
            {ARTIFACT_PANEL_TITLE} ({artifacts.length})
          </button>
        )}
        {/* Open the context rail. Shown when the chat has context to show and the
            rail is closed. Sits top-right; when the drafts reopen pill is also
            visible (drafts exist but its panel is collapsed) it drops a row so
            the two never overlap. */}
        {hasContext && !contextPanelOpen && (
          <button
            onClick={() => setContextPanelOpen(true)}
            className={cn(
              "hidden lg:inline-flex absolute right-4 z-10 items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur hover:bg-card transition-colors",
              !panelOpen && hasDraftPanel ? "top-16" : "top-4",
            )}
            aria-label="Show chat context"
          >
            <Layers className="h-3.5 w-3.5" />
            Context
          </button>
        )}
        <div
          ref={scrollRef}
          className={cn(
            "cowork-chat-canvas flex-1 px-3 sm:px-6",
            messages.length === 0 && !loadingChatId
              ? "overflow-y-auto py-3 sm:py-4"
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
            <div className={cn("mx-auto flex max-w-4xl flex-col pb-2", "gap-7")}>
              {messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    legacyContentFormat={writerContentFormat}
                  onRetry={async () => {
                    let originalTask = retryTask(messages, m.id);
                    let canonicalSettledWithoutRetry = false;
                    let canonicalTerminalReason:
                      | Message["terminalReason"]
                      | undefined;
                    const ownedRun = activeId
                      ? chatSession.runFor(activeId)
                      : undefined;
                    if (
                      originalTask &&
                      ownedRun?.assistantId === m.id &&
                      activeId
                    ) {
                      originalTask = null;
                      try {
                        const response = await fetch(`/api/chats/${activeId}`);
                        const data = await response.json();
                        if (data.ok) {
                          const canonical = hydrate(
                            data.messages as RawDbMessage[],
                          );
                          originalTask =
                            persistedRetryTaskForUserMessage(
                              canonical,
                              ownedRun.userMsg,
                            );
                          const canonicalArtifacts = (
                            data.messages as RawDbMessage[]
                          ).flatMap((message) => message.artifacts ?? []);
                          const canonicalTerminal =
                            ownedRun.assistantId === m.id
                              ? assistantAfterPersistedUserMessage(
                              canonical,
                              ownedRun.userMsg,
                                )
                              : undefined;
                          if (canonicalTerminal) {
                            canonicalTerminalReason =
                              canonicalTerminal.terminalReason;
                            chatSession.completeRun(
                              activeId,
                              ownedRun,
                              canonical,
                              canonicalArtifacts,
                            );
                            canonicalSettledWithoutRetry = !originalTask;
                          } else {
                            chatSession.reconcile(
                              activeId,
                              canonical,
                              canonicalArtifacts,
                            );
                          }
                        }
                      } catch {
                        originalTask = null;
                      }
                    }
                    if (originalTask) {
                      void send(originalTask.text, {
                        retryOfUserMessageId: originalTask.userMessageId,
                      });
                    } else if (canonicalSettledWithoutRetry) {
                      if (
                        !canonicalTerminalReason ||
                        canonicalTerminalReason === "done" ||
                        canonicalTerminalReason === "ask"
                      ) {
                        toast.info("That turn already completed successfully.");
                      } else if (canonicalTerminalReason === "error") {
                        toast.error(
                          "That turn ended with an error and cannot be retried safely.",
                        );
                      } else {
                        toast.info(
                          "That turn already ended and cannot be retried safely.",
                        );
                      }
                    } else {
                      toast.info(
                        "Cowork is still reconciling that turn. Retry again in a moment.",
                      );
                    }
                  }}
                  onAnswer={(text, _ask, actionSelectionIds, clarificationChoiceIndex) => {
                    // Ask-card answers are free text, not explicit card actions:
                    // only the server may interpret them as Artifact operations.
                    void send(text, {
                      actionSelectionIds,
                      clarificationAssistantMessageId: m.id,
                      ...(clarificationChoiceIndex !== undefined
                        ? { clarificationChoiceIndex }
                        : {}),
                    });
                  }}
                />
              ))}
              {/* Reattach indicator: this chat's turn is running server-side but
                  we hold no live local run (a full-page navigation destroyed the
                  stream + plan). Show "Cowork is still working…" so the user gets
                  the feedback back; the reattach poll swaps in the reply when it
                  settles. Suppressed once a local run exists (its overlay shows
                  real progress) or the turn finishes. */}
              {reattachingChatId === activeId &&
                !chatSession.runFor(activeId) && (
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

        <form
          onSubmit={onSubmit}
          className="border-t border-border bg-card/90 px-3 py-3 shadow-[0_-18px_45px_rgba(28,28,26,0.04)] backdrop-blur sm:px-6 sm:py-4"
        >
          <div className="mx-auto flex max-w-4xl flex-col gap-2.5 relative">
            {/* Slash-command menu — anchored above the composer. Open while the
                input is a bare "/<query>". Click or ↑/↓+Enter to prefill a starter. */}
            {slashOpen && (
              <div className="absolute bottom-full left-0 right-0 z-20 mb-3 overflow-hidden rounded-2xl border border-border bg-card/90 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur">
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
                          <Zap className="h-4 w-4 shrink-0 text-state-warning" aria-hidden />
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

            {generationSettingsOpen && (
              <div
                ref={generationSettingsRef}
                role="dialog"
                aria-label="Generation settings"
                className="absolute bottom-full left-0 right-0 z-20 mb-3 overflow-hidden rounded-2xl border border-border bg-card/90 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur"
              >
                <div className="flex items-center justify-between border-b border-border px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <span>Generation settings</span>
                  <button
                    type="button"
                    onClick={() => setGenerationSettingsOpen(false)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Close generation settings"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-col divide-y divide-border p-3.5">
                  <div className="flex items-center justify-between gap-3 pb-3.5">
                    <div>
                      <p className="text-sm font-medium text-foreground">Posts</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Choose exactly how many new Posts to create.
                      </p>
                    </div>
                    <div
                      role="group"
                      aria-label="Number of Posts"
                      className="flex shrink-0 items-center gap-1 rounded-xl border border-border bg-muted/50 p-1"
                    >
                      {DRAFT_COUNT_OPTIONS.map((option) => {
                        const selected = draftCountSelection === option;
                        const label = String(option);
                        return (
                          <button
                            key={label}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => {
                              setDraftCountSelection(option);
                              setGenerationSettingsOpen(false);
                            }}
                            className={cn(
                              "min-w-8 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors",
                              selected
                                ? "bg-card text-primary shadow-sm"
                                : "text-muted-foreground hover:bg-card/70 hover:text-foreground",
                            )}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 pt-3.5">
                    <div>
                      <p className="text-sm font-medium text-foreground">Post type</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Only applies when generating a new original post.
                      </p>
                    </div>
                    <div
                      role="group"
                      aria-label="Post type"
                      className="flex shrink-0 items-center gap-1 rounded-xl border border-border bg-muted/50 p-1"
                    >
                      {(["auto", ...POST_TYPE_OPTIONS] as const).map((option) => {
                        const selected = postTypeSelection === option;
                        const label =
                          option === "auto"
                            ? "Any"
                            : option === "regular"
                              ? "Regular"
                              : "Lead magnet";
                        return (
                          <button
                            key={option}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => {
                              setPostTypeSelection(option);
                              setGenerationSettingsOpen(false);
                            }}
                            className={cn(
                              "rounded-lg px-2 py-1.5 text-xs font-medium transition-colors",
                              selected
                                ? "bg-card text-primary shadow-sm"
                                : "text-muted-foreground hover:bg-card/70 hover:text-foreground",
                            )}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Add context menu — anchored above the composer like the other
                popovers. It must render OUTSIDE the composer card: the card is
                overflow-hidden (rounded-corner clipping), so a popover inside
                it gets cut off at the card's top edge. */}
            {contextMenuOpen && (
              <div
                ref={contextMenuRef}
                role="dialog"
                aria-label="Add context"
                className="absolute bottom-full left-0 z-20 mb-3 w-64 overflow-hidden rounded-2xl border border-border bg-card/90 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur"
              >
                <div className="flex items-center justify-between border-b border-border px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <span>Add context</span>
                  <button
                    type="button"
                    onClick={() => setContextMenuOpen(false)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Close"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-col py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setContextMenuOpen(false);
                      fileInputRef.current?.click();
                    }}
                    disabled={attachments.length >= MAX_ATTACHMENTS}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 text-foreground">Attach a file</span>
                    <span className="text-xs text-muted-foreground">
                      {attachments.length}/{MAX_ATTACHMENTS}
                    </span>
                  </button>
                  {customSkills.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setContextMenuOpen(false);
                        setSkillPickerOpen(true);
                      }}
                      className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted"
                    >
                      <Zap
                        className={cn(
                          "h-4 w-4 shrink-0",
                          pendingSkills.length > 0
                            ? "text-state-warning"
                            : "text-muted-foreground",
                        )}
                        aria-hidden
                      />
                      <span className="flex-1 text-foreground">Apply a skill</span>
                      {pendingSkills.length > 0 && (
                        <span className="text-xs text-state-warning">
                          {pendingSkills.length}
                        </span>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setContextMenuOpen(false);
                      setPostFormatPickerOpen(true);
                    }}
                    disabled={!!modelSource}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <FileText
                      className={cn(
                        "h-4 w-4 shrink-0",
                        pendingPostFormat
                          ? "text-primary"
                          : "text-muted-foreground",
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 text-foreground">Choose post format</span>
                    {pendingPostFormat && (
                      <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setContextMenuOpen(false);
                      setCreatorStylePickerOpen(true);
                    }}
                    disabled={!!modelSource}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Fingerprint
                      className={cn(
                        "h-4 w-4 shrink-0",
                        pendingCreatorStyle
                          ? "text-primary"
                          : "text-muted-foreground",
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 text-foreground">Choose creator style</span>
                    {pendingCreatorStyle && (
                      <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setContextMenuOpen(false);
                      setLeadMagnetPickerOpen(true);
                    }}
                    disabled={leadMagnetPickerDisabled}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Magnet
                      className={cn(
                        "h-4 w-4 shrink-0",
                        pendingLeadMagnet
                          ? "text-primary"
                          : "text-muted-foreground",
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 text-foreground">Choose lead magnet</span>
                    {pendingLeadMagnet && (
                      <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* ⚡ Skill picker panel — browse + toggle the workspace's skills. */}
            {skillPickerOpen && customSkills.length > 0 && (
              <div
                ref={skillPickerRef}
                role="dialog"
                aria-label="Apply a custom skill"
                className="absolute bottom-full left-0 right-0 z-20 mb-3 overflow-hidden rounded-2xl border border-border bg-card/90 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur"
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
                          on && "bg-state-warning-bg",
                        )}
                      >
                        <Zap
                          className={cn(
                            "h-4 w-4 shrink-0",
                            on ? "text-state-warning" : "text-muted-foreground",
                          )}
                          aria-hidden
                        />
                        <span className="text-foreground">/{sk.name}</span>
                        {sk.description && (
                          <span className="truncate text-xs text-muted-foreground">
                            {sk.description}
                          </span>
                        )}
                        {on && <Check className="ml-auto h-3.5 w-3.5 text-state-warning" />}
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
                className="absolute bottom-full left-0 right-0 z-20 mb-3 overflow-hidden rounded-2xl border border-border bg-card/90 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur"
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
                          if (!on) {
                            enterCreateCommand();
                          }
                          setPostFormatPickerOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                          on && "bg-state-danger-bg",
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
                className="absolute bottom-full left-0 right-0 z-20 mb-3 overflow-hidden rounded-2xl border border-border bg-card/90 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur"
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
                <div className="border-b border-border bg-state-warning-bg px-3.5 py-2 text-xs leading-5 text-muted-foreground">
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
                    <Magnet className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
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
                              : "border-primary/30 bg-state-danger-bg text-primary hover:bg-state-danger-bg",
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
                              className="w-full resize-none rounded-xl border border-border bg-white px-3 py-2 text-base outline-none transition-[border-color,box-shadow] focus:border-primary/50 focus:ring-2 focus:ring-primary/10 sm:text-sm"
                              placeholder="Create a checklist, prompt pack, or template that fits this post..."
                            />
                          </div>
                          <div className="grid gap-2 sm:grid-cols-[1fr_160px]">
                            <input
                              value={leadMagnetCreateCtaUrl}
                              onChange={(e) => setLeadMagnetCreateCtaUrl(e.target.value)}
                              className="min-w-0 rounded-xl border border-border bg-white px-3 py-2 text-base outline-none transition-[border-color,box-shadow] focus:border-primary/50 focus:ring-2 focus:ring-primary/10 sm:text-sm"
                              placeholder="Optional CTA URL"
                            />
                            <input
                              value={leadMagnetCreateCtaLabel}
                              onChange={(e) => setLeadMagnetCreateCtaLabel(e.target.value)}
                              className="min-w-0 rounded-xl border border-border bg-white px-3 py-2 text-base outline-none transition-[border-color,box-shadow] focus:border-primary/50 focus:ring-2 focus:ring-primary/10 sm:text-sm"
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
                            if (!on) {
                              enterCreateCommand();
                            }
                            setLeadMagnetPickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                            on && "bg-state-danger-bg",
                          )}
                        >
                          <Magnet
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
                className="absolute bottom-full left-0 right-0 z-20 mb-3 overflow-hidden rounded-2xl border border-border bg-card/90 shadow-[0_24px_80px_rgba(28,28,26,0.16)] backdrop-blur"
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
                            if (!on) {
                              enterCreateCommand();
                            }
                            setCreatorStylePickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                            on && "bg-state-danger-bg",
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
                "relative overflow-hidden rounded-[1.35rem] border bg-card/90 shadow-[0_18px_60px_rgba(28,28,26,0.12)] ring-1 ring-white/70 backdrop-blur transition-colors",
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
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[1.35rem] border-2 border-dashed border-primary/50 bg-card/90 backdrop-blur-sm">
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
              <div className="mx-3 mt-3 flex items-start gap-2.5 rounded-xl border border-state-warning-border bg-state-warning-bg text-state-warning px-3 py-2.5 text-sm">
                <Info className="h-4 w-4 mt-0.5 shrink-0" />
                <p className="flex-1 leading-snug">{limitNotice}</p>
                <button
                  type="button"
                  onClick={() => setLimitNotice(null)}
                  className="text-state-warning hover:text-state-warning shrink-0"
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
                    className="inline-flex items-center gap-1.5 rounded-full border border-state-warning-border bg-state-warning-bg pl-2.5 pr-1.5 py-1 text-xs text-state-warning"
                  >
                    <Zap className="h-3 w-3" aria-hidden />
                    <span className="max-w-[140px] truncate">/{sk.name}</span>
                    <button
                      type="button"
                      onClick={() => toggleSkill(sk)}
                      className="text-state-warning hover:text-state-warning"
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
                <span className="inline-flex items-center gap-1.5 rounded-full border border-state-danger-border bg-state-danger-bg pl-2.5 pr-1.5 py-1 text-xs text-primary">
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
                <span className="inline-flex items-center gap-1.5 rounded-full border border-state-danger-border bg-state-danger-bg pl-2.5 pr-1.5 py-1 text-xs text-primary">
                  <Magnet className="h-3 w-3" aria-hidden />
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
                <span className="inline-flex items-center gap-1.5 rounded-full border border-state-danger-border bg-state-danger-bg pl-2.5 pr-1.5 py-1 text-xs text-primary">
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
                  sending
                    ? "Type your next message…"
                    : composerCommandKind === "create"
                      ? "What should the new post be about?"
                      : composerCommandKind === "edit"
                        ? editTargetLabel
                          ? `What should change in ${editTargetLabel}?`
                          : "Select a Post before describing the change…"
                      : askContextPost
                        ? `Ask about ${askContextPost.label}…`
                        : "Ask Cowork anything…"
                }
                // Rests at ONE line (min-h-10 ≈ one line of text-base leading-relaxed
                // + py-1.5), then the auto-grow effect expands it up to 10 rows as you
                // type. text-base + leading-relaxed keeps what you type readable.
                className="min-h-10 w-full resize-none border-0 bg-transparent px-1 py-1.5 text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:ring-0"
              />
              <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2.5">
              <div
                className="inline-flex h-9 shrink-0 items-center rounded-xl border border-border bg-card p-0.5"
                role="group"
                aria-label="Cowork command"
              >
                <button
                  type="button"
                  aria-pressed={composerCommandKind === "ask"}
                  onClick={() => setCoworkComposer({ kind: "ask" })}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-[0.6rem] px-2.5 text-xs font-medium transition-colors",
                    composerCommandKind === "ask"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <CoworkCommandIcon kind="ask" className="h-3.5 w-3.5" />
                  {askContextPost ? `Ask · ${askContextPost.label}` : "Ask"}
                </button>
                <button
                  type="button"
                  aria-pressed={composerCommandKind === "create"}
                  onClick={() => {
                    enterCreateCommand();
                  }}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-[0.6rem] px-2.5 text-xs font-medium transition-colors",
                    composerCommandKind === "create"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <CoworkCommandIcon kind="create" className="h-3.5 w-3.5" />
                  Create
                </button>
                {hasEditablePosts && (
                  <button
                    type="button"
                    aria-pressed={composerCommandKind === "edit"}
                    onClick={() => enterEditCommand()}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-[0.6rem] px-2.5 text-xs font-medium transition-colors",
                      composerCommandKind === "edit"
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <CoworkCommandIcon kind="edit" className="h-3.5 w-3.5" />
                    {editTargetLabel ? `Edit · ${editTargetLabel}` : "Edit"}
                  </button>
                )}
              </div>
              {effectiveCoworkComposer.kind === "edit" && (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <select
                    value={editTargetPost?.artifactId ?? ""}
                    onChange={(event) =>
                      setCoworkComposer({
                        kind: "edit",
                        targetPostId: event.target.value,
                        scope: effectiveCoworkComposer.scope,
                      })
                    }
                    aria-label="Post to edit"
                    className="h-9 max-w-56 rounded-xl border border-border bg-card px-2.5 text-xs font-medium text-foreground outline-none focus:border-primary"
                  >
                    {!editTargetPost && (
                      <option value="" disabled>
                        Select a Post
                      </option>
                    )}
                    {artifactIndex.entries.map((entry) => (
                      <option key={entry.artifactId} value={entry.artifactId}>
                        {numberedArtifactLabel(entry)}
                      </option>
                    ))}
                  </select>
                  {hasEditablePosts && (
                    <div
                      className="inline-flex h-9 items-center rounded-xl border border-border bg-card p-0.5"
                      role="group"
                      aria-label="Edit scope"
                    >
                      <button
                        type="button"
                        aria-pressed={effectiveCoworkComposer.scope === "full_post"}
                        onClick={() =>
                          setCoworkComposer({
                            ...effectiveCoworkComposer,
                            scope: "full_post",
                          })
                        }
                        className={cn(
                          "h-8 rounded-[0.6rem] px-2.5 text-xs font-medium transition-colors",
                          effectiveCoworkComposer.scope === "full_post"
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        Whole Post
                      </button>
                      <button
                        type="button"
                        aria-pressed={effectiveCoworkComposer.scope === "hook"}
                        onClick={() =>
                          setCoworkComposer({
                            ...effectiveCoworkComposer,
                            scope: "hook",
                          })
                        }
                        className={cn(
                          "h-8 rounded-[0.6rem] px-2.5 text-xs font-medium transition-colors",
                          effectiveCoworkComposer.scope === "hook"
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        Hook only
                      </button>
                    </div>
                  )}
                </div>
              )}
              {composerCommandKind === "create" && (
              <Button
                ref={generationSettingsButtonRef}
                type="button"
                variant="outline"
                onClick={() => {
                  setSkillPickerOpen(false);
                  setPostFormatPickerOpen(false);
                  setCreatorStylePickerOpen(false);
                  setLeadMagnetPickerOpen(false);
                  setContextMenuOpen(false);
                  setGenerationSettingsOpen((open) => !open);
                }}
                className={cn(
                  "h-9 shrink-0 gap-1.5 rounded-xl border-border bg-card px-2.5 hover:bg-muted",
                  (generationSettingsOpen ||
                    draftCountSelection !== "auto" ||
                    postTypeSelection !== "auto") &&
                    "border-primary/60 text-primary",
                )}
                aria-label={`Generation settings — Post count: ${
                  draftCountSelection === "auto"
                    ? "Auto"
                    : draftCountSelection
                }, post type: ${
                  postTypeSelection === "auto"
                    ? "Any"
                    : postTypeSelection === "regular"
                      ? "Regular"
                      : "Lead magnet"
                }`}
                aria-expanded={generationSettingsOpen}
                title="Choose how many Posts to create and which post type to source"
              >
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
                <span className="text-xs font-medium tabular-nums">
                  {draftCountSelection === "auto"
                    ? "Auto"
                    : `${draftCountSelection} ${draftCountSelection === 1 ? "post" : "posts"}`}
                  {postTypeSelection !== "auto" &&
                    ` · ${postTypeSelection === "regular" ? "Regular" : "Lead magnet"}`}
                </span>
              </Button>
              )}
              <div className="relative">
                <Button
                  ref={contextMenuButtonRef}
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setGenerationSettingsOpen(false);
                    setSkillPickerOpen(false);
                    setPostFormatPickerOpen(false);
                    setCreatorStylePickerOpen(false);
                    setLeadMagnetPickerOpen(false);
                    setContextMenuOpen((open) => !open);
                  }}
                  className={cn(
                    "h-9 shrink-0 gap-1.5 rounded-xl border-border bg-card px-2.5 hover:bg-muted",
                    (contextMenuOpen ||
                      attachments.length > 0 ||
                      pendingSkills.length > 0 ||
                      pendingPostFormat ||
                      pendingCreatorStyle ||
                      pendingLeadMagnet) &&
                      "border-primary/60 text-primary",
                  )}
                  aria-label="Add context"
                  aria-expanded={contextMenuOpen}
                  title="Attach files, apply skills, pick format, style, or lead magnet"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  <span className="text-xs font-medium">Add context</span>
                  {(attachments.length > 0 ||
                    pendingSkills.length > 0 ||
                    pendingPostFormat ||
                    pendingCreatorStyle ||
                    pendingLeadMagnet) && (
                    <span className="text-xs font-medium tabular-nums">
                      {attachments.length +
                        pendingSkills.length +
                        (pendingPostFormat ? 1 : 0) +
                        (pendingCreatorStyle ? 1 : 0) +
                        (pendingLeadMagnet ? 1 : 0)}
                    </span>
                  )}
                </Button>
              </div>
              <div className="min-w-0 flex-1" />
              {sending ? (
                // Mid-stream: the primary button stops the run (aborts the SSE
                // fetch; the partial response is kept).
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={stopActiveRun}
                  disabled={chatSession.runFor(activeId)?.stopPending === true}
                  className="h-10 w-10 shrink-0 rounded-full border-border bg-card"
                  aria-label={
                    chatSession.runFor(activeId)?.stopPending
                      ? "Stopping"
                      : "Stop generating"
                  }
                  title={
                    chatSession.runFor(activeId)?.stopPending
                      ? "Stopping"
                      : "Stop generating"
                  }
                >
                  <Square className="h-4 w-4 fill-current" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  disabled={
                    !input.trim() ||
                    overLimit ||
                    (composerCommandKind === "edit" && !editTargetPost)
                  }
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
          <div className="flex items-center justify-between px-4 h-14 border-b border-border bg-card/70">
            <span className="text-sm font-semibold tracking-[-0.01em]">
              {ARTIFACT_PANEL_TITLE} ({artifacts.length})
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
            {artifactsList}
          </div>
        </aside>
      )}

      {/* Right: context rail — desktop inline column. A read-only, aggregated
          view of what's shaping this chat. Fixed-width (compact card, no resize),
          sibling to the drafts panel so both can sit side by side on wide
          screens. */}
      {contextPanelOpen && hasContext && (
        <aside className="relative hidden lg:flex w-80 shrink-0 flex-col border-l border-border bg-muted/80">
          <div className="flex items-center justify-between px-4 h-14 border-b border-border bg-card/70">
            <span className="flex items-center gap-2 text-sm font-semibold tracking-[-0.01em]">
              <Layers className="h-4 w-4 text-muted-foreground" />
              Context
            </span>
            <button
              onClick={() => setContextPanelOpen(false)}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
              aria-label="Close context panel"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable] p-3.5">
            <ChatContextPanel summary={contextSummary} />
          </div>
        </aside>
      )}

      {/* Mobile: a floating "Context" pill that opens the context card as a
          bottom sheet (the desktop rail is hidden below lg). Sits above the
          drafts pill so the two don't stack on top of each other. */}
      {hasContext && !mobileContextOpen && (
        <button
          type="button"
          onClick={() => setMobileContextOpen(true)}
          className={cn(
            "lg:hidden absolute left-1/2 -translate-x-1/2 z-20 inline-flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-3.5 py-2 text-xs font-medium shadow-md backdrop-blur hover:bg-card transition-colors",
            hasDraftPanel ? "bottom-44" : "bottom-32",
          )}
          aria-label="Show chat context"
        >
          <Layers className="h-3.5 w-3.5" />
          Context
        </button>
      )}
      {mobileContextOpen && hasContext && (
        <div className="lg:hidden absolute inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileContextOpen(false)}
            aria-hidden="true"
          />
          <div className="relative max-h-[80%] flex flex-col rounded-t-[1.35rem] border-t border-border bg-card shadow-xl animate-in slide-in-from-bottom duration-200">
            <div className="flex items-center justify-between px-4 h-14 border-b border-border shrink-0">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Layers className="h-4 w-4 text-muted-foreground" />
                Context
              </span>
              <button
                type="button"
                onClick={() => setMobileContextOpen(false)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-card hover:text-foreground"
                aria-label="Close context"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3.5 pb-[env(safe-area-inset-bottom)]">
              <ChatContextPanel summary={contextSummary} />
            </div>
          </div>
        </div>
      )}

      {/* Mobile: a floating "Drafts (N)" pill above the composer that opens the
          drafts as a bottom sheet. The desktop panel is hidden below lg, so this
          is the ONLY way to reach generated drafts on a phone. */}
      {hasDraftPanel && !mobileDraftsOpen && (
        <button
          type="button"
          onClick={() => setMobileDraftsOpen(true)}
          className="lg:hidden absolute bottom-32 left-1/2 -translate-x-1/2 z-20 inline-flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-3.5 py-2 text-xs font-medium shadow-md backdrop-blur hover:bg-card transition-colors"
          aria-label={`Show ${ARTIFACT_PANEL_TITLE.toLowerCase()}`}
        >
          <FileText className="h-3.5 w-3.5" />
          {ARTIFACT_PANEL_TITLE} ({artifacts.length})
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
                {ARTIFACT_PANEL_TITLE} ({artifacts.length})
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
              {artifactsList}
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
  source: ModelSource | ModelSourceAttachment;
  onRemove?: () => void;
}) {
  if ("state" in source && source.state === "unavailable") {
    return (
      <div className="flex items-center gap-2.5 rounded-2xl border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
        <FileText className="h-4 w-4 shrink-0" aria-hidden />
        <span>Source post no longer available</span>
      </div>
    );
  }
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
            <span className="text-[10px] font-normal text-state-warning bg-state-warning-bg rounded px-1.5 py-0.5">
              partial
            </span>
          )}
          {source.postType === "lead_magnet" && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-state-danger-border bg-state-danger-bg px-1.5 py-0.5 text-[10px] font-normal text-primary"
              title="Lead Magnet: Auto. Cowork will keep this as a lead-magnet post and pick a saved resource if one fits."
            >
              <Magnet className="h-2.5 w-2.5" aria-hidden />
              Lead Magnet: Auto
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground truncate">{preview}…</p>
      </div>
      {onRemove && (
      <button
        type="button"
        onClick={onRemove}
        className="rounded-lg p-1 text-muted-foreground hover:bg-card hover:text-foreground shrink-0"
        aria-label="Remove source post"
      >
        <X className="h-4 w-4" />
      </button>
      )}
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
    <div className="group flex w-full items-center gap-2 rounded-2xl border border-border bg-card/90 px-3 py-2.5 shadow-sm transition-colors hover:bg-card">
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
          className="grid size-10 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-0 transition-[color,background-color,opacity,scale] hover:bg-muted hover:text-destructive active:scale-[0.96] group-hover:opacity-100 focus-visible:opacity-100"
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
        "group flex min-h-10 items-center gap-2 rounded-xl py-1 pl-2.5 pr-1 text-sm cursor-pointer transition-[color,background-color,border-color,opacity,transform] duration-150 ease-[cubic-bezier(0.25,1,0.5,1)]",
        active
          ? "bg-white text-foreground shadow-sm ring-1 ring-border"
          : "text-muted-foreground hover:bg-card/70 hover:text-foreground",
      )}
      onClick={onOpen}
    >
      {chat.title === AGENT_CHAT_TITLE ? (
        <>
          {/* The agent keeps one identity color (coral) everywhere it appears. */}
          <AiIcon className="h-3.5 w-3.5 shrink-0 text-accent-brand" />
          <span className="truncate flex-1 font-medium text-accent-brand">{chat.title}</span>
        </>
      ) : (
        <>
          <MessageSquare className={cn("h-3.5 w-3.5 shrink-0", active ? "text-primary" : "opacity-60")} />
          <span className={cn("truncate flex-1", active && "font-medium")}>{chat.title}</span>
        </>
      )}
      {working ? (
        <WorkingLabel />
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="grid size-10 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-0 transition-[color,background-color,opacity,scale] hover:bg-muted hover:text-destructive active:scale-[0.96] group-hover:opacity-100 focus-visible:opacity-100"
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
  onRetry,
  onAnswer,
  legacyContentFormat,
}: {
  message: Message;
  // Re-runs the exact user task that produced this failed assistant turn.
  onRetry: () => void;
  // Submit handler for the clarifying-question card (ask_user): sends the
  // composed answer as the next user message.
  onAnswer: (
    text: string,
    ask: AskQuestion,
    actionSelectionIds: string[],
    clarificationChoiceIndex?: number,
  ) => void;
  legacyContentFormat: ContentFormat;
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
                className="inline-flex items-center gap-1.5 rounded-full border border-state-warning-border bg-state-warning-bg px-2.5 py-0.5 text-[11px] text-state-warning"
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
              className="inline-flex items-center gap-1.5 rounded-full border border-state-danger-border bg-state-danger-bg px-2.5 py-0.5 text-[11px] text-primary"
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
              className="inline-flex items-center gap-1.5 rounded-full border border-state-danger-border bg-state-danger-bg px-2.5 py-0.5 text-[11px] text-primary"
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
              className="inline-flex items-center gap-1.5 rounded-full border border-state-danger-border bg-state-danger-bg px-2.5 py-0.5 text-[11px] text-primary"
              title={`Lead magnet ${message.leadMagnet.selection === "auto" ? "auto-selected" : "selected"}: ${message.leadMagnet.title}`}
            >
              <Magnet className="h-3 w-3" aria-hidden />
              <span className="max-w-[200px] truncate">
                Giveaway: {message.leadMagnet.title}
              </span>
            </span>
          </div>
        )}
        {message.modelSource && (
          <div className="max-w-[85%]">
            <SourcePostChip source={message.modelSource} />
          </div>
        )}
        <div className="max-w-[82%] rounded-2xl rounded-br-md border border-primary/15 bg-primary/[0.09] px-4 py-2.5 text-sm leading-relaxed text-foreground shadow-[0_1px_0_rgba(255,255,255,0.8)] whitespace-pre-wrap">
          {message.text}
        </div>
        {/* Hover-reveal copy (always tappable on touch, where there's no hover). */}
        {message.text && (
          <MessageCopyButton
            text={message.text}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
          />
        )}
      </div>
    );
  }

  const tools = message.tools ?? [];
  const plan = message.plan ?? [];
  const draftRendered = message.draftRendered === true;
  const activityTools = visibleActivityTools(
    tools,
    draftRendered,
  );
  const status = agentStatus({ ...message, tools: activityTools });

  return (
    <div className="group flex flex-col gap-3">
      {/* Agent progress — status-only turns, planned turns, and tool-detail
          turns all use the same card language so Cowork does not jump between
          unrelated "working" UIs. */}
      {plan.length > 0 ? (
        <PlanChecklist steps={plan} status={status} />
      ) : shouldShowActivityRail(plan, activityTools) ? (
        <ActivityStream
          tools={activityTools}
          status={status ?? "Working"}
          showTail={status !== null}
          draftRendered={draftRendered}
        />
      ) : status ? (
        <AgentProgressStatus status={status} />
      ) : null}

      {/* Activity stream — one narrated line per tool call, on a thin left rail.
          Hidden when a plan is showing (the checklist replaces it), EXCEPT keep
          it whenever a tool FAILED (the plan card has no failure state, so the
          ✕ would otherwise be invisible on a planned turn). See
          shouldShowActivityRail. */}
      {plan.length > 0 && shouldShowActivityRail(plan, activityTools) && (
        <ActivityStream tools={activityTools} status="Tool details" />
      )}

      {/* Assistant prose. Generated drafts/hooks are NOT rendered here — they
          live in the right-hand Drafts panel so they're not duplicated. "chat"
          mode renders the model's "- "/"1." lists as proper bullets/numbers;
          the draft-body surfaces below stay default "draft" so a real post is
          never restyled. */}
      {message.text && (
        <div className="text-[15px] leading-7 whitespace-pre-wrap text-foreground">
          {renderRichText(
            message.text,
            "chat",
            message.streaming,
            (message.contentFormat ?? legacyContentFormat) === "markdown",
          )}
        </div>
      )}

      <GroundedSourceLinks artifacts={message.artifacts} />

      {/* Copy the assistant's text reply — appears once the turn finishes
          streaming. Cards have their own copy; this covers the prose (e.g. a
          list of angles the user wants to grab). Hover-reveal on desktop, always
          visible on touch. */}
      {message.text && !message.streaming && (
        <MessageCopyButton
          text={contentBodyForFormat(
            message.text,
            message.contentFormat ?? legacyContentFormat,
          )}
          className="-ml-1.5 self-start opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
        />
      )}

      {message.usage && !message.streaming && (
        <TaskUsageSummary usage={message.usage} />
      )}

      {/* Ordinary modeled citations remain hidden. GroundedSourceLinks accepts
          only the server-tagged grounded-answer presentation and a verified
          LinkedIn URL, so broad research analyses do not regain partial cards. */}

      {/* Clarifying question (ask_user): an interactive card with the agent's
          options + a free-text box. Shown once the turn settles; submitting
          sends the composed answer as the next message. */}
      {message.ask && !message.streaming && (
        <AskCard ask={message.ask} onSubmit={onAnswer} />
      )}

      {/* Recovery affordance for cut-off / tool-budget-exhausted turns. Retry
          re-sends the original task so the model repeats any required work. */}
      {message.recoverable && !message.streaming && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-state-warning-border bg-state-warning-bg px-3 py-2 text-sm text-state-warning">
          <div className="flex-1 leading-snug">
            <p>{message.recoverable.message}</p>
            <p className="mt-0.5 text-xs text-state-warning">
              Retry will run your original request again.
            </p>
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-state-warning text-state-warning-bg px-2.5 py-1 text-xs font-medium hover:bg-state-warning transition-colors"
          >
            Retry task
          </button>
        </div>
      )}
    </div>
  );
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
  onSubmit: (
    text: string,
    ask: AskQuestion,
    actionSelectionIds: string[],
    clarificationChoiceIndex?: number,
  ) => void;
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
  const selectionComplete = isAskSelectionComplete(ask, selected, other);
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
    const actionSelectionIds = selected.flatMap((option) => {
      const index = ask.options.indexOf(option);
      const id = index >= 0 ? ask.optionIds?.[index] : undefined;
      return id ? [id] : [];
    });
    const clarificationChoiceIndex =
      !isMulti && selected.length === 1
        ? ask.options.indexOf(selected[0]!)
        : undefined;
    onSubmit(
      action.text,
      ask,
      actionSelectionIds,
      clarificationChoiceIndex !== undefined && clarificationChoiceIndex >= 0
        ? clarificationChoiceIndex
        : undefined,
    );
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
            if (e.key === "Enter" && selectionComplete) {
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
          disabled={!selectionComplete}
          onClick={submit}
        >
          {isDoneOnly ? "Done" : "Send answer"}
        </Button>
      </div>
    </div>
  );
}

// Whether to render the per-tool activity rail under the message. When a plan
// checklist is present it's the SOLE progress surface, so the rail is hidden to
// avoid narrating the same work twice (the screenshot bug: plan card + rail,
// desynced). The ONE exception: a failed tool. The plan card has no failure
// state (steps only go pending → active → done), so on a planned turn a tool ✕
// would vanish — keep the rail whenever any tool failed so the user still sees
// it. With no plan, the rail shows as before.

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
    <div className="agent-card-in w-full max-w-2xl rounded-2xl border border-primary/15 bg-card/90 px-3.5 py-3 shadow-sm shadow-primary/5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-primary/85">
          <AiIcon className="h-3.5 w-3.5 shrink-0" />
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
      title={planProgressTitle(steps, status)}
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
              <CheckCircle2 className="check-pop h-4 w-4 shrink-0 text-state-success" />
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
function ActivityStream({
  tools,
  status,
  showTail = false,
  draftRendered = false,
}: {
  tools: ToolChip[];
  status: string;
  showTail?: boolean;
  draftRendered?: boolean;
}) {
  const tailLabel = activityTailLabel(
    tools,
    showTail ? status : null,
    draftRendered,
  );
  return (
    <AgentProgressShell title={status}>
      <div className="flex flex-col gap-1.5">
        {tools.map((t, i) => {
          // A rejected render_post that is FOLLOWED by a successful render_post
          // in the same turn is the finalizer catching a rough first draft and
          // the agent self-correcting — the post still ships fine. Showing it as
          // a red ✗ "render post" makes a healthy turn look broken ("the app
          // keeps failing"). Reframe those as a neutral "Polishing the draft…"
          // step. A render that fails with NO later success is a genuine failure
          // and keeps the honest treatment.
          const isDraftRender = t.name === "render_post";
          const recoveredLater =
            t.ok === false &&
            isDraftRender &&
            tools
              .slice(i + 1)
              .some((later) => later.name === "render_post" && later.ok === true);
          const phrase = recoveredLater
            ? "Polishing the draft"
            : toolPhrase(t.name, t.ok !== undefined);
          const detail = recoveredLater ? "" : toolDetail(t.name, t.args ?? "");
          return (
            <div
              key={t.id}
              // agent-step-in fires once when this row mounts (each step is keyed
              // by tool id, so appending a new step animates only that row).
              className="agent-step-in flex items-center gap-2 text-[13px] text-muted-foreground"
            >
              {t.ok === undefined ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
              ) : recoveredLater ? (
                // A self-corrected retry: a calm, non-alarming completed step.
                <CheckCircle2 className="check-pop h-4 w-4 shrink-0 text-muted-foreground/60" />
              ) : t.ok ? (
                <CheckCircle2 className="check-pop h-4 w-4 shrink-0 text-state-success" />
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
        {tailLabel && (
          <div className="agent-step-in flex items-center gap-2 text-[13px] text-foreground">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            <span className="font-medium">{tailLabel}</span>
          </div>
        )}
      </div>
    </AgentProgressShell>
  );
}

function CoworkLeadMagnetResource({
  leadMagnet,
  href,
}: {
  leadMagnet: AppliedLeadMagnet;
  href: string | null;
}) {
  const deliverables = leadMagnet.deliverables?.slice(0, 3) ?? [];
  const resourceType = leadMagnet.resourceType
    ? leadMagnet.resourceType
        .split("_")
        .map((word) => word[0]?.toUpperCase() + word.slice(1))
        .join(" ")
    : "Lead magnet";
  return (
    <section className="border-t border-border/70 bg-muted/25 px-4 py-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-state-brand-border bg-state-brand-bg text-state-brand">
          <Magnet className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-muted-foreground">
            <span className="text-state-brand">Resource ready</span>
            <span aria-hidden>·</span>
            <span>{resourceType}</span>
            {leadMagnet.estimatedMinutes && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" aria-hidden />
                  {leadMagnet.estimatedMinutes} min to apply
                </span>
              </>
            )}
          </div>
          <h3 className="mt-1.5 text-sm font-semibold leading-5 text-foreground">
            {leadMagnet.title}
          </h3>
          {leadMagnet.selectionSummary && (
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              {leadMagnet.selectionSummary}
            </p>
          )}
          {deliverables.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-xs leading-5 text-foreground/85">
              {deliverables.map((deliverable) => (
                <li key={deliverable} className="flex items-start gap-2">
                  <Check className="mt-1 h-3 w-3 shrink-0 text-state-success" aria-hidden />
                  <span>{deliverable}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-medium text-background transition-colors hover:bg-foreground/88 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
              >
                Open resource
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            ) : (
              <span className="text-xs text-muted-foreground">
                Saved to your Lead Magnets library
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ArtifactCard({
  artifact,
  chatId,
  author,
  label,
  refiningDraftId,
  onEdit,
  onAsk,
  onBodyChange,
  onMetaChange,
  leadMagnetHref,
  editDisabled,
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
  // Select this exact Post as the visible composer's Edit target.
  onEdit: () => void;
  // Bind the next Ask turn to this exact Post without authorizing an edit.
  onAsk: () => void;
  // The Done-edit PATCH succeeded — the parent updates its session cache
  // cache so the next render reflects the saved body (otherwise the parent's
  // stale prop would seed-reset the local body on a re-render).
  onBodyChange?: (newBody: string) => void;
  onMetaChange?: (metaPatch: Record<string, unknown>) => Promise<void>;
  leadMagnetHref?: (leadMagnet: AppliedLeadMagnet | null) => string | null;
  // True while a turn is streaming in this chat — Edit is disabled because a
  // second turn would be rejected by the send() in-flight guard.
  editDisabled?: boolean;
  // Remove this draft from the chat. Confirmed before firing. Absent → no
  // delete affordance (e.g. a context where deletion doesn't apply).
  onDelete?: () => void;
}) {
  const [copied, markCopied] = useCopiedFlag();
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  // Whether the primary save/schedule should UPDATE an existing Posts-board row.
  // Only for post artifacts in a chat that was opened to refine that specific post.
  const canUpdateOriginal = !!refiningDraftId && artifact.kind === "post";
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const scheduleMeta = scheduleMetaFromArtifact(artifact);
  const [saved, setSaved] = useState(
    !!(canUpdateOriginal ? refiningDraftId : scheduleMeta.boardDraftId),
  );
  const mediaAttachments = artifactMediaAttachments(artifact);
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
  const [scheduleMediaAttachments, setScheduleMediaAttachments] = useState(mediaAttachments);
  const [uploadingScheduleImage, setUploadingScheduleImage] = useState(false);
  const [nextOpenDay, setNextOpenDay] = useState<string | null>(null);
  const [loadingNextOpenDay, setLoadingNextOpenDay] = useState(false);
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
    setScheduleMediaAttachments(mediaAttachments);
  }
  const dirty = body !== artifactBody;
  const scheduleMediaChanged =
    scheduleMediaAttachments.map((item) => item.id).join("\n") !==
    mediaAttachments.map((item) => item.id).join("\n");

  useEffect(() => {
    if (!scheduleOpen || scheduleStatus === "scheduled") return;
    const controller = new AbortController();
    const today = localCalendarDate(new Date());
    void fetch(`/api/drafts/next-open-day?today=${today}`, {
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data: { ok?: boolean; nextOpenDay?: string }) => {
        if (!data.ok || !data.nextOpenDay) return;
        const openDay = data.nextOpenDay;
        setNextOpenDay(openDay);
        setScheduleWhen((current) =>
          current || suggestedScheduleLocalInput(openDay),
        );
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") {
          setNextOpenDay(null);
        }
      })
      .finally(() => setLoadingNextOpenDay(false));
    return () => controller.abort();
  }, [scheduleOpen, scheduleStatus]);

  // Custom-skill slugs the server stamped onto meta.skills when this draft was
  // produced under an active /skill — rendered as amber chips next to the
  // "Draft" badge ("this draft came from /cta"). Defensive read: meta is
  // unknown-shape; only accept a string array.
  const draftSkills = ((): string[] => {
    const v = (artifact.meta as { skills?: unknown } | undefined)?.skills;
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  })();
  const draftSource = modeledSourceAttribution(artifact.meta);
  const researchRoute = (
    artifact.meta?.research_provenance as
      | { route?: string }
      | undefined
  )?.route;
  const researchSources =
    researchRoute === "news_research" || researchRoute === "web_research"
      ? researchSourcesFromArtifact(artifact.meta)
      : [];
  const draftLeadMagnet = artifactLeadMagnet(artifact);
  const draftLeadMagnetHref = leadMagnetHref?.(draftLeadMagnet) ?? null;
  const generatedImageStatus = generatedLeadMagnetImageStatus(artifact);

  const copy = async () => {
    // markdown-model draft → copy the LinkedIn-ready form (matches publish).
    if (
      await copyToClipboard(
        draftEgressBody(body, artifact.meta),
        "Copied to clipboard",
      )
    ) {
      markCopied();
    }
  };

  // The kind to send on save. A hook always stays a hook. Otherwise: if the
  // user made an EXPLICIT post-type choice for this turn (a starter contract
  // or a Generation Settings pick — stamped by the server into
  // meta.explicit_post_type, never derived from body text), that choice is
  // authoritative and must survive the save unmodified. Only when there was
  // no explicit choice do we omit kind, letting the server auto-classify
  // regular vs lead-magnet from the body — the original, still-desired
  // behavior for a lead magnet written in Cowork with no picker used.
  const kindForSave = (): DraftKind | undefined => {
    if (artifact.kind === "hook") return "hook";
    const explicit = artifact.meta?.explicit_post_type;
    if (explicit === "lead_magnet") return "lead_magnet";
    if (explicit === "regular") return "post";
    return undefined;
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
          ...(kindForSave() ? { kind: kindForSave() } : {}),
          ...(artifact.meta ? { meta: artifact.meta } : {}),
          ...(mediaAttachments.length ? { media_attachments: mediaAttachments } : {}),
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save");
      const savedDraftId = data.artifact?.id;
      if (!savedDraftId) throw new Error("Saved draft response was missing its id.");

      // The POST is the authoritative save. Record that success before the
      // follow-up chat metadata PATCH: if linking the board id back to the chat
      // fails, presenting Save as retryable can create another row even though
      // the first save already succeeded.
      setBoardDraftId(savedDraftId);
      setSaved(true);
      const savedPostToast = (
        <span>
          Draft saved on your{" "}
          <Link
            href={`/dashboard/posts?open=${encodeURIComponent(savedDraftId)}`}
            className="font-medium underline underline-offset-2"
          >
            Posts
          </Link>
        </span>
      );
      try {
        await onMetaChange?.({ board_draft_id: savedDraftId });
        toast.success(savedPostToast);
      } catch {
        toast.success(savedPostToast, {
          description: "The chat link did not sync. Reload before making more changes.",
        });
      }
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
        body: JSON.stringify({
          body,
          content_format: draftMarkdownEnabled(artifact.meta)
            ? "markdown"
            : "plain",
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update post");
      setSaved(true);
      toast.success("Post updated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // The primary save action: update the original when this chat is refining one,
  // otherwise save a new draft.
  const save = canUpdateOriginal ? updateOriginal : saveAsNew;

  const persistScheduleChanges = async (draftId: string, errorMessage: string) => {
    // A refine artifact is newer than the Posts row even when the user has not
    // edited it locally (`dirty` compares against the artifact, not the row).
    // Always carry its body + format back to the original before scheduling.
    const shouldPersistBody = dirty || canUpdateOriginal;
    if (!shouldPersistBody && !scheduleMediaChanged) return;
    const res = await fetch(`/api/drafts/${draftId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(shouldPersistBody ? { body } : {}),
        ...(shouldPersistBody && canUpdateOriginal
          ? {
              content_format: draftMarkdownEnabled(artifact.meta)
                ? "markdown"
                : "plain",
            }
          : {}),
        media_attachments: scheduleMediaAttachments,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || errorMessage);
    if (shouldPersistBody) onBodyChange?.(body);
    setSaved(true);
  };

  const ensureSchedulableDraft = async (): Promise<string> => {
    if (canUpdateOriginal) {
      if (!refiningDraftId) throw new Error("Couldn't find the original post.");
      await persistScheduleChanges(refiningDraftId, "Failed to update post");
      return refiningDraftId;
    }

    if (boardDraftId) {
      await persistScheduleChanges(boardDraftId, "Failed to update draft");
      return boardDraftId;
    }

    if (!chatId) throw new Error("Save the chat before scheduling this draft.");
    const res = await fetch(`/api/chats/${chatId}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: artifact.title,
        body,
        ...(kindForSave() ? { kind: kindForSave() } : {}),
        ...(artifact.meta ? { meta: artifact.meta } : {}),
        media_attachments: scheduleMediaAttachments,
      }),
    });
    const data = await res.json();
    if (!data.ok || !data.artifact?.id) {
      throw new Error(data.error || "Failed to save draft before scheduling");
    }
    setBoardDraftId(data.artifact.id);
    setSaved(true);
    await onMetaChange?.({ board_draft_id: data.artifact.id });
    return data.artifact.id;
  };

  const addScheduleImage = async (file: File | undefined) => {
    if (!file || uploadingScheduleImage) return;
    try {
      const fileValidation = validatePostMediaFile({
        name: file.name,
        contentType: file.type,
        size: file.size,
      });
      if (!fileValidation.ok || fileValidation.type !== "image") {
        throw new Error(
          fileValidation.ok ? "Choose a JPG, PNG, GIF, or WebP image." : fileValidation.error,
        );
      }
      const preflightError = validatePostMediaSet([
        ...scheduleMediaAttachments,
        {
          id: "pending-schedule-image",
          source: "library",
          assetId: "pending-schedule-image",
          name: file.name,
          mimeType: fileValidation.normalizedContentType,
          size: file.size,
          type: "image",
          uploadedAt: new Date().toISOString(),
        },
      ]);
      if (preflightError) throw new Error(preflightError);

      setUploadingScheduleImage(true);
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetch("/api/media-assets", { method: "POST", body: form });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        asset?: {
          id: string;
          filename: string;
          mimeType: string;
          size: number;
          type: "image" | "video" | "document";
          signedUrl?: string | null;
          storageBucket?: string | null;
          storagePath?: string | null;
          createdAt: string;
        };
      };
      if (!data.ok || !data.asset || data.asset.type !== "image") {
        throw new Error(data.error || "Couldn't upload that image.");
      }
      const attachment: PostMediaAttachment = {
        id: `asset:${data.asset.id}`,
        source: "library",
        assetId: data.asset.id,
        name: data.asset.filename,
        mimeType: data.asset.mimeType,
        size: data.asset.size,
        type: "image",
        storageBucket: data.asset.storageBucket,
        storagePath: data.asset.storagePath,
        previewUrl: data.asset.signedUrl,
        uploadedAt: data.asset.createdAt,
      };
      const next = [...scheduleMediaAttachments, attachment];
      const mediaError = validatePostMediaSet(next);
      if (mediaError) throw new Error(mediaError);
      setScheduleMediaAttachments(next);
      toast.success("Image attached");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setUploadingScheduleImage(false);
    }
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
        media_attachments: scheduleMediaAttachments,
      };
      await onMetaChange?.(next);
      setBoardDraftId(draftId);
      setScheduledAt(next.scheduled_at);
      setScheduleStatus("scheduled");
      setFirstComment(next.first_comment ?? "");
      setScheduleWhen(isoToLocalInput(next.scheduled_at));
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
      await onMetaChange?.({
        scheduled_at: null,
        schedule_status: null,
        first_comment: null,
      });
      setScheduledAt(null);
      setScheduleStatus(null);
      setFirstComment("");
      setScheduleWhen("");
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
    <div className="rounded-xl border border-border bg-white text-foreground shadow-[0_16px_45px_rgba(28,28,26,0.10)]">
      {/* "Draft N" badge + applied-skill chip(s). Skills come from the server
          stamping meta.skills onto the artifact when one was active for the
          turn that produced it (see route's artifact case). Renders even when
          there's no draft label, so a single-draft turn still shows /name. */}
      {(label || draftSkills.length > 0 || draftSource) && (
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
          {draftSource?.url ? (
            <a
              href={draftSource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border bg-white px-2.5 py-0.5 text-[10px] font-semibold text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
              title="Open the original swipe-file post this draft modeled."
            >
              <FileText className="h-2.5 w-2.5" aria-hidden />
              Source post
              <ExternalLink className="h-2.5 w-2.5" aria-hidden />
            </a>
          ) : draftSource ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-border bg-white px-2.5 py-0.5 text-[10px] font-semibold text-muted-foreground"
              title="This draft is attributed to a swipe-file source whose original link is unavailable."
            >
              <FileText className="h-2.5 w-2.5" aria-hidden />
              Source post
            </span>
          ) : null}
          {draftSkills.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-full border border-state-warning-border bg-state-warning-bg px-2.5 py-0.5 text-[10px] font-semibold text-state-warning"
              title={`Produced with custom skill /${name}`}
            >
              <Zap className="h-2.5 w-2.5" aria-hidden />
              /{name}
            </span>
          ))}
        </div>
      )}
      {/* LinkedIn-style post header (fixed) */}
      <div className="flex items-center gap-2.5 px-3.5 pt-3.5 shrink-0">
        <AvatarImg
          src={author.avatarUrl}
          fallbackSrc={author.fallbackAvatarUrl}
          className="h-10 w-10 rounded-xl object-cover shrink-0"
          fallback={
            // Initials placeholder when no avatar loads: the LinkedIn CDN URL
            // expired AND the Clerk backup also failed (both tried by AvatarImg).
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
              className="inline-flex items-center rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-state-danger-bg hover:text-state-danger transition-colors"
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
              //  (b) Even on success, the parent's session cache still has
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
                  // Tell the parent so the session cache reflects the saved body.
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
                <CoworkCommandIcon kind="edit" className="h-3.5 w-3.5" /> Edit
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
          {/* markdown=true only when this draft was written by a markdown model
              (meta.markdown, stamped at creation for GPT-5.6 Luna) → the body is
              normalized to LinkedIn plain text before render, matching publish. */}
          {renderRichText(body, "draft", false, Boolean(artifact.meta?.markdown))}
        </ScrollableBody>
      )}

      {/* "Why I wrote it this way" — the collaborator note. Stamped onto
          meta.rationale by the interactive render_post tool, and only when it
          passed the generic-rationale net server-side. Absent rationale →
          nothing renders. */}
      {typeof artifact.meta?.rationale === "string" &&
        artifact.meta.rationale.trim() && (
          <div className="flex items-start gap-1.5 px-3 pb-1 text-[11px] leading-relaxed text-muted-foreground">
            <Lightbulb
              className="h-3 w-3 mt-0.5 shrink-0 text-primary/70"
              aria-hidden
            />
            <span>{artifact.meta.rationale.trim()}</span>
          </div>
        )}

      {draftLeadMagnet && (
        <CoworkLeadMagnetResource
          leadMagnet={draftLeadMagnet}
          href={draftLeadMagnetHref}
        />
      )}

      {/* Show the full "Sources used" list only for news/web research drafts.
          Modeled drafts already carry a per-draft source chip at the top, so
          listing every research source here duplicates information. */}
      <ResearchSources sources={researchSources} />

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
        {!canUpdateOriginal && (
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
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 rounded-full border-border"
          onClick={onAsk}
          disabled={editDisabled}
          aria-label="Ask about this Post"
          title="Ask for feedback or discuss this post without changing it"
        >
          <CoworkCommandIcon kind="ask" className="h-3.5 w-3.5" />
          Ask
        </Button>
        {/* Edit selects this exact Post in the shared composer. Target and scope
            stay visible there, so there is only one place to describe changes. */}
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 rounded-full border-border"
          onClick={onEdit}
          disabled={editDisabled}
          aria-label="Edit this Post"
          title={
            editDisabled
              ? "Wait for the current turn to finish before editing"
              : "Edit this Post in place"
          }
        >
          <CoworkCommandIcon kind="edit" className="h-3.5 w-3.5" />
          {editDisabled ? "Editing…" : "Edit"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 rounded-full border-border"
          onClick={() => {
            if (!scheduleOpen && scheduleStatus !== "scheduled") {
              setLoadingNextOpenDay(true);
            }
            setScheduleOpen((v) => !v);
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
              <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background/55 px-3 py-2">
                <div className="min-w-0 text-xs">
                  <div className="font-medium text-foreground">
                    {scheduleMediaAttachments.length
                      ? `${scheduleMediaAttachments.length} attachment${scheduleMediaAttachments.length === 1 ? "" : "s"}`
                      : "Add an image"}
                  </div>
                  <div className="truncate text-muted-foreground">
                    {scheduleMediaAttachments.map((item) => item.name).join(", ") || "Optional · saved safely in your media library"}
                  </div>
                </div>
                <label className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-medium hover:bg-muted">
                  {uploadingScheduleImage ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ImageIcon className="h-3.5 w-3.5" />
                  )}
                  {uploadingScheduleImage ? "Uploading…" : "Add image"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    aria-label="Add image to scheduled post"
                    className="sr-only"
                    disabled={uploadingScheduleImage}
                    onChange={(event) => {
                      void addScheduleImage(event.currentTarget.files?.[0]);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  {loadingNextOpenDay
                    ? "Finding your next open day…"
                    : nextOpenDay
                      ? `Next open day: ${formatScheduleDay(nextOpenDay)}`
                      : "Choose any future date and time."}
                </span>
                {nextOpenDay && (
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline"
                    onClick={() => setScheduleWhen(suggestedScheduleLocalInput(nextOpenDay))}
                  >
                    Use it
                  </button>
                )}
              </div>
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
                  disabled={
                    scheduling ||
                    uploadingScheduleImage ||
                    !scheduleWhen ||
                    body.length > 3000
                  }
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
        <div className="mb-3 rounded-xl border border-state-warning-border bg-state-warning-bg px-3 py-2 text-[11px] leading-snug text-state-warning">
          Image could not be generated{reason ? `: ${reason}` : ""}. The draft text is still ready.
        </div>
      );
    }
    if (generatedImageStatus?.status === "save_failed") {
      const reason = userFacingImageFailureReason(generatedImageStatus.reason);
      return (
        <div className="mb-3 rounded-xl border border-state-warning-border bg-state-warning-bg px-3 py-2 text-[11px] leading-snug text-state-warning">
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
        <div className="inline-flex items-center gap-1.5 rounded-full border border-state-danger-border bg-state-danger-bg px-2.5 py-1 text-[10px] font-medium text-primary">
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
  // Free-form note — the real teaching channel. Chips are quick picks; the
  // user's own take (which can differ from anything the AI would infer) is
  // saved with the feedback and injected into future writer prompts via the
  // existing feedback-memory block.
  const [note, setNote] = useState("");
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
    const changed = rating !== next;
    setRating(changed ? next : null);
    if (changed) {
      setSelected([]);
      setPhrase("");
      setNote("");
      setSaved(null);
    }
  };

  const toggleReason = (reason: ContentFeedbackReason) => {
    if (selected.includes(reason)) {
      setSelected(selected.filter((selectedReason) => selectedReason !== reason));
      return;
    }
    if (selected.length >= FEEDBACK_REASON_LIMIT) {
      toast.error(`Pick up to ${FEEDBACK_REASON_LIMIT} feedback chips.`);
      return;
    }
    setSelected([...selected, reason]);
  };

  const save = async () => {
    if (!rating || saving) return;
    const snapshot = body.trim();
    if (!snapshot) {
      toast.error("There is no draft text to save feedback for.");
      return;
    }
    // A chip OR a free-form note is enough — free text alone is valid feedback.
    if (selected.length === 0 && !note.trim()) {
      toast.error("Pick a chip or write a quick note.");
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
          ...(note.trim() ? { note: note.trim() } : {}),
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
      setNote("");
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
                ? "border-state-success-border bg-state-success-bg text-state-success ring-2 ring-emerald-500/15 hover:bg-state-success-bg"
                : "border-state-success-border bg-state-success-bg text-state-success hover:border-state-success-border hover:bg-state-success-bg",
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
                ? "border-state-danger-border bg-state-danger-bg text-state-danger ring-2 ring-red-500/15 hover:bg-state-danger-bg"
                : "border-state-danger-border bg-state-danger-bg text-state-danger hover:border-state-danger-border hover:bg-state-danger-bg",
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

          {/* Free-form note — works on its own (no chip required) so the user
              can teach takes/opinions the AI would never infer. */}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder={
              rating === "up"
                ? "What landed? Your take teaches Cowork what to repeat (optional)…"
                : "What felt off? Your take teaches Cowork what to avoid (optional)…"
            }
            className="w-full resize-none rounded-xl border border-border bg-white px-3 py-2 text-xs leading-4 text-foreground outline-none placeholder:text-muted-foreground/55 focus:ring-2 focus:ring-primary/15"
            disabled={saving}
          />

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {selected.length}/{FEEDBACK_REASON_LIMIT} selected
            </span>
            <Button
              type="button"
              size="sm"
              className="h-8 rounded-full"
              onClick={save}
              disabled={saving || (selected.length === 0 && !note.trim())}
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

function localCalendarDate(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function formatScheduleDay(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
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
type StarterGroup = "explore" | "create" | "borrow-attention";
type Starter = {
  id: ComposerStarterId;
  group: StarterGroup;
  command: Exclude<CoworkComposerCommandKind, "edit">;
  icon: LucideIcon;
  label: string;
  prompt: string;
  recommendedDescription?: string;
};

const STARTERS: Starter[] = [
  {
    id: "brainstorm",
    group: "explore",
    command: "ask",
    icon: Lightbulb,
    label: "Brainstorm new post ideas",
    recommendedDescription: "Explore angles that are already working.",
    prompt:
      "Give me 5 post ideas based on what's been going viral across my tracked accounts over the last 30 days. Pull from ALL niches — don't ask me which niche, and don't limit it to mine. Adapt every idea to my voice and my niche. For each, give a one-line angle and the hook style it would use.",
  },
  {
    id: "model-top-viral",
    group: "create",
    command: "create",
    icon: Flame,
    label: "Model a top viral post",
    recommendedDescription: "Adapt a proven Swipe File structure.",
    prompt:
      "Find a top-performing regular post in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original.",
  },
  {
    id: "model-recent-lead-magnet",
    group: "create",
    command: "create",
    icon: Magnet,
    label: "Model a recent viral lead magnet",
    prompt:
      "Find the most recent high-performing lead-magnet post in my swipe file and adapt it into a lead-magnet post in my voice, using my lead-magnet style.",
  },
  {
    id: "working-this-week",
    group: "explore",
    command: "ask",
    icon: TrendingUp,
    label: "What's working this week",
    prompt:
      "Show me the top posts from THIS WEEK (the last 7 days of the most recent scrape) and tell me what hook patterns and formats are working right now.",
  },
  {
    id: "write-original",
    group: "create",
    command: "create",
    icon: SquarePen,
    label: "Write an original post",
    recommendedDescription: "Recommended · Start with a topic.",
    prompt:
      "Write an original post in my voice about [topic]. Choose a proven framework that fits the topic, but do not model it after one specific source post.",
  },
  {
    id: "namejack",
    group: "borrow-attention",
    command: "create",
    icon: AtSign,
    label: "Namejack a person",
    prompt:
      "Namejack [person] — write a LinkedIn post in my voice that borrows their attention. Anchor on them, then pivot to my own insight. Pick the best lane (agree & extend, respectful contrarian, decode, or apply) and don't fabricate anything they said.",
  },
  {
    id: "brandjack",
    group: "borrow-attention",
    command: "create",
    icon: Building2,
    label: "Brandjack a company",
    prompt:
      "Brandjack [company] — write a LinkedIn post in my voice that borrows their recognition. Do a teardown, a steal-this, or a versus, then deliver something the reader can apply. Keep it factual and reference-only (no impersonation).",
  },
  {
    id: "newsjack",
    group: "borrow-attention",
    command: "create",
    icon: Newspaper,
    label: "Newsjack a recent event",
    prompt:
      "Newsjack a recent event about [topic]. Search for verified news from the last 14 days first, choose the most relevant story for my expertise, and write a timely LinkedIn post in my voice with an original insight. If nothing fresh and appropriate exists, tell me instead of using old or invented news.",
  },
];

const STARTER_LAYOUT = partitionCoworkStarters(STARTERS);

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

const IMAGE_ARTIFACT_POLL_MS = 5000;
const HIDDEN_POLL_MS = 8000;

function EmptyState({
  onPick,
  author,
  nextAction,
}: {
  onPick: (starter: Starter) => void;
  author: Author;
  nextAction: CoworkNextAction;
}) {
  const groups = [
    {
      title: "Explore",
      description: "Find angles from what is working now.",
      starters: STARTER_LAYOUT.library.filter(
        (starter) => starter.group === "explore",
      ),
    },
    {
      title: "Create",
      description: "Turn an idea or proven source into a post.",
      starters: STARTER_LAYOUT.library.filter(
        (starter) => starter.group === "create",
      ),
    },
    {
      title: "Borrow attention",
      description: "Build a post around a person, brand, or timely story.",
      starters: STARTER_LAYOUT.library.filter(
        (starter) => starter.group === "borrow-attention",
      ),
    },
  ];

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center px-2 py-7 sm:px-5 sm:py-9">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3.5 text-left">
        <AvatarImg
          src={author.avatarUrl}
          fallbackSrc={author.fallbackAvatarUrl}
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
            Start with a recommendation, browse workflows, or describe what you need below.
          </p>
          </div>
        </div>
        <NextActionChip action={nextAction} />
      </div>

      <div className="mt-7 grid gap-2 lg:grid-cols-3">
        <StarterCommand
          starter={STARTER_LAYOUT.primary}
          onPick={onPick}
          description={STARTER_LAYOUT.primary.recommendedDescription}
          variant="default"
        />
        {STARTER_LAYOUT.alternatives.map((starter) => (
          <StarterCommand
            key={starter.id}
            starter={starter}
            onPick={onPick}
            description={starter.recommendedDescription}
            variant="default"
          />
        ))}
      </div>

      <details className="group mt-5 border-y border-border">
        <summary className="flex cursor-pointer list-none items-center gap-3 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">Browse more workflows</span>
            <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
              Explore what&apos;s working, model proven posts, and borrow attention.
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <div className="grid grid-cols-1 divide-y divide-border border-t border-border lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          {groups.map((group) => (
            <section key={group.title} className="py-5 md:px-5 first:md:pl-0 last:md:pr-0">
              <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
              <p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">
                {group.description}
              </p>
              <div className="mt-3 flex flex-col gap-1.5">
                {group.starters.map((starter) => (
                  <StarterCommand key={starter.id} starter={starter} onPick={onPick} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </details>
    </div>
  );
}

function StarterCommand({
  starter,
  onPick,
  description,
  variant = "library",
}: {
  starter: Starter;
  onPick: (starter: Starter) => void;
  description?: string;
  variant?: "default" | "library";
}) {
  const Icon = starter.icon;
  return (
    <button
      type="button"
      onClick={() => onPick(starter)}
      title={starter.prompt}
      className={cn(
        "group flex w-full items-center gap-2.5 rounded-[10px] border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 active:translate-y-px",
        variant === "default" && "min-h-[4.5rem] border-border/70 bg-card px-3.5 py-2.5 hover:bg-muted/45",
        variant === "library" && "min-h-12 border-transparent hover:border-border hover:bg-card",
      )}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-tight">{starter.label}</span>
        {description && (
          <span className="mt-1 block text-xs leading-4 text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/55 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function NextActionChip({ action }: { action: CoworkNextAction }) {
  const [breakoutBusy, setBreakoutBusy] = useState(false);
  const iconByKind: Record<CoworkNextAction["kind"], LucideIcon> = {
    track_creators: AtSign,
    voice: Fingerprint,
    inspiration: Search,
    breakout: Flame,
    review: ClipboardCheck,
    schedule: CalendarClock,
    batch: AiIcon,
  };
  const Icon = iconByKind[action.kind];

  // Breakout radar (Phase E4): stash the post as a modeling source, then open a
  // fresh chat with it attached — a grounded turn, one click from the chip.
  const openBreakout = async (e: React.MouseEvent) => {
    if (!action.breakoutPostId || breakoutBusy) return;
    e.preventDefault();
    setBreakoutBusy(true);
    try {
      const res = await fetch("/api/model-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "swipe", postId: action.breakoutPostId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.id) throw new Error(data?.error || "Couldn't open it.");
      window.location.assign(`/dashboard?model=${encodeURIComponent(data.id)}`);
    } catch (error) {
      toast.error((error as Error).message);
      setBreakoutBusy(false);
    }
  };

  return (
    <a
      href={action.href}
      onClick={action.breakoutPostId ? (e) => void openBreakout(e) : undefined}
      aria-busy={breakoutBusy || undefined}
      className="group inline-flex max-w-full items-center gap-2 rounded-full border border-state-info-border bg-state-info-bg px-3 py-1.5 text-left text-xs shadow-sm transition-colors hover:border-state-info"
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-card text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 truncate text-state-info">
        <span className="font-medium">Next:</span>{" "}
        <span>{action.title}</span>
      </span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </a>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


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
// per-card Edit button) produced a second card.

// Render a live run as the two bubbles it contributes to the active chat: the
// user's message and the streaming assistant message.
// The ask-turn reload races the next answer send. If the user answers quickly,
// the ask run is no longer the current run by the time its reload returns, but
// the reloaded rows are still valuable: they contain the persisted ask_user
// card that keeps the prior prompt/question visible under the new answer run.
// Apply that reload when it fills in a missing ask turn, but don't let an older
// ask-only snapshot overwrite a newer base that already includes later rows.
// Compare the optional filename lists on two user messages (order-sensitive,
// which is fine — they come from the same picked-file order).

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

// Decide how to handle a picked file: read as text, send as a parseable file,
// describe as image context, or reject.

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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

// Convert persisted DB rows into display messages. Tool rows are dropped from
// the visible transcript (they're internal); assistant artifacts attach to the
// assistant message. Post fences are stripped from assistant text for display.

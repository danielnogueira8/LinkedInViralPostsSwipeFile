import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  generationConfigV1Schema,
  resolveGenerationConfig,
  resolvedGenerationConfigSchema,
  type GenerationConfigV1,
  type ResolvedGenerationConfig,
} from "@/lib/generation-config";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { NoWorkspaceError } from "@/lib/workspace";
import type { DraftFinalizerSpecialists } from "@/lib/agent/draft-finalizer";
import {
  type DraftEngineSource,
  type DraftEngineTask,
} from "@/lib/agent/draft-engine";
import {
  runWriterTurn,
  WRITER_TURN_BUDGET_MS,
  type WriterInput,
} from "@/lib/agent/execute/writer";
import {
  runAgentTurn,
  ACTION_ORCHESTRATOR_DEADLINE_MS,
} from "@/lib/agent/execute/agent";
import {
  advanceActionOrchestratorClarification,
  actionOrchestratorEnabledForWorkspace,
  compileActionOrchestratorRoute,
  compileReadOnlyOrchestratorRoute,
  compileReadOnlyOrchestratorReserveRoute,
  readOnlyOrchestratorEnabledForWorkspace,
  type ActionOrchestratorRoute,
  type ReadOnlyOrchestratorRoute,
} from "@/lib/agent/turn/compile";
import {
  createSupabaseActionRetryRepository,
  resolveActionRetryRoot,
  type ActionRetryRepository,
} from "@/lib/agent/action-retry";
import {
  continuationForModeledDraftRoute,
  parseModeledDraftBatchContinuation,
  type ModeledDraftBatchContinuation,
} from "@/lib/agent/modeled-draft-continuation";
import {
  isDirectFindAndModelEligible,
  isDirectFixedSourcePostEligible,
  isDirectLeadMagnetEligible,
  isDirectMultiPostEligible,
  isDirectRefineEligible,
  isDirectOriginalPostEligible,
  isDirectPartialTextEligible,
} from "@/lib/agent/direct-writer-policy";
import {
  compileDirectPartialTextSpec,
  requestedDirectPostCount,
} from "@/lib/agent/direct-deliverable-policy";
import { stripArtifactFences } from "@/lib/artifact-fences";
import {
  type AgentEvent,
  type Artifact,
  type PlanStep,
} from "@/lib/agent/contracts";
import {
  createCoworkTurnTelemetry,
  observeCoworkTurn,
  type CoworkRoute,
  type CoworkTelemetrySink,
  type CoworkTurnTelemetry,
} from "@/lib/agent/cowork-telemetry";

import type { CoworkTurnUsageWire } from "@/lib/cowork-turn-usage";
import { encodeChatSseFrame } from "@/lib/transport/contracts";
import {
  configuredSseHeartbeatInterval,
  startSseHeartbeat,
} from "@/lib/transport/sse-heartbeat";
import {
  executeAcceptedChatTurn,
  type ChatTurnOutcome,
} from "@/lib/agent/chat-turn-lifecycle";
import { resolveTurnOutcome } from "@/lib/agent/turn/outcome";
import {
  resolveTurnContract,
  resolveTurnCount,
  type TurnContract,
} from "@/lib/agent/turn/compile";
import {
  buildTurnContext,
  loadCitedSwipePostImage,
  requestedBasePostCount,
  CREATOR_STYLE_CONTEXT_PERSISTENCE_ERROR,
  CREATOR_STYLE_RETRY_CONTEXT_VERSION,
  CREATOR_STYLE_SELECTION_REQUIRED_ERROR,
  CUSTOM_SKILL_RETRY_CONTEXT_VERSION,
  LEAD_MAGNET_SELECTION_REQUIRED_ERROR,
  LEAD_MAGNET_TOOL_NAME,
  MAX_CREATOR_STYLE_RETRY_BLOCK_CHARS,
  MODEL_SOURCE_TOOL_NAME,
  type CreatorStyleRetryContext,
  type CustomSkillRetryContext,
  type FrozenCustomSkill,
  type ModelSourceReference,
  type ModelSourceRow,
} from "@/lib/agent/turn/context";
// Back-compat re-exports: the context-assembly helpers now live in
// lib/agent/turn/context.ts (PLAN-cowork-unification Phase 1, step 4);
// existing importers of this module keep working unchanged.
export {
  chatHistoryWithModelSources,
  extractLeadMagnetSelection,
  extractModelSourceId,
  firstSourceImage,
  imageAttachmentAnalysisBlock,
  isBatchArtifactFilingRow,
  latestAttachedModelSourceId,
  latestDraftForVariation,
  latestLeadMagnetSelection,
  modelSourceEnvelope,
  modelSourceIdForTurn,
  modelSourceStructureBlock,
  resolveTrustedRefineTarget,
  reusableManualLeadMagnetIdForTurn,
  shouldApplyLeadMagnetContext,
  sourceMediaCanRenderAsImage,
} from "@/lib/agent/turn/context";
export type {
  CustomSkillRetryContext,
  FrozenCustomSkill,
} from "@/lib/agent/turn/context";
import {
  checkChatRateLimit,
  claimChatTurn,
  releaseChatTurn,
} from "@/lib/agent/rate-limit";
import { preflightUserPrompt } from "@/lib/agent/prompt-preflight";
import { isCancelRequested } from "@/lib/agent/cancel";
import { safeFilename } from "@/lib/agent/untrusted";
import {
  computeStructureSkeleton,
  type StructureSkeleton,
} from "@/lib/post-structure-skeleton";
import { splicePreservedBody } from "@/lib/hook-splice";
import {
  type NoModelFormat,
} from "@/lib/agent/no-model-formats";
import {
  requestsDirectSourceModeling,
} from "@/lib/agent/source-policy";
import { compileModeledPostIntent } from "@/lib/agent/modeled-post-intent";
import {
  composerStarterIdSchema,
  composerStarterMarkerFromToolCalls,
  composerStarterToolCall,
  resolveComposerTaskContext,
  type ComposerStarterId,
  type ComposerTaskContext,
  type ComposerTaskSelection,
} from "@/lib/composer-task-context";
import {
  hasPendingAskOnly,
  hasPendingActionAsk,
  hasUnsavedAssistantDraftReferent,
  validatePendingActionAnswer,
} from "@/lib/agent/turn-policy";
import {
  NO_MODEL_FORMAT_IDS,
  type NoModelFormatId,
} from "@/lib/agent/no-model-format-catalog";
import {
  leadMagnetGenerateSchema,
} from "@/lib/lead-magnets";
import { generateLeadMagnetResource } from "@/lib/lead-magnet-ai";
import {
  buildLeadMagnetCampaign,
  campaignImageContext,
  enforceLeadMagnetCampaignCta,
  hasLeadMagnetResourceOverlap,
} from "@/lib/lead-magnet-campaign";
import {
  SKILL_BODY_MAX,
  SKILL_NAME_MAX,
  SKILLS_PER_TURN_MAX,
} from "@/lib/custom-skills";
import {
  type ContentFeedback,
} from "@/lib/content-feedback";
import {
  type ContentPreference,
} from "@/lib/preferences";
import { fetchRecentPostDrafts, type RecentDraft } from "@/lib/recent-drafts";
import {
  completeChat,
  logOpenRouterUsage,
  streamChat,
  CHAT_MODEL,
  type ChatMessage,
  type ContentBlock,
  type ToolCall,
  type Usage,
} from "@/lib/openrouter";
import {
  contentFormatForModel,
  stampDraftFormat,
} from "@/lib/markdown/mode";
import {
  AUTOMATIC_LEAD_MAGNET_IMAGE_GENERATION_ENABLED,
  shouldGenerateLeadMagnetImage,
  type LeadMagnetImageContext,
  type SourcePostImage,
} from "@/lib/lead-magnet-image-generation";
import { enqueueLeadMagnetImageJob } from "@/lib/lead-magnet-image-jobs";
import type { AppliedLeadMagnet } from "@/lib/chat-hydration";
import { persistChatAssistantTurn } from "@/lib/chat-message-persistence";
import {
  chatSetupDeadlines,
  createChatSetupDeadline,
  waitForChatSetup,
  type ChatSetupDeadline,
} from "@/lib/chat-stream-policy";
import { runTool, type ToolResult } from "@/lib/agent/tools";
import { canonicalScrapedPostText } from "@/lib/agent/scraped-post-text";
import {
  classifyDirectRefineFocus,
  isExclusiveHookRefine,
} from "@/lib/agent/direct-refine-policy";

export const runtime = "nodejs";
// The agent loop can run several tool rounds + a long final generation. Give it
// the same generous ceiling as the voice route (Vercel Pro fluid compute).
export const maxDuration = 300;
const CHAT_SSE_HEARTBEAT_MS = configuredSseHeartbeatInterval(
  Number(process.env.CHAT_SSE_HEARTBEAT_MS || 15_000),
);

// Attachment limits. The main Cowork model is text/tool-call oriented: text
// attachments are inlined, PDF/doc files ride as parser-backed file blocks, and
// images are first summarized by a vision-capable model before the agent sees
// them as text context.
const MAX_ATTACHMENTS = 5;
// ~10MB per file as a base64 data URL (base64 is ~1.33x the raw bytes).
const MAX_DATA_URL_LEN = 14_000_000;
const MAX_TEXT_LEN = 200_000; // inlined text-file cap (chars)
// Aggregate cap across all attachments in one request (~28MB of base64 ≈ 20MB
// raw), so a request body can't balloon into memory regardless of the per-file
// caps. The client enforces a friendlier 20MB; this is the hard backstop.
const MAX_TOTAL_ATTACHMENT_LEN = 28_000_000;
const CUSTOM_SKILL_CONTEXT_PERSISTENCE_ERROR =
  "I couldn’t save the selected custom-skill context safely, so no draft was created. Send the request again to retry.";
const GENERATION_CONFIG_CONTEXT_PERSISTENCE_ERROR =
  "I couldn’t save the draft-count setting safely, so no draft was created. Send the request again to retry.";

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "skills",
  "csv",
  "tsv",
  "json",
  "log",
]);

const FILE_ATTACHMENT_MIME_TO_EXTENSIONS: Record<string, string[]> = {
  "application/pdf": ["pdf"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    "docx",
  ],
  "application/rtf": ["rtf"],
  "text/rtf": ["rtf"],
};

const IMAGE_ATTACHMENT_MIME_TO_EXTENSIONS: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
};

type AttachmentInput = {
  kind: "text" | "file" | "image";
  filename: string;
  text?: string;
  dataUrl?: string;
};

function extensionForFilename(filename: string): string {
  const clean = safeFilename(filename).toLowerCase();
  const idx = clean.lastIndexOf(".");
  return idx >= 0 ? clean.slice(idx + 1) : "";
}

function parseDataUrlHeader(
  dataUrl: string,
): { mime: string; isBase64: boolean; body: string } | null {
  const match = /^data:([^;,]+)((?:;[^,]+)*),([\s\S]*)$/i.exec(dataUrl);
  if (!match) return null;
  return {
    mime: match[1].trim().toLowerCase(),
    isBase64: match[2].toLowerCase().split(";").includes("base64"),
    body: match[3],
  };
}

function decodeDataUrlPrefix(body: string): Buffer {
  return Buffer.from(body.slice(0, 256), "base64");
}

function hasExpectedMagicBytes(mime: string, body: string): boolean {
  const prefix = decodeDataUrlPrefix(body);
  if (mime === "application/pdf") {
    return prefix.subarray(0, 4).toString("ascii") === "%PDF";
  }
  if (mime === "application/msword") {
    return prefix
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  }
  if (
    mime ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return prefix.subarray(0, 2).toString("ascii") === "PK";
  }
  if (mime === "application/rtf" || mime === "text/rtf") {
    return prefix.subarray(0, 5).toString("ascii").startsWith("{\\rtf");
  }
  if (mime === "image/png") {
    return prefix
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === "image/jpeg") {
    return prefix.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  }
  if (mime === "image/webp") {
    return (
      prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
      prefix.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

export function validateChatAttachment(input: AttachmentInput): string | null {
  const ext = extensionForFilename(input.filename);
  if (input.kind === "text") {
    if (!input.text?.trim()) return "Text attachments must include text.";
    if (input.dataUrl) return "Text attachments must not include file data.";
    if (!TEXT_ATTACHMENT_EXTENSIONS.has(ext))
      return "Unsupported text attachment type.";
    return null;
  }

  if (!input.dataUrl) return "File attachments must include file data.";
  if (input.text) return "File attachments must not include inline text.";

  const parsed = parseDataUrlHeader(input.dataUrl);
  if (!parsed || !parsed.isBase64)
    return "File attachments must be base64 data URLs.";

  const allowedExtensions =
    input.kind === "image"
      ? IMAGE_ATTACHMENT_MIME_TO_EXTENSIONS[parsed.mime]
      : FILE_ATTACHMENT_MIME_TO_EXTENSIONS[parsed.mime];
  if (!allowedExtensions) {
    return input.kind === "image"
      ? "Unsupported image attachment type."
      : "Unsupported file attachment type.";
  }
  if (!allowedExtensions.includes(ext))
    return "Attachment filename does not match its file type.";
  if (!hasExpectedMagicBytes(parsed.mime, parsed.body)) {
    return "Attachment content does not match its declared file type.";
  }
  return null;
}

const attachmentSchema: z.ZodType<AttachmentInput> = z
  .object({
    kind: z.enum(["text", "file", "image"]),
    filename: z.string().min(1).max(255),
    // For kind:'text' — the decoded text content (client reads it).
    text: z.string().max(MAX_TEXT_LEN).optional(),
    // For kind:'file'/'image' — a data: URL.
    dataUrl: z.string().max(MAX_DATA_URL_LEN).optional(),
  })
  .superRefine((attachment, ctx) => {
    const message = validateChatAttachment(attachment);
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });

export const chatTurnRequestSchema = z.object({
  // Empty/overlong/junk user text is handled by preflightUserPrompt below so
  // the user gets a friendly, specific rejection and no turn is claimed.
  message: z.string(),
  clientTurnId: z.string().uuid().optional(),
  retryOfUserMessageId: z.string().min(1).max(200).optional(),
  actionSelectionIds: z.array(z.string().uuid()).min(1).max(5).optional(),
  clientTimezone: z.string().min(1).max(64).optional(),
  // "Model this post": the stashed source id (chat_modeling_sources). The server
  // fetches + weaves the post text, so a long post never hits the message cap.
  modelSourceId: z.string().uuid().optional(),
  // True for an AI-refine turn (the user clicked "Refine" on a specific draft).
  // A refine already targets ONE unambiguous card client-side, so the routing
  // layer treats it as a trusted refine task rather than a from-scratch post.
  skipDecision: z.boolean().optional(),
  // Trusted refine identity. New clients send the selected artifact id and the
  // concise user instruction separately from the legacy body-embedded message.
  // The server re-reads the artifact from this chat; it never trusts a client
  // body as the direct writer's source of truth.
  refineTargetId: z.string().min(1).max(200).optional(),
  refineInstruction: z.string().trim().min(1).max(4_000).optional(),
  // Hook-only refine: server-side splice guarantee. When true, the server
  // takes ONLY the model's new opener from the render_post output and glues
  // it onto hookOnlyOriginalBody byte-for-byte before persisting the artifact.
  // The body cannot drift no matter what the model returned. Set by the
  // per-card Refine button and by the ask-card "Tighten the hook" click.
  // Both fields must be present together; either alone is ignored.
  hookOnly: z.boolean().optional(),
  hookOnlyOriginalBody: z.string().max(20000).optional(),
  // Custom skills the user invoked this turn (via /name or the ⚡ picker). The
  // server resolves these ids → bodies (workspace-scoped, capped) and injects
  // them into the agent's skill block. Capped here too so a crafted request
  // can't smuggle in dozens.
  skillIds: z.array(z.string().uuid()).max(SKILLS_PER_TURN_MAX).optional(),
  // Optional UI-selected no-model post format. Only honored for from-scratch
  // post requests; modeled/template/refine/hook/search turns ignore it.
  forcedNoModelFormatId: z.enum(NO_MODEL_FORMAT_IDS).optional(),
  // Optional UI-selected creator style. The server resolves the id → the
  // workspace's READY profile (never trusts a client body) and injects its
  // mechanics-only block. Ignored when a model source is attached (the source
  // controls structure). Composes with a post format.
  creatorStyleId: z.string().uuid().optional(),
  // Optional UI-selected lead magnet. Honored only for lead-magnet/giveaway
  // turns; otherwise ignored so it cannot leak into regular posts.
  leadMagnetId: z.string().uuid().optional(),
  // Optional UI-selected request to create a new lead magnet for this post.
  // The resource is generated only after a draft artifact exists, so the
  // resource can be based on the finished post instead of steering it upfront.
  createLeadMagnet: leadMagnetGenerateSchema.optional(),
  // Structured per-turn generation controls. Count is transported separately
  // from free text so source quantities and output quantities cannot be
  // conflated by downstream prompts or planners.
  generationConfig: generationConfigV1Schema.optional(),
  // Server-owned semantics for a prompt chosen from the existing starter UI.
  // Copy can be edited freely; the stable id carries the selected workflow.
  starterId: composerStarterIdSchema.optional(),
  attachments: z
    .array(attachmentSchema)
    .max(MAX_ATTACHMENTS)
    .optional()
    .refine(
      (atts) =>
        !atts ||
        atts.reduce(
          (n, a) => n + (a.dataUrl?.length ?? 0) + (a.text?.length ?? 0),
          0,
        ) <= MAX_TOTAL_ATTACHMENT_LEN,
      { message: "Attachments exceed the total size limit." },
    ),
});

export type ChatTurnRequest = z.infer<typeof chatTurnRequestSchema>;

/**
 * Return only a quantity explicitly attached to the requested post output.
 * Source/discovery counts are intentionally ignored.
 */
export function explicitMessageDraftCount(instruction: string): number | null {
  const modeledIntent = compileModeledPostIntent(instruction);
  if (modeledIntent.kind === "exact") {
    return modeledIntent.outputCount;
  }
  if (
    modeledIntent.kind === "ambiguous" &&
    modeledIntent.outputCount.kind === "exact"
  ) {
    return modeledIntent.outputCount.value;
  }
  return requestedDirectPostCount(instruction);
}

export type ChatTurnDependencies = {
  scopedSupabase: typeof scopedSupabase;
  checkChatRateLimit: typeof checkChatRateLimit;
  claimChatTurn: typeof claimChatTurn;
  releaseChatTurn: typeof releaseChatTurn;
  runWriterTurn: typeof runWriterTurn;
  runAgentTurn: typeof runAgentTurn;
  createActionRetryRepository: typeof createSupabaseActionRetryRepository;
  actionOrchestratorEnabledForWorkspace: typeof actionOrchestratorEnabledForWorkspace;
  readOnlyOrchestratorEnabledForWorkspace: typeof readOnlyOrchestratorEnabledForWorkspace;
  completeChat: typeof completeChat;
  fetchRecentPostDrafts: typeof fetchRecentPostDrafts;
  generateLeadMagnetResource: typeof generateLeadMagnetResource;
  now: () => Date;
  draftFinalizerSpecialists?: Partial<DraftFinalizerSpecialists>;
  /** Optional telemetry sink for tests/observers. Defaults to console logging. */
  coworkTelemetrySink?: CoworkTelemetrySink;
};

const productionChatTurnDependencies: ChatTurnDependencies = {
  scopedSupabase,
  checkChatRateLimit,
  claimChatTurn,
  releaseChatTurn,
  runWriterTurn,
  runAgentTurn,
  createActionRetryRepository: createSupabaseActionRetryRepository,
  actionOrchestratorEnabledForWorkspace,
  readOnlyOrchestratorEnabledForWorkspace,
  completeChat,
  fetchRecentPostDrafts,
  generateLeadMagnetResource,
  now: () => new Date(),
};

type Attachment = z.infer<typeof attachmentSchema>;

export function isRecentUnansweredUserMessage(
  message: { role?: unknown; created_at?: unknown } | null | undefined,
  now: number = Date.now(),
): boolean {
  if (message?.role !== "user" || typeof message.created_at !== "string") {
    return false;
  }
  const ageMs = now - new Date(message.created_at).getTime();
  return ageMs >= 0 && ageMs < 30_000;
}

const PINNED_COWORK_ROUTE_VALUES = new Set<CoworkRoute>([
  "direct_writer",
  "action_orchestrator",
  "read_only_orchestrator",
  "answer",
]);

function normalizePinnedCoworkRoute(value: unknown): CoworkRoute | null {
  if (
    typeof value === "string" &&
    PINNED_COWORK_ROUTE_VALUES.has(value as CoworkRoute)
  ) {
    return value as CoworkRoute;
  }
  return null;
}

const CUSTOM_SKILLS_TOOL_NAME = "_custom_skills_applied";
const POST_FORMAT_TOOL_NAME = "_post_format_selected";
const CREATOR_STYLE_TOOL_NAME = "_creator_style_selected";
const GENERATION_CONFIG_TOOL_NAME = "_generation_config_selected";
// Stashed on the ASSISTANT row when the turn ended with a recoverable error
// (cut-off / stalled, including before SSE headers). hydrate() reads it back so
// the one-click Retry banner survives the canonical reload.
const RECOVERABLE_TOOL_NAME = "_recoverable";
const TURN_USAGE_TOOL_NAME = "_turn_usage";

type RecoverableMarker = {
  code: string | number;
  message: string;
  retryRootUserMessageId?: string;
  continuation?: ModeledDraftBatchContinuation;
};

function isServerRecoverableToolCall(call: ToolCall): boolean {
  return (
    call.id === RECOVERABLE_TOOL_NAME &&
    call.function.name === RECOVERABLE_TOOL_NAME
  );
}

export type RetryRootMarker =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "valid"; rootUserMessageId: string };

export function retryRootMarkerFromToolCalls(
  calls: readonly ToolCall[] | null | undefined,
): RetryRootMarker {
  if (!calls) return { kind: "none" };
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (!isServerRecoverableToolCall(call)) continue;
    try {
      const parsed = JSON.parse(call.function.arguments) as {
        retryRootUserMessageId?: unknown;
      };
      if (
        !Object.prototype.hasOwnProperty.call(
          parsed,
          "retryRootUserMessageId",
        )
      ) {
        return { kind: "none" };
      }
      const root = z.string().uuid().safeParse(parsed.retryRootUserMessageId);
      return root.success
        ? { kind: "valid", rootUserMessageId: root.data }
        : { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
  }
  return { kind: "none" };
}

export type ModeledDraftBatchContinuationMarker =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "valid"; continuation: ModeledDraftBatchContinuation };

export function modeledDraftBatchContinuationMarkerFromToolCalls(
  calls: readonly ToolCall[] | null | undefined,
): ModeledDraftBatchContinuationMarker {
  if (!calls) return { kind: "none" };
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (!isServerRecoverableToolCall(call)) continue;
    try {
      const parsed = JSON.parse(call.function.arguments) as {
        code?: unknown;
        retryRootUserMessageId?: unknown;
        continuation?: unknown;
      };
      const claimsModeledContinuation =
        Object.prototype.hasOwnProperty.call(parsed, "continuation") ||
        (typeof parsed.code === "string" &&
          parsed.code.startsWith("modeled_batch_resumable_"));
      if (!claimsModeledContinuation) return { kind: "none" };
      const root = z.string().uuid().safeParse(parsed.retryRootUserMessageId);
      const continuation = parseModeledDraftBatchContinuation(
        parsed.continuation,
      );
      if (!root.success || !continuation) {
        return { kind: "invalid" };
      }
      return { kind: "valid", continuation };
    } catch {
      return { kind: "invalid" };
    }
  }
  return { kind: "none" };
}

// Build the synthetic marker persisted on the assistant row for a recoverable
// turn. Carries the code + message so hydrate can rebuild the exact banner.
function recoverableToolCall(marker: RecoverableMarker): ToolCall {
  return {
    id: "_recoverable",
    type: "function",
    function: {
      name: RECOVERABLE_TOOL_NAME,
      arguments: JSON.stringify({
        code: String(marker.code ?? ""),
        message: marker.message,
        ...(marker.retryRootUserMessageId
          ? { retryRootUserMessageId: marker.retryRootUserMessageId }
          : {}),
        ...(marker.continuation
          ? { continuation: marker.continuation }
          : {}),
      }),
    },
  };
}

function turnUsageToolCall(usage: CoworkTurnUsageWire): ToolCall {
  return {
    id: TURN_USAGE_TOOL_NAME,
    type: "function",
    function: {
      name: TURN_USAGE_TOOL_NAME,
      arguments: JSON.stringify(usage),
    },
  };
}

export function generationConfigToolCall(
  config: ResolvedGenerationConfig,
): ToolCall {
  return {
    id: GENERATION_CONFIG_TOOL_NAME,
    type: "function",
    function: {
      name: GENERATION_CONFIG_TOOL_NAME,
      arguments: JSON.stringify(config),
    },
  };
}

export type GenerationConfigSelectionMarker =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "valid"; config: ResolvedGenerationConfig };

export function generationConfigSelectionMarkerFromToolCalls(
  calls: readonly ToolCall[] | null | undefined,
): GenerationConfigSelectionMarker {
  const markers = (calls ?? []).filter(
    (call) =>
      call.id === GENERATION_CONFIG_TOOL_NAME &&
      call.function.name === GENERATION_CONFIG_TOOL_NAME,
  );
  if (markers.length === 0) return { kind: "none" };
  if (markers.length !== 1) return { kind: "invalid" };
  try {
    const parsed = resolvedGenerationConfigSchema.safeParse(
      JSON.parse(markers[0].function.arguments),
    );
    return parsed.success
      ? { kind: "valid", config: parsed.data }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

async function persistChatSetupFailure(opts: {
  sb: SupabaseClient;
  chatId: string;
  workspaceId: string;
  content: string;
  recoverable?: RecoverableMarker;
}): Promise<void> {
  try {
    const { error } = await opts.sb.from("chat_messages").insert({
      chat_id: opts.chatId,
      workspace_id: opts.workspaceId,
      role: "assistant",
      content: opts.content,
      ...(opts.recoverable
        ? { tool_calls: [recoverableToolCall(opts.recoverable)] }
        : {}),
    });
    if (error) throw error;
  } catch {
    // Best effort. The claim is still released in the caller's next step so a
    // database write failure cannot wedge the chat for the stale-claim window.
  }
}

// The raw skeleton (not the rendered prose block) for a genuine modeling
// source — same genre gate as modelSourceStructureBlock. Feeds the
// finalizer's coarse structure gate (DraftFinalizerOptions.structureSkeleton
// in lib/agent/draft-finalizer.ts): its mere presence scopes that gate to
// modeled-post turns only, so a refine/template source must yield undefined
// here, not just an empty prose block.
export function modelSourceStructureSkeleton(
  src: Pick<ModelSourceRow, "post_text" | "source">,
): StructureSkeleton | undefined {
  if (src.source === "draft" || src.source === "template") return undefined;
  const clean = src.post_text.trim();
  if (!clean) return undefined;
  return computeStructureSkeleton(clean);
}

function withGeneratedImageMeta(
  artifact: Artifact,
  generatedImageMeta: Record<string, unknown>,
): Artifact {
  return {
    ...artifact,
    meta: {
      ...(artifact.meta ?? {}),
      generated_lead_magnet_image: generatedImageMeta,
    },
  };
}

export function tagArtifactWithModelSourceReference(
  artifact: Artifact,
  sourceRef: ModelSourceReference | null,
): Artifact {
  if (!sourceRef) return artifact;
  if (artifact.kind === "cite") return artifact;
  const meta = artifact.meta ?? {};
  const existingSourceId =
    typeof meta.source_post_id === "string" && meta.source_post_id.trim()
      ? meta.source_post_id
      : null;
  // A durable modeled batch already owns one canonical source per artifact.
  // Turn-level history may still contain an older attached source; that
  // convenience reference may fill missing provenance, but it must never
  // replace an artifact's explicit slot identity.
  if (
    existingSourceId &&
    existingSourceId !== sourceRef.source_post_id
  ) {
    return artifact;
  }
  return {
    ...artifact,
    meta: {
      ...meta,
      source: "model_source",
      source_post_id: sourceRef.source_post_id,
      ...(sourceRef.source_url ? { source_url: sourceRef.source_url } : {}),
    },
  };
}

export function sourceReferenceFromCiteArtifact(
  artifact: Artifact,
): ModelSourceReference | null {
  if (artifact.kind !== "cite") return null;
  const meta = artifact.meta as
    | {
        postId?: unknown;
        card?: { id?: unknown; postUrl?: unknown };
      }
    | undefined;
  const sourcePostId =
    typeof meta?.card?.id === "string"
      ? meta.card.id
      : typeof meta?.postId === "string"
        ? meta.postId
        : "";
  const sourceUrl =
    typeof meta?.card?.postUrl === "string" &&
    /^https?:\/\//i.test(meta.card.postUrl)
      ? meta.card.postUrl
      : null;
  if (!sourcePostId) return null;
  return { source_post_id: sourcePostId, source_url: sourceUrl };
}

function sourceReferenceFromCiteArtifacts(
  citeArtifacts: Artifact[],
): ModelSourceReference | null {
  for (const artifact of citeArtifacts) {
    const sourceRef = sourceReferenceFromCiteArtifact(artifact);
    if (sourceRef) return sourceRef;
  }
  return null;
}

function isDraftArtifact(artifact: Artifact): boolean {
  return artifact.kind === "post" || artifact.kind === "hook";
}

// Mutates `artifacts` in place (an already-streamed draft gets its source_url
// backfilled) AND returns the artifacts that actually changed, so the caller
// can re-send exactly those over the live SSE stream. Without that second
// half, a cite arriving AFTER its draft (the prompt's own instructed order —
// "call render_cite AFTER mentioning the post") patches the SERVER's copy but
// the browser — which already rendered the draft with no chip — never learns
// about the correction until a later page reload re-fetches from the DB.
export function applyCiteSourceToDraftArtifacts(
  artifacts: Artifact[],
  citeArtifacts: Artifact[],
): Artifact[] {
  const sourceRef = sourceReferenceFromCiteArtifacts(citeArtifacts);
  if (!sourceRef) return [];
  const updated: Artifact[] = [];
  for (let i = 0; i < artifacts.length; i++) {
    const artifact = artifacts[i];
    if (!isDraftArtifact(artifact)) continue;
    const currentMeta = artifact.meta as
      | { source_post_id?: unknown; source_url?: unknown }
      | undefined;
    const currentSourceId =
      typeof currentMeta?.source_post_id === "string"
        ? currentMeta.source_post_id
        : "";
    if (currentSourceId && currentSourceId !== sourceRef.source_post_id) {
      continue;
    }
    const currentUrl = currentMeta?.source_url;
    if (typeof currentUrl === "string" && currentUrl) continue;
    artifacts[i] = tagArtifactWithModelSourceReference(artifact, sourceRef);
    updated.push(artifacts[i]);
  }
  return updated;
}

export function modelSourceToolCall(modelSourceId: string): ToolCall {
  return {
    id: "_model_source_attached",
    type: "function",
    function: {
      name: MODEL_SOURCE_TOOL_NAME,
      arguments: JSON.stringify({ id: modelSourceId }),
    },
  };
}

export function customSkillsToolCall(
  names: string[],
  retryContext?: CustomSkillRetryContext,
): ToolCall {
  return {
    id: "_skills_applied",
    type: "function",
    function: {
      name: CUSTOM_SKILLS_TOOL_NAME,
      arguments: JSON.stringify({
        names,
        ...(retryContext ? { retryContext } : {}),
      }),
    },
  };
}

export type CustomSkillSelectionMarker =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "unfrozen" }
  | { kind: "valid"; context: CustomSkillRetryContext };

const customSkillRetryItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(SKILL_NAME_MAX),
    body: z.string().trim().min(1).max(SKILL_BODY_MAX),
  })
  .strict();
const customSkillSelectionSchema = z
  .object({
    names: z
      .array(z.string().trim().min(1).max(SKILL_NAME_MAX))
      .min(1)
      .max(SKILLS_PER_TURN_MAX),
    retryContext: z
      .object({
        version: z.literal(CUSTOM_SKILL_RETRY_CONTEXT_VERSION),
        skills: z
          .array(customSkillRetryItemSchema)
          .min(1)
          .max(SKILLS_PER_TURN_MAX),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.retryContext.skills.map((skill) => skill.id);
    const frozenNames = value.retryContext.skills.map((skill) => skill.name);
    if (
      new Set(ids).size !== ids.length ||
      new Set(frozenNames).size !== frozenNames.length ||
      value.names.length !== frozenNames.length ||
      value.names.some((name, index) => name !== frozenNames[index])
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "custom-skill retry context must map one-to-one",
      });
    }
  });
const legacyCustomSkillSelectionSchema = z
  .object({
    names: z
      .array(z.string().trim().min(1).max(SKILL_NAME_MAX))
      .min(1)
      .max(SKILLS_PER_TURN_MAX),
  })
  .strict();

/** Recover only the exact bounded skill bodies persisted by the server. */
export function customSkillSelectionMarkerFromToolCalls(
  calls: readonly ToolCall[] | null | undefined,
): CustomSkillSelectionMarker {
  const markers = (calls ?? []).filter(
    (call) => call.function.name === CUSTOM_SKILLS_TOOL_NAME,
  );
  if (markers.length === 0) return { kind: "none" };
  if (markers.length !== 1) return { kind: "invalid" };
  try {
    const value: unknown = JSON.parse(markers[0].function.arguments);
    const parsed = customSkillSelectionSchema.safeParse(value);
    if (parsed.success) {
      return {
        kind: "valid",
        context: {
          version: parsed.data.retryContext.version,
          skills: parsed.data.retryContext.skills,
        },
      };
    }
    return legacyCustomSkillSelectionSchema.safeParse(value).success
      ? { kind: "unfrozen" }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

export function postFormatToolCall(args: {
  id: NoModelFormatId;
  label: string;
  forced: boolean;
}): ToolCall {
  return {
    id: "_post_format_selected",
    type: "function",
    function: {
      name: POST_FORMAT_TOOL_NAME,
      arguments: JSON.stringify(args),
    },
  };
}

// Synthetic tool call stashed on the user row when a creator style was applied
// this turn — hydrate() reads it back to render the "Style: Creator Name" badge.
// Persisted only when the style actually reached the model (resolved + no model
// source), mirroring the forced-only gate on the post-format tool call.
export function creatorStyleToolCall(args: {
  id: string;
  name: string;
  creatorName: string;
}, retryContext?: {
  version: typeof CREATOR_STYLE_RETRY_CONTEXT_VERSION;
  resolvedBlock: string;
}): ToolCall {
  return {
    id: "_creator_style_selected",
    type: "function",
    function: {
      name: CREATOR_STYLE_TOOL_NAME,
      arguments: JSON.stringify({
        ...args,
        ...(retryContext ? { retryContext } : {}),
      }),
    },
  };
}

export type CreatorStyleSelectionMarker =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "unfrozen"; id: string }
  | { kind: "valid"; context: CreatorStyleRetryContext };

const creatorStyleSelectionBaseSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1),
    creatorName: z.string().trim().min(1),
  });
const creatorStyleSelectionSchema = creatorStyleSelectionBaseSchema
  .extend({
    retryContext: z
      .object({
        version: z.literal(CREATOR_STYLE_RETRY_CONTEXT_VERSION),
        resolvedBlock: z
          .string()
          .trim()
          .min(1)
          .max(MAX_CREATOR_STYLE_RETRY_BLOCK_CHARS),
      })
      .strict(),
  })
  .strict();
const legacyCreatorStyleSelectionSchema =
  creatorStyleSelectionBaseSchema.strict();

/**
 * Recover only a server-persisted creator-style selection. Retry requests do
 * not trust a fresh client id because changing optional writing context would
 * rebind a durable modeled batch to different generation semantics.
 */
export function creatorStyleSelectionMarkerFromToolCalls(
  calls: readonly ToolCall[] | null | undefined,
): CreatorStyleSelectionMarker {
  const markers = (calls ?? []).filter(
    (call) =>
      call.id === CREATOR_STYLE_TOOL_NAME &&
      call.function.name === CREATOR_STYLE_TOOL_NAME,
  );
  if (markers.length === 0) return { kind: "none" };
  if (markers.length !== 1) return { kind: "invalid" };
  try {
    const value: unknown = JSON.parse(markers[0].function.arguments);
    const parsed = creatorStyleSelectionSchema.safeParse(value);
    if (parsed.success) {
      return {
        kind: "valid",
        context: {
          version: parsed.data.retryContext.version,
          id: parsed.data.id,
          name: parsed.data.name,
          creatorName: parsed.data.creatorName,
          resolvedBlock: parsed.data.retryContext.resolvedBlock,
        },
      };
    }
    const legacy = legacyCreatorStyleSelectionSchema.safeParse(value);
    return legacy.success
      ? { kind: "unfrozen", id: legacy.data.id }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

export function leadMagnetToolCall(
  args: AppliedLeadMagnet & { id: string },
): ToolCall {
  return {
    id: "_lead_magnet_selected",
    type: "function",
    function: {
      name: LEAD_MAGNET_TOOL_NAME,
      arguments: JSON.stringify(args),
    },
  };
}

const LEAD_MAGNET_IMAGE_PLAN_STEP_ID = "server_lead_magnet_image";
const LEAD_MAGNET_RESOURCE_PLAN_STEP_ID = "server_lead_magnet_resource";

export function withLeadMagnetImagePlanStep(
  steps: PlanStep[],
  status: PlanStep["status"],
): PlanStep[] {
  const imageStep: PlanStep = {
    id: LEAD_MAGNET_IMAGE_PLAN_STEP_ID,
    label: "Adapt the source image",
    status,
  };
  if (steps.length === 0) {
    return [
      {
        id: "server_draft_lead_magnet_post",
        label: "Draft the lead-magnet post",
        status: "done",
      },
      imageStep,
    ];
  }
  const existing = steps.findIndex(
    (step) => step.id === LEAD_MAGNET_IMAGE_PLAN_STEP_ID,
  );
  if (existing >= 0) {
    return steps.map((step, index) =>
      index === existing ? { ...step, status } : step,
    );
  }
  return [...steps, imageStep];
}

export function withLeadMagnetResourcePlanStep(
  steps: PlanStep[],
  status: PlanStep["status"],
): PlanStep[] {
  const resourceStep: PlanStep = {
    id: LEAD_MAGNET_RESOURCE_PLAN_STEP_ID,
    label: "Generate or match the lead magnet resource",
    status,
  };
  if (steps.length === 0) {
    return [
      {
        id: "server_draft_lead_magnet_post",
        label: "Draft the lead-magnet post",
        status: "done",
      },
      resourceStep,
    ];
  }
  const existing = steps.findIndex(
    (step) => step.id === LEAD_MAGNET_RESOURCE_PLAN_STEP_ID,
  );
  if (existing >= 0) {
    return steps.map((step, index) =>
      index === existing ? { ...step, status } : step,
    );
  }
  return [...steps, resourceStep];
}

// A resolved find-and-model source: the lean engine input (id + raw body) plus
// the post_url so chat-turn can stamp the draft's "Source post" chip.
export type ResolvedFindAndModelSource = {
  source: DraftEngineSource;
  sourceUrl: string | null;
};

// THIN PATH find-and-model source resolver. Runs the SAME rotation-aware search
// the heavy loop's directSourceModelingTurn prefetch uses (top viral REGULAR
// post, limit 1), so "find a top post and rewrite it" resolves a source up
// front and can take the lean direct route instead of the GLM render loop.
// Returns the source body (for the engine) AND the post_url (for the source
// chip). Fail-open: any error / empty result returns undefined and the caller
// falls through to the heavy path unchanged.
export async function resolveFindAndModelSource(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<ResolvedFindAndModelSource | undefined> {
  try {
    const result = await runTool(
      "search_viral_posts",
      { post_type: "regular", sort: "viral", dir: "desc", limit: 1 },
      workspaceId,
      signal,
      { autoSelectModelingSources: true },
    );
    if (result.ok === false) return undefined;
    const posts = Array.isArray(result.posts)
      ? (result.posts as Array<{
          id?: unknown;
          text?: unknown;
          post_url?: unknown;
        }>)
      : [];
    const top = posts[0];
    if (
      !top ||
      typeof top.id !== "string" ||
      typeof top.text !== "string" ||
      !top.text.trim()
    ) {
      return undefined;
    }
    const body = canonicalScrapedPostText(top.text);
    if (!body) return undefined;
    const sourceUrl =
      typeof top.post_url === "string" && /^https?:\/\//i.test(top.post_url)
        ? top.post_url
        : null;
    return { source: { id: top.id, text: body }, sourceUrl };
  } catch {
    return undefined;
  }
}

// -----------------------------------------------------------------------------
// POST /api/chats/[id]/stream
//
// Body: { message }. Persists the user message, runs the GLM-5.1 agent over the
// full transcript, and streams AgentEvents back as SSE. On completion persists
// the assistant turn (text + tool_calls + artifacts) and every tool result, and
// bumps the chat's updated_at (+ auto-titles it from the first user message).
// -----------------------------------------------------------------------------
export async function executeChatTurn(
  input: {
    chatId: string;
    userId: string;
    body: ChatTurnRequest;
    signal: AbortSignal;
  },
  dependencies: Partial<ChatTurnDependencies> = {},
) {
  const { chatId, userId, body, signal } = input;
  const deps = { ...productionChatTurnDependencies, ...dependencies };

  // Resolve workspace + validate the chat up front (outside the stream) so auth
  // / not-found errors come back as normal JSON, not a half-open SSE stream.
  let workspaceId: string;
  let sbRaw: Awaited<ReturnType<typeof scopedSupabase>>["raw"];
  let userText: string;
  let attachments: Attachment[] = [];
  let modelSourceId: string | undefined;
  let currentModelSource: ModelSourceRow | null = null;
  let skipDecision = false;
  let refineTargetId: string | undefined;
  let refineInstruction: string | undefined;
  let trustedRefineTarget: Artifact | null = null;
  let skillIds: string[] = [];
  let customSkillRetryContext: CustomSkillRetryContext | null = null;
  let resolvedCustomSkills: FrozenCustomSkill[] = [];
  let forcedNoModelFormatId: NoModelFormatId | undefined;
  let creatorStyleId: string | undefined;
  let creatorStyleRetryContext: CreatorStyleRetryContext | null = null;
  let leadMagnetId: string | undefined;
  let createLeadMagnet: z.infer<typeof leadMagnetGenerateSchema> | undefined;
  let requestedGenerationConfig: GenerationConfigV1 | null = null;
  let resolvedGenerationConfig: ResolvedGenerationConfig | null = null;
  let generationConfigRestoredFromRetry = false;
  let activeDraftCountOverride: number | undefined;
  let composerStarterId: ComposerStarterId | undefined;
  let composerTaskContext: ComposerTaskContext | null = null;
  let composerTaskSelection: ComposerTaskSelection = {};
  let hasAuthoritativeDraftCount = false;
  // Hook-only refine: when both are set, the artifact handler splices the
  // model's new opener onto hookOnlyOriginalBody byte-for-byte before pushing
  // + persisting. See lib/hook-splice.ts:splicePreservedBody.
  let hookOnly = false;
  let hookOnlyOriginalBody: string | undefined;
  let hasModelSource = false;
  // Resolved bodies of the user's invoked custom skills (filled in below).
  let customSkillBodies: string[] = [];
  // Parallel to customSkillBodies — the slugs, passed to the decide pre-pass so
  // it never asks "which skill?" when one is already applied (see decide.ts).
  let customSkillNames: string[] = [];
  // Set once claimChatTurn succeeds, so any later failure in setup (or the
  // stream's finally) releases the exclusive turn claim rather than leaving the
  // chat wedged until the staleness window expires.
  let turnClaimed = false;
  let turnCostOperationKey: string | null = null;
  let claimedTurnStartedAt: string | null = null;
  let claimedUserMessageId: string | null = null;
  let actionTurnMessageId: string | null = null;
  let resolvedActionInstruction: string | null = null;
  let normalizedActionRoute: ActionOrchestratorRoute | null = null;
  let confirmedActionTargetIds: string[] = [];
  let actionRetryRepository: ActionRetryRepository | null = null;
  let persistedActionContinuation = false;
  let pendingActionAsk = false;
  let pendingAskOnly = false;
  let modeledBatchContinuation: ModeledDraftBatchContinuation | null = null;
  let modeledBatchContractRequested = false;
  let currentTurnModelSourceOwnership:
    | "historical_continuation"
    | "server_selected" = "historical_continuation";
  let setupDeadline: ChatSetupDeadline | null = null;
  let setupSignal: AbortSignal = signal;
  // Claim-time contract PLACEHOLDER (telemetry-only): built pre-claim through
  // the SAME resolveTurnContract builder that resolves the single
  // authoritative contract post-routing, so setup-cancellation telemetry keeps
  // the request's kind. Never consumed by routing, executors, or persistence
  // gates, and always overwritten by the post-clarification contract before
  // the turn runs.
  let preclaimContractPlaceholder: TurnContract = {
    kind: "answer",
    expectedCount: 1,
  };
  // Count-only projection of that placeholder: keeps the generation-config
  // resolution honest on multi-draft turns (the claim's cost reservation
  // derives its own count from the message content through the same
  // resolveTurnCount rule — see rate-limit.ts turnCostEstimate).
  let preclaimPostDraftEstimate: number | null = null;
  // Post-clarification composer post count, hoisted out of the setup block so
  // the persistence gates and the single contract resolution can use it.
  let postClarificationPostCount: number | null = null;
  // Session-sticky lane preference for this chat. Loaded from the chat row and
  // honored unless this turn is explicitly continuing a saved workflow.
  let pinnedCoworkRoute: CoworkRoute | null = null;
  // Kind projection of the best available estimate, used only for
  // zero-delivery telemetry finishes before the single contract exists.
  const estimatedContractKind = (): TurnContract["kind"] =>
    postClarificationPostCount !== null
      ? "post"
      : preclaimContractPlaceholder.kind;
  let coworkTelemetry!: CoworkTurnTelemetry;
  const disarmSetupGuards = () => {
    setupDeadline?.stop();
  };
  const turnError = (
    message: string,
    status: number,
    extraHeaders?: Record<string, string>,
  ) =>
    jsonError(message, status, {
      ...(extraHeaders ?? {}),
      ...(claimedUserMessageId
        ? { "X-User-Message-Id": claimedUserMessageId }
        : {}),
      ...(claimedTurnStartedAt
        ? { "X-Turn-Started-At": claimedTurnStartedAt }
        : {}),
    });
  try {
    const sb = await deps.scopedSupabase();
    workspaceId = sb.workspaceId;
    sbRaw = sb.raw;
    userText = body.message;
    attachments = body.attachments ?? [];
    modelSourceId = body.modelSourceId;
    skipDecision = body.skipDecision ?? false;
    refineTargetId = body.refineTargetId;
    refineInstruction = body.refineInstruction;
    skillIds = body.skillIds ?? [];
    forcedNoModelFormatId = body.forcedNoModelFormatId;
    creatorStyleId = body.creatorStyleId;
    leadMagnetId = body.leadMagnetId;
    createLeadMagnet = body.createLeadMagnet;
    requestedGenerationConfig = body.generationConfig ?? null;
    composerStarterId = body.starterId;
    // Both fields must be present together — hookOnly alone with no source
    // body is meaningless (nothing to splice against) and quietly ignoring
    // it prevents a malformed client from tripping the splice with an empty
    // body (which would then destroy the artifact).
    if (body.hookOnly && body.hookOnlyOriginalBody) {
      hookOnly = true;
      hookOnlyOriginalBody = body.hookOnlyOriginalBody;
    }

    const { data: chat, error } = await sbRaw
      .from("chats")
      .select("id, title, pinned_cowork_route")
      .eq("id", chatId)
      .eq("workspace_id", workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!chat) {
      return turnError("Chat not found", 404);
    }
    pinnedCoworkRoute = normalizePinnedCoworkRoute(
      (chat as { pinned_cowork_route?: unknown }).pinned_cowork_route,
    );

    const promptCheck = preflightUserPrompt(userText);
    if (!promptCheck.ok) {
      logChatReject(
        workspaceId,
        chatId,
        `prompt_${promptCheck.reason}`,
        promptCheck.status,
      );
      return turnError(promptCheck.message, promptCheck.status);
    }

    // Monthly cost cap first (fail-closed money ceiling). The hourly/daily count
    // caps + the user-message insert happen atomically in claimChatTurn below.
    const cost = await deps.checkChatRateLimit(workspaceId);
    if (!cost.ok) {
      logChatReject(workspaceId, chatId, cost.reason ?? "cost_cap", 429);
      return turnError(
        cost.message,
        429,
        cost.retryAfterSec
          ? { "Retry-After": String(cost.retryAfterSec) }
          : undefined,
      );
    }

    const fileNote = attachments.length
      ? `\n\n📎 Attached: ${attachments.map((a) => safeFilename(a.filename)).join(", ")}`
      : "";
    const turnContent = userText + fileNote;

    // Duplicate-turn burst guard. The client has an in-flight lock, but a rapid
    // double-submit (observed: the same prompt POSTed 5-7x within ~140ms-3s,
    // each one a full billed agent turn)
    // can race past it before a run registers. The atomic claim below is the
    // authoritative concurrency/spend protection; this read is only the cheap
    // first 30-second brake.
    //
    // Reject when the most recent message is a user row newer than 30 seconds.
    // The assistant row lands only when the agent finishes, so a fresh POST in
    // that window is a resubmit, not a real follow-up.
    // Neither inserts a row nor runs the agent → no spend.
    const { data: recentMessages } = await sbRaw
      .from("chat_messages")
      .select("id, role, content, created_at, tool_calls, artifacts, terminal_reason, user_stop_requested_at")
      .eq("chat_id", chatId)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(64);
    const lastMsg = recentMessages?.[0];
    if (lastMsg?.role === "user") {
      // 30s window covers a normal turn's latency with headroom (a slow
      // tool-calling turn can take 20s+; the assistant row lands only when it
      // finishes, so a user row still being the newest means the turn is
      // in-flight). Never reject identical content forever: if terminal-row
      // persistence failed during a database outage, the atomic claim must be
      // allowed to decide the later retry instead of an orphan user row.
      if (isRecentUnansweredUserMessage(lastMsg)) {
        logChatReject(workspaceId, chatId, "duplicate_turn", 409);
        return turnError(
          "That message is already being processed — please wait for the reply before sending again.",
          409,
        );
      }
    }

    // Atomically check the count caps AND persist the user message in one
    // locked transaction, so concurrent requests can't all slip past the caps.
    // We store the typed text + a compact note of attached filenames (not the
    // file bytes — those are consumed this turn only).
    const actionLaneEnabled = deps.actionOrchestratorEnabledForWorkspace();
    actionRetryRepository = deps.createActionRetryRepository(sbRaw);
    const recentMessageWindow = (recentMessages ?? []) as Array<{
      id: string;
      role: ChatMessage["role"];
      tool_calls: ToolCall[] | null;
      artifacts: Artifact[] | null;
      terminal_reason:
        | "done"
        | "ask"
        | "cancelled"
        | "deadline"
        | "error"
        | null;
      user_stop_requested_at: string | null;
    }>;
    pendingAskOnly = hasPendingAskOnly(recentMessageWindow);
    pendingActionAsk = hasPendingActionAsk(recentMessageWindow);
    const actionAnswer = validatePendingActionAnswer(
      recentMessageWindow,
      userText,
      body.actionSelectionIds,
    );
    if (!actionAnswer.ok) {
      return turnError(
        `Choose exactly ${actionAnswer.expected} saved drafts before continuing.`,
        400,
      );
    }
    let preclaimInstruction = userText;
    if (actionAnswer.cancelled && pendingActionAsk) {
      persistedActionContinuation = true;
      normalizedActionRoute = {
        kind: "no_action",
        noActionReason: "cancelled",
      };
      resolvedActionInstruction = userText;
    } else if (body.retryOfUserMessageId) {
      const retryUserIndex = recentMessageWindow.findIndex(
        (message) =>
          message.role === "user" &&
          message.id === body.retryOfUserMessageId,
      );
      const retryUser =
        retryUserIndex >= 0 ? recentMessageWindow[retryUserIndex] : undefined;
      const pairedCustomSkillMarker =
        customSkillSelectionMarkerFromToolCalls(retryUser?.tool_calls);
      if (pairedCustomSkillMarker.kind === "invalid") {
        return turnError(
          "The saved custom-skill selection failed its integrity check. Send the request again as a new message.",
          409,
        );
      }
      if (pairedCustomSkillMarker.kind === "unfrozen") {
        return turnError(
          "That Retry does not contain frozen custom-skill context. Send the request again as a new message.",
          409,
        );
      }
      if (pairedCustomSkillMarker.kind === "valid") {
        const frozenSkillIds = pairedCustomSkillMarker.context.skills.map(
          (skill) => skill.id,
        );
        if (
          skillIds.length > 0 &&
          (skillIds.length !== frozenSkillIds.length ||
            skillIds.some((id, index) => id !== frozenSkillIds[index]))
        ) {
          return turnError(
            "That Retry no longer matches the custom skills used by the original task. Send a new request instead.",
            409,
          );
        }
        skillIds = frozenSkillIds;
        customSkillRetryContext = pairedCustomSkillMarker.context;
      } else if (skillIds.length > 0) {
        return turnError(
          "That Retry adds custom skills that were not part of the original task. Send it as a new request instead.",
          409,
        );
      }
      const pairedCreatorStyleMarker =
        creatorStyleSelectionMarkerFromToolCalls(retryUser?.tool_calls);
      if (pairedCreatorStyleMarker.kind === "invalid") {
        return turnError(
          "The saved creator-style selection failed its integrity check. Send the request again as a new message.",
          409,
        );
      }
      if (pairedCreatorStyleMarker.kind === "unfrozen") {
        return turnError(
          "That Retry does not contain a frozen creator-style context. Send the request again as a new message.",
          409,
        );
      }
      if (pairedCreatorStyleMarker.kind === "valid") {
        const frozenStyle = pairedCreatorStyleMarker.context;
        if (
          creatorStyleId &&
          creatorStyleId !== frozenStyle.id
        ) {
          return turnError(
            "That Retry no longer matches the creator style used by the original task. Send a new request instead.",
            409,
          );
        }
        creatorStyleId = frozenStyle.id;
        creatorStyleRetryContext = frozenStyle;
      } else if (creatorStyleId) {
        return turnError(
          "That Retry adds a creator style that was not part of the original task. Send it as a new request instead.",
          409,
        );
      }
      const pairedGenerationConfigMarker =
        generationConfigSelectionMarkerFromToolCalls(retryUser?.tool_calls);
      if (pairedGenerationConfigMarker.kind === "invalid") {
        return turnError(
          "The saved draft-count setting failed its integrity check. Send the request again as a new message.",
          409,
        );
      }
      if (pairedGenerationConfigMarker.kind === "valid") {
        if (
          requestedGenerationConfig &&
          requestedGenerationConfig.draftCount !==
            pairedGenerationConfigMarker.config.draftCount
        ) {
          return turnError(
            "That Retry no longer matches the draft count used by the original task. Send it as a new request instead.",
            409,
          );
        }
        resolvedGenerationConfig = pairedGenerationConfigMarker.config;
        generationConfigRestoredFromRetry = true;
      } else if (requestedGenerationConfig) {
        return turnError(
          "That Retry adds a draft-count setting that was not part of the original task. Send it as a new request instead.",
          409,
        );
      }
      const pairedStarterMarker = composerStarterMarkerFromToolCalls(
        retryUser?.tool_calls,
      );
      if (pairedStarterMarker.kind === "invalid") {
        return turnError(
          "The saved starter context failed its integrity check. Send the request again as a new message.",
          409,
        );
      }
      if (pairedStarterMarker.kind === "valid") {
        if (
          composerStarterId &&
          composerStarterId !== pairedStarterMarker.starterId
        ) {
          return turnError(
            "That Retry no longer matches the starter used by the original task. Send it as a new request instead.",
            409,
          );
        }
        composerStarterId = pairedStarterMarker.starterId;
      } else if (composerStarterId) {
        return turnError(
          "That Retry adds a starter context that was not part of the original task. Send it as a new request instead.",
          409,
        );
      }
      const pairedAssistant =
        retryUserIndex >= 0
          ? recentMessageWindow
              .slice(0, retryUserIndex)
              .find((message) => message.role === "assistant")
          : undefined;
      const pairedModeledBatchMarker =
        modeledDraftBatchContinuationMarkerFromToolCalls(
          pairedAssistant?.tool_calls,
        );
      const pairedRetryRootMarker = retryRootMarkerFromToolCalls(
        pairedAssistant?.tool_calls,
      );
      if (
        pairedModeledBatchMarker.kind === "invalid" ||
        pairedRetryRootMarker.kind === "invalid"
      ) {
        return turnError(
          "The saved modeled-set continuation failed its integrity check. Send the request again as a new message.",
          409,
        );
      }
      const retry = await resolveActionRetryRoot(
        {
          workspaceId,
          chatId,
          retryOfUserMessageId: body.retryOfUserMessageId,
          submittedContent: turnContent,
          pairedAssistantTerminalReason: pairedAssistant
            ? pairedAssistant.terminal_reason ?? "done"
            : null,
          pairedAssistantRecoverable: Boolean(
            pairedAssistant?.tool_calls?.some(
              isServerRecoverableToolCall,
            ),
          ),
          pairedAssistantRetryRootUserMessageId:
            pairedRetryRootMarker.kind === "valid"
              ? pairedRetryRootMarker.rootUserMessageId
              : undefined,
          pairedUserStopped: Boolean(retryUser?.user_stop_requested_at),
          signal: setupSignal,
        },
        actionRetryRepository,
      );
      if (!retry.ok) {
        if (retry.reason === "cancelled") {
          return turnError(
            "That stopped board action is permanently cancelled and cannot be resumed. Send a new request if you still want the change.",
            409,
          );
        }
        if (retry.reason === "completed") {
          return turnError(
            "That turn already completed successfully. Refresh the chat to see its result.",
            409,
          );
        }
        return turnError(
          "That Retry action is stale or no longer matches the original task. Send a new request instead.",
          409,
        );
      }
      actionTurnMessageId = retry.turnMessageId;
      resolvedActionInstruction = retry.effectiveInstruction;
      normalizedActionRoute = retry.route;
      persistedActionContinuation = Boolean(retry.route);
      modeledBatchContinuation =
        pairedModeledBatchMarker.kind === "valid"
          ? pairedModeledBatchMarker.continuation
          : null;
      confirmedActionTargetIds = retry.confirmedTargetIds;
      preclaimInstruction = retry.effectiveInstruction;
    } else if (pendingActionAsk) {
      persistedActionContinuation = true;
      const context = await actionRetryRepository.latestContext({
        workspaceId,
        chatId,
        signal: setupSignal,
      });
      if (!context?.route || context.cancelled) {
        return turnError(
          "That action clarification expired. Send the board request again.",
          409,
        );
      }
      resolvedActionInstruction = `${context.effectiveInstruction}\n\nClarification answer: ${userText}`;
      preclaimInstruction = resolvedActionInstruction;
      confirmedActionTargetIds = actionAnswer.selectedTargetIds ?? [];
      normalizedActionRoute =
        confirmedActionTargetIds.length > 0
          ? context.route
          : context.route.kind === "clarify_action"
            ? advanceActionOrchestratorClarification(
                context.route,
                userText,
                deps.now(),
                body.clientTimezone,
              )
            : context.route;
    }
    if (!resolvedGenerationConfig) {
      resolvedGenerationConfig = resolveGenerationConfig({
        selected: requestedGenerationConfig,
        explicitMessageDraftCount:
          explicitMessageDraftCount(preclaimInstruction),
      });
    }
    const preclaimPartialSpec = compileDirectPartialTextSpec(
      preclaimInstruction,
    );
    const fallbackPreclaimPostCount = requestedBasePostCount(
      preclaimInstruction,
      Boolean(modelSourceId),
    );
    hasAuthoritativeDraftCount =
      resolvedGenerationConfig.draftCountSource === "ui" ||
      generationConfigRestoredFromRetry;
    composerTaskSelection = {
      ...(composerStarterId ? { starterId: composerStarterId } : {}),
      ...(hasAuthoritativeDraftCount
        ? { selectedDraftCount: resolvedGenerationConfig.draftCount }
        : {}),
      ...(modelSourceId ? { selectedSourceId: modelSourceId } : {}),
    };
    composerTaskContext = resolveComposerTaskContext({
      ...composerTaskSelection,
      fallbackPostCount: fallbackPreclaimPostCount,
    });
    const preclaimBasePostCount =
      composerTaskContext.kind === "post"
        ? composerTaskContext.expectedDraftCount
        : null;
    activeDraftCountOverride =
      hasAuthoritativeDraftCount && preclaimBasePostCount !== null
        ? resolvedGenerationConfig.draftCount
        : undefined;
    const preclaimRoutingInput = {
      userInstruction: preclaimInstruction,
      ...(activeDraftCountOverride
        ? { draftCountOverride: activeDraftCountOverride }
        : {}),
      isRefine: skipDecision,
      hasModelSource: Boolean(modelSourceId),
      hasAttachments: attachments.length > 0,
      hasLeadMagnet: Boolean(leadMagnetId || createLeadMagnet),
      hasCreatorStyle: Boolean(creatorStyleId),
      composerTaskContext,
      hasUnsavedDraftReferent:
        hasUnsavedAssistantDraftReferent(recentMessageWindow),
      clientTimezone: body.clientTimezone,
    };
    const preclaimActionRoute = modeledBatchContinuation
      ? null
      : normalizedActionRoute ??
        compileActionOrchestratorRoute(preclaimRoutingInput, deps.now());
    normalizedActionRoute = preclaimActionRoute;
    const preclaimReadOnlyRoute =
      modeledBatchContinuation?.route ??
      compileReadOnlyOrchestratorReserveRoute(preclaimRoutingInput);
    const preclaimModeledContinuation =
      continuationForModeledDraftRoute(preclaimReadOnlyRoute);
    const preclaimModeledRoute = Boolean(
      modeledBatchContinuation ||
        preclaimModeledContinuation ||
        (preclaimReadOnlyRoute &&
          compileModeledPostIntent(preclaimInstruction, {
            draftCountOverride: activeDraftCountOverride,
          }).kind !== "none"),
    );
    currentTurnModelSourceOwnership = preclaimModeledRoute
      ? "server_selected"
      : "historical_continuation";
    modeledBatchContractRequested = Boolean(preclaimModeledContinuation);
    // Claim-time placeholder via the ONE contract builder (telemetry-only —
    // overwritten post-routing). The gen-config resolution below consumes
    // only its count projection, never a second divergent contract.
    preclaimContractPlaceholder = resolveTurnContract({
      actionRoute: preclaimActionRoute,
      useActionOrchestrator: true,
      readOnlyRoute: preclaimReadOnlyRoute,
      useReadOnlyOrchestrator: true,
      hasPartialSpec: preclaimPartialSpec !== null,
      fallbackPostCount:
        preclaimBasePostCount !== null || skipDecision
          ? (activeDraftCountOverride ?? preclaimBasePostCount ?? 1)
          : null,
    });
    preclaimPostDraftEstimate =
      preclaimContractPlaceholder.kind === "post"
        ? preclaimContractPlaceholder.expectedCount
        : null;
    if (
      preclaimPostDraftEstimate !== null &&
      preclaimPostDraftEstimate >= 1 &&
      !generationConfigRestoredFromRetry &&
      resolvedGenerationConfig.draftCountSource !== "ui"
    ) {
      const contractCount = resolveTurnCount({
        messageCount: preclaimPostDraftEstimate,
      });
      resolvedGenerationConfig = {
        version: 1,
        draftCount: contractCount.count,
        draftCountSource:
          explicitMessageDraftCount(preclaimInstruction) !== null ||
          preclaimPostDraftEstimate !== 1
            ? "message"
            : "default",
      };
    }
    const claim = await deps.claimChatTurn(workspaceId, chatId, turnContent, {
      clientTurnId: body.clientTurnId,
      readOnlyOrchestrator: Boolean(
        (preclaimActionRoute?.kind === "action_management" &&
          (actionLaneEnabled || persistedActionContinuation)) ||
          (pendingActionAsk && persistedActionContinuation) ||
          ((preclaimReadOnlyRoute || (pendingAskOnly && !pendingActionAsk)) &&
            (preclaimModeledRoute ||
              Boolean(
                continuationForModeledDraftRoute(preclaimReadOnlyRoute),
              ) ||
              deps.readOnlyOrchestratorEnabledForWorkspace())),
      ),
    });
    if (!claim.ok) {
      // turn_active is a concurrency conflict (409), not a rate limit (429).
      const status = claim.reason === "turn_active" ? 409 : 429;
      logChatReject(
        workspaceId,
        chatId,
        claim.reason ?? "claim_failed",
        status,
      );
      return turnError(
        claim.message,
        status,
        claim.retryAfterSec
          ? { "Retry-After": String(claim.retryAfterSec) }
          : undefined,
      );
    }
    // The exclusive turn claim is now held; ensure it's released on every exit.
    turnClaimed = true;
    turnCostOperationKey = claim.operationKey;
    coworkTelemetry = createCoworkTurnTelemetry(
      {
        traceId: chatId,
        workspaceId,
        route: "setup",
        // Claim-time placeholder only; the single post-clarification
        // resolveTurnContract result replaces it once routing lands.
        requestedContract: preclaimContractPlaceholder,
      },
      deps.coworkTelemetrySink,
    );

    // From the moment the atomic claim lands until the SSE response exists,
    // the browser has no turn timestamp it can send to the Stop endpoint. Own
    // that invisible interval on the server: an ordinary setup gets a short
    // bound, while explicit image/lead-magnet setup gets its known extra room.
    // Every later setup await receives this signal. Supabase requests abort at
    // the fetch layer and other reads race the signal, so this handler reaches
    // its release gate before the browser's later client deadline offers Retry.
    if (signal.aborted) {
      const message = "The chat request was cancelled before it started.";
      await persistChatSetupFailure({
        sb: sbRaw,
        chatId,
        workspaceId,
        content: `⚠️ ${message}`,
      });
      await coworkTelemetry.finish({
        deliveredContract: {
          kind: estimatedContractKind(),
          deliveredCount: 0,
        },
        provenanceStatus: "not_required",
        terminalOutcome: "cancelled",
      });
      await deps.releaseChatTurn(workspaceId, chatId, turnCostOperationKey);
      turnClaimed = false;
      return turnError(message, 499);
    }
    const deadlines = chatSetupDeadlines({
      hasImageAttachment: attachments.some(
        (attachment) => attachment.kind === "image",
      ),
      createsLeadMagnet: Boolean(createLeadMagnet),
    });
    setupDeadline = createChatSetupDeadline(deadlines.serverMs);
    setupSignal = AbortSignal.any([signal, setupDeadline.signal]);

    // Bind every later metadata write to the exact user row inserted by THIS
    // claim. Never look up "latest user" after lengthy setup: if cancellation
    // or a future retry changes ordering, an old handler must not annotate the
    // replacement turn.
    const { data: claimedUserMessage, error: claimedUserMessageError } =
      await waitForChatSetup(
        sbRaw
          .from("chat_messages")
          .select("id")
          .eq("chat_id", chatId)
          .eq("workspace_id", workspaceId)
          .eq("role", "user")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        setupSignal,
      );
    if (claimedUserMessageError) throw claimedUserMessageError;
    if (typeof claimedUserMessage?.id !== "string") {
      throw new Error("The claimed chat message could not be identified.");
    }
    claimedUserMessageId = claimedUserMessage.id;
    coworkTelemetry.configure({ traceId: claimedUserMessageId });

    // Auto-title from the first user message if still the default. The
    // `.eq("title", "New chat")` makes this atomic: it only titles when the DB
    // row is STILL the default, so a concurrent user rename is never clobbered
    // (the stale in-memory chat.title is just a cheap pre-check).
    if (chat.title === "New chat") {
      const title = userText.replace(/\s+/g, " ").slice(0, 60).trim();
      if (title) {
        let titleUpdate = sbRaw
          .from("chats")
          .update({ title, updated_at: new Date().toISOString() })
          .eq("id", chatId)
          .eq("workspace_id", workspaceId)
          .eq("title", "New chat");
        if (turnCostOperationKey) {
          titleUpdate = titleUpdate.eq(
            "turn_cost_operation_key",
            turnCostOperationKey,
          );
        }
        await waitForChatSetup(titleUpdate, setupSignal);
      }
    }

    // Clear any stale cancel flag from a prior turn so the loop's between-
    // rounds polling can't accidentally cancel THIS turn based on a leftover
    // timestamp. The agent loop polls cancel_requested_at > turnStartedAt.
    let clearCancel = sbRaw
      .from("chats")
      .update({ cancel_requested_at: null })
      .eq("id", chatId)
      .eq("workspace_id", workspaceId);
    if (turnCostOperationKey) {
      clearCancel = clearCancel.eq(
        "turn_cost_operation_key",
        turnCostOperationKey,
      );
    }
    const { data: claimedTurn, error: clearCancelError } =
      await waitForChatSetup(
        clearCancel.select("turn_started_at").maybeSingle(),
        setupSignal,
      );
    if (clearCancelError) throw clearCancelError;
    claimedTurnStartedAt =
      typeof claimedTurn?.turn_started_at === "string"
        ? claimedTurn.turn_started_at
        : null;
    if (!claimedTurnStartedAt) {
      throw new Error("The active chat turn could not be identified.");
    }
  } catch (e) {
    const setupExpired = setupDeadline?.didExpire() ?? false;
    const requestAborted = signal.aborted;
    disarmSetupGuards();
    // Once a user row exists, always terminate it with an assistant row BEFORE
    // releasing the claim. Otherwise the duplicate guard can permanently reject
    // the same retry, or a fast replacement turn can be mispaired with this
    // older failure row.
    if (turnClaimed) {
      const persistedMessage = setupExpired
        ? "Cowork took too long to prepare this turn. Please retry."
        : requestAborted
          ? "The chat request was cancelled before it started."
          : "Something went wrong starting this turn. Please try again.";
      await persistChatSetupFailure({
        sb: sbRaw!,
        chatId,
        workspaceId: workspaceId!,
        content: `⚠️ ${persistedMessage}`,
        ...(setupExpired
          ? {
              recoverable: {
                code: "stream_stalled",
                message: persistedMessage,
              },
            }
          : {}),
      });
      await coworkTelemetry.finish({
        deliveredContract: {
          kind: estimatedContractKind(),
          deliveredCount: 0,
        },
        provenanceStatus: "not_required",
        terminalOutcome: setupExpired
          ? "recoverable_error"
          : requestAborted
            ? "cancelled"
            : "hard_failure",
      });
      await deps.releaseChatTurn(workspaceId!, chatId, turnCostOperationKey);
      turnClaimed = false;
    }
    if (e instanceof NoWorkspaceError) return turnError(e.message, 400);
    if (e instanceof z.ZodError) return turnError("Invalid request body", 400);
    if (setupExpired || requestAborted) {
      const message = setupExpired
        ? "Cowork took too long to prepare this turn. Please retry."
        : "The chat request was cancelled before it started.";
      return turnError(message, setupExpired ? 504 : 499);
    }
    return turnError((e as Error)?.message ?? "Unexpected error", 500);
  }

  // Everything from here to the stream runs AFTER the turn claim has inserted
  // the user message. The context assembly itself lives in
  // lib/agent/turn/context.ts (buildTurnContext) — a throw in this span (a DB
  // connection drop on the history read, the model-source fetch, or the skill
  // resolution) used to escape UNCAUGHT — the claim stayed held (chat wedged
  // ~330s) AND the user row sat with no assistant reply (dangling turn). Wrap
  // it: on a throw we release the claim, persist a brief error reply so the
  // user row isn't orphaned, and return a clean JSON error. (The
  // ReadableStream has its OWN try/finally for throws DURING streaming.)
  let history: ChatMessage[];
  let effectiveUserInstruction = userText;
  const orchestratorAttachmentBlocks: ContentBlock[] = [];
  // Built below only for a from-scratch post request (no model/template/refine
  // source): the selected archetype's rules + full DB exemplars. Empty on every
  // other turn so the executor prompt stays byte-identical.
  let appliedNoModelFormat: {
    id: NoModelFormatId;
    label: string;
    forced: boolean;
  } | null = null;
  let selectedNoModelFormat: NoModelFormat | null = null;
  let leadMagnetBlock = "";
  let appliedLeadMagnet: (AppliedLeadMagnet & { id: string }) | null = null;
  let shouldAttachLeadMagnet = false;
  let activeLeadMagnetCampaign: ReturnType<
    typeof buildLeadMagnetCampaign
  > | null = null;
  let modelSourceImage: SourcePostImage | null = null;
  let modelSourceImageSkipReason: string | null = null;
  let modelSourceImageSourcePostId: string | null = null;
  let citedSourceImage: SourcePostImage | null = null;
  let citedSourceImageSkipReason: string | null = null;
  let citedSourceImageSourcePostId: string | null = null;
  let modelSourceReference: ModelSourceReference | null = null;
  let imageGenerationAuthor: { name: string | null } | null = null;
  // Built below only when the user picked a creator style AND no model source is
  // attached (a source controls structure, so the style is ignored then). Empty
  // otherwise so the executor prompt stays byte-identical.
  let creatorStyleBlock = "";
  let appliedCreatorStyle: {
    id: string;
    name: string;
    creatorName: string;
  } | null = null;
  let feedbackMemory: ContentFeedback[] = [];
  let preferences: ContentPreference[] = [];
  let priorPostDrafts: RecentDraft[] = [];
  let preloadedVoiceResult: ToolResult | null = null;
  try {
    const turnContext = await buildTurnContext({
      sbRaw,
      workspaceId,
      chatId,
      userId,
      userText,
      attachments,
      modelSourceId,
      skipDecision,
      refineTargetId,
      refineInstruction,
      leadMagnetId,
      createLeadMagnet,
      forcedNoModelFormatId,
      creatorStyleId,
      creatorStyleRetryContext,
      customSkillRetryContext,
      skillIds,
      composerTaskContext,
      composerTaskSelection,
      activeDraftCountOverride,
      resolvedGenerationConfig,
      hasAuthoritativeDraftCount,
      resolvedActionInstruction,
      currentTurnModelSourceOwnership,
      setupSignal,
      cancellationReason: () =>
        setupDeadline?.didExpire() ? "deadline" : "cancelled",
      coworkTelemetry,
      pinnedCoworkRoute:
        pinnedCoworkRoute === "setup" ? undefined : pinnedCoworkRoute,
      deps: {
        fetchRecentPostDrafts: deps.fetchRecentPostDrafts,
        generateLeadMagnetResource: deps.generateLeadMagnetResource,
        completeChat: deps.completeChat,
      },
    });
    history = turnContext.history;
    effectiveUserInstruction = turnContext.effectiveUserInstruction;
    orchestratorAttachmentBlocks.push(...turnContext.attachmentBlocks);
    trustedRefineTarget = turnContext.trustedRefineTarget;
    currentModelSource = turnContext.currentModelSource;
    const currentModelEnvelope = turnContext.currentModelEnvelope;
    modelSourceReference = turnContext.modelSourceReference;
    modelSourceImage = turnContext.modelSourceImage;
    modelSourceImageSkipReason = turnContext.modelSourceImageSkipReason;
    modelSourceImageSourcePostId = turnContext.modelSourceImageSourcePostId;
    hasModelSource = turnContext.hasModelSource;
    composerTaskContext = turnContext.composerTaskContext;
    activeDraftCountOverride = turnContext.activeDraftCountOverride;
    postClarificationPostCount = turnContext.postClarificationPostCount;
    preloadedVoiceResult = turnContext.voiceResult;
    selectedNoModelFormat = turnContext.selectedNoModelFormat;
    appliedNoModelFormat = turnContext.appliedNoModelFormat;
    shouldAttachLeadMagnet = turnContext.shouldAttachLeadMagnet;
    leadMagnetBlock = turnContext.leadMagnetBlock;
    appliedLeadMagnet = turnContext.appliedLeadMagnet;
    activeLeadMagnetCampaign = turnContext.activeLeadMagnetCampaign;
    imageGenerationAuthor = turnContext.imageGenerationAuthor;
    creatorStyleBlock = turnContext.creatorStyleBlock;
    appliedCreatorStyle = turnContext.appliedCreatorStyle;
    feedbackMemory = turnContext.feedbackMemory;
    preferences = turnContext.preferences;
    priorPostDrafts = turnContext.priorPostDrafts;
    resolvedCustomSkills = turnContext.resolvedCustomSkills;
    customSkillBodies = turnContext.customSkillBodies;
    customSkillNames = turnContext.customSkillNames;

    // Stash synthetic metadata on the just-inserted user row. This keeps the
    // visible row clean while preserving invisible turn context for reloads and
    // follow-up turns:
    //   - _model_source_attached lets later answers keep using the same modeled
    //     post/template source, instead of forgetting the transient ?model id.
    //   - _custom_skills_applied lets hydrate render the "/skill" badge.
    // Most display-only metadata remains best-effort. Creator-style metadata
    // and custom skills on a durable modeled batch freeze generation context
    // for Retry, so those writes are authoritative before generation starts.
    const userToolCalls: ToolCall[] = [];
    if (modelSourceId && currentModelEnvelope) {
      userToolCalls.push(modelSourceToolCall(modelSourceId));
    }
    if (customSkillNames.length > 0) {
      userToolCalls.push(
        customSkillsToolCall(customSkillNames, {
          version: CUSTOM_SKILL_RETRY_CONTEXT_VERSION,
          skills: resolvedCustomSkills,
        }),
      );
    }
    if (appliedNoModelFormat?.forced) {
      userToolCalls.push(postFormatToolCall(appliedNoModelFormat));
    }
    if (appliedCreatorStyle) {
      userToolCalls.push(
        creatorStyleToolCall(appliedCreatorStyle, {
          version: CREATOR_STYLE_RETRY_CONTEXT_VERSION,
          resolvedBlock: creatorStyleBlock,
        }),
      );
    }
    if (appliedLeadMagnet) {
      userToolCalls.push(leadMagnetToolCall(appliedLeadMagnet));
    }
    if (composerStarterId) {
      userToolCalls.push(composerStarterToolCall(composerStarterId));
    }
    // Post-shaped turns stamp the resolved generation config onto the user row
    // so a later Retry can integrity-check the draft count. Post-clarification
    // truth (same rule the single contract's legacy fallback uses): the
    // composer resolved a post count, a UI override is active, or this is a
    // refine continuation.
    const stampsGenerationConfig =
      resolvedGenerationConfig !== null &&
      (postClarificationPostCount !== null ||
        activeDraftCountOverride !== undefined ||
        skipDecision);
    if (stampsGenerationConfig && resolvedGenerationConfig) {
      userToolCalls.push(generationConfigToolCall(resolvedGenerationConfig));
    }
    let userToolCallWriteFailed = false;
    if (userToolCalls.length > 0) {
      if (claimedUserMessageId) {
        const {
          data: updatedUserMessage,
          error: userToolCallWriteError,
        } = await waitForChatSetup(
          sbRaw
            .from("chat_messages")
            .update({ tool_calls: userToolCalls })
            .eq("id", claimedUserMessageId)
            .eq("workspace_id", workspaceId)
            .select("id")
            .maybeSingle(),
          setupSignal,
        );
        userToolCallWriteFailed =
          Boolean(userToolCallWriteError) ||
          updatedUserMessage?.id !== claimedUserMessageId;
      }
    }
    if (
      appliedCreatorStyle &&
      (!claimedUserMessageId || userToolCallWriteFailed)
    ) {
      throw new Error(CREATOR_STYLE_CONTEXT_PERSISTENCE_ERROR);
    }
    if (
      modeledBatchContractRequested &&
      resolvedCustomSkills.length > 0 &&
      (!claimedUserMessageId || userToolCallWriteFailed)
    ) {
      throw new Error(CUSTOM_SKILL_CONTEXT_PERSISTENCE_ERROR);
    }
    if (
      stampsGenerationConfig &&
      (!claimedUserMessageId || userToolCallWriteFailed)
    ) {
      throw new Error(GENERATION_CONFIG_CONTEXT_PERSISTENCE_ERROR);
    }

    // Persist the assembled attachment blocks so follow-up turns can re-inject
    // them from history. This is best-effort: the current turn already holds the
    // blocks in memory, so a failed write must not abort the turn.
    if (turnContext.attachmentBlocks.length > 0 && claimedUserMessageId) {
      try {
        await waitForChatSetup(
          sbRaw
            .from("chat_messages")
            .update({ content_blocks: turnContext.attachmentBlocks })
            .eq("id", claimedUserMessageId)
            .eq("workspace_id", workspaceId)
            .select("id")
            .maybeSingle(),
          setupSignal,
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            attachment_blocks_persistence_failed: {
              workspaceId,
              chatId,
              userMessageId: claimedUserMessageId,
              error: (error as Error)?.message ?? String(error),
            },
          }),
        );
      }
    }

  } catch (e) {
    const setupExpired = setupDeadline?.didExpire() ?? false;
    const requestAborted = signal.aborted;
    disarmSetupGuards();
    // A throw in the post-claim setup span: release the claim (else the chat
    // wedges ~330s) + persist a short error reply so the just-inserted user
    // message isn't left dangling with no answer, then return JSON (no stream
    // was opened yet). Best-effort on both side effects.
    const setupError = setupExpired
      ? "Cowork took too long to prepare this turn. Please retry."
      : ((e as Error)?.message ?? "Failed to start the turn");
    const assistantError =
      setupError === LEAD_MAGNET_SELECTION_REQUIRED_ERROR ||
      setupError === CREATOR_STYLE_SELECTION_REQUIRED_ERROR ||
      setupError === CREATOR_STYLE_CONTEXT_PERSISTENCE_ERROR ||
      setupError === CUSTOM_SKILL_CONTEXT_PERSISTENCE_ERROR ||
      setupError === GENERATION_CONFIG_CONTEXT_PERSISTENCE_ERROR
        ? setupError
        : "⚠️ Something went wrong starting this turn. Please try again.";
    await persistChatSetupFailure({
      sb: sbRaw,
      chatId,
      workspaceId,
      content: assistantError,
      ...(setupExpired
        ? {
            recoverable: {
              code: "stream_stalled",
              message: setupError,
            },
          }
        : {}),
    });
    await coworkTelemetry.finish({
      deliveredContract: {
        kind: estimatedContractKind(),
        deliveredCount: 0,
      },
      provenanceStatus: "not_required",
      terminalOutcome: setupExpired
        ? "recoverable_error"
        : requestAborted
          ? "cancelled"
          : "hard_failure",
    });
    await deps
      .releaseChatTurn(workspaceId, chatId, turnCostOperationKey)
      .catch(() => {});
    turnClaimed = false;
    return turnError(
      setupError,
      setupExpired
        ? 504
        : requestAborted
          ? 499
          : setupError === LEAD_MAGNET_SELECTION_REQUIRED_ERROR ||
              setupError === CREATOR_STYLE_SELECTION_REQUIRED_ERROR
            ? 409
            : setupError === CREATOR_STYLE_CONTEXT_PERSISTENCE_ERROR ||
                setupError === CUSTOM_SKILL_CONTEXT_PERSISTENCE_ERROR ||
                setupError === GENERATION_CONFIG_CONTEXT_PERSISTENCE_ERROR
              ? 503
              : 500,
    );
  }

  const setupExpired = setupDeadline?.didExpire() ?? false;
  disarmSetupGuards();
  if (setupExpired || signal.aborted) {
    const message = setupExpired
      ? "Cowork took too long to prepare this turn. Please retry."
      : "The chat request was cancelled before it started.";
    await persistChatSetupFailure({
      sb: sbRaw,
      chatId,
      workspaceId,
      content: `⚠️ ${message}`,
      ...(setupExpired
        ? {
            recoverable: {
              code: "stream_stalled",
              message,
            },
          }
        : {}),
    });
    await coworkTelemetry.finish({
      deliveredContract: {
        kind: estimatedContractKind(),
        deliveredCount: 0,
      },
      provenanceStatus: "not_required",
      terminalOutcome: setupExpired ? "recoverable_error" : "cancelled",
    });
    await deps
      .releaseChatTurn(workspaceId, chatId, turnCostOperationKey)
      .catch(() => {});
    turnClaimed = false;
    return turnError(message, setupExpired ? 504 : 499);
  }

  // Direct writer is the unified drafting path; the COWORK_THIN_PATH rollout
  // flag has been removed and lean mode is no longer forced (default false).
  const directWriterEnabled = true;
  const directPartialSpec = compileDirectPartialTextSpec(
    effectiveUserInstruction,
  );
  const directPostCount =
    activeDraftCountOverride ??
    (composerTaskContext?.kind === "post"
      ? composerTaskContext.expectedDraftCount
      : null) ??
    requestedDirectPostCount(effectiveUserInstruction);
  // Find-and-model: a "find a top post in my swipe file and rewrite it" turn
  // has NO pre-attached source, so directSource is empty and the fixed-source
  // direct route is rejected. Resolve the source HERE with the same rotation-
  // aware search the heavy loop's prefetch uses, so the discovery-phrased turn
  // qualifies for the direct route and the strong model writes it tool-free.
  // Runs at most once (advances the rotation cursor once); any failure falls
  // through to the heavy loop unchanged (fail-open).
  const wantsFindAndModel =
    !currentModelSource?.post_text.trim() &&
    !modelSourceId &&
    requestsDirectSourceModeling(effectiveUserInstruction);
  const resolvedFindSource = wantsFindAndModel
    ? await resolveFindAndModelSource(workspaceId, signal)
    : undefined;
  const directSource: DraftEngineSource | undefined =
    currentModelSource?.post_text.trim()
      ? {
          id: currentModelSource.source_post_id ?? currentModelSource.id,
          text: currentModelSource.post_text,
        }
      : resolvedFindSource?.source;
  // Stamp the "Source post" chip for a find-and-model draft. The chip is drawn
  // from `modelSourceReference` (tagArtifactWithModelSourceReference below);
  // that's normally set only for a pre-ATTACHED source, so a find-and-model
  // draft would otherwise ship with no chip even though it DID model a real
  // swipe-file post. Only set it when we actually resolved a find source and no
  // attached source already owns the reference.
  if (resolvedFindSource && !modelSourceReference) {
    modelSourceReference = {
      source_post_id: resolvedFindSource.source.id,
      source_url: resolvedFindSource.sourceUrl,
    };
  }
  const directWritingContext = {
    enabled: directWriterEnabled,
    hasAttachments: attachments.length > 0,
    hasLeadMagnet: Boolean(
      shouldAttachLeadMagnet || appliedLeadMagnet || activeLeadMagnetCampaign,
    ),
    hasCreatorStyle: Boolean(creatorStyleId),
    voiceResolved: preloadedVoiceResult?.ok === true,
  };
  const useDirectRefine = isDirectRefineEligible({
    ...directWritingContext,
    isRefine: skipDecision,
    refineInstruction: refineInstruction ?? "",
    targetResolved: trustedRefineTarget !== null,
    targetKind:
      trustedRefineTarget?.kind === "post" ||
      trustedRefineTarget?.kind === "hook"
        ? trustedRefineTarget.kind
        : null,
    targetHasLeadMagnet: Boolean(trustedRefineTarget?.meta?.lead_magnet),
    hasModelSource: Boolean(modelSourceId),
  });
  const useDirectPartial = isDirectPartialTextEligible({
    ...directWritingContext,
    userInstruction: effectiveUserInstruction,
    sourceRequested: Boolean(modelSourceId),
    sourceResolved: Boolean(directSource),
    isRefine: skipDecision,
  });
  const useDirectMulti = isDirectMultiPostEligible({
    ...directWritingContext,
    userInstruction: effectiveUserInstruction,
    sourceRequested: Boolean(modelSourceId),
    sourceResolved: Boolean(directSource),
    isRefine: skipDecision,
    requestedCount: directPostCount ?? undefined,
    composerTaskContext: composerTaskContext ?? undefined,
  });
  const useDirectSource =
    isDirectFixedSourcePostEligible({
      ...directWritingContext,
      userInstruction: effectiveUserInstruction,
      sourceResolved: Boolean(directSource),
      isRefine: skipDecision,
    }) ||
    // Find-and-model: source was resolved up front by resolveFindAndModelSource,
    // so the discovery-phrasing turn now qualifies for the direct route instead
    // of the heavy GLM render loop.
    (Boolean(resolvedFindSource) &&
      isDirectFindAndModelEligible({
        ...directWritingContext,
        userInstruction: effectiveUserInstruction,
        sourceResolved: Boolean(directSource),
        isRefine: skipDecision,
      }));
  const useDirectOriginal = isDirectOriginalPostEligible({
    userInstruction: effectiveUserInstruction,
    requestedCount: directPostCount ?? undefined,
    ...directWritingContext,
    // Intent must fail closed here. A supplied source/style id can resolve to
    // nothing (deleted, not ready, or outside the workspace); that still means
    // the user requested context the direct engine does not own.
    hasModelSource: Boolean(modelSourceId),
    isRefine: skipDecision,
    composerTaskContext: composerTaskContext ?? undefined,
  });
  // Lead-magnet direct route. A lead-magnet post is a from-scratch original post
  // with the giveaway framing. The direct engine injects that framing
  // (leadMagnetBlock) and the CTA is HARD-enforced downstream by
  // transformDraftCandidate (rejects a draft that doesn't mention the resource),
  // so a lead-magnet post can be written by the strong model without ever
  // shipping without its comment-CTA.
  //
  // Uses isDirectLeadMagnetEligible (not the original-post gate): a find-and-
  // adapt lead-magnet — "find the most recent lead-magnet post in my swipe file
  // and adapt it into a lead-magnet post about X" — is discovery-phrased, which
  // the original gate rejects. But for a lead-magnet the RESOURCE is the source
  // (already resolved here), and the found post is never used as a structural
  // source (the engine task is `original`), so that discovery rejection is a
  // false blocker that would otherwise strand this journey on GLM. The
  // lead-magnet gate tolerates discovery while still rejecting everything
  // genuinely unsafe.
  const activeLeadMagnetForDirect = Boolean(
    activeLeadMagnetCampaign && leadMagnetBlock.trim(),
  );
  const useDirectLeadMagnet =
    activeLeadMagnetForDirect &&
    isDirectLeadMagnetEligible({
      userInstruction: effectiveUserInstruction,
      ...directWritingContext,
      hasModelSource: Boolean(modelSourceId),
      isRefine: skipDecision,
    });
  // Creator-style direct route. A creator-style post is a from-scratch original
  // post that borrows another creator's WRITING MECHANICS (hooks, cadence,
  // formatting) for the user's own topic. The direct engine injects that
  // mechanics-only block (creatorStyleBlock), so the strong model can write it.
  // Reuses the original-post eligibility with hasCreatorStyle forced false (the
  // engine owns it now). No hard CTA-style guard is needed — creator style
  // shapes rhythm, it has no mandatory element to enforce; the block's own
  // wrapper already forbids copying the creator's topics/claims.
  const activeCreatorStyleForDirect = Boolean(
    creatorStyleId && !hasModelSource && creatorStyleBlock.trim(),
  );
  const useDirectCreatorStyle =
    activeCreatorStyleForDirect &&
    isDirectOriginalPostEligible({
      userInstruction: effectiveUserInstruction,
      requestedCount: directPostCount ?? undefined,
      ...directWritingContext,
      hasCreatorStyle: false,
      hasModelSource: Boolean(modelSourceId),
      isRefine: skipDecision,
      composerTaskContext: composerTaskContext ?? undefined,
    });
  let useDirectWriter =
    !modeledBatchContractRequested &&
    (useDirectRefine ||
      useDirectPartial ||
      useDirectMulti ||
      useDirectSource ||
      useDirectOriginal ||
      useDirectLeadMagnet ||
      useDirectCreatorStyle);
  let actionOrchestratorRoute: ActionOrchestratorRoute | null = useDirectWriter
    ? null
    : normalizedActionRoute;

  // Session-sticky lane pinning: unless this turn is explicitly continuing a
  // saved workflow (retry, action clarification, or any pending ask answer),
  // reuse the chat's pinned lane. The compiler stays authoritative for the
  // contract/count; the pin only selects the lane. "answer" is allowed in the
  // schema but never pinned, so it is treated as no preference.
  const hasExplicitWorkflowContinuation =
    Boolean(body.retryOfUserMessageId) || pendingActionAsk || pendingAskOnly;
  const honorPinnedRoute =
    pinnedCoworkRoute &&
    !hasExplicitWorkflowContinuation &&
    pinnedCoworkRoute !== "answer";
  if (honorPinnedRoute) {
    if (pinnedCoworkRoute === "direct_writer") {
      useDirectWriter = true;
    } else if (
      pinnedCoworkRoute === "action_orchestrator" &&
      !actionOrchestratorRoute
    ) {
      actionOrchestratorRoute = {
        kind: "clarify_action",
        clarificationReason: "action",
      };
    }
  }

  const useActionOrchestrator = Boolean(
    actionOrchestratorRoute &&
      (deps.actionOrchestratorEnabledForWorkspace() ||
        persistedActionContinuation),
  );
  if (useActionOrchestrator) {
    coworkTelemetry.configure({
      route: "action_orchestrator",
      // Intermediate value only — the single resolveTurnContract call below
      // re-configures telemetry with the same result once routing lands.
      requestedContract: resolveTurnContract({
        actionRoute: actionOrchestratorRoute,
        useActionOrchestrator: true,
      }),
    });
    if (!claimedUserMessageId || !actionRetryRepository) {
      throw new Error("Action retry context could not be scoped to this turn.");
    }
    try {
      await actionRetryRepository.saveContext({
        workspaceId,
        chatId,
        userMessageId: claimedUserMessageId,
        rootTurnMessageId: actionTurnMessageId ?? claimedUserMessageId,
        effectiveInstruction: effectiveUserInstruction,
        route: actionOrchestratorRoute!,
        confirmedTargetIds: confirmedActionTargetIds,
        signal: setupSignal,
      });
    } catch {
      const actionSetupExpired = setupDeadline?.didExpire() ?? false;
      const actionRequestAborted = signal.aborted;
      const message = actionSetupExpired
        ? "Cowork took too long to prepare this board action. Please retry."
        : actionRequestAborted
          ? "The board action was cancelled before it started."
          : "I couldn’t persist the safety context for this board action, so nothing was changed. Send it again to retry safely.";
      await persistChatSetupFailure({
        sb: sbRaw,
        chatId,
        workspaceId,
        content: `⚠️ ${message}`,
      });
      await coworkTelemetry.finish({
        deliveredContract: {
          kind: "saved_draft_action",
          deliveredCount: 0,
        },
        provenanceStatus: "not_required",
        terminalOutcome: actionSetupExpired
          ? "recoverable_error"
          : actionRequestAborted
            ? "cancelled"
            : "hard_failure",
      });
      await deps.releaseChatTurn(workspaceId, chatId, turnCostOperationKey);
      turnClaimed = false;
      return turnError(
        message,
        actionSetupExpired ? 504 : actionRequestAborted ? 499 : 503,
      );
    }
  }
  let readOnlyOrchestratorRoute: ReadOnlyOrchestratorRoute | null =
    useDirectWriter || useActionOrchestrator
      ? null
      : modeledBatchContinuation?.route ??
        compileReadOnlyOrchestratorRoute({
          userInstruction: effectiveUserInstruction,
          ...(activeDraftCountOverride
            ? { draftCountOverride: activeDraftCountOverride }
            : {}),
          isRefine: skipDecision,
          hasModelSource: Boolean(modelSourceId),
          hasAttachments: attachments.length > 0,
          hasLeadMagnet: Boolean(
            shouldAttachLeadMagnet ||
              appliedLeadMagnet ||
              activeLeadMagnetCampaign,
          ),
          hasCreatorStyle: Boolean(creatorStyleId),
          composerTaskContext: composerTaskContext ?? undefined,
        });

  if (
    honorPinnedRoute &&
    pinnedCoworkRoute === "read_only_orchestrator" &&
    !readOnlyOrchestratorRoute
  ) {
    readOnlyOrchestratorRoute = {
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts: directPostCount ?? 1,
      minimumSources: 2,
      workspaceSearchMode: "diverse",
    };
  }

  const modeledBatchRouteContract = continuationForModeledDraftRoute(
    readOnlyOrchestratorRoute,
  );
  const deterministicModeledRoute = Boolean(
    modeledBatchContinuation ||
      modeledBatchRouteContract ||
      (readOnlyOrchestratorRoute &&
        compileModeledPostIntent(effectiveUserInstruction, {
          draftCountOverride: activeDraftCountOverride,
        }).kind !== "none"),
  );
  if (deterministicModeledRoute && preloadedVoiceResult?.ok !== true) {
    // A missing voice profile is never transient — retrying re-runs the exact
    // same lookup and fails the exact same way every time, so offering "Retry"
    // is a loop with no exit. loadVoiceProfile marks that case with a `status`
    // key on the tool result (lib/agent/tools.ts); a transient load failure
    // (err() shape, no `status`) keeps the recoverable 503 path below.
    const noReadyVoiceProfile =
      preloadedVoiceResult !== null && "status" in preloadedVoiceResult;
    if (noReadyVoiceProfile) {
      const message =
        "This needs a voice profile to write in your voice, and your workspace doesn't have one yet. Head to the Voice tab to generate one, then send this again.";
      await persistChatSetupFailure({
        sb: sbRaw,
        chatId,
        workspaceId,
        content: `⚠️ ${message}`,
      });
      await coworkTelemetry.finish({
        deliveredContract: {
          kind: "post",
          deliveredCount: 0,
        },
        provenanceStatus: "missing",
        terminalOutcome: "hard_failure",
      });
      await deps.releaseChatTurn(workspaceId, chatId, turnCostOperationKey);
      turnClaimed = false;
      return turnError(message, 422);
    }
    const message = modeledBatchContinuation
      ? "I couldn’t load the writing context required to resume this modeled set safely. Retry will continue the same saved batch."
      : "I couldn’t load the writing context required to start this modeled set safely. Retry will try the request again without creating a partial set.";
    await persistChatSetupFailure({
      sb: sbRaw,
      chatId,
      workspaceId,
      content: `⚠️ ${message}`,
      recoverable: {
        code: "modeled_batch_context_unavailable",
        message,
        retryRootUserMessageId:
          actionTurnMessageId ?? claimedUserMessageId ?? undefined,
        ...(modeledBatchContinuation
          ? {
              continuation: modeledBatchContinuation,
            }
          : {}),
      },
    });
    await coworkTelemetry.finish({
      deliveredContract: {
        kind: "post",
        deliveredCount: 0,
      },
      provenanceStatus: "missing",
      terminalOutcome: "recoverable_error",
    });
    await deps.releaseChatTurn(workspaceId, chatId, turnCostOperationKey);
    turnClaimed = false;
    return turnError(message, 503);
  }
  const useReadOnlyOrchestrator = Boolean(
    readOnlyOrchestratorRoute &&
      preloadedVoiceResult?.ok === true &&
      (Boolean(modeledBatchRouteContract) ||
        deterministicModeledRoute ||
        deps.readOnlyOrchestratorEnabledForWorkspace()),
  );
  const directWriterTask: DraftEngineTask = useDirectRefine
    ? {
        kind: "refine",
        instruction: refineInstruction!,
        focus: classifyDirectRefineFocus(refineInstruction!),
        target: trustedRefineTarget as Artifact & { kind: "post" },
      }
    : useDirectPartial
      ? {
          kind: "partial",
          spec: directPartialSpec!,
          ...(directSource ? { source: directSource } : {}),
        }
      : useDirectMulti
        ? {
            kind: "multi",
            expectedCount: directPostCount!,
            ...(directSource ? { source: directSource } : {}),
          }
        : useDirectSource
          ? { kind: "source", source: directSource! }
          : { kind: "original" };
  const coworkRoute: CoworkRoute = useDirectWriter
    ? "direct_writer"
    : useActionOrchestrator
      ? "action_orchestrator"
      : useReadOnlyOrchestrator
        ? "read_only_orchestrator"
        : "answer";
  // THE single authoritative deliverable contract for this turn
  // (PLAN-cowork-unification Phase 1, step 3): computed ONCE, here —
  // post-clarification and post-routing — from the same
  // effectiveUserInstruction the executors consume. The only other contract
  // value in the turn is the telemetry placeholder above, produced by this
  // same builder and overwritten here.
  const turnContract: TurnContract = resolveTurnContract({
    directWriterTask: useDirectWriter ? directWriterTask : null,
    actionRoute: actionOrchestratorRoute,
    useActionOrchestrator,
    readOnlyRoute: readOnlyOrchestratorRoute,
    useReadOnlyOrchestrator,
    hasPartialSpec: directPartialSpec !== null,
    fallbackPostCount:
      activeDraftCountOverride ??
      postClarificationPostCount ??
      (skipDecision ? 1 : null),
  });
  coworkTelemetry.configure({
    traceId: claimedUserMessageId ?? chatId,
    route: coworkRoute,
    requestedContract: turnContract,
  });

  // Persist the first non-answer lane selection so the next ambiguous turn
  // stays in the same drafting workflow. Answer turns are not part of a
  // multi-turn drafting workflow and never pin a lane.
  if (!pinnedCoworkRoute && coworkRoute !== "answer") {
    try {
      await sbRaw
        .from("chats")
        .update({
          pinned_cowork_route: coworkRoute,
          updated_at: new Date().toISOString(),
        })
        .eq("id", chatId)
        .eq("workspace_id", workspaceId);
    } catch {
      // Best-effort: a failed pin write does not abort the turn.
    }
  }

  const activeModeledBatchContinuation = useReadOnlyOrchestrator
    ? modeledBatchRouteContract
    : null;
  const modeledBatchRetryRootUserMessageId = activeModeledBatchContinuation
    ? actionTurnMessageId ?? claimedUserMessageId ?? undefined
    : undefined;

  const encoder = new TextEncoder();
  let resolveTerminal!: (outcome: ChatTurnOutcome) => void;
  const terminal = new Promise<ChatTurnOutcome>((resolve) => {
    resolveTerminal = resolve;
  });
  // Once the client disconnects, the underlying controller is closed/errored and
  // enqueuing to it throws `Invalid state: Controller is already closed`. Guard
  // every write behind a `closed` flag (set in finally and on stream cancel) and
  // swallow any residual enqueue error, so a late event on a torn-down stream
  // can't throw out of `start` and skip persistence / double-close.
  let closed = false;
  let stopHeartbeat = () => {};
  const send = (
    controller: ReadableStreamDefaultController,
    event: string,
    data: unknown,
  ) => {
    if (closed) return;
    const frame = encodeChatSseFrame(event, data);
    if (!frame) {
      console.error(JSON.stringify({ chat_sse_contract_violation: { event } }));
      const fallback = encodeChatSseFrame("error", {
        message: "The assistant stream produced an invalid event.",
        code: "invalid_stream_event",
      });
      try {
        if (fallback) controller.enqueue(encoder.encode(fallback));
      } catch {
        // The consumer may already have disconnected.
      }
      closed = true;
      return;
    }
    try {
      controller.enqueue(encoder.encode(frame));
    } catch {
      // Controller already closed (client gone) — stop trying to write.
      closed = true;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      // Provider reasoning can be silent for longer than the browser's 55s
      // transport watchdog. Send SSE comments (ignored by the event parser)
      // so a healthy, still-running model round is never mistaken for a dead
      // connection and cancelled before its first tool call arrives.
      stopHeartbeat = startSseHeartbeat({
        intervalMs: CHAT_SSE_HEARTBEAT_MS,
        write: () => {
          if (closed) return;
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        },
      });
      const artifacts: Artifact[] = [];
      const pendingCiteArtifacts: Artifact[] = [];
      let movedCiteSourceToDraft = false;
      let leadMagnetImageGeneratedThisTurn = false;
      // A lead-magnet draft that was ready to get an image EXCEPT no source
      // image had loaded yet (neither model-source nor cited). render_cite is
      // its own SSE event, processed separately from the draft — and the
      // system prompt tells the model to call it AFTER the draft, so on a
      // normal turn the draft's own image decision runs before the cite (and
      // its image) has arrived. Stashed here so a LATER cite arrival can
      // retroactively trigger generation instead of the turn's one shot at an
      // image being silently spent with sourceImage: null. Cleared the moment
      // an image decision (fire OR explicit skip) actually lands for it.
      let pendingImageDraft: {
        artifact: Artifact;
        leadMagnet: LeadMagnetImageContext;
      } | null = null;
      // Accumulate streamed text + whether we've already persisted the assistant
      // turn, so an error/abort mid-stream still saves a row (otherwise the user
      // message is orphaned with no reply, which corrupts the next turn's
      // history).
      let streamedText = "";
      let persisted = false;
      let responseModel = CHAT_MODEL;
      const recordResponseModel = (model: string) => {
        responseModel = model;
      };
      let latestPlanSteps: PlanStep[] = [];
      // Persist the current plan to chats.live_plan so a client that navigated
      // away mid-turn and came back can restore the literal checklist (not just a
      // "still working…" indicator). Never throws (a failed write only costs the
      // returning client its checklist, never the turn). Plans change a few times
      // per turn (not per token), so the write volume is small. Returns the
      // promise so the finally can AWAIT the NULL-clear specifically — awaiting it
      // before releaseChatTurn guarantees the clear lands before the NEXT turn
      // (which can only claim after release) writes its first plan, so a stale
      // clear can't null a newer turn's live_plan.
      const persistLivePlan = (steps: PlanStep[] | null): Promise<void> =>
        Promise.resolve(
          sbRaw
            .from("chats")
            .update({ live_plan: steps && steps.length ? steps : null })
            .eq("id", chatId)
            .eq("workspace_id", workspaceId),
        ).then(
          () => {},
          () => {},
        );
      // Attempt lead-magnet image generation for `artifact` given whatever
      // source image is available RIGHT NOW. Shared by two call sites:
      //   (a) the draft artifact's own arrival (the common case), and
      //   (b) a LATER cite arrival retrying a draft that had no source image
      //       yet when (a) ran — see pendingImageDraft above.
      // Mutates nothing; returns the artifact with generation meta attached
      // (queued/failed) OR unchanged if a source image genuinely isn't
      // available yet (caller decides whether to stash it for retry).
      // Emits the same tool_start/tool_end/plan_update events either way, so
      // a retry-triggered generation looks identical in the activity rail to
      // one triggered on the first pass.
      const attemptLeadMagnetImage = async (
        artifact: Artifact,
        leadMagnetContext: LeadMagnetImageContext,
      ): Promise<{ artifact: Artifact; fired: boolean }> => {
        if (!AUTOMATIC_LEAD_MAGNET_IMAGE_GENERATION_ENABLED) {
          return { artifact, fired: false };
        }
        const sourceImageForLeadMagnet = modelSourceImage ?? citedSourceImage;
        if (
          !shouldGenerateLeadMagnetImage({
            artifact,
            leadMagnet: leadMagnetContext,
            sourceImage: sourceImageForLeadMagnet,
          })
        ) {
          return { artifact, fired: false };
        }
        const imageToolId = `lead_magnet_image_${artifact.id}`;
        latestPlanSteps = withLeadMagnetImagePlanStep(
          latestPlanSteps,
          "active",
        );
        void persistLivePlan(latestPlanSteps);
        send(controller, "plan_update", { steps: latestPlanSteps });
        send(controller, "tool_start", {
          id: imageToolId,
          name: "generate_lead_magnet_image",
          args: JSON.stringify({ leadMagnet: leadMagnetContext.title }),
        });
        let tagged = artifact;
        try {
          const queued = await enqueueLeadMagnetImageJob({
            sb: sbRaw,
            workspaceId,
            target: {
              kind: "chat_message_artifact",
              chatId,
              artifactId: artifact.id,
            },
            sourceImage: sourceImageForLeadMagnet as SourcePostImage,
            leadMagnet: leadMagnetContext,
            artifact,
            author: imageGenerationAuthor,
          });
          tagged = withGeneratedImageMeta(artifact, queued.queuedMeta);
          send(controller, "tool_end", {
            id: imageToolId,
            name: "generate_lead_magnet_image",
            ok: true,
            summary: "Image queued",
          });
        } catch (e) {
          tagged = withGeneratedImageMeta(artifact, {
            status: "failed",
            reason: (e as Error)?.message || "Image could not be queued.",
            source_post_id: (sourceImageForLeadMagnet as SourcePostImage)
              .postId,
            lead_magnet_id: leadMagnetContext.id ?? null,
            lead_magnet_title: leadMagnetContext.title,
          });
          send(controller, "tool_end", {
            id: imageToolId,
            name: "generate_lead_magnet_image",
            ok: false,
            summary: "Image could not be queued",
          });
        }
        latestPlanSteps = withLeadMagnetImagePlanStep(latestPlanSteps, "done");
        void persistLivePlan(latestPlanSteps);
        send(controller, "plan_update", { steps: latestPlanSteps });
        return { artifact: tagged, fired: true };
      };
      // Returns true iff the assistant row was actually committed. The Supabase
      // JS client RESOLVES with { error } (it does not throw), so a bare
      // `await insert()` swallows a failed write — and this is the app's single
      // most important save path. If the assistant insert fails we would send
      // `done` over a reply that was never stored, leaving the user's message
      // orphaned with no answer on reload, silently. So we check every { error }
      // and, on the assistant-row failure, return false so the caller surfaces a
      // recoverable error instead of a false `done`.
      const persistAssistant = async (
        content: string,
        toolCalls: ToolCall[] | null,
        terminalReason: "done" | "ask" | "cancelled" | "deadline" | "error",
        tokens?: { input: number; output: number },
        toolMessages?: { content: string; tool_call_id: string | null }[],
      ): Promise<boolean> => {
        if (persisted) return true;
        persisted = true;
        // Persist cite artifacts as a bare postId reference — drop the resolved
        // meta.card snapshot. Engagement counts drift and LinkedIn media URLs
        // expire (~weekly), so the card is RE-RESOLVED fresh on chat load
        // rather than stored stale.
        //
        // post/hook drafts: stamp meta.markdown when the writer model emits
        // markdown (GPT-5.6 Luna), so every downstream egress (render, publish,
        // copy) normalizes the body. For a non-markdown model this adds nothing —
        // the meta is untouched — keeping Haiku/GLM/Gemini drafts byte-identical
        // and the OPENROUTER_CHAT_MODEL rollback clean.
        const persistArtifacts = artifacts.map((a) => {
          if (a.kind === "cite") {
            return {
              ...a,
              meta: { postId: (a.meta as { postId?: string })?.postId },
            };
          }
          return a;
        });
        const { error: asstErr } = await persistChatAssistantTurn({
          sb: sbRaw,
          chatId,
          workspaceId,
          content,
          toolCalls,
          artifacts: persistArtifacts.length ? persistArtifacts : null,
          inputTokens: tokens?.input ?? null,
          outputTokens: tokens?.output ?? null,
          toolMessages: toolMessages ?? [],
          terminalReason,
          contentFormat: contentFormatForModel(responseModel),
        });
        if (asstErr) {
          // THE critical failure: the reply wasn't stored. Metric it (grep
          // `assistant_persist_failed`) and report failure so the caller sends
          // an error frame instead of `done`.
          console.error(
            JSON.stringify({
              assistant_persist_failed: {
                stage: "assistant",
                chat_id: chatId,
                workspace_id: workspaceId,
                error: asstErr.message,
              },
            }),
          );
          return false;
        }
        const { error: bumpErr } = await sbRaw
          .from("chats")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", chatId)
          .eq("workspace_id", workspaceId);
        // The reply IS saved; a failed recency bump only mis-sorts the sidebar.
        // Log but still report success.
        if (bumpErr) {
          console.error(
            JSON.stringify({
              assistant_persist_failed: {
                stage: "chat_bump",
                chat_id: chatId,
                error: bumpErr.message,
              },
            }),
          );
        }
        return true;
      };
      // Set when a recoverable error frame is emitted this turn; a recoverable
      // error is followed by a `done` that persists the reply, so we stash this
      // on the assistant row there to keep the Continue banner across reloads.
      let recoverableMarker: RecoverableMarker | null = null;
      const transformDraftCandidate = (body: string) => {
        if (
          activeLeadMagnetCampaign &&
          !hasLeadMagnetResourceOverlap(body, activeLeadMagnetCampaign)
        ) {
          return {
            ok: false as const,
            message:
              "The generated post did not match the selected lead magnet, so no draft was saved. Please try again.",
          };
        }
        let transformedBody = activeLeadMagnetCampaign
          ? enforceLeadMagnetCampaignCta(body, activeLeadMagnetCampaign)
          : body;
        const legacyHookOnlyAllowed =
          !refineInstruction || isExclusiveHookRefine(refineInstruction);
        if (
          !useDirectRefine &&
          hookOnly &&
          hookOnlyOriginalBody &&
          legacyHookOnlyAllowed
        ) {
          transformedBody = splicePreservedBody(
            hookOnlyOriginalBody,
            transformedBody,
          );
        }
        return { ok: true as const, body: transformedBody };
      };
      async function* executeAnswerTurn(): AsyncGenerator<AgentEvent> {
        const startedAt = Date.now();
        const systemMessage: ChatMessage = {
          role: "system",
          content:
            "You are Cowork, a LinkedIn content assistant. Answer the user's question or brainstorming request helpfully and concisely. Do not write a LinkedIn post draft unless the user explicitly asks for one.",
        };
        const messages: ChatMessage[] = [systemMessage, ...history];
        const stream = streamChat({
          model: CHAT_MODEL,
          messages,
          signal,
          sessionId: chatId,
        });
        let text = "";
        let model = CHAT_MODEL;
        let usage: Usage | undefined;
        try {
          for await (const delta of stream) {
            if (delta.model) model = delta.model;
            if (delta.text) {
              text += delta.text;
              yield { type: "text", delta: delta.text };
            }
            if (delta.usage) usage = delta.usage;
          }
        } catch (error) {
          coworkTelemetry.recordAttempt({
            stage: "answer",
            attempt: 1,
            model,
            provider: "openrouter",
            outcome: "failed",
            reasonCode:
              error instanceof Error
                ? error.name === "AbortError"
                  ? "cancelled"
                  : error.message
                : String(error),
            latencyMs: Date.now() - startedAt,
            usage,
          });
          throw error;
        }
        const latencyMs = Date.now() - startedAt;
        recordResponseModel(model);
        coworkTelemetry.recordAttempt({
          stage: "answer",
          attempt: 1,
          model,
          provider: "openrouter",
          outcome: "accepted",
          latencyMs,
          usage,
        });
        await logOpenRouterUsage(
          "cowork_answer",
          model,
          usage,
          workspaceId,
          {
            chat_id: chatId,
            reasoning_tokens:
              usage?.completion_tokens_details?.reasoning_tokens ?? 0,
            cached_input_tokens:
              usage?.prompt_tokens_details?.cached_tokens ?? 0,
          },
        );
        yield {
          type: "done",
          message: {
            content: text,
            tool_calls: null,
            artifacts: [],
            toolMessages: [],
            inputTokens: usage?.prompt_tokens ?? 0,
            outputTokens: usage?.completion_tokens ?? 0,
          },
        };
      }
      const observeTurn = (turn: AsyncGenerator<AgentEvent>) =>
        observeCoworkTurn({
          stream: turn,
          telemetry: coworkTelemetry,
          contract: turnContract,
          signal,
          deferFinish: true,
        });
      const runTurn = () => {
        const turnStartedAtMs = Date.parse(claimedTurnStartedAt!);
        const cancellationProbe = (probeSignal: AbortSignal) =>
          isCancelRequested(chatId, turnStartedAtMs, probeSignal);

        const writerInput: Omit<WriterInput, "task"> = {
          workspaceId,
          userInstruction: effectiveUserInstruction,
          voiceResult: preloadedVoiceResult!,
          preferences,
          feedbackMemory,
          priorPostDrafts,
          format: selectedNoModelFormat,
          customSkillBodies,
          customSkillNames,
          signal,
          cancellationProbe,
          finalizerSpecialists: deps.draftFinalizerSpecialists,
          transformCandidate: transformDraftCandidate,
          finalTransformCandidate: transformDraftCandidate,
          telemetry: coworkTelemetry,
          onModelUsed: recordResponseModel,
          ...(shouldAttachLeadMagnet && leadMagnetBlock.trim()
            ? { leadMagnetBlock }
            : {}),
          ...(creatorStyleBlock.trim() ? { creatorStyleBlock } : {}),
        };

        if (useDirectWriter) {
          return observeTurn(
            deps.runWriterTurn({
              ...writerInput,
              sessionId: chatId,
              history,
              task: directWriterTask,
              deadlineAtMs: turnStartedAtMs + WRITER_TURN_BUDGET_MS,
              // Coarse structure gate opt-in — true ONLY for a genuine
              // "model this post" source (mirrors modelSourceStructureBlock's
              // own genre split; false for a refine/template source, or when
              // there's no attached source at all).
              enableStructureGate: Boolean(
                currentModelSource &&
                  modelSourceStructureSkeleton(currentModelSource),
              ),
              // Lead-magnet framing for the writer prompt. The comment-CTA is
              // still HARD-enforced by transformDraftCandidate above, so a draft
              // that ignores this block is rejected rather than shipped CTA-less.
              ...(useDirectLeadMagnet ? { leadMagnetBlock } : {}),
              // Creator-style mechanics for the writer prompt.
              ...(useDirectCreatorStyle ? { creatorStyleBlock } : {}),
            }),
          );
        }
        if (useActionOrchestrator && actionOrchestratorRoute) {
          return observeTurn(
            deps.runAgentTurn({
              workspaceId,
              chatId,
              turnMessageId: actionTurnMessageId ?? claimedUserMessageId!,
              userInstruction: effectiveUserInstruction,
              history,
              task: { kind: "action", route: actionOrchestratorRoute },
              confirmedActionTargetIds,
              signal,
              cancellationProbe,
              telemetry: coworkTelemetry,
              onModelUsed: recordResponseModel,
              writerInput,
              deadlineAtMs: turnStartedAtMs + ACTION_ORCHESTRATOR_DEADLINE_MS,
            }),
          );
        }
        if (useReadOnlyOrchestrator && readOnlyOrchestratorRoute) {
          return observeTurn(
            deps.runAgentTurn({
              workspaceId,
              chatId,
              turnMessageId: actionTurnMessageId ?? claimedUserMessageId!,
              userInstruction: effectiveUserInstruction,
              history,
              task: { kind: "research", route: readOnlyOrchestratorRoute },
              ...(modeledBatchContinuation
                ? { modeledBatchContinuation }
                : {}),
              attachmentNames: attachments.map((attachment) =>
                safeFilename(attachment.filename),
              ),
              attachmentBlocks: orchestratorAttachmentBlocks,
              cancellationProbe,
              writerInput,
              signal,
              telemetry: coworkTelemetry,
              onModelUsed: recordResponseModel,
              deadlineAtMs: turnStartedAtMs + WRITER_TURN_BUDGET_MS,
            }),
          );
        }
        // Step 9: every unrouted turn resolves to the deterministic answer lane.
        return observeTurn(executeAnswerTurn());
      };
      const outcome = await executeAcceptedChatTurn({
        signal,
        run: runTurn,
        persist: async (ev) => {
          switch (ev.type) {
            case "text":
              streamedText += ev.delta;
              send(controller, "text", { delta: ev.delta });
              break;
            case "tool_start":
              send(controller, "tool_start", {
                id: ev.id,
                name: ev.name,
                args: ev.args,
              });
              break;
            case "tool_end":
              send(controller, "tool_end", {
                id: ev.id,
                name: ev.name,
                ok: ev.ok,
                // Deterministic finding for the activity chip (may be absent).
                ...(ev.summary ? { summary: ev.summary } : {}),
              });
              break;
            case "plan":
            case "plan_update":
              // The agent's live task checklist. Both events carry the FULL
              // ordered step list (client replaces, doesn't merge). Not persisted
              // with the finished message, but MIRRORED to chats.live_plan while
              // in flight so a client that navigated away and back restores the
              // checklist (cleared on settle in the finally below).
              latestPlanSteps = ev.steps;
              void persistLivePlan(ev.steps);
              send(controller, ev.type, { steps: ev.steps });
              break;
            case "ask":
              // The agent asked a clarifying question and ended the turn. Live-
              // only (the question text also rides in done.content for reload
              // context); the interactive card renders from this event.
              send(controller, "ask", ev.ask);
              break;
            case "preference_saved":
              // The agent saved a durable writing preference. Live-only signal
              // for a lightweight "I'll remember that — undo?" affordance; the
              // rule is persisted + editable in the Voice tab, so nothing needs
              // to ride in `done` for reload.
              send(controller, "preference_saved", {
                id: ev.id,
                rule: ev.rule,
              });
              break;
            case "artifact": {
              if (ev.artifact.kind === "cite") {
                pendingCiteArtifacts.push(ev.artifact);
                const updatedDrafts = applyCiteSourceToDraftArtifacts(
                  artifacts,
                  [ev.artifact],
                );
                if (updatedDrafts.length > 0) {
                  movedCiteSourceToDraft = true;
                  // Re-send each corrected draft so the LIVE client (which
                  // already rendered it with no source chip, before this cite
                  // arrived) picks up the patched meta.source_url. Without
                  // this, only the server's own `artifacts` array — and a
                  // later page reload — ever see the correction.
                  for (const draft of updatedDrafts) {
                    send(controller, "artifact", draft);
                  }
                }
                // LEAD-MAGNET IMAGE RETRY. A draft that arrived before this
                // cite had no source image to work with (render_cite is its
                // own event, and the prompt tells the model to call it AFTER
                // the draft) — pendingImageDraft stashed it rather than
                // silently spending the turn's one image attempt on
                // sourceImage: null. Now that a cite has landed, resolve its
                // image and retroactively try generation on that stashed
                // draft, re-sending the result so the live client (which
                // already rendered the draft with no image) sees it.
                if (
                  pendingImageDraft &&
                  !leadMagnetImageGeneratedThisTurn &&
                  !modelSourceImage &&
                  !citedSourceImage
                ) {
                  const citeSourceRefForRetry = sourceReferenceFromCiteArtifact(
                    ev.artifact,
                  );
                  if (citeSourceRefForRetry) {
                    const citedSourceImageDecision =
                      await loadCitedSwipePostImage({
                        sbRaw,
                        workspaceId,
                        sourceRef: citeSourceRefForRetry,
                        signal,
                      });
                    citedSourceImage = citedSourceImageDecision.image;
                    citedSourceImageSkipReason =
                      citedSourceImageDecision.skipReason;
                    citedSourceImageSourcePostId =
                      citedSourceImageDecision.sourcePostId;
                  }
                }
                if (
                  pendingImageDraft &&
                  !leadMagnetImageGeneratedThisTurn &&
                  (modelSourceImage ?? citedSourceImage)
                ) {
                  const {
                    artifact: pendingArtifact,
                    leadMagnet: pendingLeadMagnet,
                  } = pendingImageDraft;
                  pendingImageDraft = null;
                  const attempt = await attemptLeadMagnetImage(
                    pendingArtifact,
                    pendingLeadMagnet,
                  );
                  if (attempt.fired) {
                    leadMagnetImageGeneratedThisTurn = true;
                    const idx = artifacts.findIndex(
                      (a) => a.id === attempt.artifact.id,
                    );
                    if (idx !== -1) artifacts[idx] = attempt.artifact;
                    send(controller, "artifact", attempt.artifact);
                  }
                }
                break;
              }

              // Stamp the active custom skills into the artifact's meta so the
              // draft card can show a /skill badge. cite artifacts are
              // passthrough references, not generated content — left untagged.
              // ONE decorate before push (persist) and send (live stream) so
              // both reload + streaming see the same badge.
              let tagged = tagArtifactWithCreatorStyle(
                tagArtifactWithLeadMagnet(
                  tagArtifactWithModelSourceReference(
                    tagArtifactWithNoModelFormat(
                      tagArtifactWithSkills(ev.artifact, customSkillNames),
                      appliedNoModelFormat,
                    ),
                    modelSourceReference,
                  ),
                  appliedLeadMagnet,
                ),
                appliedCreatorStyle,
              );
              if (isDraftArtifact(tagged) && turnContract.kind === "post") {
                tagged = {
                  ...tagged,
                  meta: stampDraftFormat(tagged.meta, responseModel),
                };
              }
              const citeSourceRef = modelSourceReference
                ? null
                : sourceReferenceFromCiteArtifacts(pendingCiteArtifacts);
              if (citeSourceRef) {
                tagged = tagArtifactWithModelSourceReference(
                  tagged,
                  citeSourceRef,
                );
                movedCiteSourceToDraft = true;
                if (
                  AUTOMATIC_LEAD_MAGNET_IMAGE_GENERATION_ENABLED &&
                  !modelSourceImage &&
                  !citedSourceImage
                ) {
                  const citedSourceImageDecision =
                    await loadCitedSwipePostImage({
                      sbRaw,
                      workspaceId,
                      sourceRef: citeSourceRef,
                      signal,
                    });
                  citedSourceImage = citedSourceImageDecision.image;
                  citedSourceImageSkipReason =
                    citedSourceImageDecision.skipReason;
                  citedSourceImageSourcePostId =
                    citedSourceImageDecision.sourcePostId;
                }
              } else if (
                pendingCiteArtifacts.length > 0 &&
                isDraftArtifact(tagged)
              ) {
                movedCiteSourceToDraft = true;
              }
              const sourceImageForLeadMagnet =
                modelSourceImage ?? citedSourceImage;
              const sourceImageSkipReason =
                modelSourceImageSkipReason ?? citedSourceImageSkipReason;
              const sourceImageSourcePostId =
                modelSourceImageSourcePostId ?? citedSourceImageSourcePostId;
              const imageLeadMagnetContext = activeLeadMagnetCampaign
                ? campaignImageContext(activeLeadMagnetCampaign)
                : null;
              const imageLeadMagnetTitle =
                appliedLeadMagnet?.title ??
                imageLeadMagnetContext?.title ??
                "Lead magnet";
              if (
                AUTOMATIC_LEAD_MAGNET_IMAGE_GENERATION_ENABLED &&
                !leadMagnetImageGeneratedThisTurn &&
                imageLeadMagnetContext
              ) {
                const attempt = await attemptLeadMagnetImage(
                  tagged,
                  imageLeadMagnetContext,
                );
                tagged = attempt.artifact;
                if (attempt.fired) {
                  leadMagnetImageGeneratedThisTurn = true;
                } else if (
                  isDraftArtifact(tagged) &&
                  !sourceImageForLeadMagnet
                ) {
                  if (sourceImageSkipReason) {
                    // A decision REJECTED the source image (wrong media type,
                    // fetch failure, etc.) — record why, nothing left to wait
                    // for.
                    leadMagnetImageGeneratedThisTurn = true;
                    latestPlanSteps = withLeadMagnetImagePlanStep(
                      latestPlanSteps,
                      "done",
                    );
                    void persistLivePlan(latestPlanSteps);
                    send(controller, "plan_update", { steps: latestPlanSteps });
                    tagged = withGeneratedImageMeta(tagged, {
                      status: "skipped",
                      reason: sourceImageSkipReason,
                      source_post_id: sourceImageSourcePostId,
                      lead_magnet_id: imageLeadMagnetContext.id ?? null,
                      lead_magnet_title: imageLeadMagnetTitle,
                    });
                  } else {
                    // No source image AND no explicit rejection yet — the
                    // model likely hasn't called render_cite yet this round
                    // (it's told to cite AFTER the draft). Stash this draft so
                    // a LATER cite arrival (which resolves citedSourceImage)
                    // can retroactively fire generation instead of silently
                    // spending the turn's one shot on sourceImage: null.
                    pendingImageDraft = {
                      artifact: tagged,
                      leadMagnet: imageLeadMagnetContext,
                    };
                  }
                }
              }
              artifacts.push(tagged);
              send(controller, "artifact", tagged);
              break;
            }
            case "done": {
              if (
                pendingCiteArtifacts.length > 0 &&
                !movedCiteSourceToDraft &&
                !artifacts.some(isDraftArtifact)
              ) {
                for (const citeArtifact of pendingCiteArtifacts) {
                  artifacts.push(citeArtifact);
                  send(controller, "artifact", citeArtifact);
                }
              }
              // If a recoverable error preceded this done, stash the marker on
              // the assistant row so hydrate can re-derive the Continue banner
              // after the post-stream reload (recoverable is otherwise live-only).
              const turnUsage = coworkTelemetry.snapshotUsage();
              // A modeled coordinator can cross its deadline at a cancellation
              // boundary after producing a result, without first yielding an
              // error frame. Persist the same server marker in that path so a
              // second Retry still resolves to the original durable batch.
              const persistedRecoverableMarker =
                recoverableMarker ??
                (modeledBatchRetryRootUserMessageId &&
                ev.terminalReason === "deadline"
                  ? {
                      code: "modeled_batch_deadline",
                      message:
                        ev.message.content ||
                        "The modeled set reached its deadline. Retry will continue the same batch.",
                      retryRootUserMessageId:
                        modeledBatchRetryRootUserMessageId,
                    }
                  : null);
              const doneToolCalls = [
                ...(ev.message.tool_calls ?? []),
                ...(persistedRecoverableMarker
                  ? [recoverableToolCall(persistedRecoverableMarker)]
                  : []),
                turnUsageToolCall(turnUsage),
              ];
              const saved = await persistAssistant(
                ev.message.content,
                doneToolCalls,
                ev.terminalReason ?? "done",
                {
                  input: ev.message.inputTokens,
                  output: ev.message.outputTokens,
                },
                ev.message.toolMessages.map((t) => ({
                  // Tool messages always carry string content.
                  content: typeof t.content === "string" ? t.content : "",
                  tool_call_id: t.tool_call_id ?? null,
                })),
              );
              if (!saved) {
                // The reply was generated but the DB save failed. Do NOT send a
                // `done` over a reply that isn't stored (it would vanish on
                // reload). Surface a recoverable error — the turn's work is done,
                // so retrying re-runs it cleanly. (Metric already logged.)
                send(controller, "error", {
                  message:
                    "Your reply was generated but couldn't be saved. Please try again.",
                  code: "persist_failed",
                  recovery: "continue",
                });
                const persistenceError = new Error(
                  "Assistant turn persistence failed.",
                );
                persistenceError.name = "AssistantPersistenceError";
                return {
                  ok: false as const,
                  error: persistenceError,
                };
              }
              send(controller, "done", { artifacts, usage: turnUsage });
              break;
            }
            case "error":
              // RECOVERABLE errors (length_truncated, tool_budget_exhausted)
              // are followed by a `done` event with the proper finalText —
              // skip persisting here and let `done` carry the canonical
              // content. The error frame is purely a UI signal (show the
              // Continue button). Non-recoverable errors (provider 5xx,
              // rate limits, content filter) DON'T get a `done` event, so we
              // persist here to make sure the user's turn isn't orphaned.
              if (!ev.recovery) {
                await persistAssistant(
                  stripArtifactFences(streamedText) ||
                    "⚠️ The assistant hit an error and couldn't finish this response.",
                  null,
                  "error",
                );
              } else {
                // Recoverable: the `done` that follows will persist the reply.
                // Remember the banner so it's stashed on that row for reloads.
                const resumesDurableModeledBatch =
                  modeledBatchRetryRootUserMessageId &&
                  typeof ev.code === "string" &&
                  ev.code.startsWith("modeled_batch_resumable_");
                recoverableMarker = {
                  code: ev.code ?? "",
                  message: ev.message,
                  ...(modeledBatchRetryRootUserMessageId
                    ? {
                        retryRootUserMessageId:
                          modeledBatchRetryRootUserMessageId,
                      }
                    : {}),
                  ...(resumesDurableModeledBatch
                    ? {
                        continuation:
                          activeModeledBatchContinuation ?? undefined,
                      }
                    : {}),
                };
              }
              send(controller, "error", {
                message: ev.message,
                code: ev.code,
                recovery: ev.recovery,
              });
              break;
          }
        },
        persistFailure: async (e) => {
          // Thrown mid-stream (incl. client abort): persist the partial so the
          // turn isn't lost, then surface the error (preserving any provider
          // error code so the client can render a specific message).
          await persistAssistant(
            stripArtifactFences(streamedText) ||
              "⚠️ The assistant hit an error and couldn't finish this response.",
            null,
            signal.aborted ? "cancelled" : "error",
          ).catch(() => {});
          const err = e as Error & { code?: string | number };
          send(controller, "error", { message: err.message, code: err.code });
        },
        release: async () => {
          // Clear the live plan — the turn is over, so a returning client should
          // see the persisted result, not a stale (now-complete) checklist. AWAIT
          // it before releaseChatTurn so the clear lands before the next turn (which
          // can only claim after release) writes its first plan — otherwise a slow
          // clear could null a newer turn's live_plan. Never throws (see above).
          await persistLivePlan(null);
          // Release the exclusive turn claim now the turn is fully done (success,
          // error, or abort), so the next message on this chat can start at once
          // rather than waiting out the staleness window.
          await deps.releaseChatTurn(workspaceId, chatId, turnCostOperationKey);
        },
      }).catch((cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        send(controller, "error", { message: error.message });
        return { terminal: "failure" as const, error };
      });
      const persistenceFailed =
        outcome.error?.name === "AssistantPersistenceError";
      await coworkTelemetry.finishStaged(
        resolveTurnOutcome({
          terminal: outcome.terminal,
          staged: coworkTelemetry.stagedTerminalOutcome(),
          persistenceFailed,
          cancelled: signal.aborted,
        }),
        persistenceFailed,
      );
      stopHeartbeat();
      resolveTerminal(outcome);
      // Guard the close: if the client already disconnected the controller is
      // closed and calling close() again throws. Mark closed first so any
      // straggler send() also no-ops.
      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the runtime on disconnect — nothing to do.
        }
      }
    },
    // Client disconnected (tab closed, Stop aborted the fetch). Stop writing; the
    // agent loop's own abort path (via signal) handles halting + persistence.
    cancel() {
      closed = true;
      stopHeartbeat();
    },
  });

  return { stream, claimedTurnStartedAt, claimedUserMessageId, terminal };
}

export function jsonError(
  message: string,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders ?? {}) },
  });
}

// Emit a structured log on a guarded turn rejection (duplicate-send, cost cap,
// count cap, concurrent turn). These are the paths that protect against the
// worst money incident (the duplicate-send burst), yet they were invisible:
// nothing was logged, so a client-guard regression would be undetectable in
// production without it recurring on a bill. The `chat_reject` envelope mirrors
// the `agent_turn` one in run.ts — grep `chat_reject AND reason:duplicate_turn`
// to see the dedupe firing, or `chat_reject AND status:429` for cap hits.
// Exported so the diagnostic contract (the exact log shape) is unit-tested
// rather than silently drifting.
export function chatRejectLogLine(
  workspaceId: string,
  chatId: string,
  reason: string,
  status: number,
): string {
  return JSON.stringify({
    chat_reject: { workspace_id: workspaceId, chat_id: chatId, reason, status },
  });
}

function logChatReject(
  workspaceId: string,
  chatId: string,
  reason: string,
  status: number,
): void {
  console.log(chatRejectLogLine(workspaceId, chatId, reason, status));
}

// Stamp the turn's active custom-skill slugs onto a generated artifact's meta
// so the draft card can show "produced with /name" chips. Pure — exported so
// the contract (cite is never tagged; existing meta keys are preserved; no
// skills → passthrough) is unit-tested.
export function tagArtifactWithSkills(
  artifact: Artifact,
  skillNames: string[],
): Artifact {
  if (skillNames.length === 0) return artifact;
  if (artifact.kind === "cite") return artifact;
  return {
    ...artifact,
    meta: { ...(artifact.meta ?? {}), skills: skillNames },
  };
}

export function tagArtifactWithNoModelFormat(
  artifact: Artifact,
  format: { id: NoModelFormatId; label: string; forced: boolean } | null,
): Artifact {
  if (!format) return artifact;
  if (artifact.kind === "cite") return artifact;
  return {
    ...artifact,
    meta: {
      ...(artifact.meta ?? {}),
      no_model_format: format,
    },
  };
}

export function tagArtifactWithLeadMagnet(
  artifact: Artifact,
  leadMagnet: (AppliedLeadMagnet & { id: string }) | null,
): Artifact {
  if (!leadMagnet) return artifact;
  if (artifact.kind === "cite") return artifact;
  return {
    ...artifact,
    meta: {
      ...(artifact.meta ?? {}),
      lead_magnet: leadMagnet,
    },
  };
}

// Stamp the applied creator style onto a generated artifact's meta (not shown on
// cards in v1, but preserved for reload context + parity with the skill/format
// tags). Same contract: cite untagged, no style → passthrough, meta preserved.
export function tagArtifactWithCreatorStyle(
  artifact: Artifact,
  style: { id: string; name: string; creatorName: string } | null,
): Artifact {
  if (!style) return artifact;
  if (artifact.kind === "cite") return artifact;
  return {
    ...artifact,
    meta: {
      ...(artifact.meta ?? {}),
      creator_style: style,
    },
  };
}

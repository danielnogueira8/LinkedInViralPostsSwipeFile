import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  generationConfigV1Schema,
  resolvedGenerationConfigSchema,
  type ResolvedGenerationConfig,
} from "@/lib/generation-config";
import { scopedSupabase } from "@/lib/supabase-scoped";

import {
  type DraftFinalizerSpecialists,
} from "@/lib/agent/finalize/finalizer";
import { executeTurnPlan } from "@/lib/agent/turn/execute";
import {
  finalizeTurn,
  recoverableErrorValue,
  type RecoverableMarker,
} from "@/lib/agent/turn/finalize";
import { runWriterTurn } from "@/lib/agent/execute/writer";
import { runAgentTurn } from "@/lib/agent/execute/agent";
import {
  actionOrchestratorEnabledForWorkspace,
  compileTurnPlan,
  readOnlyOrchestratorEnabledForWorkspace,
} from "@/lib/agent/turn/compile";
import {
  createSupabaseActionRetryRepository,
} from "@/lib/agent/action-retry";
import {
  parseModeledDraftBatchContinuation,
  type ModeledDraftBatchContinuation,
} from "@/lib/agent/modeled-draft-continuation";
import { requestedDirectPostCount } from "@/lib/agent/direct-deliverable-policy";
import { type CoworkTelemetrySink } from "@/lib/agent/cowork-telemetry";

import { setupChatTurn } from "@/lib/agent/turn/setup";
import {
  chatTurnOperationSchema,
  TURN_OPERATION_TOOL_NAME,
  TURN_OPERATION_VERSION,
  type ChatTurnOperation,
} from "@/lib/agent/turn/operation-marker";
export type { ChatTurnOperation } from "@/lib/agent/turn/operation-marker";

import {
  CREATOR_STYLE_RETRY_CONTEXT_VERSION,
  CUSTOM_SKILL_RETRY_CONTEXT_VERSION,
  LEAD_MAGNET_TOOL_NAME,
  MAX_CREATOR_STYLE_RETRY_BLOCK_CHARS,
  MODEL_SOURCE_TOOL_NAME,
  type CreatorStyleRetryContext,
  type CustomSkillRetryContext,
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
// Artifact tagging helpers moved to their own module so the execution stream can
// use them without creating an import cycle with this file.
export {
  applyCiteSourceToDraftArtifacts,
  isDraftArtifact,
  sourceReferenceFromCiteArtifact,
  tagArtifactWithCreatorStyle,
  tagArtifactWithLeadMagnet,
  tagArtifactWithModelSourceReference,
  tagArtifactWithNoModelFormat,
  tagArtifactWithSkills,
  withGeneratedImageMeta,
  withLeadMagnetImagePlanStep,
  withLeadMagnetResourcePlanStep,
} from "@/lib/agent/turn/artifact-tags";
import {
  checkChatRateLimit,
  claimChatTurn,
  releaseChatTurn,
} from "@/lib/agent/rate-limit";

import { safeFilename } from "@/lib/agent/untrusted";

import { compileModeledPostIntent } from "@/lib/agent/modeled-post-intent";
import {
  composerStarterIdSchema,
} from "@/lib/composer-task-context";

import {
  NO_MODEL_FORMAT_IDS,
  type NoModelFormatId,
} from "@/lib/agent/no-model-format-catalog";
import {
  leadMagnetGenerateSchema,
} from "@/lib/lead-magnets";
import { generateLeadMagnetResource } from "@/lib/lead-magnet-ai";
import {
  SKILL_BODY_MAX,
  SKILL_NAME_MAX,
  SKILLS_PER_TURN_MAX,
} from "@/lib/custom-skills";
import { fetchRecentPostDrafts } from "@/lib/recent-drafts";
import { completeChat, type ToolCall } from "@/lib/openrouter";
import type { AppliedLeadMagnet } from "@/lib/chat-hydration";

export const runtime = "nodejs";
// The agent loop can run several tool rounds + a long final generation. Give it
// the same generous ceiling as the voice route (Vercel Pro fluid compute).
export const maxDuration = 300;

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

const chatContextKindSchema = z.enum([
  "skills",
  "creator_style",
  "post_format",
]);
const chatContextPolicySchema = z
  .object({
    inherit: z.array(chatContextKindSchema).max(3).optional(),
    clear: z.array(chatContextKindSchema).max(3).optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const inherited = new Set(policy.inherit ?? []);
    for (const kind of policy.clear ?? []) {
      if (inherited.has(kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `context ${kind} cannot be inherited and cleared in the same turn`,
          path: ["clear"],
        });
      }
    }
  });
export type TurnOperationMarker =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "valid"; operation: ChatTurnOperation };

export function turnOperationMarkerFromToolCalls(input: {
  tool_calls?: readonly ToolCall[] | null;
} | null | undefined): TurnOperationMarker {
  const markers = (input?.tool_calls ?? []).filter(
    (call) =>
      call.id === TURN_OPERATION_TOOL_NAME &&
      call.function.name === TURN_OPERATION_TOOL_NAME,
  );
  if (markers.length === 0) return { kind: "none" };
  if (markers.length !== 1) return { kind: "invalid" };
  try {
    const value = JSON.parse(markers[0].function.arguments) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { kind: "invalid" };
    }
    const { version, ...operationValue } = value as Record<string, unknown>;
    if (version !== TURN_OPERATION_VERSION) return { kind: "invalid" };
    const operation = chatTurnOperationSchema.safeParse(operationValue);
    return operation.success
      ? { kind: "valid", operation: operation.data }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

export const chatTurnRequestSchema = z.object({
  // Empty/overlong/junk user text is handled by preflightUserPrompt below so
  // the user gets a friendly, specific rejection and no turn is claimed.
  message: z.string(),
  // Immutable current-turn intent supplied by explicit UI controls that
  // already know the operation. Ordinary composer language is compiled by the
  // server. Legacy refine fields remain accepted during migration, but this
  // object wins.
  operation: chatTurnOperationSchema.optional(),
  // Non-authoritative browser context for free-text references such as
  // "improve this". The server re-resolves this id against canonical chat
  // Artifacts before compiling an operation; explicit UI actions use operation.
  selectedArtifactId: z.string().min(1).max(200).optional(),
  clientTurnId: z.string().uuid().optional(),
  retryOfUserMessageId: z.string().min(1).max(200).optional(),
  actionSelectionIds: z.array(z.string().uuid()).min(1).max(5).optional(),
  clientTimezone: z.string().min(1).max(64).optional(),
  // "Model this post": the stashed source id (chat_modeling_sources). The server
  // fetches + weaves the post text, so a long post never hits the message cap.
  modelSourceId: z.string().uuid().optional(),
  // Rolling-compatibility refine fields. Setup accepts only the complete trio
  // and immediately normalizes it to an edit_artifact operation.
  skipDecision: z.boolean().optional(),
  refineTargetId: z.string().min(1).max(200).optional(),
  refineInstruction: z.string().trim().min(1).max(4_000).optional(),
  // Hook-only refine: server-side splice guarantee. When true, the server
  // takes ONLY the model's new opener from the render_post output and glues
  // it onto hookOnlyOriginalBody byte-for-byte before persisting the artifact.
  // The body cannot drift no matter what the model returned. Set by the
  // Legacy body snapshots remain accepted by the transport during rolling
  // deploys but are never trusted; setup re-reads the canonical Artifact body.
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
  // Context is current-turn-only by default. A client must explicitly opt in
  // to chat inheritance, and can persist a tombstone that prevents a later
  // opt-in from reviving context selected before the clear.
  contextPolicy: chatContextPolicySchema.optional(),
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

const CUSTOM_SKILLS_TOOL_NAME = "_custom_skills_applied";
const POST_FORMAT_TOOL_NAME = "_post_format_selected";
const CREATOR_STYLE_TOOL_NAME = "_creator_style_selected";
const GENERATION_CONFIG_TOOL_NAME = "_generation_config_selected";
// Stashed on the ASSISTANT row when the turn ended with a recoverable error
// (cut-off / stalled, including before SSE headers). hydrate() reads it back so
// the one-click Retry banner survives the canonical reload.
const RECOVERABLE_TOOL_NAME = "_recoverable";

export function isServerRecoverableToolCall(call: ToolCall): boolean {
  return (
    call.id === RECOVERABLE_TOOL_NAME &&
    call.function.name === RECOVERABLE_TOOL_NAME
  );
}

export type RetryRootMarker =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "valid"; rootUserMessageId: string };

type RecoverableSource = {
  recoverable_error?: unknown;
  tool_calls?: readonly ToolCall[] | null | undefined;
};

function normalizeRecoverableSource(
  input: readonly ToolCall[] | null | undefined | RecoverableSource,
): RecoverableSource {
  if (input === null || input === undefined || Array.isArray(input)) {
    return { tool_calls: input as readonly ToolCall[] | null | undefined };
  }
  return input as RecoverableSource;
}

function recoverableArgsFromSource(
  source: RecoverableSource,
): Record<string, unknown> | undefined {
  if (
    source.recoverable_error !== undefined &&
    source.recoverable_error !== null
  ) {
    if (
      typeof source.recoverable_error === "object" &&
      !Array.isArray(source.recoverable_error)
    ) {
      return source.recoverable_error as Record<string, unknown>;
    }
    return undefined;
  }
  if (!source.tool_calls) return undefined;
  for (let index = source.tool_calls.length - 1; index >= 0; index -= 1) {
    const call = source.tool_calls[index];
    if (!isServerRecoverableToolCall(call)) continue;
    try {
      return JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function retryRootMarkerFromToolCalls(
  input: readonly ToolCall[] | null | undefined | RecoverableSource,
): RetryRootMarker {
  const source = normalizeRecoverableSource(input);
  const parsed = recoverableArgsFromSource(source);
  if (!parsed) return { kind: "none" };
  if (
    !Object.prototype.hasOwnProperty.call(parsed, "retryRootUserMessageId")
  ) {
    return { kind: "none" };
  }
  const root = z.string().uuid().safeParse(parsed.retryRootUserMessageId);
  return root.success
    ? { kind: "valid", rootUserMessageId: root.data }
    : { kind: "invalid" };
}

export type ModeledDraftBatchContinuationMarker =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "valid"; continuation: ModeledDraftBatchContinuation };

export function modeledDraftBatchContinuationMarkerFromToolCalls(
  input: readonly ToolCall[] | null | undefined | RecoverableSource,
): ModeledDraftBatchContinuationMarker {
  const source = normalizeRecoverableSource(input);
  const parsed = recoverableArgsFromSource(source);
  if (!parsed) return { kind: "none" };
  const claimsModeledContinuation =
    Object.prototype.hasOwnProperty.call(parsed, "continuation") ||
    (typeof parsed.code === "string" &&
      parsed.code.startsWith("modeled_batch_resumable_"));
  if (!claimsModeledContinuation) return { kind: "none" };
  const root = z.string().uuid().safeParse(parsed.retryRootUserMessageId);
  const continuation = parseModeledDraftBatchContinuation(parsed.continuation);
  if (!root.success || !continuation) {
    return { kind: "invalid" };
  }
  return { kind: "valid", continuation };
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

function parseGenerationConfigSelectionValue(
  value: unknown,
): GenerationConfigSelectionMarker | null {
  const parsed = resolvedGenerationConfigSchema.safeParse(value);
  return parsed.success ? { kind: "valid", config: parsed.data } : null;
}

type GenerationConfigSelectionSource = {
  generation_config?: unknown;
  tool_calls?: readonly ToolCall[] | null | undefined;
};

function normalizeGenerationConfigSelectionSource(
  input:
    | readonly ToolCall[] | null | undefined
    | GenerationConfigSelectionSource,
): GenerationConfigSelectionSource {
  if (input === null || input === undefined || Array.isArray(input)) {
    return { tool_calls: input as readonly ToolCall[] | null | undefined };
  }
  return input as GenerationConfigSelectionSource;
}

export function generationConfigSelectionMarkerFromToolCalls(
  input:
    | readonly ToolCall[] | null | undefined
    | GenerationConfigSelectionSource,
): GenerationConfigSelectionMarker {
  const source = normalizeGenerationConfigSelectionSource(input);
  if (
    source.generation_config !== undefined &&
    source.generation_config !== null
  ) {
    return parseGenerationConfigSelectionValue(source.generation_config) ?? {
      kind: "invalid",
    };
  }
  const calls = source.tool_calls;
  const markers = (calls ?? []).filter(
    (call) =>
      call.id === GENERATION_CONFIG_TOOL_NAME &&
      call.function.name === GENERATION_CONFIG_TOOL_NAME,
  );
  if (markers.length === 0) return { kind: "none" };
  if (markers.length !== 1) return { kind: "invalid" };
  try {
    return (
      parseGenerationConfigSelectionValue(
        JSON.parse(markers[0].function.arguments),
      ) ?? { kind: "invalid" }
    );
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
        ? { recoverable_error: recoverableErrorValue(opts.recoverable) }
        : {}),
    });
    if (error) throw error;
  } catch {
    // Best effort. The claim is still released in the caller's next step so a
    // database write failure cannot wedge the chat for the stale-claim window.
  }
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
function parseCustomSkillSelectionValue(
  value: unknown,
): CustomSkillSelectionMarker | null {
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
    : null;
}

type CustomSkillSelectionSource = {
  applied_skills?: unknown;
  tool_calls?: readonly ToolCall[] | null | undefined;
};

function normalizeCustomSkillSelectionSource(
  input: readonly ToolCall[] | null | undefined | CustomSkillSelectionSource,
): CustomSkillSelectionSource {
  if (input === null || input === undefined || Array.isArray(input)) {
    return { tool_calls: input as readonly ToolCall[] | null | undefined };
  }
  return input as CustomSkillSelectionSource;
}

export function customSkillSelectionMarkerFromToolCalls(
  input: readonly ToolCall[] | null | undefined | CustomSkillSelectionSource,
): CustomSkillSelectionMarker {
  const source = normalizeCustomSkillSelectionSource(input);
  if (
    source.applied_skills !== undefined &&
    source.applied_skills !== null
  ) {
    return parseCustomSkillSelectionValue(source.applied_skills) ?? {
      kind: "invalid",
    };
  }
  const calls = source.tool_calls;
  const markers = (calls ?? []).filter(
    (call) => call.function.name === CUSTOM_SKILLS_TOOL_NAME,
  );
  if (markers.length === 0) return { kind: "none" };
  if (markers.length !== 1) return { kind: "invalid" };
  try {
    const value: unknown = JSON.parse(markers[0].function.arguments);
    return parseCustomSkillSelectionValue(value) ?? { kind: "invalid" };
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

function parseCreatorStyleSelectionValue(
  value: unknown,
): CreatorStyleSelectionMarker | null {
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
  return legacy.success ? { kind: "unfrozen", id: legacy.data.id } : null;
}

type CreatorStyleSelectionSource = {
  creator_style_context?: unknown;
  tool_calls?: readonly ToolCall[] | null | undefined;
};

function normalizeCreatorStyleSelectionSource(
  input: readonly ToolCall[] | null | undefined | CreatorStyleSelectionSource,
): CreatorStyleSelectionSource {
  if (input === null || input === undefined || Array.isArray(input)) {
    return { tool_calls: input as readonly ToolCall[] | null | undefined };
  }
  return input as CreatorStyleSelectionSource;
}

/**
 * Recover only a server-persisted creator-style selection. Retry requests do
 * not trust a fresh client id because changing optional writing context would
 * rebind a durable modeled batch to different generation semantics.
 */
export function creatorStyleSelectionMarkerFromToolCalls(
  input: readonly ToolCall[] | null | undefined | CreatorStyleSelectionSource,
): CreatorStyleSelectionMarker {
  const source = normalizeCreatorStyleSelectionSource(input);
  if (
    source.creator_style_context !== undefined &&
    source.creator_style_context !== null
  ) {
    return parseCreatorStyleSelectionValue(source.creator_style_context) ?? {
      kind: "invalid",
    };
  }
  const calls = source.tool_calls;
  const markers = (calls ?? []).filter(
    (call) =>
      call.id === CREATOR_STYLE_TOOL_NAME &&
      call.function.name === CREATOR_STYLE_TOOL_NAME,
  );
  if (markers.length === 0) return { kind: "none" };
  if (markers.length !== 1) return { kind: "invalid" };
  try {
    const value: unknown = JSON.parse(markers[0].function.arguments);
    return parseCreatorStyleSelectionValue(value) ?? { kind: "invalid" };
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

  const setupResult = await setupChatTurn(
    { chatId, userId, body, signal },
    {
      ...deps,
      jsonError,
      logChatReject,
      persistChatSetupFailure,
      isRecentUnansweredUserMessage,
      isServerRecoverableToolCall,
      customSkillSelectionMarkerFromToolCalls,
      creatorStyleSelectionMarkerFromToolCalls,
      generationConfigSelectionMarkerFromToolCalls,
      modeledDraftBatchContinuationMarkerFromToolCalls,
      retryRootMarkerFromToolCalls,
      turnOperationMarkerFromToolCalls,
      explicitMessageDraftCount,
    },
  );
  if (setupResult instanceof Response) return setupResult;

  const plan = await compileTurnPlan(
    setupResult,
    chatId,
    {
      actionOrchestratorEnabledForWorkspace:
        deps.actionOrchestratorEnabledForWorkspace,
      readOnlyOrchestratorEnabledForWorkspace:
        deps.readOnlyOrchestratorEnabledForWorkspace,
      releaseChatTurn: deps.releaseChatTurn,
      persistChatSetupFailure,
    },
  );
  if (plan instanceof Response) return plan;

  const executeResult = executeTurnPlan(plan, setupResult, chatId, deps);

  return finalizeTurn(plan, setupResult, executeResult, {
    chatId,
    releaseChatTurn: deps.releaseChatTurn,
    signal,
  });
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

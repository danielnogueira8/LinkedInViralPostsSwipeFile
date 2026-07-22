import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionOrchestratorRoute } from "@/lib/agent/turn/compile";
import { supabaseAdmin } from "@/lib/supabase";

type RetryUser = { id: string; content: string };
type RetryTerminalReason =
  | "done"
  | "ask"
  | "cancelled"
  | "deadline"
  | "error";

export type ActionRetryContext = {
  rootTurnMessageId: string;
  effectiveInstruction: string;
  route: ActionOrchestratorRoute | null;
  confirmedTargetIds: string[];
  cancelled: boolean;
};

export type ActionRetryRepository = {
  latestUser(input: {
    workspaceId: string;
    chatId: string;
    signal?: AbortSignal;
  }): Promise<RetryUser | null>;
  userById(input: {
    workspaceId: string;
    chatId: string;
    userMessageId: string;
    signal?: AbortSignal;
  }): Promise<RetryUser | null>;
  contextForUser(input: {
    workspaceId: string;
    chatId: string;
    userMessageId: string;
    signal?: AbortSignal;
  }): Promise<ActionRetryContext | null>;
  latestContext(input: {
    workspaceId: string;
    chatId: string;
    signal?: AbortSignal;
  }): Promise<ActionRetryContext | null>;
  saveContext(input: {
    workspaceId: string;
    chatId: string;
    userMessageId: string;
    rootTurnMessageId: string;
    effectiveInstruction: string;
    route: ActionOrchestratorRoute;
    confirmedTargetIds: string[];
    signal?: AbortSignal;
  }): Promise<void>;
};

export type ActionRetryResolution =
  | ({ ok: true; turnMessageId: string } & Pick<
      ActionRetryContext,
      "effectiveInstruction" | "route" | "confirmedTargetIds"
    >)
  | { ok: false; reason: "stale_or_altered" | "cancelled" | "completed" };

function retryContextFromRow(value: unknown): ActionRetryContext | null {
  const row = value as {
    root_turn_message_id?: unknown;
    effective_instruction?: unknown;
    route?: unknown;
    confirmed_target_ids?: unknown;
    cancelled_at?: unknown;
  } | null;
  const route = row?.route as ActionOrchestratorRoute | null | undefined;
  const confirmedTargetIds = Array.isArray(row?.confirmed_target_ids)
    ? row.confirmed_target_ids.filter(
        (draftId): draftId is string => typeof draftId === "string",
      )
    : [];
  return typeof row?.root_turn_message_id === "string" &&
    typeof row.effective_instruction === "string" &&
    route &&
    typeof route === "object" &&
    typeof route.kind === "string"
    ? {
        rootTurnMessageId: row.root_turn_message_id,
        effectiveInstruction: row.effective_instruction,
        route,
        confirmedTargetIds,
        cancelled: typeof row.cancelled_at === "string",
      }
    : null;
}

export async function resolveActionRetryRoot(
  input: {
    workspaceId: string;
    chatId: string;
    retryOfUserMessageId: string;
    submittedContent: string;
    pairedAssistantTerminalReason?: RetryTerminalReason | null;
    pairedAssistantRecoverable?: boolean;
    pairedAssistantRetryRootUserMessageId?: string;
    pairedUserStopped?: boolean;
    signal?: AbortSignal;
  },
  repository: ActionRetryRepository,
): Promise<ActionRetryResolution> {
  const latest = await repository.latestUser(input);
  if (
    !latest ||
    latest.id !== input.retryOfUserMessageId ||
    latest.content !== input.submittedContent
  ) {
    return { ok: false, reason: "stale_or_altered" };
  }
  const terminal = input.pairedAssistantTerminalReason;
  if (input.pairedUserStopped) {
    return { ok: false, reason: "cancelled" };
  }
  if (
    !input.pairedAssistantRecoverable &&
    (terminal === "done" || terminal === "ask")
  ) {
    return { ok: false, reason: "completed" };
  }
  // Retry ancestry is explicit and scoped to the exact persisted user row.
  // Identical text elsewhere in the chat never proves that two actions are the
  // same logical operation.
  const context = await repository.contextForUser({
    ...input,
    userMessageId: input.retryOfUserMessageId,
  });
  if (context?.cancelled) {
    return { ok: false, reason: "cancelled" };
  }
  const markedRootId = input.pairedAssistantRetryRootUserMessageId;
  const markedRoot =
    !context && markedRootId
      ? await repository.userById({
          ...input,
          userMessageId: markedRootId,
        })
      : null;
  const canonicalMarkedRootId =
    markedRoot &&
    markedRoot.id === markedRootId &&
    markedRoot.content === input.submittedContent
      ? markedRoot.id
      : null;
  // A persisted server marker is authoritative for a chained Retry. Falling
  // back to the immediately preceding retry row when that root no longer
  // resolves would silently fork a second durable batch instead of resuming
  // the original operation.
  if (!context && markedRootId && !canonicalMarkedRootId) {
    return { ok: false, reason: "stale_or_altered" };
  }
  return {
    ok: true,
    turnMessageId:
      context?.rootTurnMessageId ??
      canonicalMarkedRootId ??
      input.retryOfUserMessageId,
    effectiveInstruction:
      context?.effectiveInstruction ?? input.submittedContent,
    route: context?.route ?? null,
    confirmedTargetIds: context?.confirmedTargetIds ?? [],
  };
}

export function createSupabaseActionRetryRepository(
  client: SupabaseClient,
  internalClient: () => SupabaseClient = supabaseAdmin,
): ActionRetryRepository {
  return {
    async latestUser(input) {
      let query = client
        .from("chat_messages")
        .select("id, content")
        .eq("workspace_id", input.workspaceId)
        .eq("chat_id", input.chatId)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(1);
      if (input.signal) query = query.abortSignal(input.signal);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      const row = data as { id?: unknown; content?: unknown } | null;
      return typeof row?.id === "string" && typeof row.content === "string"
        ? { id: row.id, content: row.content }
        : null;
    },
    async userById(input) {
      let query = client
        .from("chat_messages")
        .select("id, content")
        .eq("workspace_id", input.workspaceId)
        .eq("chat_id", input.chatId)
        .eq("role", "user")
        .eq("id", input.userMessageId);
      if (input.signal) query = query.abortSignal(input.signal);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      const row = data as { id?: unknown; content?: unknown } | null;
      return typeof row?.id === "string" && typeof row.content === "string"
        ? { id: row.id, content: row.content }
        : null;
    },
    async contextForUser(input) {
      let query = internalClient()
        .from("chat_action_retry_contexts")
        .select(
          "root_turn_message_id, effective_instruction, route, confirmed_target_ids, cancelled_at",
        )
        .eq("workspace_id", input.workspaceId)
        .eq("chat_id", input.chatId)
        .eq("user_message_id", input.userMessageId);
      if (input.signal) query = query.abortSignal(input.signal);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      const row = data as {
        root_turn_message_id?: unknown;
        effective_instruction?: unknown;
        route?: unknown;
        confirmed_target_ids?: unknown;
        cancelled_at?: unknown;
      } | null;
      return retryContextFromRow(row);
    },
    async latestContext(input) {
      let query = internalClient()
        .from("chat_action_retry_contexts")
        .select(
          "root_turn_message_id, effective_instruction, route, confirmed_target_ids, cancelled_at",
        )
        .eq("workspace_id", input.workspaceId)
        .eq("chat_id", input.chatId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (input.signal) query = query.abortSignal(input.signal);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return retryContextFromRow(data);
    },
    async saveContext(input) {
      let query = client.rpc("save_chat_action_retry_context", {
        p_workspace_id: input.workspaceId,
        p_chat_id: input.chatId,
        p_user_message_id: input.userMessageId,
        p_root_turn_message_id: input.rootTurnMessageId,
        p_effective_instruction: input.effectiveInstruction,
        p_route: input.route,
        p_confirmed_target_ids: input.confirmedTargetIds,
      });
      if (input.signal) query = query.abortSignal(input.signal);
      const { error } = await query;
      if (error) throw error;
    },
  };
}

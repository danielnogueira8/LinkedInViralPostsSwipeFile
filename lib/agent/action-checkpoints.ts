import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";

export type ActionCheckpointStatus =
  | "running"
  | "committed"
  | "failed"
  | "cancelled";

export type ActionCheckpoint = {
  id: string;
  workspaceId: string;
  chatId: string;
  turnMessageId: string;
  operationKey: string;
  actionType: "move_on_board" | "schedule_post";
  targetId: string;
  arguments: Record<string, unknown>;
  status: ActionCheckpointStatus;
  result: Record<string, unknown> | null;
  errorCode: string | null;
};

export type ActionCheckpointRepository = {
  listForTurn(input: {
    workspaceId: string;
    chatId: string;
    turnMessageId: string;
    signal?: AbortSignal;
  }): Promise<ActionCheckpoint[]>;
  claim(input: {
    workspaceId: string;
    chatId: string;
    turnMessageId: string;
    operationKey: string;
    actionType: ActionCheckpoint["actionType"];
    targetId: string;
    arguments: Record<string, unknown>;
    leaseSeconds: number;
    signal?: AbortSignal;
  }): Promise<{
    checkpoint: ActionCheckpoint;
    owned: boolean;
    leaseToken: string | null;
  }>;
  finish(input: {
    workspaceId: string;
    operationKey: string;
    leaseToken: string;
    status: Exclude<ActionCheckpointStatus, "running">;
    result: Record<string, unknown>;
    errorCode?: string | null;
    signal?: AbortSignal;
  }): Promise<ActionCheckpoint>;
  execute(input: {
    workspaceId: string;
    operationKey: string;
    leaseToken: string;
    signal?: AbortSignal;
  }): Promise<ActionCheckpoint>;
  cancelTurn(input: {
    workspaceId: string;
    chatId: string;
    turnMessageId: string;
    reason: string;
  }): Promise<void>;
  isTurnCancelled(input: {
    workspaceId: string;
    chatId: string;
    turnMessageId: string;
  }): Promise<boolean>;
  releaseTurnLeases(input: {
    workspaceId: string;
    chatId: string;
    turnMessageId: string;
  }): Promise<void>;
  resetUncommittedTurn(input: {
    workspaceId: string;
    chatId: string;
    turnMessageId: string;
  }): Promise<void>;
};

type CheckpointRow = {
  id: string;
  workspace_id: string;
  chat_id: string;
  turn_message_id: string;
  operation_key: string;
  action_type: ActionCheckpoint["actionType"];
  target_id: string;
  arguments: Record<string, unknown> | null;
  status: ActionCheckpointStatus;
  result: Record<string, unknown> | null;
  error_code: string | null;
};

function checkpointFromRow(value: unknown): ActionCheckpoint {
  const row = (Array.isArray(value) ? value[0] : value) as
    | (CheckpointRow & { owned?: boolean; lease_token?: string | null })
    | null;
  if (!row?.id || !row.operation_key) {
    throw new Error("Action checkpoint response was invalid.");
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    chatId: row.chat_id,
    turnMessageId: row.turn_message_id,
    operationKey: row.operation_key,
    actionType: row.action_type,
    targetId: row.target_id,
    arguments: row.arguments ?? {},
    status: row.status,
    result: row.result ?? null,
    errorCode: row.error_code ?? null,
  };
}

export function createSupabaseActionCheckpointRepository(
  client: SupabaseClient = supabaseAdmin(),
): ActionCheckpointRepository {
  return {
    async listForTurn(input) {
      let query = client
        .from("chat_action_checkpoints")
        .select(
          "id, workspace_id, chat_id, turn_message_id, operation_key, action_type, target_id, arguments, status, result, error_code",
        )
        .eq("workspace_id", input.workspaceId)
        .eq("chat_id", input.chatId)
        .eq("turn_message_id", input.turnMessageId)
        .order("created_at", { ascending: true });
      if (input.signal) query = query.abortSignal(input.signal);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map(checkpointFromRow);
    },

    async claim(input) {
      let query = client.rpc("claim_chat_action_checkpoint", {
        p_workspace_id: input.workspaceId,
        p_chat_id: input.chatId,
        p_turn_message_id: input.turnMessageId,
        p_operation_key: input.operationKey.slice(0, 200),
        p_action_type: input.actionType,
        p_target_id: input.targetId,
        p_arguments: input.arguments,
        p_lease_seconds: input.leaseSeconds,
      });
      if (input.signal) query = query.abortSignal(input.signal);
      const { data, error } = await query;
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as
        | (CheckpointRow & { owned?: boolean; lease_token?: string | null })
        | null;
      return {
        checkpoint: checkpointFromRow(row),
        owned: row?.owned === true,
        leaseToken:
          typeof row?.lease_token === "string" && row.lease_token
            ? row.lease_token
            : null,
      };
    },

    async finish(input) {
      let query = client.rpc("finish_chat_action_checkpoint", {
        p_workspace_id: input.workspaceId,
        p_operation_key: input.operationKey.slice(0, 200),
        p_lease_token: input.leaseToken,
        p_status: input.status,
        p_result: input.result,
        p_error_code: input.errorCode ?? null,
      });
      if (input.signal) query = query.abortSignal(input.signal);
      const { data, error } = await query;
      if (error) throw error;
      return checkpointFromRow(data);
    },

    async execute(input) {
      let query = client.rpc("execute_chat_action_checkpoint", {
        p_workspace_id: input.workspaceId,
        p_operation_key: input.operationKey.slice(0, 200),
        p_lease_token: input.leaseToken,
      });
      if (input.signal) query = query.abortSignal(input.signal);
      const { data, error } = await query;
      if (error) throw error;
      return checkpointFromRow(data);
    },

    async cancelTurn(input) {
      const { error } = await client.rpc("cancel_chat_action_turn", {
        p_workspace_id: input.workspaceId,
        p_chat_id: input.chatId,
        p_turn_message_id: input.turnMessageId,
        p_reason: input.reason.slice(0, 80),
      });
      if (error) throw error;
    },

    async isTurnCancelled(input) {
      const { data, error } = await client
        .from("chat_action_turn_controls")
        .select("turn_message_id")
        .eq("workspace_id", input.workspaceId)
        .eq("chat_id", input.chatId)
        .eq("turn_message_id", input.turnMessageId)
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },

    async releaseTurnLeases(input) {
      const { error } = await client.rpc("release_chat_action_turn_leases", {
        p_workspace_id: input.workspaceId,
        p_chat_id: input.chatId,
        p_turn_message_id: input.turnMessageId,
      });
      if (error) throw error;
    },

    async resetUncommittedTurn(input) {
      const { error } = await client.rpc("reset_uncommitted_chat_action_turn", {
        p_workspace_id: input.workspaceId,
        p_chat_id: input.chatId,
        p_turn_message_id: input.turnMessageId,
      });
      if (error) throw error;
    },
  };
}

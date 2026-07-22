import { AsyncLocalStorage } from "node:async_hooks";
import type { Artifact } from "@/lib/agent/contracts";

type PersistedRole = "user" | "assistant" | "tool";

export type PersistedHarnessMessage = {
  id: string;
  chat_id: string;
  workspace_id: string;
  role: PersistedRole;
  content: string;
  tool_calls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> | null;
  tool_call_id: string | null;
  artifacts: Artifact[] | null;
  content_blocks: Array<{
    type: "text" | "file" | "image_url";
    text?: string;
    file?: { filename: string; file_data: string };
    image_url?: { url: string };
  }> | null;
  input_tokens: number | null;
  output_tokens: number | null;
  terminal_reason?: string | null;
  content_format?: string | null;
  model_source_id?: string | null;
  applied_skills?: unknown;
  no_model_format_id?: string | null;
  creator_style_context?: unknown;
  lead_magnet_id?: string | null;
  composer_starter_id?: string | null;
  generation_config?: unknown;
  recoverable_error?: unknown;
  turn_usage?: unknown;
  created_at: string;
};

export type PersistedHarnessUsage = {
  id: string;
  provider: string;
  kind: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  workspace_id: string;
  meta: Record<string, unknown> | null;
  created_at: string;
};

export type PersistedHarnessDraft = {
  id: string;
  workspace_id: string;
  chat_id: string | null;
  title: string | null;
  body: string;
  kind: string;
  status: string;
  plan_to_post_on: string | null;
  lifecycle_version: number;
  created_at: string;
};

type Row = Record<string, unknown>;
type TableName =
  | "chats"
  | "chat_action_checkpoints"
  | "chat_action_retry_contexts"
  | "chat_action_turn_controls"
  | "chat_artifacts"
  | "chat_messages"
  | "chat_modeling_sources"
  | "content_feedback"
  | "content_preferences"
  | "creator_style_profiles"
  | "custom_skills"
  | "saved_posts"
  | "usage_events"
  | "voice_profiles";

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "is"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "ilike"; column: string; value: string };

type Mutation =
  | { kind: "insert"; value: Row | Row[] }
  | { kind: "update"; value: Row }
  | null;

const harnessStoreContext = new AsyncLocalStorage<CoworkHarnessStore>();

export function currentCoworkHarnessAdminClient() {
  const store = harnessStoreContext.getStore();
  if (!store) {
    throw new Error("Harness Supabase client called outside a scenario session.");
  }
  return store.client;
}

/**
 * Stateful Supabase adapter for the authenticated route harness. It models the
 * small PostgREST surface ChatTurn uses and makes later reads observe writes.
 */
export class CoworkHarnessStore {
  readonly workspaceId = "workspace_harness";
  readonly userId = "user_harness";
  readonly chatId = "00000000-0000-4000-8000-000000000101";
  private sequence = 0;
  // Keep persisted turn timestamps aligned with the harness's injected ChatTurn
  // clock. Deadline tests must measure elapsed time, not a fixture-clock skew.
  private readonly clockMs = Date.parse("2026-07-14T23:30:00.000Z");
  onActionCheckpointExecuted: (() => void) | null = null;
  failActionRetryContextSave = false;
  failActionTurnCancelAttempts = 0;
  failCreatorStyleMarkerUpdate = false;
  failTurnOperationMarkerUpdate = false;
  missCreatorStyleMarkerUpdateTarget = false;
  private readonly readCounts = new Map<TableName, number>();
  private readonly tables: Record<TableName, Row[]> = {
    chats: [],
    chat_action_checkpoints: [],
    chat_action_retry_contexts: [],
    chat_action_turn_controls: [],
    chat_artifacts: [],
    chat_messages: [],
    chat_modeling_sources: [],
    content_feedback: [],
    content_preferences: [],
    creator_style_profiles: [],
    custom_skills: [],
    saved_posts: [],
    usage_events: [],
    voice_profiles: [],
  };

  constructor() {
    this.tables.chats.push({
      id: this.chatId,
      workspace_id: this.workspaceId,
      title: "New chat",
      archived_at: null,
      cancel_requested_at: null,
      turn_started_at: null,
      turn_cost_operation_key: null,
      live_plan: null,
      pinned_cowork_route: null,
      created_at: this.iso(),
      updated_at: this.iso(),
    });
  }

  readonly client = {
    from: (table: string) => this.query(table as TableName),
    rpc: (name: string, params: Record<string, unknown>) =>
      this.rpcQuery(name, params),
  };

  run<T>(work: () => T): T {
    return harnessStoreContext.run(this, work);
  }

  private iso(offsetMs = 0): string {
    return new Date(this.clockMs + offsetMs).toISOString();
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${String(this.sequence).padStart(4, "0")}`;
  }

  private nextUuid(): string {
    this.sequence += 1;
    return `00000000-0000-4000-8000-${String(this.sequence).padStart(12, "0")}`;
  }

  private insert(table: TableName, value: Row): Row {
    const row = {
      id: value.id ?? this.nextId(table),
      created_at: value.created_at ?? this.iso(this.sequence),
      ...value,
    };
    this.tables[table].push(row);
    return row;
  }

  claim(content: string): { ok: true; operationKey: string } {
    const operationKey = "operation_harness";
    const chat = this.tables.chats[0];
    chat.turn_started_at = this.iso();
    chat.turn_cost_operation_key = operationKey;
    this.insert("chat_messages", {
      id: this.nextUuid(),
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "user",
      content,
      tool_calls: null,
      tool_call_id: null,
      artifacts: null,
      input_tokens: null,
      output_tokens: null,
    });
    return { ok: true, operationKey };
  }

  release(): void {
    const chat = this.tables.chats[0];
    chat.turn_started_at = null;
    chat.turn_cost_operation_key = null;
  }

  requestCancellation(): void {
    this.tables.chats[0].cancel_requested_at = this.iso(1_000);
  }

  requestActionCancellation(): void {
    this.requestCancellation();
    const context = [...this.tables.chat_action_retry_contexts].at(-1);
    if (!context) throw new Error("action cancellation requires a retry context");
    const cancelledAt = this.iso();
    if (
      !this.tables.chat_action_turn_controls.some(
        (row) =>
          row.workspace_id === context.workspace_id &&
          row.turn_message_id === context.root_turn_message_id,
      )
    ) {
      this.insert("chat_action_turn_controls", {
        workspace_id: context.workspace_id,
        chat_id: context.chat_id,
        turn_message_id: context.root_turn_message_id,
        cancelled_at: cancelledAt,
        reason: "user_stop",
      });
    }
    for (const retryContext of this.tables.chat_action_retry_contexts) {
      if (
        retryContext.workspace_id === context.workspace_id &&
        retryContext.chat_id === context.chat_id &&
        retryContext.root_turn_message_id === context.root_turn_message_id
      ) {
        retryContext.cancelled_at ??= cancelledAt;
      }
    }
    for (const checkpoint of this.tables.chat_action_checkpoints) {
      if (
        checkpoint.workspace_id === context.workspace_id &&
        checkpoint.chat_id === context.chat_id &&
        checkpoint.turn_message_id === context.root_turn_message_id &&
        checkpoint.status === "running"
      ) {
        Object.assign(checkpoint, {
          status: "cancelled",
          result: { ok: false, cancelled: true },
          error_code: "turn_cancelled",
          lease_token: null,
        });
      }
    }
  }

  seedBookmarkModelSource(source: {
    id: string;
    sourcePostId: string;
    postText: string;
    postUrl: string;
  }): void {
    this.insert("chat_modeling_sources", {
      id: source.id,
      workspace_id: this.workspaceId,
      post_text: source.postText,
      source: "bookmark",
      source_post_id: source.sourcePostId,
      post_type: "regular",
    });
    this.insert("saved_posts", {
      id: source.sourcePostId,
      workspace_id: this.workspaceId,
      post_url: source.postUrl,
      media_type: "none",
      media_urls: [],
    });
  }

  seedHistoricalBookmarkModelSource(source: {
    id: string;
    sourcePostId: string;
    postText: string;
    postUrl: string;
  }): void {
    this.seedBookmarkModelSource(source);
    this.insert("chat_messages", {
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "user",
      content: "Model a post from this attached source.",
      tool_calls: [
        {
          id: "_model_source_attached",
          type: "function",
          function: {
            name: "_model_source_attached",
            arguments: JSON.stringify({ id: source.id }),
          },
        },
      ],
      tool_call_id: null,
      artifacts: null,
      input_tokens: null,
      output_tokens: null,
    });
    this.insert("chat_messages", {
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "assistant",
      content: "The attached source was used for the prior turn.",
      tool_calls: null,
      tool_call_id: null,
      artifacts: null,
      input_tokens: null,
      output_tokens: null,
    });
  }

  readCount(table: TableName): number {
    return this.readCounts.get(table) ?? 0;
  }

  seedDraft(draft: {
    id: string;
    title: string;
    body: string;
    status?: "idea" | "drafting" | "ready";
    meta?: Record<string, unknown>;
    mediaAttachments?: Artifact["media_attachments"];
  }): void {
    this.insert("chat_artifacts", {
      id: draft.id,
      workspace_id: this.workspaceId,
      chat_id: this.chatId,
      title: draft.title,
      body: draft.body,
      meta: draft.meta ?? null,
      kind: "post",
      status: draft.status ?? "drafting",
      plan_to_post_on: null,
      media_attachments: draft.mediaAttachments ?? [],
      scheduled_at: null,
      schedule_status: null,
      first_comment: null,
      published_at: null,
      publish_error: null,
      lifecycle_version: 0,
    });
  }

  seedVoiceProfile(): void {
    if (
      this.tables.voice_profiles.some(
        (profile) => profile.workspace_id === this.workspaceId,
      )
    ) {
      return;
    }
    this.insert("voice_profiles", {
      workspace_id: this.workspaceId,
      linkedin_handle: "harness-writer",
      display_name: "Harness Writer",
      headline: "Practical founder and operator",
      summary: "Direct, practical writing grounded in useful experience.",
      profile: {
        tone: ["direct", "practical"],
        sentence_style: "Short and varied.",
        biographical_facts: [],
      },
      source_post_count: 12,
      status: "ready",
      model: "fixture",
      generated_at: this.iso(),
    });
  }

  seedCreatorStyleProfile(style: {
    id: string;
    name: string;
    creatorName: string;
    promptBlock: string;
    status?: "ready" | "pending" | "failed";
  }): void {
    const existing = this.tables.creator_style_profiles.find(
      (profile) =>
        profile.id === style.id &&
        profile.workspace_id === this.workspaceId,
    );
    if (existing) {
      Object.assign(existing, {
        name: style.name,
        creator_name: style.creatorName,
        prompt_block: style.promptBlock,
        status: style.status ?? "ready",
      });
      return;
    }
    this.insert("creator_style_profiles", {
      id: style.id,
      workspace_id: this.workspaceId,
      name: style.name,
      creator_name: style.creatorName,
      prompt_block: style.promptBlock,
      status: style.status ?? "ready",
    });
  }

  seedCustomSkill(skill: { id: string; name: string; body: string }): void {
    const existing = this.tables.custom_skills.find(
      (row) =>
        row.id === skill.id && row.workspace_id === this.workspaceId,
    );
    if (existing) {
      Object.assign(existing, {
        name: skill.name,
        body: skill.body,
      });
      return;
    }
    this.insert("custom_skills", {
      id: skill.id,
      workspace_id: this.workspaceId,
      name: skill.name,
      body: skill.body,
    });
  }

  seedPinnedCoworkRoute(route: string | null): void {
    const chat = this.tables.chats[0];
    if (!chat) return;
    chat.pinned_cowork_route = route;
  }

  seedMessageArtifact(artifact: Artifact): void {
    this.insert("chat_messages", {
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "assistant",
      content: "Here’s your draft.",
      tool_calls: null,
      tool_call_id: null,
      artifacts: [artifact],
      input_tokens: null,
      output_tokens: null,
    });
  }

  seedConversationTurn(user: string, assistant: string): void {
    this.insert("chat_messages", {
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "user",
      content: user,
      tool_calls: null,
      tool_call_id: null,
      artifacts: null,
      content_blocks: null,
      input_tokens: null,
      output_tokens: null,
    });
    this.insert("chat_messages", {
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "assistant",
      content: assistant,
      tool_calls: null,
      tool_call_id: null,
      artifacts: null,
      content_blocks: null,
      input_tokens: null,
      output_tokens: null,
    });
  }

  seedAttachmentTurn(
    user: string,
    contentBlocks: PersistedHarnessMessage["content_blocks"],
    assistant: string,
  ): void {
    this.insert("chat_messages", {
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "user",
      content: user,
      tool_calls: null,
      tool_call_id: null,
      artifacts: null,
      content_blocks: contentBlocks,
      input_tokens: null,
      output_tokens: null,
    });
    this.insert("chat_messages", {
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "assistant",
      content: assistant,
      tool_calls: null,
      tool_call_id: null,
      artifacts: null,
      content_blocks: null,
      input_tokens: null,
      output_tokens: null,
    });
  }

  seedRetryableActionTurn(content: string): string {
    const user = this.insert("chat_messages", {
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "user",
      content,
      tool_calls: null,
      tool_call_id: null,
      artifacts: null,
      input_tokens: null,
      output_tokens: null,
    });
    this.insert("chat_messages", {
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "assistant",
      content: "The previous action response was interrupted. Retry it.",
      tool_calls: null,
      tool_call_id: null,
      artifacts: null,
      input_tokens: null,
      output_tokens: null,
      terminal_reason: "error",
    });
    return String(user.id);
  }

  seedRetryableModeledTurn(
    content: string,
    continuation: Record<string, unknown>,
    malformed?: "root" | "continuation" | "root_only",
  ): string {
    const rootUserMessageId = "00000000-0000-4000-8000-000000000711";
    this.insert("chat_messages", {
      id: rootUserMessageId,
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "user",
      content,
      tool_calls: null,
      tool_call_id: null,
      artifacts: null,
      input_tokens: null,
      output_tokens: null,
    });
    this.insert("chat_messages", {
      chat_id: this.chatId,
      workspace_id: this.workspaceId,
      role: "assistant",
      content: "The modeled set is safely checkpointed. Retry it.",
      tool_calls: [
        {
          id: "_recoverable",
          type: "function",
          function: {
            name: "_recoverable",
            arguments: JSON.stringify({
              code:
                malformed === "root_only"
                  ? "orchestrator_evidence_unavailable"
                  : "modeled_batch_resumable_reviewer_unavailable",
              message: "Retry will continue the same modeled set.",
              retryRootUserMessageId:
                malformed === "root" || malformed === "root_only"
                  ? "not-a-uuid"
                  : rootUserMessageId,
              ...(malformed === "root_only"
                ? {}
                : {
                    continuation:
                      malformed === "continuation"
                        ? { ...continuation, version: 999 }
                        : continuation,
                  }),
            }),
          },
        },
      ],
      tool_call_id: null,
      artifacts: null,
      input_tokens: null,
      output_tokens: null,
      terminal_reason: "error",
    });
    return rootUserMessageId;
  }

  seedActionRetryContext(input: {
    userMessageId: string;
    rootTurnMessageId: string;
    effectiveInstruction: string;
    route: Record<string, unknown>;
    confirmedTargetIds?: string[];
  }): void {
    this.insert("chat_action_retry_contexts", {
      workspace_id: this.workspaceId,
      chat_id: this.chatId,
      user_message_id: input.userMessageId,
      root_turn_message_id: input.rootTurnMessageId,
      effective_instruction: input.effectiveInstruction,
      route: input.route,
      confirmed_target_ids: input.confirmedTargetIds ?? [],
    });
  }

  seedCommittedActionCheckpoint(input: {
    chatId: string;
    turnMessageId: string;
    operationKey: string;
    actionType: "move_on_board" | "schedule_post";
    targetId: string;
    arguments: Record<string, unknown>;
  }): void {
    const draft = this.tables.chat_artifacts.find(
      (row) =>
        row.id === input.targetId && row.workspace_id === this.workspaceId,
    );
    if (!draft) throw new Error("Committed checkpoint fixture needs a draft.");
    if (input.actionType === "move_on_board") {
      draft.status = input.arguments.status;
    } else {
      draft.plan_to_post_on = input.arguments.date ?? null;
    }
    this.insert("chat_action_checkpoints", {
      workspace_id: this.workspaceId,
      chat_id: input.chatId,
      turn_message_id: input.turnMessageId,
      operation_key: input.operationKey,
      action_type: input.actionType,
      target_id: input.targetId,
      arguments: input.arguments,
      status: "committed",
      result: {
        ok: true,
        draft: {
          id: draft.id,
          title: draft.title,
          kind: draft.kind,
          status: draft.status,
          plan_to_post_on: draft.plan_to_post_on ?? null,
          created_at: draft.created_at,
        },
      },
      error_code: null,
      lease_token: null,
    });
  }

  draft(id: string): Row | null {
    return this.tables.chat_artifacts.find((row) => row.id === id) ?? null;
  }

  resetDraftStatus(id: string, status: string): void {
    const draft = this.tables.chat_artifacts.find(
      (row) => row.id === id && row.workspace_id === this.workspaceId,
    );
    if (!draft) throw new Error("Draft reset fixture needs a saved draft.");
    draft.status = status;
    draft.lifecycle_version = 0;
  }

  drafts(): PersistedHarnessDraft[] {
    return this.tables.chat_artifacts.map(
      (row) => row as PersistedHarnessDraft,
    );
  }

  duplicateLastPersistedArtifact(): void {
    const assistant = this.tables.chat_messages.findLast(
      (row) => row.role === "assistant" && Array.isArray(row.artifacts),
    );
    const artifacts = (assistant?.artifacts ?? []) as Artifact[];
    const first = artifacts[0];
    if (!assistant || !first) {
      throw new Error("Duplicate-artifact fixture requires a persisted artifact.");
    }
    assistant.artifacts = [
      ...artifacts,
      { ...first, id: `${first.id}_duplicate_fixture` },
    ];
  }

  messages(): PersistedHarnessMessage[] {
    return this.tables.chat_messages
      .slice()
      .sort((left, right) =>
        String(left.created_at).localeCompare(String(right.created_at)),
      )
      .map((row) => row as PersistedHarnessMessage);
  }

  usages(): PersistedHarnessUsage[] {
    return this.tables.usage_events.map((row) => row as PersistedHarnessUsage);
  }

  private query(table: TableName) {
    if (!(table in this.tables)) {
      throw new Error(`Cowork harness has no table adapter for ${table}`);
    }
    const filters: Filter[] = [];
    let mutation: Mutation = null;
    let order: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    let range: { from: number; to: number } | null = null;
    type QueryResult = {
      data: unknown;
      error: { message: string } | null;
    };
    let executed: Promise<QueryResult> | null = null;

    const filteredRows = () => {
      let rows = this.tables[table].filter((row) =>
        filters.every((filter) => {
          if (filter.kind === "eq") return row[filter.column] === filter.value;
          if (filter.kind === "is") {
            return filter.value === null
              ? row[filter.column] == null
              : row[filter.column] === filter.value;
          }
          if (filter.kind === "ilike") {
            const needle = filter.value
              .replace(/^%|%$/g, "")
              .replace(/\\([\\%_])/g, "$1")
              .toLocaleLowerCase("en-US");
            return String(row[filter.column] ?? "")
              .toLocaleLowerCase("en-US")
              .includes(needle);
          }
          return filter.values.includes(row[filter.column]);
        }),
      );
      if (order) {
        rows = rows.slice().sort((left, right) => {
          const comparison = String(left[order!.column] ?? "").localeCompare(
            String(right[order!.column] ?? ""),
          );
          return order!.ascending ? comparison : -comparison;
        });
      }
      if (range) rows = rows.slice(range.from, range.to + 1);
      if (limit !== null) rows = rows.slice(0, limit);
      return rows;
    };

    const execute = (): Promise<QueryResult> => {
      if (!executed) {
        executed = Promise.resolve().then<QueryResult>(() => {
          if (mutation?.kind === "insert") {
            const values = Array.isArray(mutation.value)
              ? mutation.value
              : [mutation.value];
            return {
              data: values.map((value) => this.insert(table, value)),
              error: null,
            };
          }
          if (mutation?.kind === "update") {
            const updatesCreatorStyleContext =
              table === "chat_messages" &&
              mutation.value.creator_style_context !== undefined;
            const updatesTurnOperation =
              table === "chat_messages" &&
              Array.isArray(mutation.value.tool_calls) &&
              mutation.value.tool_calls.some(
                (call: { function?: { name?: unknown } }) =>
                  call.function?.name === "_turn_operation",
              );
            if (updatesTurnOperation && this.failTurnOperationMarkerUpdate) {
              return {
                data: [],
                error: { message: "turn operation marker write unavailable" },
              };
            }
            if (
              updatesCreatorStyleContext &&
              this.failCreatorStyleMarkerUpdate
            ) {
              return {
                data: [],
                error: { message: "creator style context write unavailable" },
              };
            }
            if (
              updatesCreatorStyleContext &&
              this.missCreatorStyleMarkerUpdateTarget
            ) {
              return { data: [], error: null };
            }
            const rows = filteredRows();
            for (const row of rows) Object.assign(row, mutation.value);
            return { data: rows, error: null };
          }
          this.readCounts.set(table, this.readCount(table) + 1);
          return { data: filteredRows(), error: null };
        });
      }
      return executed;
    };

    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (column: string, value: unknown) => {
      filters.push({ kind: "eq", column, value });
      return builder;
    };
    builder.is = (column: string, value: unknown) => {
      filters.push({ kind: "is", column, value });
      return builder;
    };
    builder.in = (column: string, values: unknown[]) => {
      filters.push({ kind: "in", column, values });
      return builder;
    };
    builder.ilike = (column: string, value: string) => {
      filters.push({ kind: "ilike", column, value });
      return builder;
    };
    builder.order = (
      column: string,
      options: { ascending?: boolean } = {},
    ) => {
      order = { column, ascending: options.ascending !== false };
      return builder;
    };
    builder.limit = (value: number) => {
      limit = value;
      return builder;
    };
    builder.range = (from: number, to: number) => {
      range = { from, to };
      return execute();
    };
    builder.insert = (value: Row | Row[]) => {
      mutation = { kind: "insert", value };
      return builder;
    };
    builder.update = (value: Row) => {
      mutation = { kind: "update", value };
      return builder;
    };
    builder.or = () => builder;
    builder.maybeSingle = async () => {
      const result = await execute();
      const rows = result.data as Row[];
      return { data: rows[0] ?? null, error: result.error };
    };
    builder.single = builder.maybeSingle;
    builder.abortSignal = () => builder;
    builder.then = (
      onFulfilled: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => execute().then(onFulfilled, onRejected);
    return builder;
  }

  private rpcQuery(name: string, params: Record<string, unknown>) {
    let executed: ReturnType<CoworkHarnessStore["rpc"]> | null = null;
    const execute = () => {
      executed ??= this.rpc(name, params);
      return executed;
    };
    const builder: Record<string, unknown> = {};
    builder.abortSignal = () => builder;
    builder.then = (
      onFulfilled: (value: Awaited<ReturnType<CoworkHarnessStore["rpc"]>>) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => execute().then(onFulfilled, onRejected);
    return builder;
  }

  private async rpc(name: string, params: Record<string, unknown>) {
    if (name === "save_chat_action_retry_context") {
      if (this.failActionRetryContextSave) {
        return {
          data: null,
          error: { message: "retry context persistence unavailable" },
        };
      }
      const existing = this.tables.chat_action_retry_contexts.find(
        (row) => row.user_message_id === params.p_user_message_id,
      );
      if (existing) {
        const sameContext =
          existing.workspace_id === params.p_workspace_id &&
          existing.chat_id === params.p_chat_id &&
          existing.root_turn_message_id === params.p_root_turn_message_id &&
          existing.effective_instruction === params.p_effective_instruction &&
          JSON.stringify(existing.route) === JSON.stringify(params.p_route) &&
          JSON.stringify(existing.confirmed_target_ids) ===
            JSON.stringify(params.p_confirmed_target_ids ?? []);
        return sameContext
          ? { data: null, error: null }
          : { data: null, error: { message: "retry context cannot be rebound" } };
      }
      const user = this.tables.chat_messages.find(
        (row) =>
          row.id === params.p_user_message_id &&
          row.workspace_id === params.p_workspace_id &&
          row.chat_id === params.p_chat_id &&
          row.role === "user",
      );
      const root = this.tables.chat_messages.find(
        (row) =>
          row.id === params.p_root_turn_message_id &&
          row.workspace_id === params.p_workspace_id &&
          row.chat_id === params.p_chat_id &&
          row.role === "user",
      );
      if (!user || !root) {
        return { data: null, error: { message: "retry context scope mismatch" } };
      }
      this.insert("chat_action_retry_contexts", {
        workspace_id: params.p_workspace_id,
        chat_id: params.p_chat_id,
        user_message_id: params.p_user_message_id,
        root_turn_message_id: params.p_root_turn_message_id,
        effective_instruction: params.p_effective_instruction,
        route: params.p_route,
        confirmed_target_ids: params.p_confirmed_target_ids ?? [],
        cancelled_at:
          this.tables.chat_action_turn_controls.find(
            (row) =>
              row.workspace_id === params.p_workspace_id &&
              row.turn_message_id === params.p_root_turn_message_id,
          )?.cancelled_at ?? null,
      });
      return { data: null, error: null };
    }
    if (name === "cancel_chat_action_turn") {
      if (this.failActionTurnCancelAttempts > 0) {
        this.failActionTurnCancelAttempts -= 1;
        return { data: null, error: { message: "turn cancellation unavailable" } };
      }
      const root = this.tables.chat_messages.find(
        (row) =>
          row.id === params.p_turn_message_id &&
          row.chat_id === params.p_chat_id &&
          row.workspace_id === params.p_workspace_id &&
          row.role === "user",
      );
      if (!root) {
        return { data: null, error: { message: "action turn scope mismatch" } };
      }
      const cancelledAt = this.iso();
      if (
        !this.tables.chat_action_turn_controls.some(
          (row) =>
            row.workspace_id === params.p_workspace_id &&
            row.turn_message_id === params.p_turn_message_id,
        )
      ) {
        this.insert("chat_action_turn_controls", {
          workspace_id: params.p_workspace_id,
          chat_id: params.p_chat_id,
          turn_message_id: params.p_turn_message_id,
          cancelled_at: cancelledAt,
          reason: params.p_reason,
        });
      }
      for (const context of this.tables.chat_action_retry_contexts) {
        if (
          context.workspace_id === params.p_workspace_id &&
          context.chat_id === params.p_chat_id &&
          context.root_turn_message_id === params.p_turn_message_id
        ) {
          context.cancelled_at ??= cancelledAt;
        }
      }
      for (const checkpoint of this.tables.chat_action_checkpoints) {
        if (
          checkpoint.workspace_id === params.p_workspace_id &&
          checkpoint.chat_id === params.p_chat_id &&
          checkpoint.turn_message_id === params.p_turn_message_id &&
          checkpoint.status === "running"
        ) {
          Object.assign(checkpoint, {
            status: "cancelled",
            result: { ok: false, cancelled: true },
            error_code: "turn_cancelled",
            lease_token: null,
          });
        }
      }
      return { data: null, error: null };
    }
    if (name === "reset_uncommitted_chat_action_turn") {
      const cancelled = this.tables.chat_action_turn_controls.some(
        (row) =>
          row.workspace_id === params.p_workspace_id &&
          row.chat_id === params.p_chat_id &&
          row.turn_message_id === params.p_turn_message_id,
      );
      const terminal = this.tables.chat_action_checkpoints.some(
        (row) =>
          row.workspace_id === params.p_workspace_id &&
          row.chat_id === params.p_chat_id &&
          row.turn_message_id === params.p_turn_message_id &&
          (row.status === "committed" || row.status === "failed"),
      );
      if (cancelled || terminal) {
        return { data: null, error: { message: "action turn cannot be reset" } };
      }
      for (
        let index = this.tables.chat_action_checkpoints.length - 1;
        index >= 0;
        index -= 1
      ) {
        const row = this.tables.chat_action_checkpoints[index];
        if (
          row.workspace_id === params.p_workspace_id &&
          row.chat_id === params.p_chat_id &&
          row.turn_message_id === params.p_turn_message_id
        ) {
          this.tables.chat_action_checkpoints.splice(index, 1);
        }
      }
      return { data: null, error: null };
    }
    if (name === "release_chat_action_turn_leases") {
      const cancelled = this.tables.chat_action_turn_controls.some(
        (row) =>
          row.workspace_id === params.p_workspace_id &&
          row.chat_id === params.p_chat_id &&
          row.turn_message_id === params.p_turn_message_id,
      );
      if (cancelled) {
        return {
          data: null,
          error: { message: "cancelled action turn cannot release leases" },
        };
      }
      for (const checkpoint of this.tables.chat_action_checkpoints) {
        if (
          checkpoint.workspace_id === params.p_workspace_id &&
          checkpoint.chat_id === params.p_chat_id &&
          checkpoint.turn_message_id === params.p_turn_message_id &&
          checkpoint.status === "running"
        ) {
          checkpoint.lease_released = true;
        }
      }
      return { data: null, error: null };
    }
    if (name === "claim_chat_action_checkpoint") {
      const existing = this.tables.chat_action_checkpoints.find(
        (row) =>
          row.workspace_id === params.p_workspace_id &&
          row.operation_key === params.p_operation_key,
      );
      if (existing) {
        const sameSemantics =
          existing.chat_id === params.p_chat_id &&
          existing.turn_message_id === params.p_turn_message_id &&
          existing.action_type === params.p_action_type &&
          existing.target_id === params.p_target_id &&
          JSON.stringify(existing.arguments) === JSON.stringify(params.p_arguments);
        if (!sameSemantics) {
          return {
            data: null,
            error: { message: "operation key semantic mismatch" },
          };
        }
        const cancelled = this.tables.chat_action_turn_controls.some(
          (row) =>
            row.workspace_id === params.p_workspace_id &&
            row.chat_id === params.p_chat_id &&
            row.turn_message_id === params.p_turn_message_id,
        );
        if (cancelled && existing.status === "running") {
          Object.assign(existing, {
            status: "cancelled",
            result: { ok: false, cancelled: true },
            error_code: "turn_cancelled",
            lease_token: null,
          });
        }
        if (existing.status === "running" && existing.lease_released === true) {
          Object.assign(existing, {
            lease_token: "00000000-0000-4000-8000-000000000902",
            lease_released: false,
          });
          return { data: { ...existing, owned: true }, error: null };
        }
        return {
          data: { ...existing, owned: false, lease_token: null },
          error: null,
        };
      }
      const cancelled = this.tables.chat_action_turn_controls.some(
        (row) =>
          row.workspace_id === params.p_workspace_id &&
          row.chat_id === params.p_chat_id &&
          row.turn_message_id === params.p_turn_message_id,
      );
      const checkpoint = this.insert("chat_action_checkpoints", {
        workspace_id: params.p_workspace_id,
        chat_id: params.p_chat_id,
        turn_message_id: params.p_turn_message_id,
        operation_key: params.p_operation_key,
        action_type: params.p_action_type,
        target_id: params.p_target_id,
        arguments: params.p_arguments,
        status: cancelled ? "cancelled" : "running",
        result: cancelled ? { ok: false, cancelled: true } : null,
        error_code: cancelled ? "turn_cancelled" : null,
        lease_token: cancelled
          ? null
          : "00000000-0000-4000-8000-000000000901",
      });
      return {
        data: { ...checkpoint, owned: !cancelled },
        error: null,
      };
    }
    if (name === "finish_chat_action_checkpoint") {
      const checkpoint = this.tables.chat_action_checkpoints.find(
        (row) =>
          row.workspace_id === params.p_workspace_id &&
          row.operation_key === params.p_operation_key,
      );
      if (!checkpoint) {
        return { data: null, error: { message: "checkpoint missing" } };
      }
      if (checkpoint.status === "running") {
        if (checkpoint.lease_token !== params.p_lease_token) {
          return { data: null, error: { message: "checkpoint lease mismatch" } };
        }
        Object.assign(checkpoint, {
          status: params.p_status,
          result: params.p_result,
          error_code: params.p_error_code ?? null,
          lease_token: null,
        });
      }
      return { data: checkpoint, error: null };
    }
    if (name === "execute_chat_action_checkpoint") {
      const checkpoint = this.tables.chat_action_checkpoints.find(
        (row) =>
          row.workspace_id === params.p_workspace_id &&
          row.operation_key === params.p_operation_key,
      );
      if (!checkpoint) {
        return { data: null, error: { message: "checkpoint missing" } };
      }
      if (checkpoint.status !== "running") {
        return { data: checkpoint, error: null };
      }
      const cancelled = this.tables.chat_action_turn_controls.some(
        (row) =>
          row.workspace_id === params.p_workspace_id &&
          row.chat_id === checkpoint.chat_id &&
          row.turn_message_id === checkpoint.turn_message_id,
      );
      if (cancelled) {
        Object.assign(checkpoint, {
          status: "cancelled",
          result: { ok: false, cancelled: true },
          error_code: "turn_cancelled",
          lease_token: null,
        });
        return { data: checkpoint, error: null };
      }
      if (checkpoint.lease_token !== params.p_lease_token) {
        return { data: null, error: { message: "checkpoint lease mismatch" } };
      }
      const draft = this.tables.chat_artifacts.find(
        (row) =>
          row.id === checkpoint.target_id &&
          row.workspace_id === params.p_workspace_id,
      );
      if (!draft) {
        Object.assign(checkpoint, {
          status: "failed",
          result: { ok: false, error: "not_found" },
          error_code: "not_found",
          lease_token: null,
        });
        return { data: checkpoint, error: null };
      }
      if (
        draft.schedule_status === "publishing" ||
        draft.schedule_status === "published"
      ) {
        Object.assign(checkpoint, {
          status: "failed",
          result: { ok: false, error: "locked" },
          error_code: "locked",
          lease_token: null,
        });
        return { data: checkpoint, error: null };
      }
      const checkpointArguments = checkpoint.arguments as Record<
        string,
        unknown
      >;
      const nextValue =
        checkpoint.action_type === "move_on_board"
          ? checkpointArguments.status
          : checkpointArguments.date ?? null;
      const currentValue =
        checkpoint.action_type === "move_on_board"
          ? draft.status
          : draft.plan_to_post_on ?? null;
      if (currentValue !== nextValue) {
        if (checkpoint.action_type === "move_on_board") {
          draft.status = nextValue;
        } else {
          draft.plan_to_post_on = nextValue;
        }
        draft.lifecycle_version = Number(draft.lifecycle_version ?? 0) + 1;
      }
      Object.assign(checkpoint, {
        status: "committed",
        result: {
          ok: true,
          draft: {
            id: draft.id,
            title: draft.title,
            kind: draft.kind,
            status: draft.status,
            plan_to_post_on: draft.plan_to_post_on ?? null,
            created_at: draft.created_at,
          },
        },
        error_code: null,
        lease_token: null,
      });
      this.onActionCheckpointExecuted?.();
      return { data: checkpoint, error: null };
    }
    if (name !== "persist_chat_assistant_turn") {
      throw new Error(`Cowork harness has no RPC adapter for ${name}`);
    }
    const assistant = this.insert("chat_messages", {
      chat_id: params.p_chat_id,
      workspace_id: params.p_workspace_id,
      role: "assistant",
      content: params.p_content ?? "",
      tool_calls: params.p_tool_calls ?? null,
      tool_call_id: null,
      artifacts: params.p_artifacts ?? null,
      input_tokens: params.p_input_tokens ?? null,
      output_tokens: params.p_output_tokens ?? null,
      terminal_reason: params.p_terminal_reason ?? null,
      content_format: params.p_content_format ?? null,
      recoverable_error: params.p_recoverable_error ?? null,
      turn_usage: params.p_turn_usage ?? null,
    });
    const toolMessages = Array.isArray(params.p_tool_messages)
      ? params.p_tool_messages
      : [];
    for (const message of toolMessages as Array<{
      content?: unknown;
      tool_call_id?: unknown;
    }>) {
      this.insert("chat_messages", {
        chat_id: params.p_chat_id,
        workspace_id: params.p_workspace_id,
        role: "tool",
        content: typeof message.content === "string" ? message.content : "",
        tool_calls: null,
        tool_call_id:
          typeof message.tool_call_id === "string"
            ? message.tool_call_id
            : null,
        artifacts: null,
        input_tokens: null,
        output_tokens: null,
      });
    }
    return { data: assistant.id, error: null };
  }
}

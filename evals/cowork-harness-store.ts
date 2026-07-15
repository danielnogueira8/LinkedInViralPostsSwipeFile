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
  input_tokens: number | null;
  output_tokens: number | null;
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
  | "chat_artifacts"
  | "chat_messages"
  | "chat_modeling_sources"
  | "content_feedback"
  | "content_preferences"
  | "creator_style_profiles"
  | "saved_posts"
  | "usage_events"
  | "voice_profiles";

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "is"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] };

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
  private readonly clockMs = Date.parse("2026-07-14T12:00:00.000Z");
  private readonly tables: Record<TableName, Row[]> = {
    chats: [],
    chat_artifacts: [],
    chat_messages: [],
    chat_modeling_sources: [],
    content_feedback: [],
    content_preferences: [],
    creator_style_profiles: [],
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
      created_at: this.iso(),
      updated_at: this.iso(),
    });
  }

  readonly client = {
    from: (table: string) => this.query(table as TableName),
    rpc: (name: string, params: Record<string, unknown>) =>
      this.rpc(name, params),
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

  seedDraft(draft: {
    id: string;
    title: string;
    body: string;
    status?: "idea" | "drafting" | "ready";
  }): void {
    this.insert("chat_artifacts", {
      id: draft.id,
      workspace_id: this.workspaceId,
      chat_id: this.chatId,
      title: draft.title,
      body: draft.body,
      meta: null,
      kind: "post",
      status: draft.status ?? "drafting",
      plan_to_post_on: null,
      media_attachments: [],
      scheduled_at: null,
      schedule_status: null,
      first_comment: null,
      published_at: null,
      publish_error: null,
      lifecycle_version: 0,
    });
  }

  seedVoiceProfile(): void {
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

  draft(id: string): Row | null {
    return this.tables.chat_artifacts.find((row) => row.id === id) ?? null;
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
    let executed: Promise<{ data: unknown; error: null }> | null = null;

    const filteredRows = () => {
      let rows = this.tables[table].filter((row) =>
        filters.every((filter) => {
          if (filter.kind === "eq") return row[filter.column] === filter.value;
          if (filter.kind === "is") {
            return filter.value === null
              ? row[filter.column] == null
              : row[filter.column] === filter.value;
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
      if (limit !== null) rows = rows.slice(0, limit);
      return rows;
    };

    const execute = async () => {
      if (!executed) {
        executed = Promise.resolve().then(() => {
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
            const rows = filteredRows();
            for (const row of rows) Object.assign(row, mutation.value);
            return { data: rows, error: null };
          }
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
      return { data: rows[0] ?? null, error: null };
    };
    builder.single = builder.maybeSingle;
    builder.abortSignal = () => builder;
    builder.then = (
      onFulfilled: (value: { data: unknown; error: null }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => execute().then(onFulfilled, onRejected);
    return builder;
  }

  private async rpc(name: string, params: Record<string, unknown>) {
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

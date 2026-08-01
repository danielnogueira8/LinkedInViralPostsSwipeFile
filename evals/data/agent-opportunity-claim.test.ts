import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  updateAgentOpportunityReadState,
  updateManagedOpportunityStatus,
} from "@/lib/agent-loop/opportunity-claim";
import { getOrCreateAgentSystemChat } from "@/lib/agent-loop/system-chat";

const actSource = readFileSync("lib/agent-loop/act.ts", "utf8");
const systemChatSource = readFileSync("lib/agent-loop/system-chat.ts", "utf8");
const routeSource = readFileSync(
  "app/api/agent/opportunities/[id]/route.ts",
  "utf8",
);
const migrationSource = readFileSync(
  "db/migration-167-agent-opportunity-claim.sql",
  "utf8",
);

function fakeClient(result: { data: unknown; error: null | Error }) {
  const calls: { filters: Array<[string, unknown]>; values: unknown } = {
    filters: [],
    values: null,
  };
  const query = {
    from: () => query,
    update: (values: unknown) => {
      calls.values = values;
      return query;
    },
    eq: (column: string, value: unknown) => {
      calls.filters.push([column, value]);
      return query;
    },
    select: () => query,
    maybeSingle: async () => result,
  };
  return {
    client: query as unknown as SupabaseClient,
    calls,
  };
}

function statefulOpportunityClient() {
  let status = "proposed";
  const db = {
    from: () => {
      let values: Record<string, unknown> = {};
      let expectedStatus = "";
      const query = {
        update: (nextValues: Record<string, unknown>) => {
          values = nextValues;
          return query;
        },
        eq: (column: string, value: unknown) => {
          if (column === "status") expectedStatus = String(value);
          return query;
        },
        select: () => query,
        maybeSingle: async () => {
          if (status !== expectedStatus) return { data: null, error: null };
          status = String(values.status);
          return { data: { id: "opp-1" }, error: null };
        },
      };
      return query;
    },
  };
  return { client: db as unknown as SupabaseClient, status: () => status };
}

function statefulChatClient() {
  let chatId: string | null = null;
  let insertAttempts = 0;
  const db = {
    from: () => {
      let operation: "select" | "insert" = "select";
      const query = {
        select: () => query,
        eq: () => query,
        is: () => query,
        insert: () => {
          operation = "insert";
          return query;
        },
        maybeSingle: async () => {
          if (operation === "select") {
            return { data: chatId ? { id: chatId } : null, error: null };
          }
          insertAttempts += 1;
          if (chatId) {
            return {
              data: null,
              error: Object.assign(new Error("duplicate"), { code: "23505" }),
            };
          }
          chatId = "chat-1";
          return { data: { id: chatId }, error: null };
        },
      };
      return query;
    },
  };
  return {
    client: db as unknown as SupabaseClient,
    chatId: () => chatId,
    insertAttempts: () => insertAttempts,
  };
}

describe("agent opportunity claims", () => {
  test("claims only a still-proposed opportunity", async () => {
    const { client, calls } = fakeClient({ data: { id: "opp-1" }, error: null });

    await expect(
      updateManagedOpportunityStatus(
        client,
        "workspace-1",
        "opp-1",
        "proposed",
        { status: "drafting" },
      ),
    ).resolves.toBe(true);
    expect(calls.values).toEqual({ status: "drafting" });
    expect(calls.filters).toEqual([
      ["id", "opp-1"],
      ["workspace_id", "workspace-1"],
      ["status", "proposed"],
    ]);
  });

  test("reports a lost claim without pretending the draft started", async () => {
    const { client } = fakeClient({ data: null, error: null });

    await expect(
      updateManagedOpportunityStatus(
        client,
        "workspace-1",
        "opp-1",
        "proposed",
        { status: "drafting" },
      ),
    ).resolves.toBe(false);
  });

  test("updates Trend Radar message state through the shared opportunity seam", async () => {
    const { client, calls } = fakeClient({ data: { id: "opp-1" }, error: null });

    await expect(
      updateAgentOpportunityReadState(client, "workspace-1", "opp-1", true),
    ).resolves.toBe(true);
    expect(calls.values).toEqual({ read_at: expect.any(String) });
    expect(calls.filters).toEqual([
      ["id", "opp-1"],
      ["workspace_id", "workspace-1"],
      ["kind", "trend"],
      ["status", "proposed"],
    ]);
  });

  test("concurrent claims have one winner and one loser", async () => {
    const state = statefulOpportunityClient();
    const results = await Promise.all([
      updateManagedOpportunityStatus(
        state.client,
        "workspace-1",
        "opp-1",
        "proposed",
        { status: "drafting" },
      ),
      updateManagedOpportunityStatus(
        state.client,
        "workspace-1",
        "opp-1",
        "proposed",
        { status: "drafting" },
      ),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(state.status()).toBe("drafting");
  });

  test("concurrent system-chat creation converges on one active chat", async () => {
    const state = statefulChatClient();
    const chats = await Promise.all([
      getOrCreateAgentSystemChat(state.client, "workspace-1"),
      getOrCreateAgentSystemChat(state.client, "workspace-1"),
    ]);

    expect(chats).toEqual(["chat-1", "chat-1"]);
    expect(state.chatId()).toBe("chat-1");
    expect(state.insertAttempts()).toBe(2);
  });

  test("the actor and route handle a concurrent loser as an already-handled action", () => {
    expect(actSource).toContain('reason: "already_handled"');
    expect(actSource).toContain('"proposed"');
    expect(routeSource).toContain('result.reason === "already_handled"');
    expect(routeSource).toContain('{ status: 409 }');
  });

  test("the system chat has one active row per workspace", () => {
    expect(migrationSource).toContain("chats_agent_system_live_idx");
    expect(migrationSource).toContain("title = 'Your agent'");
    expect(migrationSource).toContain("archived_at is null");
    expect(systemChatSource).toContain('createError?.code !== "23505"');
    expect(systemChatSource).toContain("getOrCreateAgentSystemChat");
    expect(migrationSource).toContain("app_deployment_readiness_base");
    expect(migrationSource).toContain(
      "((title=''youragent''::text)and(archived_atisnull))",
    );
    expect(migrationSource).toContain("opc.opcname");
  });
});

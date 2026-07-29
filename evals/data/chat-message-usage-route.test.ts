import { describe, expect, test, vi } from "vitest";

const TURN_USAGE = {
  total_credits: 3,
  total_cost_usd: 0.014,
  stages: [
    {
      kind: "writing",
      credits: 3,
      cost_usd: 0.014,
      models: ["internal/provider-model"],
    },
  ],
};

const rows = [
  {
    id: "assistant-usage",
    role: "assistant",
    content: "Your post is ready.",
    content_format: "plain",
    tool_calls: null,
    tool_call_id: null,
    artifacts: null,
    created_at: "2026-07-29T15:00:00.000Z",
    client_turn_id: null,
    transport_recovery_requested_at: null,
    user_stop_requested_at: null,
    terminal_reason: "done",
    model_source_id: null,
    turn_usage: TURN_USAGE,
  },
];

function project<T extends Record<string, unknown>>(
  source: T[],
  selection: string,
): Partial<T>[] {
  const fields = new Set(selection.split(",").map((field) => field.trim()));
  return source.map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(([field]) => fields.has(field)),
    ) as Partial<T>,
  );
}

const fakeRaw = {
  from(table: string) {
    if (table === "chats") {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is"]) {
        builder[method] = () => builder;
      }
      builder.maybeSingle = async () => ({
        data: {
          id: "chat-usage",
          title: "Usage",
          created_at: "2026-07-29T14:00:00.000Z",
          updated_at: "2026-07-29T15:00:00.000Z",
          turn_started_at: null,
          live_plan: null,
        },
        error: null,
      });
      return builder;
    }

    let selection = "";
    const builder: Record<string, unknown> = {};
    builder.select = (columns: string) => {
      selection = columns;
      return builder;
    };
    for (const method of ["eq", "order"]) {
      builder[method] = () => builder;
    }
    builder.then = (
      resolve: (result: { data: unknown[]; error: null }) => unknown,
    ) => resolve({ data: project(rows, selection), error: null });
    return builder;
  },
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-usage",
    raw: fakeRaw,
  }),
}));
vi.mock("@/lib/model-source-attachments", () => ({
  rehydrateModelSourceAttachments: async (messages: unknown[]) => messages,
}));
vi.mock("@/lib/cite-resolve", () => ({
  rehydrateCites: async (messages: unknown[]) => messages,
}));
vi.mock("@/lib/draft-lifecycle-rehydrate", () => ({
  rehydrateDraftLifecycle: async (messages: unknown[]) => messages,
}));

const { GET } = await import("@/app/api/chats/[id]/route");

describe("GET /api/chats/:id message usage", () => {
  test("returns the credits persisted on each generated assistant message", async () => {
    const response = await GET(
      new Request("http://test.local/api/chats/chat-usage"),
      { params: Promise.resolve({ id: "chat-usage" }) },
    );
    const payload = (await response.json()) as {
      ok: boolean;
      messages: Array<{ id: string; turn_usage?: unknown }>;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.messages).toEqual([
      expect.objectContaining({
        id: "assistant-usage",
        turn_usage: TURN_USAGE,
      }),
    ]);
  });
});

import { expect, test, vi } from "vitest";

const OLD_TURN_STARTED_AT = "2026-07-11T10:00:00.000Z";
const REPLACEMENT_TURN_STARTED_AT = "2026-07-11T10:00:01.000Z";

type ChatRow = {
  id: string;
  workspace_id: string;
  archived_at: string | null;
  turn_started_at: string;
  cancel_requested_at: string | null;
};

const chat: ChatRow = {
  id: "chat-1",
  workspace_id: "workspace-1",
  archived_at: null,
  turn_started_at: OLD_TURN_STARTED_AT,
  cancel_requested_at: null,
};

let writeReached!: () => void;
let allowWrite!: () => void;
const writeIsPending = new Promise<void>((resolve) => {
  writeReached = resolve;
});
const writeMayFinish = new Promise<void>((resolve) => {
  allowWrite = resolve;
});

const raw = {
  from(table: string) {
    if (table !== "chats") throw new Error(`Unexpected table: ${table}`);

    let patch: Partial<ChatRow> = {};
    const filters: Array<[keyof ChatRow, unknown]> = [];
    const query = {
      update(value: Partial<ChatRow>) {
        patch = value;
        return query;
      },
      eq(column: keyof ChatRow, value: unknown) {
        filters.push([column, value]);
        return query;
      },
      is(column: keyof ChatRow, value: unknown) {
        filters.push([column, value]);
        return query;
      },
      select() {
        return query;
      },
      async maybeSingle() {
        writeReached();
        await writeMayFinish;

        const stillOwnedByRequest = filters.every(
          ([column, expected]) => chat[column] === expected,
        );
        if (!stillOwnedByRequest) return { data: null, error: null };

        Object.assign(chat, patch);
        return { data: { id: chat.id }, error: null };
      },
    };
    return query;
  },
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "workspace-1", raw }),
}));

const { POST } = await import("@/app/api/chats/[id]/stop/route");

test("a delayed stop request cannot cancel the replacement turn", async () => {
  const oldStop = POST(
    new Request("http://test/api/chats/chat-1/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnStartedAt: OLD_TURN_STARTED_AT }),
    }),
    { params: Promise.resolve({ id: chat.id }) },
  );

  await writeIsPending;
  chat.turn_started_at = REPLACEMENT_TURN_STARTED_AT;
  allowWrite();
  await oldStop;

  expect(chat).toMatchObject({
    turn_started_at: REPLACEMENT_TURN_STARTED_AT,
    cancel_requested_at: null,
  });
});

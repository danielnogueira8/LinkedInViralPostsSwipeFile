import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelSourceAttachment } from "@/lib/model-source-attachments";

type Row = Record<string, unknown>;
type MessageInput = {
  id: string;
  role: string;
  model_source_id?: string;
  model_source_attachment?: ModelSourceAttachment;
};

const state = {
  rows: new Map<string, Row[]>(),
  filters: [] as Array<{ table: string; method: string; column: string; value: unknown }>,
};

function query(table: string) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      state.filters.push({ table, method: "eq", column, value });
      return chain;
    },
    in: (column: string, value: unknown) => {
      state.filters.push({ table, method: "in", column, value });
      return chain;
    },
    then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
      Promise.resolve({ data: state.rows.get(table) ?? [], error: null }).then(resolve),
  };
  return chain;
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({ from: (table: string) => query(table) }),
}));
vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIds: async () => ["account-a"],
}));

const { rehydrateModelSourceAttachments } =
  await import("@/lib/model-source-attachments");

beforeEach(() => {
  state.rows.clear();
  state.filters = [];
});

describe("rehydrateModelSourceAttachments", () => {
  test("restores a Swipefile source only on its owning user message", async () => {
    state.rows.set("chat_modeling_sources", [{
      id: "source-a", source: "swipe", source_post_id: "post-a", post_text: "stashed", author_name: "Old name", author_avatar: null, partial: false, post_type: "regular",
    }]);
    state.rows.set("posts", [{
      id: "post-a", text: "Current source post", post_type: "regular", accounts: { name: "Ada", profile_pic_url: "https://image.test/ada.jpg" },
    }]);

    const messages = await rehydrateModelSourceAttachments<MessageInput>([
      { id: "u1", role: "user", model_source_id: "source-a" },
      { id: "a1", role: "assistant", model_source_id: "source-a" },
      { id: "u2", role: "user" },
    ], "workspace-a");

    expect(messages[0].model_source_attachment).toMatchObject({
      kind: "swipe", state: "available", authorName: "Ada", postText: "Current source post",
    });
    expect(messages[1].model_source_attachment).toBeUndefined();
    expect(messages[2].model_source_attachment).toBeUndefined();
    expect(state.filters).toContainEqual({ table: "chat_modeling_sources", method: "eq", column: "workspace_id", value: "workspace-a" });
    expect(state.filters).toContainEqual({ table: "posts", method: "in", column: "account_id", value: ["account-a"] });
  });

  test("restores a Bookmark source and reports an unavailable original safely", async () => {
    state.rows.set("chat_modeling_sources", [
      { id: "bookmark-a", source: "bookmark", source_post_id: "saved-a", post_text: "stashed", author_name: "Old name", author_avatar: null, partial: false, post_type: "regular" },
      { id: "bookmark-gone", source: "bookmark", source_post_id: "saved-gone", post_text: "stashed", author_name: "Old name", author_avatar: null, partial: false, post_type: "regular" },
    ]);
    state.rows.set("saved_posts", [{
      id: "saved-a", text: null, text_snippet: "Bookmark preview", author_name: "Bea", profile_pic_url: null, post_type: "lead_magnet",
    }]);

    const messages = await rehydrateModelSourceAttachments<MessageInput>([
      { id: "u1", role: "user", model_source_id: "bookmark-a" },
      { id: "u2", role: "user", model_source_id: "bookmark-gone" },
    ], "workspace-a");

    expect(messages[0].model_source_attachment).toMatchObject({
      kind: "bookmark", state: "available", authorName: "Bea", postText: "Bookmark preview", postType: "lead_magnet",
    });
    expect(messages[1].model_source_attachment).toMatchObject({ state: "unavailable" });
    expect(state.filters).toContainEqual({ table: "saved_posts", method: "eq", column: "workspace_id", value: "workspace-a" });
  });

  test("renders a safe unavailable attachment when a historical source row was pruned", async () => {
    const [message] = await rehydrateModelSourceAttachments<MessageInput>([
      { id: "u1", role: "user", model_source_id: "pruned-source" },
    ], "workspace-a");

    expect(message.model_source_attachment).toMatchObject({
      id: "pruned-source",
      state: "unavailable",
    });
  });
});

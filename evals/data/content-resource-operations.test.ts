import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getSkillsByIds,
  getTemplateResource,
  listPreferenceResources,
  saveBookmarkResource,
  summarizeBookmarkResource,
} from "@/lib/content-resource-operations";

type Call = { method: string; args: unknown[] };

function queuedDb(results: unknown[]) {
  const calls: Call[] = [];
  const next = () => results.shift();
  const builder: Record<string, unknown> = {};
  for (const method of [
    "from",
    "select",
    "eq",
    "in",
    "order",
    "limit",
    "range",
    "insert",
  ]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.maybeSingle = () => Promise.resolve(next());
  builder.single = () => Promise.resolve(next());
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(next()).then(resolve, reject);
  return { db: builder as unknown as SupabaseClient, calls };
}

const bookmark = {
  id: "bookmark-1",
  workspace_id: "workspace-1",
  activity_id: "activity-1",
  post_url: "https://www.linkedin.com/feed/update/urn:li:activity:activity-1",
  embed_urn: null,
  author_name: null,
  author_handle: null,
  text_snippet: null,
  text: null,
  profile_pic_url: null,
  media_type: "none",
  media_urls: [],
  video_url: null,
  reactions: null,
  comments: null,
  note: null,
  category_id: null,
  post_type: "regular",
  posted_at: null,
  saved_at: "2026-07-22T00:00:00.000Z",
  created_by_user_id: null,
};

describe("content resource read operations", () => {
  it("scopes selected skill reads to the workspace and requested ids", async () => {
    const { db, calls } = queuedDb([{ data: [], error: null }]);

    await getSkillsByIds({
      db,
      workspaceId: "workspace-1",
      ids: ["skill-1", "skill-2"],
    });

    expect(calls).toContainEqual({
      method: "eq",
      args: ["workspace_id", "workspace-1"],
    });
    expect(calls).toContainEqual({
      method: "in",
      args: ["id", ["skill-1", "skill-2"]],
    });
  });

  it("bounds and orders preference reads for prompt injection", async () => {
    const { db, calls } = queuedDb([{ data: [], error: null }]);

    await listPreferenceResources({
      db,
      workspaceId: "workspace-1",
      limit: 20,
    });

    expect(calls).toContainEqual({
      method: "order",
      args: ["created_at", { ascending: false }],
    });
    expect(calls).toContainEqual({ method: "limit", args: [20] });
  });

  it("does not send a non-UUID built-in-shaped template id to Postgres", async () => {
    const { db, calls } = queuedDb([]);

    await expect(
      getTemplateResource({
        db,
        workspaceId: "workspace-1",
        id: "builtin:not-real",
      }),
    ).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("bookmark resource persistence", () => {
  it("keeps the public bookmark representation narrow", () => {
    expect(Object.keys(summarizeBookmarkResource(bookmark)).sort()).toEqual([
      "activity_id",
      "author_handle",
      "author_name",
      "category_id",
      "embed_urn",
      "id",
      "note",
      "post_url",
      "saved_at",
      "text_snippet",
    ]);
  });

  it("returns an existing workspace bookmark without inserting", async () => {
    const { db, calls } = queuedDb([{ data: bookmark, error: null }]);

    const result = await saveBookmarkResource({
      db,
      workspaceId: "workspace-1",
      activityId: "activity-1",
      values: { post_url: bookmark.post_url },
    });

    expect(result).toEqual({ saved: bookmark, existed: true });
    expect(calls.some((call) => call.method === "insert")).toBe(false);
    expect(calls).toContainEqual({
      method: "eq",
      args: ["workspace_id", "workspace-1"],
    });
  });

  it("recovers a concurrent unique conflict as an idempotent save", async () => {
    const { db, calls } = queuedDb([
      { data: null, error: { code: "23505", message: "duplicate" } },
      { data: bookmark, error: null },
    ]);

    const result = await saveBookmarkResource({
      db,
      workspaceId: "workspace-1",
      activityId: "activity-1",
      knownAbsent: true,
      values: { post_url: bookmark.post_url },
    });

    expect(result).toEqual({ saved: bookmark, existed: true });
    expect(calls.filter((call) => call.method === "from")).toHaveLength(2);
    expect(calls).toContainEqual({
      method: "insert",
      args: [
        {
          post_url: bookmark.post_url,
          workspace_id: "workspace-1",
          activity_id: "activity-1",
        },
      ],
    });
  });
});

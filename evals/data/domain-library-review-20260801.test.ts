import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFakeSupabase, type FakeDb } from "./fake-supabase";
import {
  DraftLifecycle,
  type DraftLifecycleRepository,
  type DraftRecord,
} from "@/lib/draft-lifecycle";

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => dbRef.current.client }));

const { postsNeedingEmbedding } = await import("@/lib/post-embeddings");

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: "draft-1",
    title: "A practical post",
    body: "A practical post about a useful habit.",
    meta: null,
    kind: "post",
    status: "ready",
    planToPostOn: null,
    chatId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    mediaAttachments: [],
    scheduledAt: null,
    scheduleStatus: null,
    firstComment: null,
    publishedAt: null,
    publishError: null,
    lifecycleVersion: 0,
    ...overrides,
  };
}

function memoryLifecycle(initial: DraftRecord = draft()): {
  lifecycle: DraftLifecycle;
  getDraft: () => DraftRecord;
} {
  let current = initial;
  const repository = {
    workspaceId: "workspace-1",
    find: async (id: string) => (id === current.id ? current : null),
    mutate: async (
      id: string,
      patch: Partial<DraftRecord>,
      expectedVersion: number,
    ) => {
      if (id !== current.id || current.lifecycleVersion !== expectedVersion) {
        return "stale" as const;
      }
      current = {
        ...current,
        ...patch,
        lifecycleVersion: expectedVersion + 1,
      };
      return current;
    },
  } as unknown as DraftLifecycleRepository;

  return {
    lifecycle: new DraftLifecycle(repository),
    getDraft: () => current,
  };
}

beforeEach(() => {
  dbRef.current = makeFakeSupabase({
    post_embeddings: { rows: [] },
    posts: { rows: [{ id: "post-1", text: "A real post body." }] },
  });
});

describe("non-agent domain library regression boundaries", () => {
  test("a non-positive embedding limit returns no work without scanning", async () => {
    await expect(postsNeedingEmbedding(0)).resolves.toEqual([]);
    expect(dbRef.current.queries).toHaveLength(0);
  });

  test("attaching a giveaway to an existing post keeps its kind consistent", async () => {
    const { lifecycle, getDraft } = memoryLifecycle();
    const outcome = await lifecycle.mutate("draft-1", {
      kind: "post",
      leadMagnet: {
        id: "magnet-1",
        title: "The practical playbook",
        selection: "manual",
        public_slug: "practical-playbook",
      },
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(getDraft().kind).toBe("lead_magnet");
  });
});

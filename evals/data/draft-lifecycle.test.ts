import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import {
  DraftLifecycle,
  type DraftLifecycleRepository,
  type DraftRecord,
} from "@/lib/draft-lifecycle";

const future = "2099-12-31T12:00:00.000Z";

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: "draft-1",
    title: "Opening line",
    body: "Opening line\n\nThe rest of the post.",
    meta: null,
    kind: "post",
    status: "ready",
    planToPostOn: null,
    chatId: null,
    createdAt: "2026-07-13T00:00:00.000Z",
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

class MemoryRepository implements DraftLifecycleRepository {
  readonly workspaceId = "ws-1";
  readonly rows = new Map<string, DraftRecord>();
  activeChats = new Set(["chat-1"]);
  lastSchedule: { id: string; scheduledAt: string; planToPostOn: string; lifecycleVersion: number } | null = null;

  async list() {
    return [...this.rows.values()];
  }
  async find(id: string) {
    return this.rows.get(id) ?? null;
  }
  async saveChatDraft(
    input: Parameters<DraftLifecycleRepository["saveChatDraft"]>[0],
  ) {
    if (!this.activeChats.has(input.chatId)) {
      return { outcome: "chat_not_found" as const };
    }
    const existing = [...this.rows.values()].find(
      (row) => row.chatId === input.chatId && row.body === input.body,
    );
    if (existing) return { outcome: "deduped" as const, draft: existing };
    const created = await this.create(input);
    return { outcome: "saved" as const, draft: created };
  }
  async create(input: Parameters<DraftLifecycleRepository["create"]>[0]) {
    const row = draft({
      id: `draft-${this.rows.size + 1}`,
      chatId: input.chatId,
      kind: input.kind,
      status: input.status,
      title: input.title,
      body: input.body,
      meta: input.meta,
      mediaAttachments: input.mediaAttachments,
      planToPostOn: input.planToPostOn ?? null,
    });
    this.rows.set(row.id, row);
    return row;
  }
  async mutate(
    id: string,
    patch: Partial<DraftRecord>,
    expectedVersion: number,
  ) {
    const current = this.rows.get(id);
    if (!current) return "stale" as const;
    if (current.lifecycleVersion !== expectedVersion) return "stale" as const;
    const next = {
      ...current,
      ...patch,
      lifecycleVersion: expectedVersion + 1,
    };
    this.rows.set(id, next);
    return next;
  }
  async remove(id: string) {
    const current = this.rows.get(id);
    if (!current) return "not_found" as const;
    if (current.scheduleStatus === "publishing" || current.scheduleStatus === "published") {
      return "conflict" as const;
    }
    this.rows.delete(id);
    return "removed" as const;
  }
  async schedule(
    id: string,
    patch: Parameters<DraftLifecycleRepository["schedule"]>[1],
  ) {
    const current = this.rows.get(id);
    if (!current) return "stale" as const;
    if (current.lifecycleVersion !== patch.expectedVersion) return "stale" as const;
    if (current.scheduleStatus === "publishing" || current.scheduleStatus === "published") {
      return "stale" as const;
    }
    this.lastSchedule = {
      id,
      scheduledAt: patch.scheduledAt,
      planToPostOn: patch.planToPostOn,
      lifecycleVersion: patch.expectedVersion + 1,
    };
    const next = {
      ...current,
      scheduledAt: patch.scheduledAt,
      scheduleStatus: "scheduled" as const,
      firstComment: patch.firstComment,
      planToPostOn: patch.planToPostOn,
    };
    this.rows.set(id, next);
    return next;
  }
  async cancelSchedule(id: string) {
    const current = this.rows.get(id);
    if (!current || current.scheduleStatus !== "scheduled") {
      return "conflict" as const;
    }
    const next = {
      ...current,
      scheduledAt: null,
      scheduleStatus: null,
      firstComment: null,
    };
    this.rows.set(id, next);
    return next;
  }
}

let repository: MemoryRepository;
let lifecycle: DraftLifecycle;

beforeEach(() => {
  repository = new MemoryRepository();
  lifecycle = new DraftLifecycle(repository, {
    canPublish: async () => true,
    now: () => new Date("2026-07-13T00:00:00.000Z").getTime(),
  });
});

describe("DraftLifecycle command outcomes", () => {
  test("creates board and chat drafts through the same tenant-bound module", async () => {
    const board = await lifecycle.create({ body: "A board post" });
    const chat = await lifecycle.saveFromChat({
      chatId: "chat-1",
      body: "A chat post",
      savedBy: "user-1",
    });

    expect(board.status).toBe("drafting");
    expect(chat).toMatchObject({ ok: true, value: { deduped: false } });
    if (chat.ok) expect(chat.value.draft.chatId).toBe("chat-1");
  });

  test("chat save is idempotent per chat and body", async () => {
    await lifecycle.saveFromChat({ chatId: "chat-1", body: "Same post" });
    const second = await lifecycle.saveFromChat({
      chatId: "chat-1",
      body: "Same post",
    });

    expect(second).toMatchObject({ ok: true, value: { deduped: true } });
    expect(repository.rows.size).toBe(1);
  });

  test("rejects mutations and deletion after the publish lock is held", async () => {
    repository.rows.set("draft-1", draft({ scheduleStatus: "publishing" }));

    await expect(lifecycle.mutate("draft-1", { body: "Changed" })).resolves.toMatchObject({
      ok: false,
      reason: "locked",
      status: 409,
    });
    await expect(lifecycle.remove("draft-1")).resolves.toMatchObject({
      ok: false,
      reason: "locked",
      status: 409,
    });
  });

  test("review drafts can only be approved or rejected", async () => {
    repository.rows.set("draft-1", draft({ status: "pending_review" }));
    await expect(
      lifecycle.mutate("draft-1", { status: "posted" }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_transition",
      status: 409,
    });
    await expect(
      lifecycle.mutate("draft-1", { planToPostOn: "2099-12-31" }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_transition" });
    await expect(
      lifecycle.mutate("draft-1", { status: "ready" }),
    ).resolves.toMatchObject({ ok: true, value: { status: "ready" } });

    repository.rows.set("draft-2", draft({ id: "draft-2", status: "ready" }));
    await expect(
      lifecycle.mutate("draft-2", { status: "pending_review" }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_transition" });
  });

  test("a schedule CAS miss is reported as a stale write", async () => {
    repository.rows.set("draft-1", draft());
    repository.schedule = async () => "stale";

    await expect(
      lifecycle.schedule("draft-1", { scheduledAt: future }),
    ).resolves.toMatchObject({ ok: false, reason: "stale_write", status: 409 });
  });

  test("a mutation CAS miss never overwrites a newer lifecycle version", async () => {
    repository.rows.set("draft-1", draft({ lifecycleVersion: 2 }));
    const originalMutate = repository.mutate.bind(repository);
    repository.mutate = async (id, patch, expectedVersion) => {
      const current = repository.rows.get(id)!;
      repository.rows.set(id, {
        ...current,
        lifecycleVersion: current.lifecycleVersion + 1,
      });
      return originalMutate(id, patch, expectedVersion);
    };

    await expect(
      lifecycle.mutate("draft-1", { body: "Stale edit" }),
    ).resolves.toMatchObject({ ok: false, reason: "stale_write", status: 409 });
    expect(repository.rows.get("draft-1")?.body).not.toBe("Stale edit");
  });

  test("a transient mutation CAS miss replays the command against the newest row", async () => {
    repository.rows.set("draft-1", draft({ lifecycleVersion: 2 }));
    const originalMutate = repository.mutate.bind(repository);
    let attempts = 0;
    repository.mutate = async (id, patch, expectedVersion) => {
      attempts += 1;
      if (attempts === 1) {
        const current = repository.rows.get(id)!;
        repository.rows.set(id, {
          ...current,
          title: "Concurrent title",
          lifecycleVersion: expectedVersion + 1,
        });
        return "stale" as const;
      }
      return originalMutate(id, patch, expectedVersion);
    };

    await expect(
      lifecycle.mutate("draft-1", { status: "drafting" }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        title: "Concurrent title",
        status: "drafting",
        lifecycleVersion: 4,
      },
    });
    expect(attempts).toBe(2);
  });

  test("background enrichment is versioned and limited to pending review", async () => {
    repository.rows.set(
      "draft-1",
      draft({ status: "pending_review", lifecycleVersion: 4 }),
    );
    const enriched = await lifecycle.enrichPendingReview("draft-1", {
      meta: { generated: true },
    });
    expect(enriched).toMatchObject({
      ok: true,
      value: { lifecycleVersion: 5, meta: { generated: true } },
    });

    repository.rows.set("draft-1", draft({ status: "ready" }));
    await expect(
      lifecycle.enrichPendingReview("draft-1", { meta: {} }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_transition" });
  });

  test("preserves manual titles but follows an auto-derived title on body edits", async () => {
    repository.rows.set("draft-1", draft());
    const automatic = await lifecycle.mutate("draft-1", {
      body: "A new opening\n\nNew body",
    });
    expect(automatic.ok && automatic.value.title).toBe("A new opening");

    repository.rows.set("draft-2", draft({ id: "draft-2", title: "Campaign 12" }));
    const manual = await lifecycle.mutate("draft-2", { body: "Another opening" });
    expect(manual.ok && manual.value.title).toBe("Campaign 12");
  });

  test("scheduling returns explicit connection and transition rejections", async () => {
    repository.rows.set("draft-1", draft());
    const disconnected = new DraftLifecycle(repository, {
      canPublish: async () => false,
    });
    await expect(
      disconnected.schedule("draft-1", { scheduledAt: future }),
    ).resolves.toMatchObject({ ok: false, reason: "not_connected", status: 409 });

    repository.rows.set("draft-1", draft({ scheduleStatus: "published" }));
    await expect(
      lifecycle.schedule("draft-1", { scheduledAt: future }),
    ).resolves.toMatchObject({ ok: false, reason: "locked", status: 409 });
  });

  test("scheduling derives the local plan date and cancellation keeps it", async () => {
    repository.rows.set("draft-1", draft());
    const scheduled = await lifecycle.schedule("draft-1", {
      scheduledAt: "2100-01-01T01:00:00.000Z",
      timezone: "America/New_York",
      firstComment: "  link  ",
    });

    expect(scheduled.ok && scheduled.value.planToPostOn).toBe("2099-12-31");
    expect(scheduled.ok && scheduled.value.firstComment).toBe("link");
    const cancelled = await lifecycle.cancelSchedule("draft-1");
    expect(cancelled.ok && cancelled.value.planToPostOn).toBe("2099-12-31");
  });

  test("direct uploads enforce expiry while library media remains schedulable", async () => {
    repository.rows.set(
      "draft-1",
      draft({
        mediaAttachments: [
          {
            id: "upload-1",
            source: "zernio",
            name: "image.png",
            mimeType: "image/png",
            size: 100,
            type: "image",
            url: "https://media.zernio.com/uploads/image.png",
            uploadedAt: "2026-07-13T00:00:00.000Z",
          },
        ],
      }),
    );
    await expect(
      lifecycle.schedule("draft-1", { scheduledAt: future }),
    ).resolves.toMatchObject({ ok: false, reason: "media_expiry" });

    repository.rows.set(
      "draft-1",
      draft({
        mediaAttachments: [
          {
            id: "asset:library-1",
            source: "library",
            assetId: "library-1",
            name: "image.png",
            mimeType: "image/png",
            size: 100,
            type: "image",
            uploadedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    await expect(
      lifecycle.schedule("draft-1", { scheduledAt: future }),
    ).resolves.toMatchObject({ ok: true });
  });

  test("adapters delegate instead of owning chat_artifacts transitions", () => {
    for (const path of [
      "app/api/drafts/route.ts",
      "app/api/drafts/[id]/route.ts",
      "app/api/drafts/[id]/schedule/route.ts",
      "app/api/chats/[id]/artifacts/route.ts",
      "lib/mcp/register.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("DraftLifecycle");
      expect(source).not.toContain('.from("chat_artifacts")');
    }

    const imageJobs = readFileSync("lib/lead-magnet-image-jobs.ts", "utf8");
    expect(imageJobs).toContain("enrichPendingReview");

    const cron = readFileSync(
      "app/api/cron/publish-scheduled/route.ts",
      "utf8",
    );
    expect(cron).toContain('from "@/lib/draft-publishing"');

    const migration = readFileSync(
      "db/migration-086-save-chat-draft.sql",
      "utf8",
    );
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("workspace_id = p_workspace_id");
    expect(migration).toContain("lifecycle_version bigint");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
  });
});

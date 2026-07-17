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
  async createStandalone(
    input: Parameters<DraftLifecycleRepository["createStandalone"]>[0],
  ) {
    const existing = [...this.rows.values()].find(
      (row) => row.chatId === null && row.body === input.body,
    );
    if (existing) return { outcome: "deduped" as const, draft: existing };
    const created = await this.create({ ...input, chatId: null });
    return { outcome: "saved" as const, draft: created };
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

    expect(board.outcome).toBe("saved");
    expect(board.draft.status).toBe("drafting");
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

  test("standalone create (create_draft MCP tool, POST /api/drafts) is idempotent by body — a retried call returns the existing draft, not a duplicate", async () => {
    const first = await lifecycle.create({ body: "Same standalone post" });
    const second = await lifecycle.create({ body: "Same standalone post" });

    expect(first.outcome).toBe("saved");
    expect(second.outcome).toBe("deduped");
    expect(second.draft.id).toBe(first.draft.id);
    expect(repository.rows.size).toBe(1);
  });

  test("standalone create dedup is scoped to chat_id null — a chat-saved draft with the same body doesn't collide", async () => {
    const chat = await lifecycle.saveFromChat({ chatId: "chat-1", body: "Shared text" });
    const board = await lifecycle.create({ body: "Shared text" });

    expect(chat.ok && chat.value.deduped).toBe(false);
    expect(board.outcome).toBe("saved");
    expect(repository.rows.size).toBe(2);
  });

  test("standalone create with genuinely different content is never deduped", async () => {
    const first = await lifecycle.create({ body: "First post" });
    const second = await lifecycle.create({ body: "A totally different post" });

    expect(first.outcome).toBe("saved");
    expect(second.outcome).toBe("saved");
    expect(second.draft.id).not.toBe(first.draft.id);
    expect(repository.rows.size).toBe(2);
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

  // Bug-hunt fix (task #189): a mutation on a still-'scheduled' draft (e.g.
  // the editor's Status dropdown) used to succeed, flipping `status` to
  // 'posted' while schedule_status/scheduled_at stayed untouched — the board
  // then showed "Posted" even though the publish cron (which reads only
  // schedule_status/scheduled_at) would still fire it later at the original
  // time. Now blocked the same way 'publishing'/'published' already were.
  test("rejects a mutation while a draft is still 'scheduled' — must cancel first", async () => {
    repository.rows.set(
      "draft-1",
      draft({ scheduleStatus: "scheduled", scheduledAt: future }),
    );

    await expect(
      lifecycle.mutate("draft-1", { status: "posted" }),
    ).resolves.toMatchObject({ ok: false, reason: "locked", status: 409 });
    // The board status is untouched — no desync between what's shown and
    // what the cron will actually do.
    expect(repository.rows.get("draft-1")?.status).toBe("ready");
    expect(repository.rows.get("draft-1")?.scheduleStatus).toBe("scheduled");

    // Cancelling the schedule first, THEN mutating, is the correct path and
    // still works — this fix only blocks mutating WHILE scheduled.
    await lifecycle.cancelSchedule("draft-1");
    await expect(
      lifecycle.mutate("draft-1", { status: "posted" }),
    ).resolves.toMatchObject({ ok: true });
    expect(repository.rows.get("draft-1")?.status).toBe("posted");
  });

  // remove() is intentionally NOT part of this fix — deleting a scheduled
  // draft is a legitimate, existing action (the whole row disappears, so
  // there's no "desynced label" risk the way a partial mutate() has).
  test("deleting a scheduled draft is still allowed (unaffected by the mutate lock)", async () => {
    repository.rows.set(
      "draft-1",
      draft({ scheduleStatus: "scheduled", scheduledAt: future }),
    );
    await expect(lifecycle.remove("draft-1")).resolves.toMatchObject({ ok: true });
    expect(repository.rows.has("draft-1")).toBe(false);
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

  test("an AI rewrite updates format provenance without discarding existing metadata", async () => {
    repository.rows.set(
      "draft-1",
      draft({ meta: { source: "model_source", source_post_id: "post-1" } }),
    );

    const markdown = await lifecycle.mutate("draft-1", {
      body: "**Rewritten by Luna**",
      contentFormat: "markdown",
    });
    expect(markdown).toMatchObject({
      ok: true,
      value: {
        meta: {
          source: "model_source",
          source_post_id: "post-1",
          markdown: true,
        },
      },
    });

    const plain = await lifecycle.mutate("draft-1", {
      body: "Rewritten by a plain-text model",
      contentFormat: "plain",
    });
    expect(plain).toMatchObject({
      ok: true,
      value: {
        meta: { source: "model_source", source_post_id: "post-1" },
      },
    });
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

  // markdown-model drafts (meta.markdown): the LinkedIn caption is the
  // markdownToLinkedIn form, whose Unicode bold chars are astral (2 UTF-16 code
  // units each). The cap MUST be checked on the CONVERTED length — a body that
  // fits as raw markdown can exceed 3,000 once bolded.
  describe("markdown-draft caption cap", () => {
    // 1,604 raw chars ("**" + 1,600 letters + "**") → under 3,000. Bolded, each
    // letter is astral, so the converted caption is ~3,200 code units → over.
    const rawUnderConvertedOver = `**${"a".repeat(1600)}**`;

    test("rejects when the CONVERTED body exceeds the cap (markdown on)", async () => {
      repository.rows.set(
        "draft-1",
        draft({ body: rawUnderConvertedOver, meta: { markdown: true } }),
      );
      const res = await lifecycle.schedule("draft-1", { scheduledAt: future });
      expect(res).toMatchObject({ ok: false, reason: "linkedin_length", status: 400 });
    });

    test("the SAME body is accepted when markdown is off (raw length is under)", async () => {
      // Proves the rejection above is driven by conversion, not the raw body:
      // without meta.markdown the raw 1,604-char string is measured and passes.
      repository.rows.set("draft-1", draft({ body: rawUnderConvertedOver, meta: null }));
      const res = await lifecycle.schedule("draft-1", { scheduledAt: future });
      expect(res.ok).toBe(true);
    });

    test("a short markdown draft still schedules fine (no false rejection)", async () => {
      repository.rows.set(
        "draft-1",
        draft({ body: "## Hi\n\n**bold** and a point.", meta: { markdown: true } }),
      );
      const res = await lifecycle.schedule("draft-1", { scheduledAt: future });
      expect(res.ok).toBe(true);
    });
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

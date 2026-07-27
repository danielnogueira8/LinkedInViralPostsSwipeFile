import { describe, expect, it, vi } from "vitest";
import { createDraftOperationsClient } from "@/lib/draft-operations-client";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

const draftRow = {
  id: "draft-1",
  title: "Draft",
  body: "Draft body",
  kind: "post",
  status: "drafting",
  plan_to_post_on: null,
  chat_id: null,
  created_at: "2026-08-01T10:00:00.000Z",
};

describe("Draft operations client", () => {
  it("loads one Draft by id through the workspace-scoped endpoint", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ ok: true, draft: draftRow }),
    );
    const client = createDraftOperationsClient(fetcher);

    await expect(client.find("draft-1")).resolves.toMatchObject({
      id: "draft-1",
      body: "Draft body",
    });
    expect(fetcher).toHaveBeenCalledWith("/api/drafts/draft-1", {
      method: "GET",
    });
  });

  it("creates a board Draft through the typed operation path", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ ok: true, deduped: false, draft: draftRow }),
    );
    const client = createDraftOperationsClient(fetcher);

    const created = await client.create({
      body: "Draft body",
      title: "Draft",
      status: "drafting",
    });

    expect(fetcher).toHaveBeenCalledWith("/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Draft body",
        title: "Draft",
        status: "drafting",
      }),
    });
    expect(created).toEqual({ draft: draftRow, deduped: false });
  });

  it("saves a Cowork Artifact as a Draft through the typed operation path", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ ok: true, artifact: { ...draftRow, chat_id: "chat-1" } }),
    );
    const client = createDraftOperationsClient(fetcher);

    const saved = await client.saveFromChat("chat-1", {
      body: "Draft body",
      title: "Draft",
      kind: "post",
    });

    expect(fetcher).toHaveBeenCalledWith("/api/chats/chat-1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Draft body",
        title: "Draft",
        kind: "post",
      }),
    });
    expect(saved.draft).toMatchObject({ id: "draft-1", chat_id: "chat-1" });
  });

  it("updates a Draft through the canonical Draft endpoint", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ ok: true, draft: { ...draftRow, body: "Updated" } }),
    );
    const client = createDraftOperationsClient(fetcher);

    const draft = await client.update("draft-1", {
      body: "Updated",
      content_format: "markdown",
      media_attachments: [
        {
          id: "asset:1",
          source: "library",
          assetId: "1",
          name: "image.png",
          mimeType: "image/png",
          size: 42,
          type: "image",
          uploadedAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    });

    expect(fetcher).toHaveBeenCalledWith("/api/drafts/draft-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Updated",
        content_format: "markdown",
        media_attachments: [
          {
            id: "asset:1",
            source: "library",
            assetId: "1",
            name: "image.png",
            mimeType: "image/png",
            size: 42,
            type: "image",
            uploadedAt: "2026-08-01T10:00:00.000Z",
          },
        ],
      }),
    });
    expect(draft).toMatchObject({ id: "draft-1", body: "Updated" });
  });

  it("normalizes a scheduled Draft from the accepted command", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        ok: true,
        scheduledAt: "2026-08-03T09:30:00.000Z",
        scheduleStatus: "scheduled",
        planToPostOn: "2026-08-03",
        firstComment: "Source link",
      }),
    );
    const client = createDraftOperationsClient(fetcher);

    const scheduled = await client.schedule("draft-1", {
      scheduledAt: "2026-08-03T09:30:00.000Z",
      planToPostOn: "2026-08-03",
      firstComment: "Source link",
    });

    expect(fetcher).toHaveBeenCalledWith("/api/drafts/draft-1/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheduledAt: "2026-08-03T09:30:00.000Z",
        planToPostOn: "2026-08-03",
        firstComment: "Source link",
      }),
    });
    expect(scheduled).toEqual({
      scheduledAt: "2026-08-03T09:30:00.000Z",
      scheduleStatus: "scheduled",
      planToPostOn: "2026-08-03",
      firstComment: "Source link",
    });
  });

  it("adds a Draft to the recurring queue through the typed operation path", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        ok: true,
        scheduledAt: "2026-08-03T09:30:00.000Z",
        scheduleStatus: "scheduled",
        planToPostOn: "2026-08-03",
        firstComment: null,
        timezone: "Europe/Lisbon",
        postingSlotId: "slot-1",
        postingSlotOccurrenceDate: "2026-08-03",
      }),
    );
    const client = createDraftOperationsClient(fetcher);

    await expect(
      client.queue("draft-1", {
        firstComment: null,
        timezone: "Europe/Lisbon",
      }),
    ).resolves.toEqual({
      scheduledAt: "2026-08-03T09:30:00.000Z",
      scheduleStatus: "scheduled",
      planToPostOn: "2026-08-03",
      firstComment: null,
      timezone: "Europe/Lisbon",
      postingSlotId: "slot-1",
      postingSlotOccurrenceDate: "2026-08-03",
    });
    expect(fetcher).toHaveBeenCalledWith("/api/drafts/draft-1/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstComment: null,
        timezone: "Europe/Lisbon",
      }),
    });
  });

  it("schedules a Draft into the recurring occurrence selected by the user", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        ok: true,
        scheduledAt: "2026-08-04T08:00:00.000Z",
        scheduleStatus: "scheduled",
        planToPostOn: "2026-08-04",
        firstComment: "Keep this comment",
        timezone: "Europe/Lisbon",
        postingSlotId: "slot-tuesday",
        postingSlotOccurrenceDate: "2026-08-04",
      }),
    );
    const client = createDraftOperationsClient(fetcher);

    await expect(
      client.queueAt("draft-1", {
        firstComment: "Keep this comment",
        timezone: "Europe/Lisbon",
        postingSlotId: "slot-tuesday",
        postingSlotOccurrenceDate: "2026-08-04",
      }),
    ).resolves.toMatchObject({
      scheduledAt: "2026-08-04T08:00:00.000Z",
      postingSlotId: "slot-tuesday",
      postingSlotOccurrenceDate: "2026-08-04",
    });
    expect(fetcher).toHaveBeenCalledWith("/api/drafts/draft-1/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstComment: "Keep this comment",
        timezone: "Europe/Lisbon",
        postingSlotId: "slot-tuesday",
        postingSlotOccurrenceDate: "2026-08-04",
      }),
    });
  });

  it("preserves a publishing queue booking returned after an idempotent retry", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        ok: true,
        scheduledAt: "2026-08-03T09:30:00.000Z",
        scheduleStatus: "publishing",
        planToPostOn: "2026-08-03",
        firstComment: null,
        timezone: "Europe/Lisbon",
        postingSlotId: "slot-1",
        postingSlotOccurrenceDate: "2026-08-03",
      }),
    );
    const client = createDraftOperationsClient(fetcher);

    await expect(
      client.queue("draft-1", {
        firstComment: null,
        timezone: "Europe/Lisbon",
      }),
    ).resolves.toMatchObject({
      scheduleStatus: "publishing",
      postingSlotId: "slot-1",
    });
  });

  it("returns the canonical empty schedule after unscheduling", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createDraftOperationsClient(fetcher);

    await expect(client.unschedule("draft-1")).resolves.toEqual({
      scheduledAt: null,
      scheduleStatus: null,
      firstComment: null,
      postingSlotId: null,
      postingSlotOccurrenceDate: null,
    });
    expect(fetcher).toHaveBeenCalledWith("/api/drafts/draft-1/schedule", {
      method: "DELETE",
    });
  });

  it("preserves a Draft operation's server error", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        { ok: false, error: "This post cannot be scheduled." },
        { status: 409 },
      ),
    );
    const client = createDraftOperationsClient(fetcher);

    await expect(
      client.schedule("draft-1", {
        scheduledAt: "2026-08-03T09:30:00.000Z",
        planToPostOn: "2026-08-03",
        firstComment: null,
      }),
    ).rejects.toThrow("This post cannot be scheduled.");
  });

  it("rejects an incomplete successful schedule response", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        ok: true,
        scheduledAt: "2026-08-03T09:30:00.000Z",
      }),
    );
    const client = createDraftOperationsClient(fetcher);

    await expect(
      client.schedule("draft-1", {
        scheduledAt: "2026-08-03T09:30:00.000Z",
        planToPostOn: "2026-08-03",
        firstComment: null,
      }),
    ).rejects.toThrow("Invalid response from server");
  });

  it("retries one transient transport failure without hiding server errors", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, draft: { ...draftRow, body: "Updated" } }),
      );
    const client = createDraftOperationsClient(fetcher);

    await expect(
      client.update("draft-1", { body: "Updated" }),
    ).resolves.toMatchObject({ id: "draft-1", body: "Updated" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry an unschedule whose first response may have been lost", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    const client = createDraftOperationsClient(fetcher);

    await expect(client.unschedule("draft-1")).rejects.toThrow(
      "network unavailable",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the operation-specific fallback for an error envelope without a message", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ ok: false }, { status: 500 }),
    );
    const client = createDraftOperationsClient(fetcher);

    await expect(
      client.update(
        "draft-1",
        { body: "Updated" },
        { fallbackError: "Failed to update post" },
      ),
    ).rejects.toThrow("Failed to update post");
  });
});

import { describe, expect, it, vi } from "vitest";
import { createDraftOperationsClient } from "@/lib/draft-operations-client";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("Draft operations client", () => {
  it("updates a Draft through the canonical Draft endpoint", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ ok: true, draft: { id: "draft-1", body: "Updated" } }),
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
    expect(draft).toEqual({ id: "draft-1", body: "Updated" });
  });

  it("normalizes a scheduled Draft from the accepted command", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        ok: true,
        scheduledAt: "2026-08-03T09:30:00.000Z",
        scheduleStatus: "scheduled",
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

  it("returns the canonical empty schedule after unscheduling", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createDraftOperationsClient(fetcher);

    await expect(client.unschedule("draft-1")).resolves.toEqual({
      scheduledAt: null,
      scheduleStatus: null,
      firstComment: null,
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
});

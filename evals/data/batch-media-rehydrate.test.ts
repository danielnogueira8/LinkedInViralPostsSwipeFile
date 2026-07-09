import { describe, expect, test } from "vitest";
import {
  isBatchDraft,
  spliceLiveMediaOntoArtifact,
} from "@/lib/batch-media-rehydrate";

// The pure splice logic behind the batch-media rehydrator (route path):
//   /api/chats/[id] returns chat_messages.artifacts, which is frozen at
//   insert time. The image job runs LATER against chat_artifacts. Without
//   this splice, the drafts panel keeps showing "no image" indefinitely even
//   after credits were spent to generate one.

describe("isBatchDraft", () => {
  test("post + meta.source === 'weekly_batch' is a batch draft", () => {
    expect(
      isBatchDraft({ id: "a", kind: "post", meta: { source: "weekly_batch" } }),
    ).toBe(true);
  });
  test("hook + meta.source === 'weekly_batch' is a batch draft", () => {
    expect(
      isBatchDraft({ id: "a", kind: "hook", meta: { source: "weekly_batch" } }),
    ).toBe(true);
  });
  test("a normal chat draft (no source) is NOT a batch draft", () => {
    expect(isBatchDraft({ id: "a", kind: "post", meta: {} })).toBe(false);
  });
  test("a draft from a different source is NOT a batch draft", () => {
    expect(
      isBatchDraft({
        id: "a",
        kind: "post",
        meta: { source: "model_source" },
      }),
    ).toBe(false);
  });
  test("cite artifacts are never batch drafts", () => {
    expect(
      isBatchDraft({ id: "a", kind: "cite", meta: { source: "weekly_batch" } }),
    ).toBe(false);
  });
});

describe("spliceLiveMediaOntoArtifact", () => {
  test("splices media_attachments when the image job finished", () => {
    const inline = {
      id: "a",
      kind: "post",
      body: "Frozen at insert time",
      meta: { source: "weekly_batch", lead_magnet: { title: "LM" } },
    };
    const live = {
      media_attachments: [{ id: "m1", type: "image", url: "https://x/i.jpg" }],
      meta: {
        generated_lead_magnet_image: { status: "done" },
      },
    };
    const result = spliceLiveMediaOntoArtifact(inline, live);
    expect(result.media_attachments).toEqual(live.media_attachments);
    expect(result.meta).toMatchObject({
      source: "weekly_batch",
      lead_magnet: { title: "LM" },
      generated_lead_magnet_image: { status: "done" },
    });
    // Preserves body — a chat_artifacts body edit must NOT bleed into the
    // transcript out-of-band; the inline blob is the truth for prose.
    expect(result.body).toBe("Frozen at insert time");
  });

  test("no live row → artifact unchanged", () => {
    const inline = {
      id: "a",
      kind: "post",
      body: "Body",
      meta: { source: "weekly_batch" },
    };
    expect(spliceLiveMediaOntoArtifact(inline, undefined)).toEqual(inline);
  });

  test("splices job status even when the image itself never landed", () => {
    // The failed / skipped case: no media_attachments, but the status is set
    // so the UI can show the "image couldn't be generated" note.
    const inline = {
      id: "a",
      kind: "post",
      body: "Body",
      meta: { source: "weekly_batch" },
    };
    const live = {
      meta: {
        generated_lead_magnet_image: {
          status: "failed",
          reason: "Provider rate-limited us.",
        },
      },
    };
    const result = spliceLiveMediaOntoArtifact(inline, live);
    expect(result.media_attachments).toBeUndefined();
    expect(
      (result.meta as { generated_lead_magnet_image?: { status?: string } })
        ?.generated_lead_magnet_image?.status,
    ).toBe("failed");
  });

  test("live row with an empty meta doesn't stomp the inline meta", () => {
    const inline = {
      id: "a",
      kind: "post",
      body: "Body",
      meta: { source: "weekly_batch", is_lead_magnet: true },
    };
    const result = spliceLiveMediaOntoArtifact(inline, {
      meta: {},
    });
    expect(result.meta).toEqual({
      source: "weekly_batch",
      is_lead_magnet: true,
    });
  });
});

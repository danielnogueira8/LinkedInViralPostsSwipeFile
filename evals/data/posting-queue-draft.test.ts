import { describe, expect, test, vi } from "vitest";
import { loadPostingQueueDraft } from "@/lib/posting-queue-draft";
import type { Draft } from "@/lib/draft-view";

const localDraft: Draft = {
  id: "local",
  title: "Locally edited",
  body: "Unsaved local body",
  kind: "post",
  status: "drafting",
  planToPostOn: null,
  chatId: null,
  createdAt: "2026-07-26T10:00:00.000Z",
};

describe("filled posting queue draft resolution", () => {
  test("keeps the local draft and never fetches over optimistic edits", async () => {
    const find = vi.fn();
    await expect(
      loadPostingQueueDraft([localDraft], "local", find),
    ).resolves.toBe(localDraft);
    expect(find).not.toHaveBeenCalled();
  });

  test("fetches and normalizes a draft outside the bounded board page", async () => {
    const find = vi.fn(async () => ({
      id: "older-scheduled",
      title: "Older scheduled post",
      body: "Full post",
      kind: "post",
      status: "ready",
      plan_to_post_on: "2026-08-01",
      chat_id: null,
      created_at: "2025-01-01T10:00:00.000Z",
      scheduled_at: "2026-08-01T09:00:00.000Z",
      schedule_status: "scheduled",
      posting_slot_id: "slot-1",
      posting_slot_occurrence_date: "2026-08-01",
    }));

    await expect(
      loadPostingQueueDraft([], "older-scheduled", find),
    ).resolves.toMatchObject({
      id: "older-scheduled",
      scheduleStatus: "scheduled",
      postingSlotId: "slot-1",
    });
    expect(find).toHaveBeenCalledWith("older-scheduled");
  });
});

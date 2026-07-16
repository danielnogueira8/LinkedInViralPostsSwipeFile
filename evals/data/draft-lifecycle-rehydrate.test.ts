import { describe, expect, test } from "vitest";
import { spliceLiveLifecycleOntoArtifact } from "@/lib/draft-lifecycle-rehydrate";

describe("spliceLiveLifecycleOntoArtifact", () => {
  test("clears stale Cowork schedule metadata when the board draft is unscheduled", () => {
    const inline = {
      id: "preview-1",
      kind: "post",
      body: "Keep this transcript body",
      meta: {
        board_draft_id: "board-1",
        scheduled_at: "2026-07-17T08:00:00.000Z",
        schedule_status: "scheduled",
        first_comment: "Old comment",
        source_url: "https://example.com/source",
      },
    };

    expect(
      spliceLiveLifecycleOntoArtifact(inline, {
        id: "board-1",
        scheduled_at: null,
        schedule_status: null,
        first_comment: null,
        plan_to_post_on: "2026-07-17",
      }),
    ).toEqual({
      ...inline,
      meta: {
        board_draft_id: "board-1",
        scheduled_at: null,
        schedule_status: null,
        first_comment: null,
        plan_to_post_on: "2026-07-17",
        source_url: "https://example.com/source",
      },
    });
  });

  test("overlays the current schedule without changing transcript prose", () => {
    const inline = {
      id: "preview-1",
      kind: "post",
      body: "Frozen transcript body",
      meta: { board_draft_id: "board-1" },
    };

    const result = spliceLiveLifecycleOntoArtifact(inline, {
      id: "board-1",
      scheduled_at: "2026-07-18T09:00:00.000Z",
      schedule_status: "scheduled",
      first_comment: "A link",
      plan_to_post_on: "2026-07-18",
    });

    expect(result.body).toBe("Frozen transcript body");
    expect(result.meta).toMatchObject({
      board_draft_id: "board-1",
      scheduled_at: "2026-07-18T09:00:00.000Z",
      schedule_status: "scheduled",
      first_comment: "A link",
      plan_to_post_on: "2026-07-18",
    });
  });

  test("a deleted board row removes the stale saved and schedule link", () => {
    const result = spliceLiveLifecycleOntoArtifact(
      {
        id: "preview-1",
        kind: "post",
        body: "Body",
        meta: {
          board_draft_id: "missing-board-row",
          scheduled_at: "2026-07-18T09:00:00.000Z",
          schedule_status: "scheduled",
          first_comment: "Old",
          source: "model_source",
        },
      },
      undefined,
    );

    expect(result.meta).toEqual({ source: "model_source" });
  });
});

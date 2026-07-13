import { describe, test, expect } from "vitest";
import {
  isWeeklyBatchArtifact,
} from "@/lib/chat-ui-policy";
import type { Artifact } from "@/lib/agent/contracts";

// ---------------------------------------------------------------------------
// Batch review moves to Cowork: /posts no longer shows a BatchReviewPanel.
// Instead, each weekly-batch draft card inside its Cowork batch chat gets
// inline Approve / Reject buttons. The client detects "batch draft" via
// meta.source === 'weekly_batch', which the batch pipeline stamps
// (lib/batch/weekly.ts). This test locks in the classifier so the inline
// review UI doesn't leak onto regular chat drafts (which don't carry that
// signal) OR miss real batch drafts. Pure predicate, one meta field.
// ---------------------------------------------------------------------------

const mk = (meta?: Record<string, unknown>): Artifact => ({
  id: "a1",
  kind: "post",
  title: "Title",
  body: "Body.",
  ...(meta ? { meta } : {}),
});

describe("isWeeklyBatchArtifact — gates the inline batch review UI", () => {
  test("a batch draft (meta.source === 'weekly_batch') → true", () => {
    expect(
      isWeeklyBatchArtifact(
        mk({ source: "weekly_batch", batch_id: "b_abc" }),
      ),
    ).toBe(true);
  });

  test("a regular chat draft (no meta.source, or meta.source === 'chat') → false", () => {
    expect(isWeeklyBatchArtifact(mk())).toBe(false);
    expect(isWeeklyBatchArtifact(mk({ source: "chat" }))).toBe(false);
    expect(isWeeklyBatchArtifact(mk({ skills: ["cta"] }))).toBe(false);
  });

  test("empty / malformed meta → false (defensive, so review UI never leaks)", () => {
    expect(isWeeklyBatchArtifact(mk({}))).toBe(false);
    expect(isWeeklyBatchArtifact(mk({ source: null }))).toBe(false);
    expect(isWeeklyBatchArtifact(mk({ source: 123 }))).toBe(false);
  });

  test("a hook artifact from a batch is ALSO detected (batch produces posts + lead-magnets, but the classifier is meta-based, not kind-based)", () => {
    // The pipeline stamps meta.source on every batch artifact regardless of
    // kind. If the batch ever adapts a hook, its classifier should still catch.
    const hookArtifact: Artifact = {
      id: "h1",
      kind: "hook",
      title: "Hook",
      body: "First line only.",
      meta: { source: "weekly_batch", batch_id: "b_abc" },
    };
    expect(isWeeklyBatchArtifact(hookArtifact)).toBe(true);
  });
});

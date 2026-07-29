import { describe, expect, test } from "vitest";
import {
  attachPreferenceEvidence,
  listReviewablePreferences,
} from "@/lib/preference-evidence";
import type { ContentPreference } from "@/lib/preferences";

const preference = (
  id: string,
  source: ContentPreference["source"] = "edit_delta",
): ContentPreference => ({
  id,
  workspace_id: "ws-1",
  rule: `Rule ${id}`,
  detail: null,
  source,
  created_at: "2026-07-20T00:00:00Z",
  updated_at: "2026-07-20T00:00:00Z",
});

const row = (index: number) => ({
  id: `evidence-${index}`,
  preference_id: "pref-1",
  revision_event_id: `revision-${index}`,
  batch_id: "batch-1",
  rule_snapshot: "Rule pref-1",
  before_excerpt: index === 1 ? "a".repeat(1_500) : `Before ${index}`,
  after_excerpt: `After ${index}`,
  before_truncated: index === 1,
  after_truncated: false,
  edit_origin: "posts_editor" as const,
  change_summary: {
    beforeChars: 8,
    afterChars: 7,
    deltaChars: -1,
    beforeLines: 1,
    afterLines: 1,
    deltaLines: 0,
  },
  event_created_at: "2026-07-20T00:00:00Z",
});

describe("reviewable preference evidence", () => {
  test("attaches bounded exact-body excerpts to their learned preference", () => {
    const result = attachPreferenceEvidence(
      [preference("pref-1"), preference("pref-2", "user")],
      [row(1), row(2), row(3), row(4)],
    );

    expect(result[0]?.evidence).toHaveLength(3);
    expect(result[0]?.evidence[0]).toMatchObject({
      revisionEventId: "revision-1",
      beforeExcerpt: "a".repeat(1_500),
      beforeTruncated: true,
      afterExcerpt: "After 1",
      afterTruncated: false,
      editOrigin: "posts_editor",
      ruleSnapshot: "Rule pref-1",
    });
    expect(result[1]?.evidence).toEqual([]);
  });

  test("never mutates the stored preference objects", () => {
    const original = preference("pref-1");
    const result = attachPreferenceEvidence([original], [row(1)]);

    expect(original).not.toHaveProperty("evidence");
    expect(result[0]).not.toBe(original);
  });

  test("fails open when evidence storage is unavailable during rollout", async () => {
    const result = await listReviewablePreferences({
      db: {
        rpc: async () => ({
          data: null,
          error: { message: "function does not exist" },
        }),
      } as never,
      workspaceId: "ws-1",
      preferences: [preference("pref-1")],
    });

    expect(result).toEqual([
      expect.objectContaining({ id: "pref-1", evidence: [] }),
    ]);
  });

  test("fails open when the evidence RPC rejects or returns malformed rows", async () => {
    const rejecting = await listReviewablePreferences({
      db: {
        rpc: async () => {
          throw new Error("network unavailable");
        },
      } as never,
      workspaceId: "ws-1",
      preferences: [preference("pref-1")],
    });
    const malformed = await listReviewablePreferences({
      db: {
        rpc: async () => ({ data: [{ id: "not-a-row" }], error: null }),
      } as never,
      workspaceId: "ws-1",
      preferences: [preference("pref-1")],
    });

    expect(rejecting[0]?.evidence).toEqual([]);
    expect(malformed[0]?.evidence).toEqual([]);
  });

  test("loads evidence in database-safe chunks when memory grows beyond 20 rules", async () => {
    const calls: string[][] = [];
    const preferences = Array.from({ length: 21 }, (_, index) =>
      preference(`pref-${index + 1}`),
    );

    const result = await listReviewablePreferences({
      db: {
        rpc: async (_name: string, params: { p_preference_ids: string[] }) => {
          calls.push(params.p_preference_ids);
          return { data: [], error: null };
        },
      } as never,
      workspaceId: "ws-1",
      preferences,
    });

    expect(calls.map((ids) => ids.length)).toEqual([20, 1]);
    expect(result).toHaveLength(21);
  });
});

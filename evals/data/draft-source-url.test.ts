import { describe, test, expect } from "vitest";
// Imported via the page's back-compat re-export to pin that it keeps resolving
// (the impl moved to lib/batch/review-draft).
import { sourceUrlFromMeta } from "@/app/(app)/dashboard/posts/page";
import { toReviewDraft, type ReviewDraftRow } from "@/lib/batch/review-draft";

// ---------------------------------------------------------------------------
// sourceUrlFromMeta — surfaces the "Adapted from ↗" link on a draft card. ONLY
// weekly-batch drafts (meta.source === 'weekly_batch') carry a source_url; a
// hand-authored or chat-saved draft must NOT show a link. Pure, no DOM.
// ---------------------------------------------------------------------------

describe("sourceUrlFromMeta", () => {
  test("returns the source_url for a weekly-batch draft", () => {
    expect(
      sourceUrlFromMeta({ source: "weekly_batch", source_url: "https://linkedin.com/p/1" }),
    ).toBe("https://linkedin.com/p/1");
  });

  test("null when the meta isn't a weekly-batch draft", () => {
    expect(sourceUrlFromMeta({ source: "chat", source_url: "https://x" })).toBeNull();
    expect(sourceUrlFromMeta({ source_url: "https://x" })).toBeNull();
  });

  test("null when a batch draft has no / empty source_url", () => {
    expect(sourceUrlFromMeta({ source: "weekly_batch" })).toBeNull();
    expect(sourceUrlFromMeta({ source: "weekly_batch", source_url: "" })).toBeNull();
    expect(sourceUrlFromMeta({ source: "weekly_batch", source_url: null })).toBeNull();
  });

  test("null for non-object meta (legacy / missing)", () => {
    expect(sourceUrlFromMeta(null)).toBeNull();
    expect(sourceUrlFromMeta(undefined)).toBeNull();
    expect(sourceUrlFromMeta("string")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toReviewDraft — the SHARED row→ReviewDraft mapper used by BOTH page.tsx (first
// paint) and the live-poll endpoint. They must produce identical objects so the
// panel's add-only reseed dedups by id without duplicating or mismatching cards.
// ---------------------------------------------------------------------------

function row(over: Partial<ReviewDraftRow> = {}): ReviewDraftRow {
  return {
    id: "d1",
    title: "A title",
    body: "Body text",
    meta: { source: "weekly_batch", source_url: "https://linkedin.com/p/1" },
    kind: "post",
    status: "pending_review",
    plan_to_post_on: null,
    chat_id: "c1",
    created_at: "2026-07-03T00:00:00.000Z",
    scheduled_at: null,
    schedule_status: null,
    first_comment: null,
    published_at: null,
    publish_error: null,
    ...over,
  };
}

describe("toReviewDraft", () => {
  test("maps a pending_review row to a ReviewDraft with a board-valid status", () => {
    const d = toReviewDraft(row());
    expect(d.id).toBe("d1");
    expect(d.title).toBe("A title");
    expect(d.body).toBe("Body text");
    expect(d.chatId).toBe("c1");
    expect(d.createdAt).toBe("2026-07-03T00:00:00.000Z");
    // The card edits body/title only; it carries a board-valid status so the
    // Draft type is satisfied (the real DB status stays pending_review).
    expect(d.status).toBe("drafting");
    // Surfaces the batch "Adapted from" link.
    expect(d.sourceUrl).toBe("https://linkedin.com/p/1");
  });

  test("a lead_magnet row sets kind + isLeadMagnet", () => {
    const d = toReviewDraft(row({ kind: "lead_magnet" }));
    expect(d.kind).toBe("lead_magnet");
    expect(d.isLeadMagnet).toBe(true);
  });

  test("a regular post is not a lead magnet", () => {
    const d = toReviewDraft(row({ kind: "post" }));
    expect(d.kind).toBe("post");
    expect(d.isLeadMagnet).toBe(false);
  });

  test("an unknown kind falls back to 'post'", () => {
    const d = toReviewDraft(row({ kind: "weird" }));
    expect(d.kind).toBe("post");
    expect(d.isLeadMagnet).toBe(false);
  });

  test("no source_url (hand-authored/chat) → no adapted-from link", () => {
    const d = toReviewDraft(row({ meta: { source: "chat" } }));
    expect(d.sourceUrl).toBeNull();
  });
});

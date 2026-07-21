import { describe, test, expect } from "vitest";
import { createDraftSchema } from "@/lib/draft-create-schema";

// ---------------------------------------------------------------------------
// POST /api/drafts create schema — the "New post" form now sets title, status,
// and due date, and allows an EMPTY body (capture the card now, write later).
// A fully blank draft (no name AND no body) is still rejected. Pure schema.
// ---------------------------------------------------------------------------

describe("createDraftSchema", () => {
  test("allows an empty body when a title is given", () => {
    const r = createDraftSchema.safeParse({ title: "My idea", body: "" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.title).toBe("My idea");
      expect(r.data.body).toBe("");
    }
  });

  test("allows an empty body with no title omitted → body defaults, but rejects fully blank", () => {
    // body omitted entirely → defaults to "" ; with no title that's blank → reject.
    expect(createDraftSchema.safeParse({}).success).toBe(false);
    expect(createDraftSchema.safeParse({ body: "   " }).success).toBe(false);
    expect(createDraftSchema.safeParse({ title: "   " }).success).toBe(false);
  });

  test("accepts status + a valid due date on create", () => {
    const r = createDraftSchema.safeParse({
      title: "Scheduled post",
      status: "ready",
      plan_to_post_on: "2026-07-15",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.status).toBe("ready");
      expect(r.data.plan_to_post_on).toBe("2026-07-15");
    }
  });

  test("null due date is allowed (clears / leaves unset)", () => {
    const r = createDraftSchema.safeParse({ title: "x", plan_to_post_on: null });
    expect(r.success).toBe(true);
  });

  test("rejects a malformed due date", () => {
    expect(
      createDraftSchema.safeParse({ title: "x", plan_to_post_on: "07/15/2026" }).success,
    ).toBe(false);
    expect(
      createDraftSchema.safeParse({ title: "x", plan_to_post_on: "next Tuesday" }).success,
    ).toBe(false);
  });

  test("a body with content and no title is fine (title derived server-side)", () => {
    const r = createDraftSchema.safeParse({ body: "A real post body." });
    expect(r.success).toBe(true);
  });

  test("accepts a lead_magnet_id (the chosen giveaway)", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const r = createDraftSchema.safeParse({
      body: "Comment PLAYBOOK for the guide.",
      kind: "lead_magnet",
      lead_magnet_id: id,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lead_magnet_id).toBe(id);
  });

  test("lead_magnet_id may be null or omitted", () => {
    expect(
      createDraftSchema.safeParse({ body: "x", lead_magnet_id: null }).success,
    ).toBe(true);
    expect(createDraftSchema.safeParse({ body: "x" }).success).toBe(true);
  });

  test("rejects a non-uuid lead_magnet_id", () => {
    expect(
      createDraftSchema.safeParse({ body: "x", lead_magnet_id: "not-a-uuid" }).success,
    ).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// One-click schedule on an agent-written draft.
//
// The eval suite is Node-only by design (vitest.config.ts: "Keep tests
// Node-only"), so the button itself cannot be rendered here. What IS worth
// pinning is the contract the card depends on — the parts that would break
// silently, with no type error, because they are choices rather than shapes.
// ---------------------------------------------------------------------------

const BRIEFING = readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/agent-briefing.tsx"),
  "utf8",
);

// The schedule action is shared by the Daily Brief and the agent briefing, so
// the invariants below live in the shared module rather than in either caller.
const SHARED_ACTION = readFileSync(
  path.join(process.cwd(), "lib/agent-draft-schedule.ts"),
  "utf8",
);

const QUEUE_ROUTE = readFileSync(
  path.join(process.cwd(), "app/api/drafts/[id]/queue/route.ts"),
  "utf8",
);

describe("agent draft one-click schedule", () => {
  it("books the next opening rather than a named slot", () => {
    // queueAt() requires a postingSlotId + occurrence date. The briefing card
    // has neither — it only knows "the next free one" — so switching it to
    // queueAt would 400 on every click.
    expect(SHARED_ACTION).toContain("draftOperations.queue(");
    expect(SHARED_ACTION).not.toContain("draftOperations.queueAt(");
  });

  it("routes through the allocator that creates slots when none exist", () => {
    // A workspace that never configured a posting queue must still be able to
    // click Schedule. The allocator branch ensures defaults before picking.
    expect(QUEUE_ROUTE).toContain("ensure_posting_slots");
    expect(QUEUE_ROUTE).toContain("next_posting_queue_occurrence");
  });

  it("removes the draft from the list only after the booking succeeds", () => {
    // Ordering, not shape: dropping the card first would hide a draft that was
    // never actually scheduled — the user would believe it shipped.
    const handler = BRIEFING.slice(
      BRIEFING.indexOf("const scheduleNow"),
      BRIEFING.indexOf("const review ="),
    );
    const bookingAt = handler.indexOf("await scheduleAgentDraftToNextSlot(");
    const removalAt = handler.indexOf("drafts: cur.drafts.filter");
    expect(bookingAt).toBeGreaterThan(-1);
    expect(removalAt).toBeGreaterThan(bookingAt);
  });

  it("surfaces a failure instead of silently doing nothing", () => {
    // The two real failures are "no LinkedIn account connected" and "the queue
    // changed underneath you". Both need to reach the user.
    const handler = BRIEFING.slice(
      BRIEFING.indexOf("const scheduleNow"),
      BRIEFING.indexOf("const review ="),
    );
    expect(handler).toContain("toast.error");
    // The shared action is what converts a throw into a message.
    expect(SHARED_ACTION).toContain("catch");
  });

  it("guards against a double booking from a double click", () => {
    const handler = BRIEFING.slice(
      BRIEFING.indexOf("const scheduleNow"),
      BRIEFING.indexOf("const review ="),
    );
    expect(handler).toContain("if (schedulingDraftId) return;");
    expect(BRIEFING).toContain("disabled={schedulingDraftId !== null}");
  });
});

// ---------------------------------------------------------------------------
// The Daily Brief is the surface pre-drafting is FOR: the brief says what
// happened, this says "so here is your post". Same one-click action, so the
// invariants above cover it — these pin the parts unique to this surface.
// ---------------------------------------------------------------------------
describe("today's draft on the Daily Brief", () => {
  const CARD = readFileSync(
    path.join(process.cwd(), "app/(app)/dashboard/digest/todays-draft.tsx"),
    "utf8",
  );
  const PAGE = readFileSync(
    path.join(process.cwd(), "app/(app)/dashboard/digest/page.tsx"),
    "utf8",
  );

  it("uses the shared action rather than a second copy", () => {
    expect(CARD).toContain("scheduleAgentDraftToNextSlot");
    expect(CARD).not.toContain("draftOperations");
  });

  it("removes the card only after the booking succeeds", () => {
    const bookingAt = CARD.indexOf("await scheduleAgentDraftToNextSlot(");
    const removalAt = CARD.indexOf("setDone(");
    expect(bookingAt).toBeGreaterThan(-1);
    expect(removalAt).toBeGreaterThan(bookingAt);
  });

  it("surfaces failures and guards a double click", () => {
    expect(CARD).toContain("toast.error");
    expect(CARD).toContain("if (scheduling) return;");
  });

  it("shows only today's UNSCHEDULED agent drafts", () => {
    // Already-queued drafts belong to the posting queue, not to today's
    // decision — showing them would invite a second booking.
    expect(PAGE).toContain("AGENT_SUGGESTED_BY");
    expect(PAGE).toContain('.is("schedule_status", null)');
    expect(PAGE).toContain('.gte("created_at"');
  });

  it("keeps the Brief a pure read", () => {
    // Opening the page must never generate a draft; pre-drafting is a cron.
    expect(PAGE).not.toContain("actOnOpportunity");
    expect(PAGE).not.toMatch(/\.insert\(|\.update\(|\.upsert\(/);
  });

  it("still renders the brief when there is no draft, and vice versa", () => {
    // The empty state must key off BOTH, or a workspace with a draft and no
    // digest (or the reverse) gets a blank page.
    expect(PAGE).toContain("digests.length === 0 && todaysDrafts.length === 0");
  });
});

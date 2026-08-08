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

const QUEUE_ROUTE = readFileSync(
  path.join(process.cwd(), "app/api/drafts/[id]/queue/route.ts"),
  "utf8",
);

describe("agent draft one-click schedule", () => {
  it("books the next opening rather than a named slot", () => {
    // queueAt() requires a postingSlotId + occurrence date. The briefing card
    // has neither — it only knows "the next free one" — so switching it to
    // queueAt would 400 on every click.
    expect(BRIEFING).toContain("draftOperations.queue(");
    expect(BRIEFING).not.toContain("draftOperations.queueAt(");
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
    expect(handler).toContain("await draftOperations.queue(");
    const bookingAt = handler.indexOf("await draftOperations.queue(");
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
    expect(handler).toContain("catch");
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

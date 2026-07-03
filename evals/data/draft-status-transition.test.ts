import { describe, test, expect } from "vitest";
import { isStatusTransitionAllowed } from "@/app/api/drafts/[id]/route";

// ---------------------------------------------------------------------------
// The PATCH /api/drafts/[id] status-transition guard. The #505 review gate
// widened the accepted status enum to include the off-board pending_review /
// rejected statuses. Without a guard, a raw/replayed PATCH could move a draft
// between ANY statuses — e.g. flip a live board card straight to 'rejected'
// (unrecoverable in-app) or un-review a draft into pending_review to hide it.
// The gate must stay the ONLY way in/out of pending_review. (Workspace scoping
// is enforced separately in the route; this pins the transition rules.)
// ---------------------------------------------------------------------------

const BOARD = ["idea", "drafting", "ready", "posted"] as const;

describe("isStatusTransitionAllowed — the review-gate transition guard", () => {
  test("board → board is always allowed (dragging a card between the 4 stages)", () => {
    for (const from of BOARD) {
      for (const to of BOARD) {
        expect(isStatusTransitionAllowed(from, to)).toBe(true);
      }
    }
  });

  test("a no-op transition (from === to) is allowed for every status", () => {
    for (const s of [...BOARD, "pending_review", "rejected"]) {
      expect(isStatusTransitionAllowed(s, s)).toBe(true);
    }
  });

  test("the sanctioned review exits are allowed", () => {
    expect(isStatusTransitionAllowed("pending_review", "drafting")).toBe(true); // Approve
    expect(isStatusTransitionAllowed("pending_review", "rejected")).toBe(true); // Reject
  });

  test("a board draft CANNOT be flipped off-board (the un-recoverable-hide bug)", () => {
    for (const from of BOARD) {
      expect(isStatusTransitionAllowed(from, "rejected")).toBe(false);
      expect(isStatusTransitionAllowed(from, "pending_review")).toBe(false);
    }
  });

  test("a rejected draft cannot be un-rejected via a raw PATCH", () => {
    for (const to of [...BOARD, "pending_review"]) {
      expect(isStatusTransitionAllowed("rejected", to)).toBe(false);
    }
  });

  test("pending_review cannot jump to a non-sanctioned status", () => {
    for (const to of ["idea", "ready", "posted"]) {
      expect(isStatusTransitionAllowed("pending_review", to)).toBe(false);
    }
  });
});

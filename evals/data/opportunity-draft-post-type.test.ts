import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// An opportunity card drafts a REGULAR post. It used to inherit the SOURCE
// post's type, so clicking "draft this" on a card whose source happened to be
// a lead magnet silently produced a comment-gated giveaway post — and
// attached or auto-generated a lead-magnet resource the user never asked for.
//
// The source's type describes the post being MODELLED, not the post being
// written. Only an explicit user selection may change the deliverable.
//
// Asserted against the source because actOnOpportunity is heavily
// DB-coupled: a stub deep enough to drive it end-to-end passed against BOTH
// the old and new code, so it proved nothing. These checks fail on the old
// implementation and pass on the new one.

const ACT = readFileSync(
  resolve(__dirname, "../../lib/agent-loop/act.ts"),
  "utf8",
);

/** The statement that decides whether a lead magnet is attached. */
function leadMagnetDecision(): string {
  const start = ACT.indexOf("const leadMagnetContext");
  expect(start).toBeGreaterThan(-1);
  return ACT.slice(start, ACT.indexOf(";", start) + 1);
}

describe("an opportunity drafts a regular post", () => {
  test("the lead-magnet decision does not read the source post type", () => {
    // The regression in one line: `source.postType === "lead_magnet"` here is
    // what turned a modelled resemblance into a changed deliverable.
    expect(leadMagnetDecision()).not.toContain("source.postType");
  });

  test("it keys only on the user's explicit selection", () => {
    expect(leadMagnetDecision()).toContain("direction?.leadMagnetId");
  });

  test("no auto-selection or auto-generation remains on this path", () => {
    // leadMagnetForTurn picked a best-fit resource, or generated a brand new
    // one, purely because the SOURCE was a lead magnet. Both are side effects
    // of a click the user made on an ordinary card.
    expect(ACT).not.toContain("leadMagnetForTurn");
    expect(ACT).not.toContain("createLeadMagnet:");
  });
});

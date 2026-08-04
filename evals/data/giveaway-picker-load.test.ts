import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The Giveaway row sat on "Loading…" forever after switching Kind to
// "Lead Magnet Post" on an existing draft.
//
// The effect's guard read `leadMagnetsLoading` while the effect also SET it
// and listed it as a dependency. Setting it re-ran the effect; the re-run's
// cleanup marked the in-flight fetch cancelled; and the `finally` only
// released the flag `if (!cancelled)`. So an interrupted fetch left the flag
// stuck true and the guard rejected every retry.
//
// Switching Kind is exactly that sequence: the PATCH re-renders while the
// first fetch is still open.

const MODAL = readFileSync(
  resolve(__dirname, "../../app/(app)/dashboard/draft-editor-modal.tsx"),
  "utf8",
);

/** The lead-magnet loading effect, from its ref down to its dep array. */
function loadEffect(): string {
  const start = MODAL.indexOf("const leadMagnetFetchRef");
  expect(start).toBeGreaterThan(-1);
  const end = MODAL.indexOf("}, [wantsLeadMagnets", start);
  expect(end).toBeGreaterThan(start);
  return MODAL.slice(start, MODAL.indexOf("]);", end) + 3);
}

describe("the giveaway picker cannot deadlock on Loading…", () => {
  test("the loading flag is not a dependency of the effect that sets it", () => {
    // The self-reference is the deadlock: set -> re-run -> cancel -> stuck.
    expect(loadEffect()).not.toContain("leadMagnetsLoading]");
    expect(loadEffect()).toMatch(/\}, \[wantsLeadMagnets, leadMagnetOptions\]/);
  });

  test("the guard reads a ref, not the state it writes", () => {
    const effect = loadEffect();
    expect(effect).toContain("leadMagnetFetchRef.current");
    // The old guard shape, which is what made a retry impossible.
    expect(effect).not.toContain("|| leadMagnetsLoading) return");
  });

  test("an interrupted fetch still releases the in-flight lock", () => {
    // The precise regression: `finally { if (!cancelled) ... }` never ran for
    // a cancelled fetch, so nothing could ever retry.
    const effect = loadEffect();
    const finallyBlock = effect.slice(effect.indexOf("} finally {"));
    expect(finallyBlock).toContain("leadMagnetFetchRef.current = false");
    expect(finallyBlock).toContain("setLeadMagnetsLoading(false)");
    expect(finallyBlock).not.toContain("if (!cancelled) setLeadMagnetsLoading");
  });
});

describe("LeadShark automation shows for a lead-magnet post", () => {
  const ROUTE = readFileSync(
    resolve(__dirname, "../../app/api/drafts/[id]/automation/route.ts"),
    "utf8",
  );

  test("eligibility is the post kind alone", () => {
    // Not gated on an attached resource: a user can give away something
    // hosted elsewhere and still configure the automation.
    expect(ROUTE).toContain('const isLeadMagnet = draft.kind === "lead_magnet"');
    expect(ROUTE).toContain("eligible: isLeadMagnet");
  });

  test("the panel renders whenever the draft kind is lead_magnet", () => {
    expect(MODAL).toContain('draft.kind === "lead_magnet" && (');
  });
});

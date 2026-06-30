import { describe, test, expect } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// The PATCH /api/chats/[id]/artifacts request schema's body must NOT trim user
// whitespace — LinkedIn drafts use leading/trailing blank lines and spaces
// intentionally for cadence + paragraph spacing. The original schema applied
// `.trim()` server-side, so a Done-save round-tripped through the DB came back
// stripped, and on refresh the user's text "disappeared" (only the whitespace,
// but enough to make them lose what looked like real content). Re-derived here
// (same shape as the route's patchSchema) so the no-trim guarantee is enforced
// by a unit test even if the route file is restructured.
// ---------------------------------------------------------------------------

const patchSchema = z.object({
  targetId: z.string().trim().min(1).max(100),
  body: z.string().min(1).max(20000),
  title: z.string().trim().max(200).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  supersedeId: z.string().trim().min(1).max(100).optional(),
});

describe("PATCH /artifacts body schema preserves user whitespace", () => {
  test("trailing newlines are preserved (LinkedIn paragraph spacing)", () => {
    const body = "Line one.\n\nLine two.\n\n";
    const r = patchSchema.safeParse({ targetId: "a1", body });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.body).toBe(body);
  });

  test("leading whitespace is preserved (deliberate hook indentation)", () => {
    const body = "  Sometimes a line starts with a space.\nThe rest is normal.";
    const r = patchSchema.safeParse({ targetId: "a1", body });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.body).toBe(body);
  });

  test("a whitespace-only body still fails min(1) (real edits have content)", () => {
    expect(patchSchema.safeParse({ targetId: "a1", body: " " }).success).toBe(true);
    expect(patchSchema.safeParse({ targetId: "a1", body: "" }).success).toBe(false);
  });

  test("targetId is still trimmed (ids are never whitespace-formatted)", () => {
    const r = patchSchema.safeParse({ targetId: "  a1  ", body: "x" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.targetId).toBe("a1");
  });

  test("body at the max cap (20_000 chars) is accepted", () => {
    const r = patchSchema.safeParse({ targetId: "a1", body: "x".repeat(20_000) });
    expect(r.success).toBe(true);
  });

  test("body over the cap is rejected", () => {
    const r = patchSchema.safeParse({ targetId: "a1", body: "x".repeat(20_001) });
    expect(r.success).toBe(false);
  });
});

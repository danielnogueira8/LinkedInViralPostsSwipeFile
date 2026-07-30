import { describe, test, expect } from "vitest";
import {
  creatorAvatarFallback,
  tintFor,
  timeAgo,
} from "@/lib/post-card-helpers";

// ---------------------------------------------------------------------------
// Presentation helpers shared by the swipe PostCard and the chat's inline
// source-card (so a cited post reads identically in both places). Pure.
// ---------------------------------------------------------------------------

describe("tintFor — stable avatar tint from a name", () => {
  test("is deterministic (same name → same tint)", () => {
    expect(tintFor("Alice")).toBe(tintFor("Alice"));
    expect(tintFor("Jasmin Alic")).toBe(tintFor("Jasmin Alic"));
  });

  test("returns a class string from the known palette", () => {
    const t = tintFor("Bob");
    expect(t).toMatch(/^bg-\w+-\d+ text-\w+-\d+$/);
  });

  test("distinct names can land on distinct tints (not all collapse to one)", () => {
    // 8 buckets → collisions are expected, but the palette is actually used:
    // these two specific names hash to different buckets.
    expect(tintFor("Alice")).not.toBe(tintFor("Bob"));
  });

  test("an empty name still yields a valid tint (no crash)", () => {
    expect(tintFor("")).toMatch(/^bg-/);
  });
});

describe("creatorAvatarFallback — DiceBear shapes URL for missing photos", () => {
  test("points at the shapes style on the DiceBear CDN", () => {
    expect(creatorAvatarFallback("Alice")).toBe(
      "https://api.dicebear.com/9.x/shapes/svg?seed=Alice",
    );
  });

  test("is deterministic per name but differs across names", () => {
    expect(creatorAvatarFallback("Amos Bar Joseph")).toBe(
      creatorAvatarFallback("Amos Bar Joseph"),
    );
    expect(creatorAvatarFallback("Amos Bar Joseph")).not.toBe(
      creatorAvatarFallback("Dana Founder"),
    );
  });

  test("URL-encodes the seed and survives an empty name", () => {
    expect(creatorAvatarFallback("Amos Bar Joseph")).toContain(
      "seed=Amos%20Bar%20Joseph",
    );
    expect(creatorAvatarFallback("  ")).toContain("seed=%3F");
  });
});

describe("timeAgo — short month/day formatting", () => {
  test("null → null", () => {
    expect(timeAgo(null)).toBeNull();
  });

  test("a valid ISO date → 'Mon D' (US short)", () => {
    // Use a noon-UTC timestamp so the local-date rendering can't slip to an
    // adjacent day in negative-offset timezones.
    expect(timeAgo("2026-05-09T12:00:00Z")).toBe("May 9");
    expect(timeAgo("2026-12-25T12:00:00Z")).toBe("Dec 25");
  });
});

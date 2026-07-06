import { describe, expect, test } from "vitest";
import {
  LEAD_MAGNET_AI_MONTHLY_LIMIT,
  extractDeliverables,
  leadMagnetInputSchema,
  makePublicSlug,
  monthStartIso,
  normalizeLeadMagnetMetadata,
} from "@/lib/lead-magnets";

describe("lead magnets", () => {
  test("uses a five-per-user AI monthly limit", () => {
    expect(LEAD_MAGNET_AI_MONTHLY_LIMIT).toBe(5);
  });

  test("computes a UTC month boundary for monthly caps", () => {
    expect(monthStartIso(new Date("2026-07-31T23:59:59.000Z"))).toBe("2026-07-01T00:00:00.000Z");
  });

  test("creates unguessable title-based public slugs", () => {
    expect(makePublicSlug("LinkedIn Content Audit Checklist")).toMatch(
      /^linkedin-content-audit-checklist-[a-f0-9]{8}$/,
    );
  });

  test("validates markdown document inputs", () => {
    expect(
      leadMagnetInputSchema.safeParse({
        title: "Checklist",
        markdown_body: "# Checklist\n\n- Hook\n- CTA",
        is_public: true,
      }).success,
    ).toBe(true);
    expect(leadMagnetInputSchema.safeParse({ title: "", markdown_body: "" }).success).toBe(false);
  });

  test("extracts deliverables from markdown lists", () => {
    expect(
      extractDeliverables(`# Resource\n\n- Hook checklist.\n- CTA swipe file\n1. DM script:`),
    ).toEqual(["Hook checklist", "CTA swipe file", "DM script"]);
  });

  test("normalizes metadata with derived summary and deliverables", () => {
    const meta = normalizeLeadMagnetMetadata(null, [
      "# Founder content kit",
      "",
      "Use this to turn customer calls into useful LinkedIn posts for your audience.",
      "",
      "- Call notes checklist",
      "- Post angle map",
    ].join("\n"));
    expect(meta.summary).toContain("turn customer calls");
    expect(meta.deliverables).toEqual(["Call notes checklist", "Post angle map"]);
  });
});

import { describe, test, expect } from "vitest";
import {
  normalizeSkillName,
  skillInputSchema,
  filterSkillsByQuery,
  SKILL_BODY_MAX,
  SKILL_NAME_MAX,
} from "@/lib/custom-skills";

describe("filterSkillsByQuery", () => {
  const skills = [{ name: "cta" }, { name: "hook-vault" }, { name: "cold-email" }];
  test("empty query → all", () => {
    expect(filterSkillsByQuery(skills, "")).toHaveLength(3);
  });
  test("substring match on the slug", () => {
    expect(filterSkillsByQuery(skills, "co").map((s) => s.name)).toEqual(["cold-email"]);
    expect(filterSkillsByQuery(skills, "vault").map((s) => s.name)).toEqual(["hook-vault"]);
  });
  test("no match → empty", () => {
    expect(filterSkillsByQuery(skills, "zzz")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Custom-skill input validation + name normalization. These caps are the single
// source of truth shared by the CRUD API and the agent injection, so a skill
// body can't be unbounded and /name is always an unambiguous slug.
// ---------------------------------------------------------------------------

describe("normalizeSkillName", () => {
  test("lowercases, spaces → hyphens, strips punctuation", () => {
    expect(normalizeSkillName("My CTA  Style!")).toBe("my-cta-style");
  });
  test("collapses and trims hyphens", () => {
    expect(normalizeSkillName("  --Hook__Vault--  ")).toBe("hook-vault");
  });
  test("keeps digits", () => {
    expect(normalizeSkillName("v2 format")).toBe("v2-format");
  });
  test("an all-punctuation name normalizes to empty", () => {
    expect(normalizeSkillName("!!!")).toBe("");
  });
  test("caps the slug length", () => {
    expect(normalizeSkillName("a".repeat(100)).length).toBeLessThanOrEqual(SKILL_NAME_MAX);
  });
});

describe("skillInputSchema", () => {
  test("a valid skill parses, name normalized to a slug", () => {
    const r = skillInputSchema.safeParse({
      name: "My CTA",
      description: "standard cta",
      body: "End with: comment GUIDE.",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("my-cta");
      expect(r.data.description).toBe("standard cta");
      expect(r.data.body).toBe("End with: comment GUIDE.");
    }
  });

  test("empty body → rejected", () => {
    expect(skillInputSchema.safeParse({ name: "x", body: "" }).success).toBe(false);
    expect(skillInputSchema.safeParse({ name: "x", body: "   " }).success).toBe(false);
  });

  test("a name with no letters/digits → rejected (slug would be empty)", () => {
    expect(skillInputSchema.safeParse({ name: "!!!", body: "ok" }).success).toBe(false);
  });

  test("body over the cap → rejected", () => {
    const r = skillInputSchema.safeParse({
      name: "big",
      body: "x".repeat(SKILL_BODY_MAX + 1),
    });
    expect(r.success).toBe(false);
  });

  test("body exactly at the cap → accepted", () => {
    const r = skillInputSchema.safeParse({ name: "big", body: "x".repeat(SKILL_BODY_MAX) });
    expect(r.success).toBe(true);
  });

  test("description is optional and normalizes empty → null", () => {
    const r = skillInputSchema.safeParse({ name: "x", body: "b", description: "  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.description).toBeNull();
  });
});

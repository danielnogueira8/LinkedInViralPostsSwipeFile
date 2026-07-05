import { describe, test, expect } from "vitest";
import {
  normalizeSkillName,
  skillInputSchema,
  filterSkillsByQuery,
  isSkillImportFilename,
  skillNameFromImport,
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
// Custom-skill input validation + name normalization. Metadata caps keep the UI
// scannable and /name is always an unambiguous slug; body length is intentionally
// uncapped so imported Claude-style skill files are not truncated.
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

  test("long imported skill bodies are accepted", () => {
    const r = skillInputSchema.safeParse({
      name: "big",
      body: "x".repeat(80_000),
    });
    expect(r.success).toBe(true);
  });

  test("description is optional and normalizes empty → null", () => {
    const r = skillInputSchema.safeParse({ name: "x", body: "b", description: "  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.description).toBeNull();
  });
});

describe("skill file imports", () => {
  test("accepts markdown and Claude skill file extensions", () => {
    expect(isSkillImportFilename("SKILL.md")).toBe(true);
    expect(isSkillImportFilename("voice.markdown")).toBe(true);
    expect(isSkillImportFilename("founder.skill")).toBe(true);
    expect(isSkillImportFilename("founder.skills")).toBe(true);
    expect(isSkillImportFilename("notes.txt")).toBe(false);
  });

  test("derives the skill slug from a markdown H1 when present", () => {
    expect(skillNameFromImport("SKILL.md", "# Founder Story Skill\n\nUse this.")).toBe(
      "founder-story-skill",
    );
  });

  test("falls back to filename when there is no heading", () => {
    expect(skillNameFromImport("lead-magnet.skills", "Use this.")).toBe("lead-magnet");
  });
});

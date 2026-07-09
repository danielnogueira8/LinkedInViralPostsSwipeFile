import { describe, test, expect } from "vitest";
import { zipSync } from "fflate";
import {
  normalizeSkillName,
  skillInputSchema,
  filterSkillsByQuery,
  isSkillImportFilename,
  parseSkillImportBytes,
  skillNameFromImport,
  SKILL_NAME_MAX,
  SKILL_BODY_MAX,
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
// scannable and /name is always an unambiguous slug; body is capped at
// SKILL_BODY_MAX so a rogue body can't dominate the system prompt or blow up
// cost (skill bodies are uncached — every invocation pays full input tokens).
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

  test("body at the cap is accepted; past the cap is rejected", () => {
    // At-the-cap → OK.
    const atCap = skillInputSchema.safeParse({
      name: "big",
      body: "x".repeat(SKILL_BODY_MAX),
    });
    expect(atCap.success).toBe(true);
    // Over-the-cap → rejected. A rogue skill body can't dominate the system
    // prompt or drive up cost (skill bodies are UNCACHED — every invocation
    // pays full input tokens).
    const overCap = skillInputSchema.safeParse({
      name: "big",
      body: "x".repeat(SKILL_BODY_MAX + 1),
    });
    expect(overCap.success).toBe(false);
    if (!overCap.success) {
      expect(overCap.error.issues[0].message).toMatch(/6[,.]?000|characters/i);
    }
  });

  test("description is optional and normalizes empty → null", () => {
    const r = skillInputSchema.safeParse({ name: "x", body: "b", description: "  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.description).toBeNull();
  });
});

describe("skill file imports", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

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

  test("imports plain text markdown skill files", () => {
    expect(parseSkillImportBytes("SKILL.md", bytes("# Founder Story\n\nUse this."))).toEqual({
      body: "# Founder Story\n\nUse this.",
      name: "founder-story",
    });
  });

  test("extracts SKILL.md from packaged .skill archives", () => {
    const archive = zipSync({
      "creator-style/SKILL.md": bytes("# Creator Style\n\nWrite like this."),
      "creator-style/README.md": bytes("# Ignore Me"),
    });

    expect(parseSkillImportBytes("creator.skill", archive)).toEqual({
      body: "# Creator Style\n\nWrite like this.",
      name: "creator-style",
    });
  });

  test("rejects binary .skill files instead of importing replacement-character garbage", () => {
    expect(() =>
      parseSkillImportBytes("broken.skill", new Uint8Array([0xff, 0x00, 0x90, 0x12])),
    ).toThrow(/not readable text|looks like a binary file/);
  });

  test("rejects archives without a readable skill file", () => {
    const archive = zipSync({ "assets/icon.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
    expect(() => parseSkillImportBytes("assets.skill", archive)).toThrow(
      /does not contain a SKILL\.md or Markdown file/,
    );
  });
});

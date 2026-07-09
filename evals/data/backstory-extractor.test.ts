import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  backstoryEnabled,
  extractBiographicalFacts,
  parseBackstoryArgs,
  renderBackstoryBlock,
  MAX_BIOGRAPHICAL_FACTS,
  NO_FACTS_SENTINEL,
} from "@/lib/agent/specialists/backstory";
import { sanitizeVoiceProfile } from "@/lib/claude";

// Pure logic behind the backstory extractor (A of A/B/D). The Sonnet call is
// covered by the disabled fail-open path; block rendering + arg parsing +
// profile round-tripping are the deterministic surface.

describe("parseBackstoryArgs", () => {
  test("well-formed facts parse + trim", () => {
    expect(
      parseBackstoryArgs({
        facts: ["  Former LoL player ", "Based in Portugal", ""],
      }),
    ).toEqual(["Former LoL player", "Based in Portugal"]);
  });

  test("missing / wrong shape → empty", () => {
    expect(parseBackstoryArgs(null)).toEqual([]);
    expect(parseBackstoryArgs({})).toEqual([]);
    expect(parseBackstoryArgs({ facts: "nope" })).toEqual([]);
  });

  test("caps the number of facts", () => {
    const many = Array.from({ length: 20 }, (_, i) => `fact ${i}`);
    expect(parseBackstoryArgs({ facts: many }).length).toBe(
      MAX_BIOGRAPHICAL_FACTS,
    );
  });
});

describe("renderBackstoryBlock", () => {
  test("undefined / empty → empty block", () => {
    expect(renderBackstoryBlock(undefined)).toBe("");
    expect(renderBackstoryBlock([])).toBe("");
  });

  test("the no-facts sentinel renders as empty (profile has no anchors)", () => {
    expect(renderBackstoryBlock([NO_FACTS_SENTINEL])).toBe("");
  });

  test("real facts render as a caveated 'use sparingly' library", () => {
    const block = renderBackstoryBlock([
      "Former competitive League of Legends player",
      "Based in Portugal",
    ]);
    expect(block).toContain("BACKSTORY LIBRARY");
    expect(block).toContain("• Former competitive League of Legends player");
    expect(block).toContain("• Based in Portugal");
    expect(block.toLowerCase()).toContain("use sparingly");
    expect(block.toLowerCase()).toContain("do not name-drop");
    // The framing that reframes facts as seasoning, not a checklist.
    expect(block.toLowerCase()).toContain("most posts should reference none");
  });

  test("drops the sentinel but keeps real facts when mixed", () => {
    const block = renderBackstoryBlock([
      NO_FACTS_SENTINEL,
      "Ran a content agency",
    ]);
    expect(block).toContain("• Ran a content agency");
    expect(block).not.toContain(NO_FACTS_SENTINEL);
  });
});

describe("sanitizeVoiceProfile — biographical_facts round-trip", () => {
  test("preserves non-empty biographical_facts across sanitization", () => {
    const p = sanitizeVoiceProfile({
      summary: "s",
      biographical_facts: ["Former LoL player", "  Based in Portugal  ", ""],
    });
    expect(p.biographical_facts).toEqual([
      "Former LoL player",
      "Based in Portugal",
    ]);
  });

  test("drops an empty biographical_facts (distinguishes unset from extracted-to-nothing)", () => {
    const p = sanitizeVoiceProfile({ summary: "s", biographical_facts: [] });
    expect(p.biographical_facts).toBeUndefined();
  });

  test("absent biographical_facts stays undefined", () => {
    const p = sanitizeVoiceProfile({ summary: "s" });
    expect(p.biographical_facts).toBeUndefined();
  });

  test("caps biographical_facts at 12", () => {
    const many = Array.from({ length: 20 }, (_, i) => `fact ${i}`);
    const p = sanitizeVoiceProfile({ summary: "s", biographical_facts: many });
    expect(p.biographical_facts?.length).toBe(12);
  });
});

describe("extractBiographicalFacts — disabled path (no model call)", () => {
  beforeEach(() => {
    delete process.env.AGENT_BACKSTORY_EXTRACT;
  });
  afterEach(() => {
    delete process.env.AGENT_BACKSTORY_EXTRACT;
  });

  test("disabled via env → empty, no model call", async () => {
    process.env.AGENT_BACKSTORY_EXTRACT = "0";
    expect(backstoryEnabled()).toBe(false);
    const profile = sanitizeVoiceProfile({
      summary: "A founder who was a LoL player, now writes about content.",
      positioning: "ex-agency, Portugal-based",
    });
    const facts = await extractBiographicalFacts({ profile });
    expect(facts).toEqual([]);
  });
});

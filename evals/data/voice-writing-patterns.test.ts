import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { sanitizeVoiceProfile } from "@/lib/claude";
import { buildWeeklyDraftSystem } from "@/lib/batch/weekly-draft-prompt";

describe("voice writing patterns", () => {
  test("sanitizes the prose mechanics extracted from writing samples", () => {
    const profile = sanitizeVoiceProfile({
      summary: "Direct founder voice.",
      format_patterns: {
        sentence_rhythm: "  Alternates clipped openers with long explanatory lines. ",
        paragraphing: "One sentence per paragraph, then a longer proof block.",
        vocabulary: ["plainspoken", "operator language"],
        punctuation: "Uses colons; almost never uses em dashes.",
        rhetorical_devices: ["specific before/after contrasts", "direct reader callouts"],
      },
    });

    expect(profile.format_patterns).toMatchObject({
      sentence_rhythm: "Alternates clipped openers with long explanatory lines.",
      paragraphing: "One sentence per paragraph, then a longer proof block.",
      vocabulary: ["plainspoken", "operator language"],
      punctuation: "Uses colons; almost never uses em dashes.",
      rhetorical_devices: ["specific before/after contrasts", "direct reader callouts"],
    });
  });

  test("weekly drafting receives the extracted mechanics as explicit voice context", () => {
    const voice = sanitizeVoiceProfile({
      summary: "Direct founder voice.",
      format_patterns: {
        sentence_rhythm: "Short hook, then varied sentence lengths.",
        paragraphing: "Mostly one-sentence paragraphs.",
        vocabulary: ["plain verbs"],
        punctuation: "Uses parentheses for asides.",
        rhetorical_devices: ["contrast"],
      },
    });
    const prompt = buildWeeklyDraftSystem({
      voice,
      preferences: [],
      isLeadMagnet: false,
    });

    expect(prompt).toContain("WRITING MECHANICS");
    expect(prompt).toContain("Short hook, then varied sentence lengths.");
    expect(prompt).toContain("Mostly one-sentence paragraphs.");
  });

  test("voice synthesis explicitly asks for evidence-based prose mechanics", () => {
    const source = readFileSync("lib/claude.ts", "utf8");
    expect(source).toContain('"sentence_rhythm"');
    expect(source).toContain('"paragraphing"');
    expect(source).toContain('"rhetorical_devices"');
    expect(source).toContain("Infer these writing mechanics from repeated evidence");
    expect(source).toContain("hasCompleteWritingPatterns");
    expect(source).toContain('required: ["summary", "format_patterns", "exemplars"]');
  });
});

import { unzipSync } from "fflate";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Custom (user-defined) agent skills — shared types + validation/caps.
//
// A skill is a named block of task guidance the workspace authors and the agent
// injects into a turn (the same slot as the built-in skills in
// lib/agent/skills/index.ts). Name/description/count caps keep the UI scannable;
// the body is intentionally uncapped so Claude-style .md/.skill files can be
// stored without truncation.
// ---------------------------------------------------------------------------

export type CustomSkill = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  body: string;
  created_at: string;
  updated_at: string;
};

// Caps — deliberately conservative for metadata. The skill body has no hard
// character cap; the editor only shows a soft quality warning for long bodies.
export const SKILL_NAME_MAX = 40;
export const SKILL_DESC_MAX = 120;
// Past this length the editor shows a non-blocking "long skills can dilute the
// agent's focus" hint. Not a hard limit — just a nudge toward tighter skills.
export const SKILL_BODY_SOFT_WARN = 10_000;
// Most custom skills applied to a single turn — matches the built-in cap (2) so
// the injected block stays small and the prompt can't balloon.
export const SKILLS_PER_TURN_MAX = 2;
// Per-workspace ceiling, so the picker stays scannable and storage is bounded.
export const SKILLS_PER_WORKSPACE_MAX = 30;

// The /command name + picker label. We normalize to a clean, unambiguous slug:
// lowercased, spaces→hyphens, only [a-z0-9-], collapsed/trimmed hyphens. So
// "My CTA  Style!" → "my-cta-style" and /my-cta-style invokes it.
export function normalizeSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX);
}

export function isSkillImportFilename(filename: string): boolean {
  return /\.(md|markdown|skill|skills)$/i.test(filename.trim());
}

export type SkillImport = {
  body: string;
  name: string;
};

export function skillNameFromImport(filename: string, text: string): string {
  const heading = text
    .split(/\r?\n/)
    .map((line) => /^#\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
    .find((line): line is string => !!line);
  if (heading) return normalizeSkillName(heading);

  const basename = filename
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.(md|markdown|skill|skills)$/i, "");
  return normalizeSkillName(basename ?? "");
}

function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function decodeSkillText(bytes: Uint8Array, filename: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `${filename} is not readable text. If this is a packaged Claude skill, export it as a .skill ZIP that contains SKILL.md.`,
    );
  }

  const sample = text.slice(0, 4096);
  const controlChars = sample.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g)?.length ?? 0;
  if (text.includes("\uFFFD") || controlChars > 0) {
    throw new Error(
      `${filename} looks like a binary file, not a text skill. Upload a Markdown skill file or a .skill archive that contains SKILL.md.`,
    );
  }
  return text;
}

function skillEntryName(entries: Record<string, Uint8Array>): string | null {
  const names = Object.keys(entries).filter((name) => !name.endsWith("/"));
  return (
    names.find((name) => /(^|\/)SKILL\.md$/i.test(name)) ??
    names.find((name) => /\.(md|markdown)$/i.test(name)) ??
    names.find((name) => /\.(skill|skills|txt)$/i.test(name)) ??
    null
  );
}

export function parseSkillImportBytes(filename: string, bytes: Uint8Array): SkillImport {
  if (!isSkillImportFilename(filename)) {
    throw new Error("Upload a .md, .skill, or .skills file.");
  }

  let text: string;
  if (isZipBytes(bytes)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw new Error(`Couldn't open ${filename}. Export the skill again and try uploading it.`);
    }

    const entryName = skillEntryName(entries);
    if (!entryName) {
      throw new Error(`${filename} does not contain a SKILL.md or Markdown file.`);
    }
    text = decodeSkillText(entries[entryName], entryName);
  } else {
    text = decodeSkillText(bytes, filename);
  }

  if (!text.trim()) {
    throw new Error("That skill file is empty.");
  }

  return {
    body: text,
    name: skillNameFromImport(filename, text),
  };
}

// ---------------------------------------------------------------------------
// Composer "/" command — filter the workspace skills by the menu's query. The
// chat composer already detects a bare "/<query>" and drives a starter menu; we
// list matching custom skills as a second section using this. Pure + tested.
// ---------------------------------------------------------------------------

// Filter a skill list by the "/" query (substring match on the slug name).
// Empty query → all (the user just typed "/").
export function filterSkillsByQuery<T extends { name: string }>(
  skills: T[],
  query: string,
): T[] {
  const q = query.toLowerCase();
  if (!q) return skills;
  return skills.filter((s) => s.name.toLowerCase().includes(q));
}

// Body of a create/update request. Name is normalized + non-empty after that.
export const skillInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(SKILL_NAME_MAX * 2) // pre-normalization slack; normalizeSkillName trims
    .transform(normalizeSkillName)
    .refine((n) => n.length > 0, "Name must contain letters or numbers"),
  description: z
    .string()
    .trim()
    .max(SKILL_DESC_MAX)
    .optional()
    .nullable()
    .transform((d) => (d ? d : null)),
  body: z.string().trim().min(1, "Body is required"),
});

export type SkillInput = z.infer<typeof skillInputSchema>;

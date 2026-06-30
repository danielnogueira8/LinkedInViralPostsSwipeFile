import { z } from "zod";

// ---------------------------------------------------------------------------
// Custom (user-defined) agent skills — shared types + validation/caps.
//
// A skill is a named block of task guidance the workspace authors and the agent
// injects into a turn (the same slot as the built-in skills in
// lib/agent/skills/index.ts). The caps here are the single source of truth for
// BOTH the CRUD API (write-time validation) and the agent injection (read-time
// safety), so the prompt can never balloon and a skill body can't be unbounded.
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

// Caps — deliberately conservative. A skill is GUIDANCE, not a document.
export const SKILL_NAME_MAX = 40;
export const SKILL_DESC_MAX = 120;
// chars. A built-in skill body is ~1-1.5k; users write longer ones (full
// "when to use this / when not / examples" specs), so 3k gives real room.
// Worst-case prompt impact at SKILLS_PER_TURN_MAX=2 → ~6k chars ≈ 1.5k tokens
// added to the UNCACHED skill block (the cached system prefix is unchanged).
export const SKILL_BODY_MAX = 3000;
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
  body: z.string().trim().min(1, "Body is required").max(SKILL_BODY_MAX),
});

export type SkillInput = z.infer<typeof skillInputSchema>;

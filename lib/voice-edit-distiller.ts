import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  BACKGROUND_MODEL,
  completeChat,
  logOpenRouterUsage,
  providerModelAttribution,
} from "@/lib/openrouter";
import { INJECTION_GUARD, wrapUntrustedXml } from "@/lib/agent/untrusted";
import { parseJsonObject } from "@/lib/claude";
import {
  isDuplicatePreference,
  normalizePreferenceRule,
  PREFS_PER_WORKSPACE_MAX,
  type ContentPreference,
} from "@/lib/preferences";

// ---------------------------------------------------------------------------
// Voice edit distiller (PLAN-agent-loop Phase C2).
//
// Reads the workspace's recent manual draft edits and turns them into durable
// preference rules ("uses contractions", "cuts hedging adverbs"). One cheap
// BACKGROUND_MODEL call per workspace per run; the only state it writes is
// new content_preferences rows (source "edit_delta"), deduped against what
// the user already has. Fail-open: any error leaves the workspace unchanged.
// ---------------------------------------------------------------------------

const DISTILLER_TIMEOUT_MS = 8_000;
const DISTILLER_MAX_TOKENS = 512;
const MAX_EDIT_EVENTS = 20;
const MAX_CANDIDATE_RULES = 3;
const RULE_MAX_CHARS = 120;

const DistillerSchema = z.object({
  rules: z.array(z.string().trim().min(1)).max(MAX_CANDIDATE_RULES),
});

export type DraftEditEventRow = {
  id: string;
  before_body: string;
  after_body: string;
  created_at: string;
};

function buildDistillerPrompt(events: DraftEditEventRow[]): string {
  const diffs = events
    .map((event, index) => {
      return `[Edit ${index + 1}]\nBEFORE:\n${event.before_body}\n\nAFTER:\n${event.after_body}`;
    })
    .join("\n\n---\n\n");
  return [
    "You are analyzing manual edits a user made to AI-generated LinkedIn drafts.",
    "Your job is to infer up to 3 durable writing rules that would make the next draft require fewer edits.",
    "",
    "Rules must be:",
    "- short imperative lines (max 120 characters each),",
    "- about style, tone, structure, or phrasing (not about the topic),",
    "- general enough to apply to future drafts.",
    "",
    "Return strict JSON only, no prose: {\"rules\": [\"...\", \"...\"]}.",
    "If the edits show no consistent preference, return an empty list.",
    INJECTION_GUARD,
    "",
    wrapUntrustedXml("edits", diffs),
  ].join("\n");
}

export async function distillEditDeltaRules(
  sb: SupabaseClient,
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ inserted: number; skippedDuplicates: number; candidates: number }> {
  const { data: events, error: eventsError } = await sb
    .from("draft_edit_events")
    .select("id, before_body, after_body, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(MAX_EDIT_EVENTS);
  if (eventsError) throw eventsError;
  const rows = (events ?? []) as DraftEditEventRow[];
  if (rows.length === 0) {
    return { inserted: 0, skippedDuplicates: 0, candidates: 0 };
  }

  const { data: existing, error: prefsError } = await sb
    .from("content_preferences")
    .select("id, workspace_id, rule, detail, source, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(PREFS_PER_WORKSPACE_MAX);
  if (prefsError) throw prefsError;
  const existingPrefs = (existing ?? []) as ContentPreference[];

  let candidates: string[] = [];
  try {
    const res = await completeChat({
      model: BACKGROUND_MODEL,
      maxTokens: DISTILLER_MAX_TOKENS,
      timeoutMs: DISTILLER_TIMEOUT_MS,
      glmReasoning: "none",
      messages: [
        {
          role: "system",
          content:
            "You distill manual draft edits into reusable writing rules. Output strict JSON only.",
        },
        { role: "user", content: buildDistillerPrompt(rows) },
      ],
      signal: opts.signal,
    });
    const attribution = providerModelAttribution(BACKGROUND_MODEL, res.model);
    await logOpenRouterUsage(
      "voice_edit_distiller",
      attribution.model,
      res.usage,
      workspaceId,
      attribution.metadata,
    );
    const parsed = DistillerSchema.safeParse(parseJsonObject(res.text.trim()));
    if (parsed.success) {
      candidates = parsed.data.rules
        .map((rule) => normalizePreferenceRule(rule).slice(0, RULE_MAX_CHARS))
        .filter(Boolean);
    }
  } catch (error) {
    console.warn(
      "distillEditDeltaRules model call failed:",
      error instanceof Error ? error.message : error,
    );
    return { inserted: 0, skippedDuplicates: 0, candidates: 0 };
  }

  let inserted = 0;
  let skippedDuplicates = 0;
  for (const rule of candidates) {
    if (isDuplicatePreference(rule, existingPrefs)) {
      skippedDuplicates += 1;
      continue;
    }
    const { error: insertError } = await sb.from("content_preferences").insert({
      workspace_id: workspaceId,
      rule,
      source: "edit_delta",
    });
    if (insertError) {
      console.warn(
        "distillEditDeltaRules insert failed:",
        insertError.message,
      );
      continue;
    }
    existingPrefs.unshift({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      rule,
      detail: null,
      source: "edit_delta",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    inserted += 1;
  }

  return { inserted, skippedDuplicates, candidates: candidates.length };
}

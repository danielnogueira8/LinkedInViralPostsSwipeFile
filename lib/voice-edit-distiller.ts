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
  normalizePreferenceRule,
  preferenceDedupKey,
  PREFS_INJECTED_MAX,
  type ContentPreference,
} from "@/lib/preferences";
import {
  claimRevisionEventBatch,
  completeRevisionEventClaim,
  persistRevisionEventClaimResult,
  releaseRevisionEventClaim,
} from "@/lib/content-learning/revision-events";
import type { RevisionEvent } from "@/lib/content-learning/contracts";

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
const MAX_BODY_CHARS_PER_EDIT = 6_000;

const ModelDistillerSchema = z.object({
  rules: z
    .array(
      z.object({
        rule: z.string().trim().min(1),
        evidenceEditNumbers: z
          .array(z.number().int().min(1).max(MAX_EDIT_EVENTS))
          .min(1)
          .max(MAX_EDIT_EVENTS),
      }),
    )
    .max(MAX_CANDIDATE_RULES),
});

const SavedDistillerSchema = z.object({
  rules: z
    .array(
      z.object({
        rule: z.string().trim().min(1).max(RULE_MAX_CHARS),
        evidenceEventIds: z
          .array(z.string().uuid())
          .min(1)
          .max(MAX_EDIT_EVENTS),
      }),
    )
    .max(MAX_CANDIDATE_RULES),
});

function buildDistillerPrompt(events: RevisionEvent[]): string {
  const diffs = events
    .map((event, index) => {
      return [
        `[Edit ${index + 1}]`,
        `ORIGIN: ${event.editOrigin}`,
        `CHANGE: ${event.changeSummary.deltaChars} characters, ${event.changeSummary.deltaLines} lines`,
        `BEFORE:\n${event.beforeBody.slice(0, MAX_BODY_CHARS_PER_EDIT)}`,
        `AFTER:\n${event.afterBody.slice(0, MAX_BODY_CHARS_PER_EDIT)}`,
      ].join("\n");
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
    "For every rule, cite the numbered edits that directly support that rule.",
    "Do not cite an edit unless its before/after change demonstrates the rule.",
    "Return strict JSON only, no prose:",
    '{"rules":[{"rule":"...","evidenceEditNumbers":[1,3]}]}.',
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
): Promise<{
  inserted: number;
  skippedDuplicates: number;
  candidates: number;
}> {
  const claim = await claimRevisionEventBatch(sb, workspaceId, {
    limit: MAX_EDIT_EVENTS,
  });
  if (!claim) {
    return { inserted: 0, skippedDuplicates: 0, candidates: 0 };
  }

  let completed = false;
  try {
    const { data: existing, error: prefsError } = await sb
      .from("content_preferences")
      .select("id, workspace_id, rule, detail, source, created_at, updated_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(PREFS_INJECTED_MAX);
    if (prefsError) throw prefsError;
    const existingPrefs = (existing ?? []) as ContentPreference[];

    let candidates: Array<{ rule: string; evidenceEventIds: string[] }> = [];
    const savedResult = SavedDistillerSchema.safeParse(claim.savedResult);
    if (claim.savedResult !== null && !savedResult.success) {
      throw new Error("Saved revision distillation result is invalid");
    }
    if (savedResult.success) {
      candidates = savedResult.data.rules;
    } else {
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
            { role: "user", content: buildDistillerPrompt(claim.events) },
          ],
          signal: opts.signal,
        });
        const attribution = providerModelAttribution(
          BACKGROUND_MODEL,
          res.model,
        );
        try {
          await logOpenRouterUsage(
            "voice_edit_distiller",
            attribution.model,
            res.usage,
            workspaceId,
            attribution.metadata,
          );
        } catch (error) {
          console.warn("[content-learning] revision usage log failed", {
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const parsed = ModelDistillerSchema.safeParse(
          parseJsonObject(res.text.trim()),
        );
        if (!parsed.success) {
          throw new Error("Revision distiller returned an invalid response");
        }
        candidates = parsed.data.rules
          .flatMap((candidate) => {
            const rule = normalizePreferenceRule(candidate.rule).slice(
              0,
              RULE_MAX_CHARS,
            );
            if (
              candidate.evidenceEditNumbers.some(
                (editNumber) => !claim.events[editNumber - 1],
              )
            ) {
              return [];
            }
            const evidenceEventIds = [
              ...new Set(
                candidate.evidenceEditNumbers.flatMap((editNumber) => {
                  const event = claim.events[editNumber - 1];
                  return event ? [event.id] : [];
                }),
              ),
            ];
            return rule && evidenceEventIds.length > 0
              ? [{ rule, evidenceEventIds }]
              : [];
          })
          .reduce<Array<{ rule: string; evidenceEventIds: string[] }>>(
            (unique, candidate) => {
              const duplicate = unique.find(
                (current) =>
                  preferenceDedupKey(current.rule) ===
                  preferenceDedupKey(candidate.rule),
              );
              if (duplicate) {
                duplicate.evidenceEventIds = [
                  ...new Set([
                    ...duplicate.evidenceEventIds,
                    ...candidate.evidenceEventIds,
                  ]),
                ];
              } else {
                unique.push(candidate);
              }
              return unique;
            },
            [],
          );
        const persisted = await persistRevisionEventClaimResult(
          sb,
          workspaceId,
          claim,
          { rules: candidates },
        );
        if (!persisted) {
          throw new Error(
            "Revision distillation result could not be persisted",
          );
        }
      } catch (error) {
        console.warn(
          "distillEditDeltaRules model call failed:",
          error instanceof Error ? error.message : error,
        );
        return { inserted: 0, skippedDuplicates: 0, candidates: 0 };
      }
    }

    let inserted = 0;
    let skippedDuplicates = 0;
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const rule = candidate.rule;
      const duplicate = existingPrefs.find(
        (preference) =>
          preferenceDedupKey(preference.rule) === preferenceDedupKey(rule),
      );
      const { data: outcomeRows, error: evidenceError } = await sb.rpc(
        "persist_content_preference_candidate",
        {
          p_workspace_id: workspaceId,
          p_batch_id: claim.batchId,
          p_candidate_index: candidateIndex,
          p_rule_snapshot: rule,
          p_revision_event_ids: candidate.evidenceEventIds,
          p_matching_preference_id: duplicate?.id ?? null,
        },
      );
      if (evidenceError) {
        throw new Error(
          `Revision preference evidence could not be persisted: ${evidenceError.message}`,
        );
      }
      const outcome = Array.isArray(outcomeRows) ? outcomeRows[0] : outcomeRows;
      if (!outcome || typeof outcome !== "object") {
        throw new Error("Revision preference outcome was not returned");
      }
      const result = outcome as {
        preference_id: string | null;
        outcome_kind: string;
        inserted_preference: boolean;
      };
      if (result.inserted_preference) {
        inserted += 1;
      } else {
        skippedDuplicates += 1;
      }
    }

    completed = await completeRevisionEventClaim(sb, workspaceId, claim);
    if (!completed) {
      throw new Error("Revision-event cursor could not be advanced");
    }
    return { inserted, skippedDuplicates, candidates: candidates.length };
  } finally {
    if (!completed) {
      try {
        await releaseRevisionEventClaim(sb, workspaceId, claim.token);
      } catch (error) {
        console.warn("[content-learning] revision claim release failed", {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

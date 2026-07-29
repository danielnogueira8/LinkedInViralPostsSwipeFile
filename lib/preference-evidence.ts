import type { SupabaseClient } from "@supabase/supabase-js";
import type { RevisionChangeSummary } from "@/lib/content-learning/contracts";
import type { ContentPreference } from "@/lib/preferences";
import { z } from "zod";

const EVIDENCE_PER_PREFERENCE = 3;
const EVIDENCE_IDS_PER_REQUEST = 20;

export type PreferenceEvidence = {
  id: string;
  revisionEventId: string;
  batchId: string;
  ruleSnapshot: string;
  editOrigin: "cowork_artifact" | "posts_editor" | "unknown";
  beforeExcerpt: string;
  afterExcerpt: string;
  beforeTruncated: boolean;
  afterTruncated: boolean;
  changeSummary: RevisionChangeSummary;
  createdAt: string;
};

export type ReviewableContentPreference = ContentPreference & {
  evidence: PreferenceEvidence[];
};

const EvidenceRowSchema = z.object({
  id: z.string().uuid(),
  preference_id: z.string().uuid(),
  revision_event_id: z.string().uuid(),
  batch_id: z.string().uuid(),
  rule_snapshot: z.string().min(1).max(160),
  before_excerpt: z.string().max(1_500),
  after_excerpt: z.string().max(1_500),
  before_truncated: z.boolean(),
  after_truncated: z.boolean(),
  edit_origin: z.enum(["cowork_artifact", "posts_editor", "unknown"]),
  change_summary: z.object({
    beforeChars: z.number(),
    afterChars: z.number(),
    deltaChars: z.number(),
    beforeLines: z.number(),
    afterLines: z.number(),
    deltaLines: z.number(),
  }),
  event_created_at: z.string(),
});

type EvidenceRow = z.infer<typeof EvidenceRowSchema>;

export function attachPreferenceEvidence(
  preferences: ContentPreference[],
  rows: EvidenceRow[],
): ReviewableContentPreference[] {
  const grouped = new Map<string, PreferenceEvidence[]>();
  for (const row of rows) {
    const current = grouped.get(row.preference_id) ?? [];
    if (current.length >= EVIDENCE_PER_PREFERENCE) continue;
    current.push({
      id: row.id,
      revisionEventId: row.revision_event_id,
      batchId: row.batch_id,
      ruleSnapshot: row.rule_snapshot,
      editOrigin: row.edit_origin,
      beforeExcerpt: row.before_excerpt,
      afterExcerpt: row.after_excerpt,
      beforeTruncated: row.before_truncated,
      afterTruncated: row.after_truncated,
      changeSummary: row.change_summary,
      createdAt: row.event_created_at,
    });
    grouped.set(row.preference_id, current);
  }
  return preferences.map((preference) => ({
    ...preference,
    evidence: grouped.get(preference.id) ?? [],
  }));
}

export async function listReviewablePreferences(input: {
  db: SupabaseClient;
  workspaceId: string;
  preferences: ContentPreference[];
}): Promise<ReviewableContentPreference[]> {
  if (input.preferences.length === 0) return [];
  const learnedIds = input.preferences
    .filter((preference) => preference.source === "edit_delta")
    .map((preference) => preference.id);
  if (learnedIds.length === 0) {
    return attachPreferenceEvidence(input.preferences, []);
  }

  try {
    const evidence: EvidenceRow[] = [];
    for (
      let index = 0;
      index < learnedIds.length;
      index += EVIDENCE_IDS_PER_REQUEST
    ) {
      const { data, error } = await input.db.rpc(
        "list_content_preference_evidence",
        {
          p_workspace_id: input.workspaceId,
          p_preference_ids: learnedIds.slice(
            index,
            index + EVIDENCE_IDS_PER_REQUEST,
          ),
          p_per_preference: EVIDENCE_PER_PREFERENCE,
        },
      );
      if (error) throw error;
      const parsed = z.array(EvidenceRowSchema).safeParse(data ?? []);
      if (!parsed.success) {
        throw new Error("Preference evidence response was invalid");
      }
      evidence.push(...parsed.data);
    }
    return attachPreferenceEvidence(input.preferences, evidence);
  } catch (error) {
    console.warn("[content-learning] preference evidence read unavailable", {
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return attachPreferenceEvidence(input.preferences, []);
  }
}

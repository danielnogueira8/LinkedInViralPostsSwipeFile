import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const resultSchema = z
  .object({
    status: z.enum([
      "ingested",
      "no_delta",
      "no_metric",
      "stale_snapshot",
    ]),
    outcome_id: z.string().uuid().nullable().optional(),
    delta: z.number().int().nonnegative().optional(),
    checkpoint: z.number().int().nonnegative().optional(),
    epoch: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type LeadSharkOutcomeIngestResult = z.infer<typeof resultSchema>;

/**
 * Atomically turns LeadShark's documented cumulative initial-DM count into a
 * Content Outcome and advances the source checkpoint. The database owns delta,
 * reset-epoch and idempotency decisions under a row lock.
 */
export async function ingestLeadSharkStatsOutcome(input: {
  db: SupabaseClient;
  workspaceId: string;
  automationId: string;
  leadSharkAutomationId: string;
  stats: Record<string, number>;
  observedAt: string;
}): Promise<LeadSharkOutcomeIngestResult> {
  const { data, error } = await input.db.rpc(
    "ingest_leadshark_stats_outcome",
    {
      p_workspace_id: input.workspaceId,
      p_automation_id: input.automationId,
      p_leadshark_automation_id: input.leadSharkAutomationId,
      p_stats: input.stats,
      p_observed_at: input.observedAt,
    },
  );
  if (error) throw error;
  const parsed = resultSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("LeadShark outcome adapter returned an invalid result");
  }
  return parsed.data;
}

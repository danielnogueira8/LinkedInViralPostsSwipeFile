import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test, vi } from "vitest";
import { ingestLeadSharkStatsOutcome } from "@/lib/content-learning/leadshark-outcomes";

describe("LeadShark Content Outcome adapter", () => {
  test("passes one Workspace-scoped atomic RPC payload", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        status: "ingested",
        outcome_id: "10000000-0000-4000-8000-000000000001",
        delta: 3,
        checkpoint: 5,
        epoch: 0,
      },
      error: null,
    }));
    const db = { rpc } as unknown as SupabaseClient;
    await expect(
      ingestLeadSharkStatsOutcome({
        db,
        workspaceId: "workspace-1",
        automationId: "20000000-0000-4000-8000-000000000001",
        leadSharkAutomationId: "remote-1",
        stats: { total_dms_sent: 5, total_comments: 12 },
        observedAt: "2026-07-26T14:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "ingested",
      delta: 3,
      checkpoint: 5,
    });
    expect(rpc).toHaveBeenCalledWith(
      "ingest_leadshark_stats_outcome",
      {
        p_workspace_id: "workspace-1",
        p_automation_id: "20000000-0000-4000-8000-000000000001",
        p_leadshark_automation_id: "remote-1",
        p_stats: { total_dms_sent: 5, total_comments: 12 },
        p_observed_at: "2026-07-26T14:00:00.000Z",
      },
    );
  });

  test("rejects malformed database results", async () => {
    const db = {
      rpc: vi.fn(async () => ({
        data: { status: "invented", delta: -1 },
        error: null,
      })),
    } as unknown as SupabaseClient;
    await expect(
      ingestLeadSharkStatsOutcome({
        db,
        workspaceId: "workspace-1",
        automationId: "20000000-0000-4000-8000-000000000001",
        leadSharkAutomationId: "remote-1",
        stats: {},
        observedAt: "2026-07-26T14:00:00.000Z",
      }),
    ).rejects.toThrow("invalid result");
  });
});

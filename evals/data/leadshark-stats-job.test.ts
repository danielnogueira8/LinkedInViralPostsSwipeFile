import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BackgroundJob } from "@/lib/background-jobs";

const getDecryptedKey = vi.fn();
const listAllAutomations = vi.fn();
const ingestLeadSharkStatsOutcome = vi.fn();
const markJobDone = vi.fn();
const markJobFailed = vi.fn();
const acquireProviderLock = vi.fn();
const queryResult = vi.fn();

const query = {
  select: vi.fn(() => query),
  eq: vi.fn(() => query),
  not: vi.fn(() => queryResult()),
};
const db = { from: vi.fn(() => query) };

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => db }));
vi.mock("@/lib/leadshark-credentials", () => ({
  getDecryptedKey: (...args: unknown[]) => getDecryptedKey(...args),
}));
vi.mock("@/lib/leadshark", () => ({
  listAllAutomations: (...args: unknown[]) => listAllAutomations(...args),
}));
vi.mock("@/lib/content-learning/leadshark-outcomes", () => ({
  ingestLeadSharkStatsOutcome: (...args: unknown[]) =>
    ingestLeadSharkStatsOutcome(...args),
}));
vi.mock("@/lib/background-jobs", () => ({
  acquireProviderLock: (...args: unknown[]) => acquireProviderLock(...args),
  markJobDone: (...args: unknown[]) => markJobDone(...args),
  markJobFailed: (...args: unknown[]) => markJobFailed(...args),
}));

const { runLeadSharkStatsSyncJob } =
  await import("@/lib/leadshark-stats-job");

const job = {
  id: "job-1",
  workspace_id: "workspace-1",
  payload: {},
} as BackgroundJob;

describe("LeadShark stats outcome sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDecryptedKey.mockResolvedValue("secret");
    acquireProviderLock.mockResolvedValue(true);
    queryResult.mockResolvedValue({
      data: [
        {
          id: "local-1",
          leadshark_automation_id: "remote-1",
        },
      ],
      error: null,
    });
    listAllAutomations.mockResolvedValue({
      ok: true,
      automations: [
        {
          id: "remote-1",
          postId: "urn:li:activity:1",
          stats: { total_dms_sent: 5 },
          raw: {},
        },
      ],
    });
    ingestLeadSharkStatsOutcome.mockResolvedValue({
      status: "ingested",
      delta: 3,
      checkpoint: 5,
      epoch: 0,
    });
  });

  test("delegates stats and checkpointing to one atomic adapter", async () => {
    await expect(runLeadSharkStatsSyncJob(job)).resolves.toMatchObject({
      completed: 1,
    });
    expect(ingestLeadSharkStatsOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        automationId: "local-1",
        leadSharkAutomationId: "remote-1",
        stats: { total_dms_sent: 5 },
      }),
    );
    expect(acquireProviderLock).toHaveBeenCalledWith({
      provider: "leadshark:workspace-1",
      workType: "stats",
      jobId: "job-1",
      workspaceId: "workspace-1",
      limit: 1,
      sb: db,
    });
  });

  test("requeues when the atomic adapter fails", async () => {
    ingestLeadSharkStatsOutcome.mockRejectedValue(
      new Error("outcome database unavailable"),
    );
    await expect(runLeadSharkStatsSyncJob(job)).rejects.toThrow(
      "outcome database unavailable",
    );
    expect(markJobDone).not.toHaveBeenCalled();
  });

  test("rejects a payload that attempts to redirect the Workspace", async () => {
    const mismatched = {
      ...job,
      payload: { workspaceId: "workspace-2" },
    } as BackgroundJob;
    getDecryptedKey.mockClear();
    await expect(runLeadSharkStatsSyncJob(mismatched)).resolves.toMatchObject({
      failed: 1,
    });
    expect(markJobFailed).toHaveBeenCalledWith(
      mismatched,
      "LeadShark stats Workspace mismatch",
      db,
    );
    expect(getDecryptedKey).not.toHaveBeenCalled();
    expect(acquireProviderLock).not.toHaveBeenCalled();
  });

  test("skips the upstream fetch while another Workspace sync owns the lock", async () => {
    acquireProviderLock.mockResolvedValue(false);
    await expect(runLeadSharkStatsSyncJob(job)).resolves.toMatchObject({
      completed: 1,
    });
    expect(getDecryptedKey).not.toHaveBeenCalled();
    expect(listAllAutomations).not.toHaveBeenCalled();
    expect(markJobDone).toHaveBeenCalledWith(
      job,
      { skipped: "stats_sync_in_progress" },
      db,
    );
  });
});

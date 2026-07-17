import { describe, test, expect } from "vitest";
import { STALE_PENDING_MS, recoverStalePending } from "@/lib/voice-recovery";

// ---------------------------------------------------------------------------
// Voice generation runs as a background job with a 15-minute worker lease
// (DEFAULT_STALE_AFTER_SECS, lib/background-jobs.ts) that can be extended by
// capacity-contention requeues. STALE_PENDING_MS used to be 5 minutes — sized
// for an old synchronous route (maxDuration=30/120) no longer in use — so a
// read-path poll could declare a still-legitimately-running worker "failed"
// well before its lease expired, triggering a premature retry that enqueues a
// SECOND job while the first is still executing (real duplicate Apify/
// OpenRouter spend, not just a false "failed" reading).
// ---------------------------------------------------------------------------

const WORKER_LEASE_MS = 15 * 60 * 1000;

describe("STALE_PENDING_MS — safely exceeds the worker's own lease", () => {
  test("REGRESSION: the staleness window is not shorter than the background-job lease", () => {
    expect(STALE_PENDING_MS).toBeGreaterThan(WORKER_LEASE_MS);
  });

  test("a row still inside the worker's lease window is NOT recovered as stale", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const sb = {
      raw: {
        from: () => ({
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return { eq: () => ({ eq: async () => ({ data: null, error: null }) }) };
          },
        }),
      } as never,
      workspaceId: "ws-1",
    };

    // 12 minutes ago — inside the 15-minute lease, so a legitimate worker
    // could still be executing this job.
    const pendingStartedAt = new Date(Date.now() - 12 * 60 * 1000).toISOString();
    const row = { status: "pending", pending_started_at: pendingStartedAt };

    const result = await recoverStalePending(sb, row);

    expect(result.status).toBe("pending");
    expect(updates).toHaveLength(0);
  });

  test("a row well past the lease + capacity-wait margin IS recovered as stale", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const sb = {
      raw: {
        from: () => ({
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return { eq: () => ({ eq: async () => ({ data: null, error: null }) }) };
          },
        }),
      } as never,
      workspaceId: "ws-1",
    };

    const pendingStartedAt = new Date(Date.now() - STALE_PENDING_MS - 60_000).toISOString();
    const row = { status: "pending", pending_started_at: pendingStartedAt };

    const result = await recoverStalePending(sb, row);

    expect(result.status).toBe("failed");
    expect(updates).toHaveLength(1);
  });
});

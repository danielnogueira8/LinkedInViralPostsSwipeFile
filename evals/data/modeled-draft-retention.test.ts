import { describe, expect, test, vi } from "vitest";
import {
  MODELED_DRAFT_BATCH_RETENTION_LIMIT,
  MODELED_DRAFT_BATCH_RETENTION_SECONDS,
  purgeExpiredModeledDraftBatches,
} from "@/lib/modeled-draft-batch-retention";

describe("purgeExpiredModeledDraftBatches", () => {
  test("runs the service-only purge with fixed retention and row bounds", async () => {
    const abortSignal = vi.fn(async () => ({ data: 17, error: null }));
    const rpc = vi.fn(() => ({ abortSignal }));

    const result = await purgeExpiredModeledDraftBatches({
      client: { rpc } as never,
    });

    expect(result).toEqual({ deleted: 17 });
    expect(rpc).toHaveBeenCalledWith("purge_expired_modeled_draft_batches", {
      p_retention_seconds: 7 * 24 * 60 * 60,
      p_limit: 1_000,
    });
    expect(MODELED_DRAFT_BATCH_RETENTION_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(MODELED_DRAFT_BATCH_RETENTION_LIMIT).toBe(1_000);
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  test("fails closed on an invalid database result instead of hiding a broken sweep", async () => {
    const client = {
      rpc: vi.fn(() => ({
        abortSignal: vi.fn(async () => ({ data: 1_001, error: null })),
      })),
    };

    await expect(
      purgeExpiredModeledDraftBatches({ client: client as never }),
    ).rejects.toThrow(/invalid purge result/i);
  });
});

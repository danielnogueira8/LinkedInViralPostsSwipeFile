import { beforeEach, describe, expect, test, vi } from "vitest";

const sweepDeletedMedia = vi.fn();
const purgeExpiredModeledDraftBatches = vi.fn();
const postCronAlert = vi.fn(async () => true);

vi.mock("@/lib/media-sweep", () => ({ sweepDeletedMedia }));
vi.mock("@/lib/modeled-draft-batch-retention", () => ({
  purgeExpiredModeledDraftBatches,
}));
vi.mock("@/lib/cron-alert", () => ({ postCronAlert }));

const { GET } = await import("@/app/api/cron/sweep-media/route");

function request(secret = "test-secret") {
  return new Request("https://example.com/api/cron/sweep-media", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret";
  sweepDeletedMedia.mockReset();
  purgeExpiredModeledDraftBatches.mockReset();
  postCronAlert.mockClear();
  sweepDeletedMedia.mockResolvedValue({
    candidates: 0,
    purged: 0,
    stillReferenced: 0,
    errors: [],
  });
  purgeExpiredModeledDraftBatches.mockResolvedValue({ deleted: 4 });
});

describe("GET /api/cron/sweep-media", () => {
  test("runs modeled-batch retention on the authenticated scheduled maintenance path", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(purgeExpiredModeledDraftBatches).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      modeledDraftBatchesDeleted: 4,
    });
  });

  test("alerts and fails the tick when modeled-batch retention is unavailable", async () => {
    purgeExpiredModeledDraftBatches.mockRejectedValue(
      new Error("retention RPC unavailable"),
    );

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(postCronAlert).toHaveBeenCalledWith(
      { cron: "sweep-media" },
      expect.any(Error),
    );
  });
});

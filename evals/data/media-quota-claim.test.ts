import { describe, expect, test, vi } from "vitest";
import {
  MEDIA_LIBRARY_QUOTA_BYTES,
  claimMediaQuota,
  settleMediaQuotaClaim,
} from "@/lib/media-library";

describe("media quota claims", () => {
  test("returns the database reservation and reserved usage", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ claim_id: "claim-1", used_before: 4096 }],
      error: null,
    });

    await expect(claimMediaQuota({ rpc } as never, "workspace-1", 1024)).resolves.toEqual({
      claimId: "claim-1",
      usedBefore: 4096,
    });
    expect(rpc).toHaveBeenCalledWith("claim_media_quota", {
      p_workspace_id: "workspace-1",
      p_size_bytes: 1024,
      p_limit_bytes: MEDIA_LIBRARY_QUOTA_BYTES,
    });
  });

  test("returns null when the database denies capacity", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await expect(claimMediaQuota({ rpc } as never, "workspace-1", 1024)).resolves.toBeNull();
  });

  test("settles only a still-reserved claim", async () => {
    const eqStatus = vi.fn().mockResolvedValue({ error: null });
    const eqId = vi.fn().mockReturnValue({ eq: eqStatus });
    const update = vi.fn().mockReturnValue({ eq: eqId });
    const from = vi.fn().mockReturnValue({ update });

    await settleMediaQuotaClaim({ from } as never, "claim-1", "released");

    expect(from).toHaveBeenCalledWith("media_quota_claims");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released", updated_at: expect.any(String) }),
    );
    expect(eqId).toHaveBeenCalledWith("id", "claim-1");
    expect(eqStatus).toHaveBeenCalledWith("status", "reserved");
  });
});

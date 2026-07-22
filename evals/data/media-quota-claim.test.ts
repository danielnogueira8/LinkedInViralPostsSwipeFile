import { describe, expect, test, vi } from "vitest";
import {
  MEDIA_LIBRARY_QUOTA_BYTES,
  claimMediaQuota,
  downloadWorkspaceMedia,
  removeWorkspaceMedia,
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
    const eqWorkspace = vi.fn().mockReturnValue({ eq: eqId });
    const update = vi.fn().mockReturnValue({ eq: eqWorkspace });
    const from = vi.fn().mockReturnValue({ update });

    await settleMediaQuotaClaim(
      "workspace-1",
      "claim-1",
      "released",
      { from } as never,
    );

    expect(from).toHaveBeenCalledWith("media_quota_claims");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released", updated_at: expect.any(String) }),
    );
    expect(eqWorkspace).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(eqId).toHaveBeenCalledWith("id", "claim-1");
    expect(eqStatus).toHaveBeenCalledWith("status", "reserved");
  });
});

describe("workspace media storage capabilities", () => {
  test("rejects a path outside the authenticated workspace", async () => {
    const from = vi.fn();

    await expect(
      downloadWorkspaceMedia("workspace-1", "workspace-2/file.png", {
        storage: { from },
      } as never),
    ).rejects.toThrow("Workspace media path mismatch");
    expect(from).not.toHaveBeenCalled();
  });

  test("binds removal to the fixed media bucket and workspace prefix", async () => {
    const remove = vi.fn().mockResolvedValue({ data: [], error: null });
    const from = vi.fn().mockReturnValue({ remove });

    await removeWorkspaceMedia("workspace-1", "workspace-1/file.png", {
      storage: { from },
    } as never);

    expect(from).toHaveBeenCalledWith("media-assets");
    expect(remove).toHaveBeenCalledWith(["workspace-1/file.png"]);
  });
});

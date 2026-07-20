import { describe, expect, test, vi } from "vitest";
import { claimLeadMagnetGeneration } from "@/lib/lead-magnet-ai";

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    completeChat: vi.fn(),
    logOpenRouterUsage: vi.fn(),
    streamChat: vi.fn(),
  };
});

describe("lead magnet generation claims", () => {
  test("returns the database reservation and current usage", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ claim_id: "claim-1", used_before: 8 }],
      error: null,
    });

    await expect(
      claimLeadMagnetGeneration({ rpc } as never, "workspace-1", "user-1"),
    ).resolves.toEqual({ claimId: "claim-1", usedBefore: 8 });
    expect(rpc).toHaveBeenCalledWith("claim_lead_magnet_generation", {
      p_workspace_id: "workspace-1",
      p_user_id: "user-1",
      p_limit: 10,
    });
  });

  test("returns null when the database denies capacity", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await expect(
      claimLeadMagnetGeneration({ rpc } as never, "workspace-1", "user-1"),
    ).resolves.toBeNull();
  });

  test("does not hide reservation errors", async () => {
    const error = new Error("database unavailable");
    const rpc = vi.fn().mockResolvedValue({ data: null, error });

    await expect(
      claimLeadMagnetGeneration({ rpc } as never, "workspace-1", "user-1"),
    ).rejects.toBe(error);
  });
});

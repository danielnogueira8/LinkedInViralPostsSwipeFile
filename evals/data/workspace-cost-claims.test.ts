import { describe, expect, test, vi } from "vitest";
import {
  chatCostOperationKey,
  claimWorkspaceCost,
  releaseWorkspaceCost,
} from "@/lib/workspace-cost-claims";
import { costCapGraceUsd } from "@/lib/agent/rate-limit";

describe("workspace cost claim client", () => {
  test("claims an estimated cost with a bounded operation key", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "claim-1", error: null });
    await expect(
      claimWorkspaceCost({
        workspaceId: "ws-1",
        operationKey: "x".repeat(250),
        estimatedCostUsd: 0.05,
        budgetUsd: 5,
        ttlSeconds: 330,
        sb: { rpc } as never,
      }),
    ).resolves.toBe("claim-1");
    expect(rpc).toHaveBeenCalledWith("claim_workspace_cost", {
      p_workspace_id: "ws-1",
      p_operation_key: "x".repeat(200),
      p_estimated_cost_usd: 0.05,
      p_budget_usd: 5,
      p_ttl_seconds: 330,
      p_grace_usd: costCapGraceUsd(),
    });
  });

  test("an explicit grace override wins over the monthly default", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "claim-2", error: null });
    await claimWorkspaceCost({
      workspaceId: "ws-1",
      operationKey: "op",
      estimatedCostUsd: 0.05,
      budgetUsd: 5,
      ttlSeconds: 330,
      graceUsd: 0,
      sb: { rpc } as never,
    });
    expect(rpc).toHaveBeenCalledWith(
      "claim_workspace_cost",
      expect.objectContaining({ p_grace_usd: 0 }),
    );
  });

  test("returns null on budget contention and fails closed on RPC errors", async () => {
    const denied = vi.fn().mockResolvedValue({ data: null, error: null });
    await expect(
      claimWorkspaceCost({
        workspaceId: "ws-1",
        operationKey: "lead-magnet:1",
        estimatedCostUsd: 0.05,
        budgetUsd: 5,
        ttlSeconds: 900,
        sb: { rpc: denied } as never,
      }),
    ).resolves.toBeNull();

    const error = new Error("database unavailable");
    const broken = vi.fn().mockResolvedValue({ data: null, error });
    await expect(
      claimWorkspaceCost({
        workspaceId: "ws-1",
        operationKey: "lead-magnet:2",
        estimatedCostUsd: 0.05,
        budgetUsd: 5,
        ttlSeconds: 900,
        sb: { rpc: broken } as never,
      }),
    ).rejects.toBe(error);
  });

  test("releases only the workspace-scoped operation key", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await releaseWorkspaceCost({
      workspaceId: "ws-1",
      operationKey: chatCostOperationKey("chat-1"),
      sb: { rpc } as never,
    });
    expect(rpc).toHaveBeenCalledWith("release_workspace_cost", {
      p_workspace_id: "ws-1",
      p_operation_key: "chat:chat-1",
    });
  });
});

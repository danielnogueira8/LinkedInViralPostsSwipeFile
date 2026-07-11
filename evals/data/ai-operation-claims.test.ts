import { describe, expect, test, vi } from "vitest";
import { claimAiOperation, releaseAiOperation } from "@/lib/ai-operation-claims";
import fs from "node:fs";
import path from "node:path";

function db(result: { data?: unknown; error?: unknown }) {
  return { rpc: vi.fn(async () => ({ data: null, error: null, ...result })) };
}

describe("AI operation claims", () => {
  test("returns the atomic claim id and sends a bounded operation key", async () => {
    const sb = db({ data: "claim-1" });
    await expect(
      claimAiOperation({
        workspaceId: "ws-1",
        operationKey: "x".repeat(250),
        ttlSeconds: 300,
        sb: sb as never,
      }),
    ).resolves.toBe("claim-1");
    expect(sb.rpc).toHaveBeenCalledWith("claim_ai_operation", {
      p_workspace_id: "ws-1",
      p_operation_key: "x".repeat(200),
      p_ttl_seconds: 300,
    });
  });

  test("returns null when another request owns the operation", async () => {
    const sb = db({ data: null });
    await expect(
      claimAiOperation({
        workspaceId: "ws-1",
        operationKey: "voice-generation",
        ttlSeconds: 900,
        sb: sb as never,
      }),
    ).resolves.toBeNull();
  });

  test("releases only the workspace-scoped claim", async () => {
    const sb = db({});
    await releaseAiOperation({ workspaceId: "ws-1", claimId: "claim-1", sb: sb as never });
    expect(sb.rpc).toHaveBeenCalledWith("release_ai_operation", {
      p_workspace_id: "ws-1",
      p_claim_id: "claim-1",
    });
  });

  test("migration serializes each key and restricts execution to service role", () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "db/migration-079-ai-operation-claims.sql"),
      "utf8",
    );
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("unique (workspace_id, operation_key)");
    expect(sql).toContain("on conflict (workspace_id, operation_key) do nothing");
    expect(sql).toContain("grant execute on function claim_ai_operation");
    expect(sql).toContain("to service_role");
  });
});

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

class WorkspaceCostLedger {
  private reservations = new Map<string, number>();
  private transaction = Promise.resolve();

  constructor(
    private committedUsd: number,
    private readonly budgetUsd: number,
  ) {}

  claim(operationKey: string, estimateUsd: number): Promise<boolean> {
    const run = this.transaction.then(async () => {
      // Yield inside the serialized section so Promise.all creates a real,
      // deterministic contention point rather than two sequential calls.
      await Promise.resolve();
      if (this.reservations.has(operationKey)) return true;
      const reserved = [...this.reservations.values()].reduce((sum, value) => sum + value, 0);
      if (this.committedUsd + reserved + estimateUsd > this.budgetUsd) return false;
      this.reservations.set(operationKey, estimateUsd);
      return true;
    });
    this.transaction = run.then(() => undefined, () => undefined);
    return run;
  }

  release(operationKey: string) {
    this.reservations.delete(operationKey);
  }
}

describe("workspace cost reservation concurrency", () => {
  test("near-cap chat and lead-magnet claims serialize so only one wins", async () => {
    const ledger = new WorkspaceCostLedger(4.93, 5);
    const [chatAllowed, leadMagnetAllowed] = await Promise.all([
      ledger.claim("chat:chat-1", 0.05),
      ledger.claim("lead-magnet:claim-1", 0.05),
    ]);

    expect([chatAllowed, leadMagnetAllowed].filter(Boolean)).toHaveLength(1);
    expect([chatAllowed, leadMagnetAllowed].filter((allowed) => !allowed)).toHaveLength(1);
  });

  test("a released reservation makes capacity available without double-reserving replays", async () => {
    const ledger = new WorkspaceCostLedger(4.9, 5);
    await expect(ledger.claim("chat:chat-1", 0.05)).resolves.toBe(true);
    await expect(ledger.claim("chat:chat-1", 0.05)).resolves.toBe(true);
    await expect(ledger.claim("lead-magnet:claim-1", 0.06)).resolves.toBe(false);
    ledger.release("chat:chat-1");
    await expect(ledger.claim("lead-magnet:claim-1", 0.06)).resolves.toBe(true);
  });

  test("migration uses one workspace lock and wraps chat in the shared ledger", () => {
    const sql = readFileSync(
      resolve("db/migration-085-workspace-cost-claims.sql"),
      "utf8",
    );
    expect(sql).toContain("'workspace-ai-cost:' || p_workspace_id");
    expect(sql).toContain("sum(estimated_cost_usd)");
    expect(sql).toContain("rename to claim_chat_turn_without_workspace_cost");
    expect(sql).toContain("v_cost_claim := claim_workspace_cost");
    expect(sql).toContain("perform release_workspace_cost");
    expect(sql).toContain("gen_random_uuid()::text");
    expect(sql).toContain("p_operation_key text");
    expect(sql).toContain("turn_cost_operation_key = p_operation_key");
    expect(sql).toContain("if not found then");
    expect(sql).toContain("if p_operation_key is null or btrim(p_operation_key) = '' then");
    expect(sql).toContain("elsif coalesce(v_allowed, false) then");
    expect(sql).toContain(
      "revoke all on function claim_chat_turn(text, uuid, text, integer, integer, integer, integer, numeric, numeric)",
    );
  });
});

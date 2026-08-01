import { describe, expect, test } from "vitest";
import { STALE_PENDING_MS, recoverStalePending } from "@/lib/voice-recovery";

describe("voice stale recovery ownership", () => {
  test("does not mark a newer pending run failed when the stale update matches no row", async () => {
    const filters: Array<[string, unknown]> = [];
    const builder: Record<string, unknown> = {};
    builder.update = () => builder;
    builder.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    };
    builder.select = () => builder;
    builder.maybeSingle = async () => ({ data: null, error: null });
    builder.then = (resolve: (value: { data: null; error: null }) => unknown) =>
      resolve({ data: null, error: null });

    const pendingStartedAt = new Date(
      Date.now() - STALE_PENDING_MS - 60_000,
    ).toISOString();
    const row = { status: "pending", pending_started_at: pendingStartedAt };
    const sb = {
      raw: { from: () => builder },
      workspaceId: "workspace-ownership",
    };

    const result = await recoverStalePending(sb as never, row);

    expect(result).toEqual(row);
    expect(filters).toContainEqual(["pending_started_at", pendingStartedAt]);
  });
});

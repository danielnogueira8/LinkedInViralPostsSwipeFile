import { describe, expect, test, vi } from "vitest";
import {
  orderWorkspacesFromCursor,
  runWorkingSummarySweep,
} from "@/lib/agent-loop/user-working-summary-cron";

describe("working-summary sweep cursor", () => {
  test("starts at the saved workspace and wraps deterministically", () => {
    expect(
      orderWorkspacesFromCursor(["ws-d", "ws-b", "ws-a", "ws-c"], "ws-c"),
    ).toEqual(["ws-c", "ws-d", "ws-a", "ws-b"]);
  });

  test("persists the next workspace at a deadline and resumes there", async () => {
    const firstVisited: string[] = [];
    const saved = vi.fn(async () => undefined);
    const clock = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(101);

    const first = await runWorkingSummarySweep({
      workspaces: ["ws-a", "ws-b", "ws-c", "ws-d"],
      cursor: null,
      concurrency: 2,
      startedAt: 0,
      now: clock,
      budgetMs: 100,
      marginMs: 0,
      refresh: async (workspaceId) => {
        firstVisited.push(workspaceId);
        return true;
      },
      saveCursor: saved,
    });

    expect(first).toMatchObject({
      processed: 2,
      deadlineHit: true,
      nextCursor: "ws-c",
    });
    expect(firstVisited).toEqual(["ws-a", "ws-b"]);
    expect(saved).toHaveBeenLastCalledWith("ws-c");

    const resumedVisited: string[] = [];
    const resumed = await runWorkingSummarySweep({
      workspaces: ["ws-a", "ws-b", "ws-c", "ws-d"],
      cursor: first.nextCursor,
      concurrency: 2,
      startedAt: 0,
      now: () => 0,
      budgetMs: 100,
      marginMs: 0,
      refresh: async (workspaceId) => {
        resumedVisited.push(workspaceId);
        return true;
      },
      saveCursor: async () => undefined,
    });

    expect(resumed.deadlineHit).toBe(false);
    expect(resumedVisited).toEqual(["ws-c", "ws-d", "ws-a", "ws-b"]);
  });
});

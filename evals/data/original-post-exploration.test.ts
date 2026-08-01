import { describe, expect, test } from "vitest";
import {
  automaticExplorationLane,
  type ExplorationLane,
} from "@/lib/agent/original-post-exploration";

describe("automatic original-post exploration mix", () => {
  test("keeps a stable 60/30/10 exploration mix across representative turns", () => {
    const counts: Record<ExplorationLane, number> = {
      familiar: 0,
      fresh: 0,
      experimental: 0,
    };

    for (let index = 0; index < 1_000; index += 1) {
      counts[automaticExplorationLane(`workspace-turn-${index}`)] += 1;
    }

    expect(counts.familiar).toBeGreaterThanOrEqual(560);
    expect(counts.familiar).toBeLessThanOrEqual(640);
    expect(counts.fresh).toBeGreaterThanOrEqual(260);
    expect(counts.fresh).toBeLessThanOrEqual(340);
    expect(counts.experimental).toBeGreaterThanOrEqual(70);
    expect(counts.experimental).toBeLessThanOrEqual(130);
    expect(automaticExplorationLane("repeatable-turn")).toBe(
      automaticExplorationLane("repeatable-turn"),
    );
  });
});

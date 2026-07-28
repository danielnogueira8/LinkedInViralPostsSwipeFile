import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workspace = readFileSync(
  "app/(app)/dashboard/chat-workspace.tsx",
  "utf8",
);

describe("Cowork Exploration Lane control", () => {
  test("offers the four accessible choices in Create generation settings", () => {
    expect(workspace).toContain('aria-label="Exploration Lane"');
    expect(workspace).toContain('aria-pressed={selected}');
    expect(workspace).toContain('"auto",');
    expect(workspace).toContain('"familiar",');
    expect(workspace).toContain('"fresh",');
    expect(workspace).toContain('"experimental",');
  });

  test("disables the control while a model source is attached", () => {
    expect(workspace).toContain('disabled={Boolean(modelSource)}');
  });

  test("consumes the lane after send and restores it after a pre-stream failure", () => {
    expect(workspace).toContain("consumeComposerExplorationLane(");
    expect(workspace).toContain(
      'turnGenerationConfig?.explorationLane ?? "auto"',
    );
  });
});
